# Web beta: cómo funciona y cómo publicarla

## Archivos
| Archivo | Qué es |
|---|---|
| `index.html` | La web. Abierta sin servidor, muestra los textos de prueba con su resultado de referencia ("Modo ejemplos"). |
| `app.html` | La misma web sin la cabecera HTML; es la versión que se publica en claude.ai. Si editan la web, editen este archivo y regeneren `index.html` (ver abajo). |
| `prompt.js` | La matriz de evaluación y el prompt. Es la única fuente: la usan la web y el servidor. |
| `api/analizar.js` | El servidor: recibe el texto, arma el prompt y le pide el análisis a Gemini (gratis) o a Claude. La clave queda en Vercel y nunca llega al navegador. |
| `package.json`, `vercel.json` | Configuración para Vercel. |

## La web elige sola cómo analizar
1. **Dentro de claude.ai** (el link del artifact): usa la cuenta de Claude de quien la abre. La primera vez pide permiso.
2. **Publicada en Vercel**: usa el servidor `api/analizar` con la clave gratuita de Gemini del equipo.
3. **Abierta como archivo**: solo muestra los ejemplos.

## Publicar gratis (unos 20 minutos, sin tarjeta)

**1. Clave gratuita de Gemini**
- Entrar a **aistudio.google.com** con una cuenta de Google.
- Ir a **Get API key** → **Create API key**.
- Copiar la clave y guardarla. No compartirla ni ponerla en ningún archivo.

**2. Subir la carpeta a GitHub**
- Crear una cuenta en **github.com**.
- **+** → **New repository** → nombre `detector-riesgos` → **Create repository**.
- Tocar **uploading an existing file**.
- Arrastrar todo lo que hay dentro de `beta-web`, incluida la carpeta `api`.
- Tocar **Commit changes**.

**3. Publicar en Vercel**
- En **vercel.com** → **Sign up** → **Continue with GitHub** (plan Hobby, gratis).
- **Add New** → **Project** → elegir `detector-riesgos` → **Import**.
- Antes de **Deploy**, abrir **Environment Variables** y agregar:
  - `GEMINI_API_KEY`: la clave del paso 1.
  - `CODIGO_ACCESO`: una palabra para pasarles a los docentes, por ejemplo `lab2026`. Evita que cualquiera con el link use el cupo gratuito.
- Tocar **Deploy**. Al minuto, Vercel da un link `….vercel.app`.

**4. Probar**
- Abrir el link desde el celular. Arriba del formulario tiene que decir **"Análisis en vivo con IA"**.
- Analizar un texto de prueba con el código de acceso.

**Límites del plan gratuito de Gemini**
- Tiene un tope de pedidos por minuto y por día. Para una entrega y unas pruebas sobra.
- En el plan gratuito, Google puede usar los textos para mejorar sus productos. Por eso, en las pruebas usen textos anonimizados, sin datos reales de personas.

**Si después quieren usar Claude (pago)**
- Cargar `ANTHROPIC_API_KEY` en lugar de `GEMINI_API_KEY`. El servidor usa el motor que tenga la clave cargada.
- Si quieren otro modelo de Gemini, se elige con la variable `GEMINI_MODEL`.

## Si editan `app.html`
Para regenerar `index.html`, desde esta carpeta:

```bash
{ printf '<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n</head>\n<body>\n'; cat app.html; printf '\n</body>\n</html>\n'; } > index.html
```

## Modelo y costo
- **Por defecto: Gemini** (`gemini-flash-latest`), con el plan gratuito de Google. Costo: cero.
- **Opcional: Claude** (`claude-opus-5-5`), si se carga `ANTHROPIC_API_KEY`. Cada análisis cuesta unos centavos de dólar.
