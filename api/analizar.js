// Función serverless (Vercel): recibe el texto y el contexto, arma el prompt
// con la matriz de prompt.js y le pide el análisis a un modelo de lenguaje.
//
// Proveedores, en este orden, según las claves cargadas en Vercel:
//   GEMINI_API_KEY     → Gemini de Google (gratis, sin tarjeta)
//   GROQ_API_KEY       → Groq, respaldo si Google está saturado (gratis, sin tarjeta)
//   ANTHROPIC_API_KEY  → Claude de Anthropic (pago, opcional)
// Si uno falla, se prueba el siguiente. Las claves viven en Vercel, nunca en la web.
const Detector = require("../prompt.js");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/";
const MODELO_PREFERIDO = (process.env.GEMINI_MODEL || "gemini-flash-latest").trim();
// Si el preferido está saturado o sin cupo, se prueban estos (cada modelo tiene su propio cupo gratuito).
const RESPALDOS = ["gemini-flash-lite-latest"];
const MAX_MODELOS = 6;
const PLAZO_MS = 35000; // tiempo máximo de reintentos en Gemini antes de pasar al respaldo

let ultimoQueFunciono = null; // se recuerda mientras la función siga activa
let modelosDescubiertos = null;

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

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Lista los modelos de texto "flash" que esta clave puede usar, los estables primero.
async function descubrirModelos() {
  if (modelosDescubiertos) return modelosDescubiertos;
  try {
    const r = await fetch(GEMINI_BASE + "models?pageSize=200", { headers: { "x-goog-api-key": claveGemini() } });
    if (!r.ok) return [];
    const { models = [] } = await r.json();
    const nombres = models
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /flash/.test(n) && !/image|tts|live|audio|embedding|thinking/.test(n));
    const inestable = (n) => (/preview|exp/.test(n) ? 1 : 0);
    nombres.sort((a, b) => inestable(a) - inestable(b) || b.localeCompare(a, "en", { numeric: true }));
    modelosDescubiertos = nombres;
    return nombres;
  } catch (e) {
    return [];
  }
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

function textoDeRespuesta(datos) {
  const candidato = (datos.candidates || [])[0];
  if (!candidato || candidato.finishReason === "SAFETY") throw new ErrorMotor("rechazado");
  return (candidato.content && candidato.content.parts ? candidato.content.parts : [])
    .map((p) => p.text || "")
    .join("");
}

// Prueba modelo por modelo: si uno está saturado (503/500) reintenta una vez;
// si no tiene cupo (429) o no existe (404), pasa al siguiente.
async function analizarConGemini(prompt) {
  const inicio = Date.now();
  const cola = [ultimoQueFunciono, MODELO_PREFERIDO, ...RESPALDOS].filter(Boolean);
  const probados = new Set();
  let ultimoError = null;
  let descubrio = false;

  while (probados.size < MAX_MODELOS) {
    let modelo = cola.find((m) => !probados.has(m));
    if (!modelo && !descubrio) {
      descubrio = true;
      cola.push(...(await descubrirModelos()));
      modelo = cola.find((m) => !probados.has(m));
    }
    if (!modelo) break;
    probados.add(modelo);

    for (let intento = 0; intento < 2; intento++) {
      if (Date.now() - inicio > PLAZO_MS) break;
      const r = await llamarGemini(prompt, modelo);
      if (r.ok) {
        const texto = textoDeRespuesta(await r.json());
        if (modelo !== ultimoQueFunciono) console.log("Análisis con " + modelo);
        ultimoQueFunciono = modelo;
        return texto;
      }
      const detalle = "Gemini " + r.status + " (" + modelo + "): " + mensajeGoogle(await r.text());
      ultimoError = { status: r.status, detalle };
      console.warn(detalle);
      if (r.status === 503 || r.status === 500) {
        if (intento === 0) await esperar(1200);
        continue; // reintenta el mismo modelo una vez y después pasa al siguiente
      }
      if (r.status === 429 || r.status === 404) break; // siguiente modelo
      throw new ErrorMotor("api", detalle); // clave inválida u otro error que no se arregla reintentando
    }
    if (Date.now() - inicio > PLAZO_MS) break;
  }

  if (ultimoError && ultimoError.status === 429) throw new ErrorMotor("limite", ultimoError.detalle);
  throw new ErrorMotor("saturado", ultimoError ? ultimoError.detalle : "Sin modelos disponibles.");
}

// ── Groq (respaldo gratuito) ─────────────────────────────────────────────────
const GROQ_BASE = "https://api.groq.com/openai/v1/";
const GROQ_PREFERIDOS = ["llama-3.3-70b-versatile", "openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.1-8b-instant"];
let groqModelos = null;

function claveGroq() {
  return String(process.env.GROQ_API_KEY || "").trim().replace(/^["']|["']$/g, "");
}

// Usa GROQ_MODEL si está cargado; si no, los preferidos que sigan existiendo, y después cualquier modelo de texto.
async function modelosGroq() {
  if (groqModelos) return groqModelos;
  const elegido = (process.env.GROQ_MODEL || "").trim();
  let disponibles = [];
  try {
    const r = await fetch(GROQ_BASE + "models", { headers: { Authorization: "Bearer " + claveGroq() } });
    if (r.ok) disponibles = ((await r.json()).data || []).map((m) => m.id).filter((id) => !/whisper|tts|guard|vision|playai|compound/.test(id));
  } catch (e) { /* sigue con la lista fija */ }
  const lista = [elegido, ...GROQ_PREFERIDOS.filter((m) => !disponibles.length || disponibles.includes(m)), ...disponibles];
  groqModelos = [...new Set(lista.filter(Boolean))].slice(0, 4);
  return groqModelos;
}

async function analizarConGroq(prompt) {
  let ultimo = null;
  for (const modelo of await modelosGroq()) {
    const r = await fetch(GROQ_BASE + "chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + claveGroq() },
      body: JSON.stringify({
        model: modelo,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.2,
      }),
    });
    if (r.ok) {
      const datos = await r.json();
      console.log("Análisis con Groq " + modelo);
      return ((datos.choices || [])[0] || {}).message?.content || "";
    }
    ultimo = { status: r.status, detalle: "Groq " + r.status + " (" + modelo + "): " + mensajeGoogle(await r.text()) };
    console.warn(ultimo.detalle);
    if (r.status === 401 || r.status === 403) break; // clave inválida: no tiene sentido probar otro modelo
  }
  if (ultimo && ultimo.status === 429) throw new ErrorMotor("limite", ultimo.detalle);
  throw new ErrorMotor(ultimo && ultimo.status >= 500 ? "saturado" : "api", ultimo ? ultimo.detalle : "Groq sin modelos.");
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

function motoresDisponibles() {
  const lista = [];
  if (claveGemini()) lista.push(analizarConGemini);
  if (claveGroq()) lista.push(analizarConGroq);
  if (process.env.ANTHROPIC_API_KEY) lista.push(analizarConClaude);
  return lista;
}

// Prueba proveedor por proveedor hasta que uno devuelva un JSON válido.
async function analizarConRespaldo(motores, prompt) {
  let ultimoError = null;
  for (const motor of motores) {
    try {
      return Detector.extraerJSON(await motor(prompt));
    } catch (e) {
      ultimoError = e instanceof ErrorMotor ? e : new ErrorMotor("invalid_json", String(e && e.message));
      console.warn("Falló " + motor.name + ": " + ultimoError.detalle);
    }
  }
  throw ultimoError;
}

const ESTADO_HTTP = { limite: 429, rechazado: 422, api: 502, saturado: 503, invalid_json: 502 };

module.exports = async function handler(req, res) {
  const motores = motoresDisponibles();

  // La web usa este GET para saber si hay servidor disponible.
  if (req.method === "GET") {
    return res.status(200).json({ ok: motores.length > 0, proveedores: motores.length, requiereCodigo: Boolean(process.env.CODIGO_ACCESO) });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "metodo_no_permitido" });
  }
  if (!motores.length) return res.status(503).json({ error: "sin_motor" });

  const body = req.body || {};
  if (process.env.CODIGO_ACCESO && body.codigo !== process.env.CODIGO_ACCESO) {
    return res.status(401).json({ error: "codigo_invalido" });
  }
  const texto = String(body.texto || "").trim();
  if (!texto) return res.status(400).json({ error: "texto_vacio" });
  if (texto.length > Detector.MAX_CARACTERES) return res.status(400).json({ error: "texto_largo" });

  const prompt = Detector.construirPrompt({ texto, tipo: body.tipo, perfil: body.perfil, objetivo: body.objetivo });

  try {
    return res.status(200).json(await analizarConRespaldo(motores, prompt));
  } catch (e) {
    if (e instanceof ErrorMotor) {
      if (e.codigo === "api") console.error(e.message);
      // El detalle es el mensaje del proveedor (nunca incluye la clave); ayuda a diagnosticar.
      return res.status(ESTADO_HTTP[e.codigo] || 500).json({ error: e.codigo, detalle: e.detalle });
    }
    console.error(e);
    return res.status(500).json({ error: "interno" });
  }
};
