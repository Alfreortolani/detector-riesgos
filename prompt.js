/*
 * Detector de riesgos comunicacionales — matriz de evaluación y prompt de análisis heurístico.
 *
 * Este archivo es la única fuente de la matriz y del prompt. Lo usan:
 *   - la web (index.html), cargado con <script src="prompt.js">
 *   - el servidor (api/analizar.js), cargado con require("../prompt.js")
 * Si cambian un criterio, cámbienlo acá y se actualiza en los dos lados.
 */
(function (root) {
  "use strict";

  const VERSION_MATRIZ = "1.1 · beta";

  // ── Matriz de evaluación ────────────────────────────────────────────────
  // Cada criterio tiene un código (V1, I3, P2…) para que cada hallazgo
  // indique qué regla de la matriz lo justifica.
  const CATEGORIAS = [
    {
      id: "veracidad",
      nombre: "Veracidad",
      pregunta: "¿Lo que afirma el texto es cierto, verificable y no induce a error?",
      criterios: [
        { codigo: "V1", nombre: "Afirmación sin respaldo", detalle: "Cifras, estadísticas, estudios o datos presentados como hechos sin fuente; también afirmaciones que desacreditan a especialistas sin pruebas." },
        { codigo: "V2", nombre: "Absolutos y superlativos", detalle: "«El mejor», «el único», «100 %», «garantizado», «nunca», «todos», sin forma de comprobarlo." },
        { codigo: "V3", nombre: "Promesa de resultado", detalle: "Beneficios de salud, dinero, rendimiento o plazos que no se pueden asegurar; experiencias personales presentadas como resultado esperable." },
        { codigo: "V4", nombre: "Omisión o presión", detalle: "Información incompleta que cambia el sentido (condiciones, precios, requisitos), urgencias que no se pueden comprobar, o contenido patrocinado sin identificar." },
      ],
      niveles: {
        verde: "Las afirmaciones son verificables, están atribuidas a una fuente o son opiniones presentadas como tales.",
        amarillo: "Hay superlativos o afirmaciones generales sin respaldo que pueden generar desconfianza, sin un daño probable.",
        rojo: "Hay afirmaciones que pueden inducir a error con consecuencias (salud, dinero, seguridad, derechos) o promesas que no se pueden garantizar.",
      },
    },
    {
      id: "inclusion",
      nombre: "Inclusión",
      pregunta: "¿El texto se dirige a todo su público sin discriminar, excluir ni estereotipar, aunque sea sin querer?",
      criterios: [
        { codigo: "I1", nombre: "Estereotipo", detalle: "Atribuye roles, características o capacidades a un grupo por género, edad, origen, color de piel, discapacidad, clase, orientación sexual, religión o apariencia." },
        { codigo: "I2", nombre: "Lenguaje excluyente o hiriente", detalle: "Expresiones racistas, xenófobas, machistas, homofóbicas o capacitistas; también las que descalifican, culpabilizan o se burlan de parte del público, incluido el humor a costa de un grupo o del cuerpo de las personas." },
        { codigo: "I3", nombre: "Destinatario implícito", detalle: "Da por hecho un único tipo de persona o de familia cuando el público es más amplio; masculino genérico cuando hay una alternativa sencilla." },
        { codigo: "I4", nombre: "Accesibilidad", detalle: "Jerga o siglas sin explicar, frases muy largas, información clave solo en emojis, hashtags sin mayúsculas internas (los lectores de pantalla no separan las palabras)." },
        { codigo: "I5", nombre: "Discriminación sin darse cuenta", detalle: "Expresiones de uso cotidiano con origen racista, xenófobo, antisemita, capacitista o gordofóbico que se dicen sin intención, como «trabajar como negro», «trabajo en negro», «hacerse el indio», «judiada» o «es medio autista» usado como insulto." },
      ],
      niveles: {
        verde: "Se dirige al público de forma respetuosa y comprensible.",
        amarillo: "Hay expresiones que pueden excluir a alguien o dificultar la comprensión, sin intención ofensiva evidente.",
        rojo: "Hay estereotipos fuertes, burlas o términos discriminatorios (aunque se usen sin intención) que pueden ofender a un grupo o generar una crisis.",
      },
    },
    {
      id: "privacidad",
      nombre: "Privacidad",
      pregunta: "¿El texto expone datos de personas o información que no debería ser pública?",
      criterios: [
        { codigo: "P1", nombre: "Dato identificatorio de terceros", detalle: "Nombre completo junto con cédula, teléfono, correo, dirección, foto o lugar de estudio o trabajo." },
        { codigo: "P2", nombre: "Dato sensible", detalle: "Salud, origen racial o étnico, opiniones políticas, convicciones religiosas, afiliación sindical o vida sexual (datos sensibles según la Ley 18.331 de Uruguay)." },
        { codigo: "P3", nombre: "Menores de edad", detalle: "Niñas, niños o adolescentes identificables por nombre, imagen, centro educativo o ubicación." },
        { codigo: "P4", nombre: "Información interna", detalle: "Datos de clientes, contraseñas, montos o decisiones internas no públicas, o información de otras personas sin consentimiento evidente." },
      ],
      niveles: {
        verde: "No expone datos personales ni información reservada.",
        amarillo: "Menciona personas o datos cuyo consentimiento conviene confirmar, o expone más información de la necesaria.",
        rojo: "Expone datos sensibles, datos de menores, datos identificatorios de terceros o información confidencial.",
      },
    },
    {
      id: "polemica",
      nombre: "Polémica",
      pregunta: "¿El texto puede generar rechazo público, una ola de críticas o una funa?",
      criterios: [
        { codigo: "R1", nombre: "Tema sensible a la ligera", detalle: "Política, religión, tragedias, violencia, salud mental o causas sociales usadas como chiste o como gancho de venta." },
        { codigo: "R2", nombre: "Oportunismo", detalle: "Aprovechar una tragedia, una fecha conmemorativa (8M, Día de la Diversidad, una catástrofe) o una causa para vender o ganar visibilidad, sin un compromiso real." },
        { codigo: "R3", nombre: "Doble lectura", detalle: "Frases, chistes o ironías que, sacados de contexto o en una captura de pantalla, pueden leerse como ofensivos." },
        { codigo: "R4", nombre: "Ataque o señalamiento", detalle: "Burla, ataque o comparación con personas, grupos, profesiones, competidores o figuras públicas que puede volverse en contra." },
      ],
      niveles: {
        verde: "No toca temas sensibles, o lo hace con cuidado y respeto.",
        amarillo: "Puede generar críticas o comentarios negativos de una parte del público.",
        rojo: "Es probable que genere rechazo masivo, una funa o una crisis (por ejemplo, burla de una tragedia, oportunismo evidente o contenido discriminatorio en un canal público).",
      },
    },
  ];

  // ── Contexto que elige la persona usuaria ───────────────────────────────
  const TIPOS = {
    post: {
      nombre: "Publicación en redes",
      contexto: "Publicación en redes sociales: texto breve, tono cercano, puede incluir emojis y hashtags. El público es amplio y desconocido, el contenido se comparte y se captura en pantalla, y un error se viraliza rápido.",
    },
    mail: {
      nombre: "Mail",
      contexto: "Correo electrónico: público definido (clientes, estudiantes, equipo), registro más formal. Se reenvía con facilidad, así que todo lo que contiene puede terminar fuera del grupo original.",
    },
    publicidad: {
      nombre: "Publicidad o web",
      contexto: "Pieza publicitaria o texto de sitio web: busca convencer o vender. En Uruguay la Ley 17.250 de relaciones de consumo prohíbe la publicidad engañosa, así que las promesas, cifras y condiciones tienen que poder sostenerse.",
    },
  };

  const PERFILES = {
    emprendimiento: { nombre: "Emprendimiento", contexto: "Un emprendimiento chico que publica sin equipo de comunicación. Las sugerencias tienen que ser simples de aplicar." },
    creador: { nombre: "Creador/a de contenido", contexto: "Una persona creadora de contenido o influencer. Su capital es la confianza de su comunidad; el contenido pago debe identificarse como tal." },
    institucion: { nombre: "Institución u organización", contexto: "Una institución u organización (educativa, pública, ONG, empresa). Habla en nombre de muchas personas y tiene responsabilidad sobre los datos de quienes atiende." },
    agencia: { nombre: "Agencia o comunicador/a", contexto: "Una agencia o comunicador/a que revisa contenido para un cliente antes de publicarlo." },
  };

  // Se pueden elegir varios. Si no se elige ninguno, se revisa todo por igual.
  const OBJETIVOS = {
    veracidad: { nombre: "Que la información sea cierta", foco: "VERACIDAD" },
    inclusion: { nombre: "Que no discrimine a nadie, ni sin querer", foco: "INCLUSIÓN, con atención especial a expresiones racistas o discriminatorias que se usan sin darse cuenta (I5)" },
    privacidad: { nombre: "Los datos personales", foco: "PRIVACIDAD" },
    polemica: { nombre: "Que no genere polémica ni una funa", foco: "POLÉMICA: imaginá cómo lo leería alguien que busca motivos para criticar o hacer una captura" },
  };

  function textoFoco(objetivo) {
    const lista = (Array.isArray(objetivo) ? objetivo : [objetivo]).filter(function (k) { return OBJETIVOS[k]; });
    if (!lista.length) return "Evaluá las cuatro categorías con la misma profundidad.";
    return "La persona quiere cuidar especialmente: " + lista.map(function (k) { return OBJETIVOS[k].foco; }).join("; ") +
      ". Revisá eso con más detalle; las demás categorías se evalúan igual.";
  }

  const NIVELES = ["verde", "amarillo", "rojo"];
  const MAX_CARACTERES = 6000;

  function matrizComoTexto() {
    return CATEGORIAS.map(function (c) {
      const criterios = c.criterios.map(function (k) { return "  - " + k.codigo + " · " + k.nombre + ": " + k.detalle; }).join("\n");
      return (
        "### " + c.nombre.toUpperCase() + " (id: \"" + c.id + "\")\n" +
        c.pregunta + "\n" +
        "Criterios:\n" + criterios + "\n" +
        "Niveles:\n" +
        "  - verde: " + c.niveles.verde + "\n" +
        "  - amarillo: " + c.niveles.amarillo + "\n" +
        "  - rojo: " + c.niveles.rojo
      );
    }).join("\n\n");
  }

  // ── Prompt de análisis heurístico ───────────────────────────────────────
  function construirPrompt(entrada) {
    const tipo = TIPOS[entrada.tipo] || TIPOS.post;
    const perfil = PERFILES[entrada.perfil] || PERFILES.emprendimiento;
    const texto = String(entrada.texto || "").slice(0, MAX_CARACTERES);

    return [
      "Sos una herramienta de revisión de contenidos que se usa antes de publicar. Funcionás como una segunda lectura para quien comunica: señalás riesgos y proponés cambios, pero no decidís si el texto se publica. Esa decisión es siempre de la persona.",
      "",
      "## Contexto de esta revisión",
      "- Tipo de contenido: " + tipo.contexto,
      "- Quién publica: " + perfil.contexto,
      "- Foco pedido: " + textoFoco(entrada.objetivo),
      "",
      "## Matriz de evaluación",
      "Evaluá el texto en estas cuatro categorías, usando solo estos criterios. Cada hallazgo tiene que citar el código del criterio que aplica.",
      "",
      matrizComoTexto(),
      "",
      "## Cómo evaluar",
      "1. Primero escribí en una oración el mensaje central: qué quiere comunicar el texto, a quién y qué le pide. Ese mensaje es lo que ninguna sugerencia puede cambiar.",
      "2. Para cada categoría, buscá fragmentos que activen algún criterio. Citá el fragmento EXACTAMENTE como aparece en el texto (mismas palabras, tildes, signos y emojis), lo más corto posible pero que se entienda. No inventes problemas: si una categoría no tiene hallazgos, su nivel es verde y la lista de hallazgos queda vacía.",
      "   Inclusión y Polémica se superponen: si un fragmento discrimina, registralo en Inclusión. En Polémica evaluá cuán probable es una reacción pública (críticas, capturas, funa) y repetí un fragmento solo si agrega un riesgo distinto.",
      "   Las expresiones del criterio I5 casi siempre se usan sin mala intención: explicá de dónde viene la expresión y a quién puede herir, sin acusar a quien escribió.",
      "3. Asigná el nivel de cada categoría según la descripción de niveles de la matriz. Ante la duda entre dos niveles, elegí el más bajo y explicá la duda en el resumen. Reservá el rojo para riesgos con consecuencias concretas.",
      "4. Proponé entre 2 y 4 sugerencias de reformulación, empezando por los hallazgos de nivel rojo y después los amarillos. Cada sugerencia reemplaza SOLO el fragmento problemático y tiene que conservar:",
      "   - la intención y el mensaje central,",
      "   - los datos verdaderos, la oferta y el llamado a la acción,",
      "   - el tono, la voz (vos, tú, usted, ustedes) y el registro del original,",
      "   - una extensión parecida al fragmento original.",
      "   Si el riesgo es la afirmación misma (por ejemplo, una promesa de salud falsa), reemplazala por lo que sí se puede sostener y explicá en «que_se_conserva» qué parte del objetivo se mantiene.",
      "   Si el texto no tiene riesgos, proponé igual 2 mejoras preventivas y marcalas como \"mejora_opcional\".",
      "5. Escribí en español rioplatense, claro y sin tecnicismos.",
      "",
      "## Formato de respuesta",
      "Respondé solo con un objeto JSON, sin texto antes ni después, con esta forma:",
      "{",
      "  \"mensaje_central\": \"una oración\",",
      "  \"categorias\": [",
      "    {",
      "      \"id\": \"veracidad\" | \"inclusion\" | \"privacidad\" | \"polemica\",",
      "      \"nivel\": \"verde\" | \"amarillo\" | \"rojo\",",
      "      \"resumen\": \"una oración que explique el nivel\",",
      "      \"hallazgos\": [ { \"fragmento\": \"cita exacta del texto\", \"criterio\": \"V1\", \"problema\": \"por qué es un riesgo, en una o dos oraciones\" } ]",
      "    }",
      "  ],",
      "  \"sugerencias\": [",
      "    {",
      "      \"categoria\": \"veracidad\" | \"inclusion\" | \"privacidad\" | \"polemica\",",
      "      \"tipo\": \"corrige_riesgo\" | \"mejora_opcional\",",
      "      \"fragmento_original\": \"cita exacta del texto\",",
      "      \"reformulacion\": \"texto que reemplaza al fragmento\",",
      "      \"por_que\": \"qué riesgo resuelve\",",
      "      \"que_se_conserva\": \"qué parte del mensaje original se mantiene\"",
      "    }",
      "  ]",
      "}",
      "Incluí siempre las cuatro categorías, en ese orden. Máximo 5 hallazgos por categoría.",
      "",
      "## Texto a revisar",
      "<texto>",
      texto,
      "</texto>",
    ].join("\n");
  }

  // ── Utilidades compartidas ──────────────────────────────────────────────

  // Lee el JSON aunque venga dentro de un bloque de código o con una frase alrededor.
  function extraerJSON(respuesta) {
    if (respuesta && typeof respuesta === "object") return respuesta;
    const s = String(respuesta || "").trim();
    try { return JSON.parse(s); } catch (e) { /* sigue */ }
    const bloque = s.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (bloque) { try { return JSON.parse(bloque[1]); } catch (e) { /* sigue */ } }
    const ini = s.indexOf("{");
    const fin = s.lastIndexOf("}");
    if (ini !== -1 && fin > ini) return JSON.parse(s.slice(ini, fin + 1));
    throw new Error("La respuesta no tiene un JSON válido.");
  }

  // Ordena y valida el resultado del modelo para que la web siempre reciba la misma forma.
  function normalizar(bruto) {
    const r = bruto || {};
    const porId = {};
    (Array.isArray(r.categorias) ? r.categorias : []).forEach(function (c) {
      if (c && typeof c.id === "string") porId[c.id.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")] = c;
    });
    const categorias = CATEGORIAS.map(function (def) {
      const c = porId[def.id] || {};
      const nivel = NIVELES.indexOf(c.nivel) !== -1 ? c.nivel : "amarillo";
      const hallazgos = (Array.isArray(c.hallazgos) ? c.hallazgos : [])
        .filter(function (h) { return h && h.fragmento; })
        .slice(0, 5)
        .map(function (h) { return { fragmento: String(h.fragmento), criterio: String(h.criterio || ""), problema: String(h.problema || "") }; });
      return { id: def.id, nombre: def.nombre, nivel: nivel, resumen: String(c.resumen || ""), hallazgos: hallazgos, sinDato: !porId[def.id] };
    });
    const sugerencias = (Array.isArray(r.sugerencias) ? r.sugerencias : [])
      .filter(function (s) { return s && s.reformulacion; })
      .slice(0, 4)
      .map(function (s) {
        return {
          categoria: String(s.categoria || ""),
          tipo: s.tipo === "mejora_opcional" ? "mejora_opcional" : "corrige_riesgo",
          fragmento_original: String(s.fragmento_original || ""),
          reformulacion: String(s.reformulacion),
          por_que: String(s.por_que || ""),
          que_se_conserva: String(s.que_se_conserva || ""),
        };
      });
    return {
      mensaje_central: String(r.mensaje_central || ""),
      categorias: categorias,
      global: semaforoGlobal(categorias),
      sugerencias: sugerencias,
      version_matriz: VERSION_MATRIZ,
    };
  }

  // Regla fija (no la decide el modelo): manda la categoría más grave.
  function semaforoGlobal(categorias) {
    let max = 0;
    categorias.forEach(function (c) { max = Math.max(max, NIVELES.indexOf(c.nivel)); });
    return NIVELES[max];
  }

  const Detector = {
    VERSION_MATRIZ: VERSION_MATRIZ,
    CATEGORIAS: CATEGORIAS,
    TIPOS: TIPOS,
    PERFILES: PERFILES,
    OBJETIVOS: OBJETIVOS,
    NIVELES: NIVELES,
    MAX_CARACTERES: MAX_CARACTERES,
    construirPrompt: construirPrompt,
    extraerJSON: extraerJSON,
    normalizar: normalizar,
    semaforoGlobal: semaforoGlobal,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = Detector;
  root.Detector = Detector;
})(typeof window !== "undefined" ? window : globalThis);
