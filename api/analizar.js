// Función serverless (Vercel): recibe el texto y el contexto, arma el prompt
// con la matriz de prompt.js y le pide el análisis a un modelo de lenguaje.
//
// Motor según la variable de entorno que esté cargada en Vercel:
//   GEMINI_API_KEY     → Gemini de Google (plan gratuito, sin tarjeta)
//   ANTHROPIC_API_KEY  → Claude de Anthropic (pago)
// La clave vive en Vercel, nunca en la web.
const Detector = require("../prompt.js");

const GEMINI_MODELO = process.env.GEMINI_MODEL || "gemini-flash-latest";

class ErrorMotor extends Error {
  constructor(codigo, detalle) {
    super(detalle || codigo);
    this.codigo = codigo;
  }
}

async function analizarConGemini(prompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(GEMINI_MODELO) + ":generateContent";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });
  if (r.status === 429) throw new ErrorMotor("limite");
  if (!r.ok) throw new ErrorMotor("api", "Gemini " + r.status + ": " + (await r.text()).slice(0, 300));
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
  if (process.env.GEMINI_API_KEY) return analizarConGemini;
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
      return res.status(ESTADO_HTTP[e.codigo] || 500).json({ error: e.codigo });
    }
    console.error(e);
    return res.status(500).json({ error: "interno" });
  }
};
