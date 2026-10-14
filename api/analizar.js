// Función serverless (Vercel): recibe el texto y el contexto, arma el prompt
// con la matriz de prompt.js y le pide el análisis a un modelo de lenguaje.
//
// Motor según la variable de entorno que esté cargada en Vercel:
//   GEMINI_API_KEY     → Gemini de Google (plan gratuito, sin tarjeta)
//   ANTHROPIC_API_KEY  → Claude de Anthropic (pago)
// La clave vive en Vercel, nunca en la web.
const Detector = require("../prompt.js");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/";
let geminiModelo = (process.env.GEMINI_MODEL || "gemini-flash-latest").trim();

class ErrorMotor extends Error {
  constructor(codigo, detalle) {
    super(detalle || codigo);
    this.codigo = codigo;
    this.detalle = detalle || "";
  }
}

// La clave a veces se pega con espacios, saltos de línea o comillas.
function claveGemini() {
  return String(process.env.GEMINI_API_KEY || "").trim().replace(/^["']|["']$/g, "");
}

function mensajeGoogle(cuerpo) {
  try { return JSON.parse(cuerpo).error.message; } catch (e) { return cuerpo.slice(0, 200); }
}

// Si el modelo configurado no existe para esta clave, busca un modelo "flash" disponible.
async function buscarModeloFlash() {
  const r = await fetch(GEMINI_BASE + "models?pageSize=200", { headers: { "x-goog-api-key": claveGemini() } });
  if (!r.ok) return null;
  const { models = [] } = await r.json();
  const usables = models.filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"));
  const flash = usables.filter((m) => /flash/.test(m.name) && !/lite|image|tts|live|preview|exp/.test(m.name));
  const elegido = flash.sort((a, b) => b.name.localeCompare(a.name, "en", { numeric: true }))[0] || usables[0];
  return elegido ? elegido.name.replace(/^models\//, "") : null;
}

async function llamarGemini(prompt, modelo) {
  return fetch(GEMINI_BASE + "models/" + encodeURIComponent(modelo) + ":generateContent", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": claveGemini() },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
}

async function analizarConGemini(prompt) {
  let r = await llamarGemini(prompt, geminiModelo);
  if (r.status === 404) {
    const alternativo = await buscarModeloFlash();
    if (alternativo && alternativo !== geminiModelo) {
      console.warn("Modelo " + geminiModelo + " no disponible; uso " + alternativo);
      geminiModelo = alternativo;
      r = await llamarGemini(prompt, geminiModelo);
    }
  }
  if (r.status === 429) throw new ErrorMotor("limite", mensajeGoogle(await r.text()));
  if (!r.ok) throw new ErrorMotor("api", "Gemini " + r.status + " (" + geminiModelo + "): " + mensajeGoogle(await r.text()));
  const datos = await r.json();
  const candidato = (datos.candidates || [])[0];
  if (!candidato || candidato.finishReason === "SAFETY") throw new ErrorMotor("rechazado");
  return (candidato.content && candidato.content.parts ? candidato.content.parts : [])
    .map((p) => p.text || "")
    .join("");
}

async function analizarConClaude(prompt) {
  const sdk = require("@anthropic-ai/sdk");
  const Anthropic = sdk.default || sdk;
  const client = new Anthropic();
  try {
    const response = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "medium" },
      // Si un filtro de seguridad rechaza el pedido, se reintenta en el modelo recomendado.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      messages: [{ role: "user", content: prompt }],
    });
    if (response.stop_reason === "refusal") throw new ErrorMotor("rechazado");
    return response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  } catch (e) {
    if (e instanceof ErrorMotor) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new ErrorMotor("limite");
    if (e instanceof Anthropic.APIError) throw new ErrorMotor("api", "Claude " + e.status + ": " + e.message);
    throw e;
  }
}

function motorDisponible() {
  if (claveGemini()) return analizarConGemini;
  if (process.env.ANTHROPIC_API_KEY) return analizarConClaude;
  return null;
}

const ESTADO_HTTP = { limite: 429, rechazado: 422, api: 502 };

module.exports = async function handler(req, res) {
  const analizar = motorDisponible();

  // La web usa este GET para saber si hay servidor disponible.
  if (req.method === "GET") {
    return res.status(200).json({ ok: Boolean(analizar), requiereCodigo: Boolean(process.env.CODIGO_ACCESO) });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "metodo_no_permitido" });
  }
  if (!analizar) return res.status(503).json({ error: "sin_motor" });

  const body = req.body || {};
  if (process.env.CODIGO_ACCESO && body.codigo !== process.env.CODIGO_ACCESO) {
    return res.status(401).json({ error: "codigo_invalido" });
  }
  const texto = String(body.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "texto_vacio" });
  if (texto.length > Detector.MAX_CARACTERES) return res.status(400).json({ error: "texto_largo" });

  const prompt = Detector.construirPrompt({ texto, tipo: body.tipo, perfil: body.perfil, objetivo: body.objetivo });

  try {
    const salida = await analizar(prompt);
    return res.status(200).json(Detector.extraerJSON(salida));
  } catch (e) {
    if (e instanceof ErrorMotor) {
      if (e.codigo === "api") console.error(e.message);
      // El detalle es el mensaje del proveedor (nunca incluye la clave); ayuda a diagnosticar.
      return res.status(ESTADO_HTTP[e.codigo] || 500).json({ error: e.codigo, detalle: e.detalle });
    }
    if (e instanceof SyntaxError || /JSON/.test(String(e && e.message))) {
      return res.status(502).json({ error: "invalid_json" });
    }
    console.error(e);
    return res.status(500).json({ error: "interno" });
  }
};
