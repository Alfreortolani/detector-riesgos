// Función serverless (Vercel). Hace dos cosas:
//   1. accion "analizar" (por defecto): recibe el texto y el contexto, arma el prompt
//      con la matriz de prompt.js y le pide el análisis a un modelo de lenguaje.
//   2. accion "extraer": recibe un link o una imagen (captura de un post) y devuelve
//      la descripción y el texto que aparece dentro de la imagen, para analizarlo después.
//
// Motor según la variable de entorno que esté cargada en Vercel:
//   GEMINI_API_KEY     → Gemini de Google (plan gratuito, sin tarjeta)
//   ANTHROPIC_API_KEY  → Claude de Anthropic (pago)
// La clave vive en Vercel, nunca en la web.
const Detector = require("../prompt.js");

const GEMINI_MODELO = process.env.GEMINI_MODEL || "gemini-flash-latest";
const TIPOS_IMAGEN = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_IMAGEN_BYTES = 6 * 1024 * 1024;

class ErrorMotor extends Error {
  constructor(codigo, detalle) {
    super(detalle || codigo);
    this.codigo = codigo;
  }
}

// ── Motores ────────────────────────────────────────────────────────────────
// "partes" es una lista de { texto } o { imagen: { mime, datos (base64) } }.

async function preguntarAGemini(partes) {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(GEMINI_MODELO) + ":generateContent";
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: partes.map((p) => (p.imagen ? { inline_data: { mime_type: p.imagen.mime, data: p.imagen.datos } } : { text: p.texto })),
      }],
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

async function preguntarAClaude(partes) {
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
      messages: [{
        role: "user",
        content: partes.map((p) => (p.imagen
          ? { type: "image", source: { type: "base64", media_type: p.imagen.mime, data: p.imagen.datos } }
          : { type: "text", text: p.texto })),
      }],
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
  if (process.env.GEMINI_API_KEY) return preguntarAGemini;
  if (process.env.ANTHROPIC_API_KEY) return preguntarAClaude;
  return null;
}

// ── Lectura de links ───────────────────────────────────────────────────────

// Solo links públicos http(s); no deja que el servidor abra direcciones internas.
function urlPermitida(texto) {
  let u;
  try { u = new URL(String(texto || "").trim()); } catch (e) { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || !h.includes(".") && !h.includes(":")) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return null;
  if (h.includes(":") && (h === "::1" || /^(fc|fd|fe80)/.test(h))) return null;
  return u;
}

async function descargar(url, maxBytes) {
  const ctl = new AbortController();
  const reloj = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, {
      redirect: "follow",
      signal: ctl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; DetectorRiesgosBeta/0.2; proyecto académico UCU)",
        "Accept": "text/html,application/xhtml+xml,image/*;q=0.9,*/*;q=0.8",
        "Accept-Language": "es-UY,es;q=0.9,en;q=0.5",
      },
    });
    if (!r.ok) throw new ErrorMotor("link_inaccesible", "HTTP " + r.status + " en " + url);
    const largo = Number(r.headers.get("content-length") || 0);
    if (largo > maxBytes) throw new ErrorMotor("imagen_grande");
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new ErrorMotor("imagen_grande");
    return { tipo: (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase(), buf, urlFinal: r.url || url };
  } catch (e) {
    if (e instanceof ErrorMotor) throw e;
    throw new ErrorMotor("link_inaccesible", String(e && e.message));
  } finally {
    clearTimeout(reloj);
  }
}

function decodificarEntidades(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

// Lee las etiquetas <meta property="og:..."> que usan las redes para las vistas previas.
function leerMetas(html) {
  const metas = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const clave = (tag.match(/\b(?:property|name)\s*=\s*["']([^"']+)["']/i) || [])[1];
    const valor = (tag.match(/\bcontent\s*=\s*"([^"]*)"/i) || tag.match(/\bcontent\s*=\s*'([^']*)'/i) || [])[1];
    if (clave && valor != null && !(clave.toLowerCase() in metas)) metas[clave.toLowerCase()] = decodificarEntidades(valor).trim();
  }
  const titulo = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titulo) metas._title = decodificarEntidades(titulo[1]).trim();
  return metas;
}

// Instagram arma la descripción así: «120 likes, 4 comments - cuenta on May 3, 2026: "texto del post"».
// Nos quedamos solo con el texto del post.
function limpiarDescripcion(desc) {
  const s = String(desc || "").trim();
  const m = s.match(/^[\d.,\skKmM]+(?:likes?|me gusta)[\s\S]*?:\s*["“«]([\s\S]*)["”»]\.?\s*$/i);
  return (m ? m[1] : s).trim();
}

async function extraerDeLink(textoUrl) {
  const url = urlPermitida(textoUrl);
  if (!url) throw new ErrorMotor("link_invalido");
  const pagina = await descargar(url.href, MAX_IMAGEN_BYTES);

  // Link directo a una imagen.
  if (pagina.tipo.startsWith("image/")) {
    return { descripcion: "", imagen: { mime: pagina.tipo, buf: pagina.buf }, fuente: pagina.urlFinal };
  }
  if (!/html|xml/.test(pagina.tipo)) throw new ErrorMotor("link_inaccesible", "Tipo no soportado: " + pagina.tipo);

  const metas = leerMetas(pagina.buf.toString("utf8"));
  const descripcion = limpiarDescripcion(metas["og:description"] || metas["twitter:description"] || metas.description || "");
  const urlImagen = metas["og:image"] || metas["og:image:url"] || metas["twitter:image"] || "";

  let imagen = null;
  const urlImg = urlImagen ? urlPermitida(new URL(urlImagen, pagina.urlFinal).href) : null;
  if (urlImg) {
    try {
      const img = await descargar(urlImg.href, MAX_IMAGEN_BYTES);
      if (TIPOS_IMAGEN.includes(img.tipo)) imagen = { mime: img.tipo, buf: img.buf };
    } catch (e) { /* sin imagen: seguimos con la descripción */ }
  }
  // Instagram y otras redes, cuando piden iniciar sesión, devuelven una página genérica.
  const pantallaDeLogin = /^(instagram|login|iniciar sesión|log in)/i.test(descripcion) && !imagen;
  if ((!descripcion && !imagen) || pantallaDeLogin) throw new ErrorMotor("link_inaccesible", "Sin vista previa en " + url.href);
  return { descripcion, imagen, fuente: pagina.urlFinal };
}

// ── Lectura de imágenes (OCR con el mismo modelo) ──────────────────────────

const PROMPT_TRANSCRIBIR = [
  "Vas a transcribir el texto de una imagen para que después se revise antes de publicarla.",
  "La imagen puede ser una captura de una publicación de redes sociales (Instagram, Facebook, X, TikTok, LinkedIn), un flyer, un aviso o una foto con texto.",
  "1. Copiá EXACTAMENTE el texto visible, con las mismas palabras, tildes, signos, emojis, hashtags y saltos de línea. No corrijas, no resumas, no traduzcas.",
  "2. Si es una captura de una publicación, separá:",
  "   - \"descripcion\": el texto que escribió la cuenta junto a la foto (el caption o pie del post), sin el nombre de usuario del principio.",
  "   - \"texto_en_imagen\": el texto que aparece dentro de la foto o del diseño.",
  "   Si no es una publicación, todo va en \"texto_en_imagen\" y \"descripcion\" queda vacío.",
  "3. Ignorá la interfaz de la app: me gusta, cantidad de comentarios, botones, hora, barra del celular, comentarios de otras personas.",
  "4. Si no hay texto legible, dejá los dos campos vacíos. No inventes texto.",
  "Respondé solo con este JSON, sin nada antes ni después:",
  "{ \"descripcion\": \"\", \"texto_en_imagen\": \"\" }",
].join("\n");

async function transcribirImagen(preguntar, imagen, contextoDescripcion) {
  const partes = [{ imagen: { mime: imagen.mime, datos: imagen.buf.toString("base64") } }, { texto: PROMPT_TRANSCRIBIR }];
  if (contextoDescripcion) {
    partes.push({ texto: "Ya tenemos la descripción del post por otro lado; no la repitas. Transcribí solo el texto que aparece dentro de la imagen en \"texto_en_imagen\"." });
  }
  const salida = Detector.extraerJSON(await preguntar(partes));
  return {
    descripcion: String(salida.descripcion || "").trim(),
    texto_en_imagen: String(salida.texto_en_imagen || "").trim(),
  };
}

async function extraer(preguntar, body) {
  let descripcion = "", imagen = null, fuente = "";
  if (body.url) {
    const leido = await extraerDeLink(body.url);
    descripcion = leido.descripcion;
    imagen = leido.imagen;
    fuente = leido.fuente;
  } else if (body.imagen && body.imagen.datos) {
    const mime = String(body.imagen.mime || "").toLowerCase();
    if (!TIPOS_IMAGEN.includes(mime)) throw new ErrorMotor("imagen_invalida");
    const buf = Buffer.from(String(body.imagen.datos), "base64");
    if (!buf.length) throw new ErrorMotor("imagen_invalida");
    if (buf.length > MAX_IMAGEN_BYTES) throw new ErrorMotor("imagen_grande");
    imagen = { mime, buf };
    fuente = "captura";
  } else {
    throw new ErrorMotor("link_invalido");
  }

  let textoEnImagen = "";
  if (imagen) {
    const t = await transcribirImagen(preguntar, imagen, Boolean(descripcion));
    textoEnImagen = t.texto_en_imagen;
    if (!descripcion) descripcion = t.descripcion;
  }
  if (!descripcion && !textoEnImagen) throw new ErrorMotor("sin_texto");

  // Vista previa chica para mostrar en la web (solo si la imagen no es pesada).
  const vistaPrevia = imagen && imagen.buf.length < 1.5 * 1024 * 1024
    ? "data:" + imagen.mime + ";base64," + imagen.buf.toString("base64")
    : null;
  return { descripcion, texto_en_imagen: textoEnImagen, fuente, vista_previa: body.url ? vistaPrevia : null };
}

// ── Handler ────────────────────────────────────────────────────────────────

const ESTADO_HTTP = {
  limite: 429, rechazado: 422, api: 502,
  link_invalido: 400, link_inaccesible: 422, sin_texto: 422, imagen_invalida: 400, imagen_grande: 413,
};

module.exports = async function handler(req, res) {
  const preguntar = motorDisponible();

  // La web usa este GET para saber si hay servidor disponible.
  if (req.method === "GET") {
    return res.status(200).json({ ok: Boolean(preguntar), requiereCodigo: Boolean(process.env.CODIGO_ACCESO), extraer: true });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "metodo_no_permitido" });
  }
  if (!preguntar) return res.status(503).json({ error: "sin_motor" });

  const body = req.body || {};
  if (process.env.CODIGO_ACCESO && body.codigo !== process.env.CODIGO_ACCESO) {
    return res.status(401).json({ error: "codigo_invalido" });
  }

  try {
    if (body.accion === "extraer") {
      return res.status(200).json(await extraer(preguntar, body));
    }

    const texto = String(body.texto || "").trim();
    if (!texto) return res.status(400).json({ error: "texto_vacio" });
    if (texto.length > Detector.MAX_CARACTERES) return res.status(400).json({ error: "texto_largo" });

    const prompt = Detector.construirPrompt({ texto, tipo: body.tipo, perfil: body.perfil, objetivo: body.objetivo });
    const salida = await preguntar([{ texto: prompt }]);
    return res.status(200).json(Detector.extraerJSON(salida));
  } catch (e) {
    if (e instanceof ErrorMotor) {
      if (e.codigo === "api" || e.codigo === "link_inaccesible") console.error(e.message);
      return res.status(ESTADO_HTTP[e.codigo] || 500).json({ error: e.codigo });
    }
    console.error(e);
    return res.status(500).json({ error: "interno" });
  }
};

// Para pruebas locales.
module.exports._interno = { leerMetas, limpiarDescripcion, urlPermitida };
