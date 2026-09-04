require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");

const mercadopago = require("./src/mercadopago");
const stripeModule = require("./src/stripe");
const docusignModule = require("./src/docusign");
const db = require("./src/db"); // reemplazar por tu base de datos real
const auth = require("./src/auth");
const adminAuth = require("./src/adminAuth");
const mailer = require("./src/email");  // "mailer" y no "email": en POST /api/members hay una variable local `email` que taparía al módulo
const crypto = require("crypto");
const storage = require("./src/storage");
const fx = require("./src/fx");

// Fail-fast: si falta alguna credencial crítica, preferimos que el
// servidor ni siquiera arranque, con un mensaje claro en los logs de
// Railway diciendo exactamente cuál falta — en vez de arrancar "bien" y
// recién fallar (con un error críptico) en el primer pedido real que
// necesite esa credencial.
const REQUIRED_ENV_VARS = [
  "DATABASE_URL",
  "FRONTEND_URL",
  "APP_BASE_URL",
  "DOCUSIGN_ACCOUNT_ID",
  "DOCUSIGN_INTEGRATION_KEY",
  "DOCUSIGN_USER_ID",
  "DOCUSIGN_BASE_PATH",
  "DOCUSIGN_TEMPLATE_ID",
  "DOCUSIGN_CONNECT_HMAC_KEY",
  "MP_ACCESS_TOKEN",
  "MP_WEBHOOK_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SESSION_JWT_SECRET",
  "ADMIN_JWT_SECRET",
];
function validateEnv() {
  const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error("❌ Faltan variables de entorno requeridas para arrancar:");
    missing.forEach((key) => console.error(`   - ${key}`));
    process.exit(1);
  }
  // Estas dos son mutuamente excluyentes en cuanto a CÓMO se carga la clave
  // (archivo en local, contenido de la variable en Railway) — no forman
  // parte de REQUIRED_ENV_VARS porque alcanza con que exista una de las dos.
  if (!process.env.DOCUSIGN_PRIVATE_KEY_PATH && !process.env.DOCUSIGN_PRIVATE_KEY_CONTENT) {
    console.error("❌ Falta la clave privada de DocuSign: configurá DOCUSIGN_PRIVATE_KEY_PATH (local) o DOCUSIGN_PRIVATE_KEY_CONTENT (Railway).");
    process.exit(1);
  }
}
validateEnv();

/* ======================================================================
 * MODO_DEMO — rama demo-visual-pablo
 * ======================================================================
 * Enciende la versión de demostración: reactiva las 4 fases del formulario
 * y marca TODO lo que se cree como dato de prueba (is_test = true).
 *
 * En producción esta variable no existe, así que MODO_DEMO es false y el
 * comportamiento es exactamente el de siempre. No hay que acordarse de
 * apagar nada.
 *
 * La guarda de abajo es deliberadamente intransigente: si el modo demo
 * arranca contra credenciales que no son de prueba, el servidor NO levanta.
 * Un circuito de demostración que cobre plata real sería el peor error
 * posible de todo este proyecto, y es un error de una sola línea mal pegada.
 */
const MODO_DEMO = process.env.MODO_DEMO === "true";

function validarCredencialesDeDemo() {
  if (!MODO_DEMO) return;
  const problemas = [];

  const stripe = process.env.STRIPE_SECRET_KEY || "";
  if (!stripe.startsWith("sk_test_")) {
    problemas.push('STRIPE_SECRET_KEY no empieza con "sk_test_" — en modo demo solo se admite la clave de prueba de Stripe.');
  }

  const docusign = process.env.DOCUSIGN_BASE_PATH || "";
  if (!docusign.includes("demo")) {
    problemas.push('DOCUSIGN_BASE_PATH no apunta al entorno demo de DocuSign (tiene que contener "demo").');
  }

  // Mercado Pago no distingue prueba/producción por el prefijo del token de
  // forma confiable (ambos entornos usan APP_USR-), así que no se puede
  // verificar por código. Se exige una confirmación explícita de quien
  // configura: hay que escribirla a mano después de mirar el panel.
  if (process.env.MP_CREDENCIALES !== "test") {
    problemas.push('MP_CREDENCIALES no dice "test" — verificá en el panel de Mercado Pago que el Access Token cargado sea el de "Credenciales de prueba" y recién entonces escribí MP_CREDENCIALES=test.');
  }

  if (problemas.length > 0) {
    console.error("\n❌ MODO_DEMO activo pero las credenciales no son de prueba. El servidor no arranca:");
    problemas.forEach((p) => console.error("   - " + p));
    console.error("\n   Corregí el .env y volvé a intentar. Ver LEEME.txt.\n");
    process.exit(1);
  }

  console.log("\n🧪 MODO_DEMO ACTIVO — circuito de demostración");
  console.log("   · Stripe:   " + stripe.slice(0, 12) + "…  (prueba)");
  console.log("   · DocuSign: " + docusign);
  console.log("   · Mercado Pago: token " + (process.env.MP_ACCESS_TOKEN || "").slice(0, 12) + "…  (declarado como test)");
  console.log("   · Todo lo que se cree queda marcado is_test = true\n");
}
validarCredencialesDeDemo();

const app = express();

// Railway (como cualquier PaaS) termina TLS en su proxy y reenvía al proceso
// por HTTP. Sin esto, req.ip es siempre la IP del proxy — o sea, el rate
// limit de más abajo contaría a TODOS los visitantes como un solo cliente.
// El 1 es la cantidad de proxies de confianza; no se usa `true` porque eso
// haría confiar en cualquier X-Forwarded-For que mande un atacante.
app.set("trust proxy", 1);

// Cabeceras de seguridad HTTP. contentSecurityPolicy va apagado a propósito:
// este proceso sirve únicamente JSON de API, no HTML, así que una CSP acá no
// protege nada (la landing la sirve Surge, que es donde tendría sentido) y
// solo agrega superficie para romper cosas. HSTS sí queda activo.
app.use(helmet({ contentSecurityPolicy: false }));

// Stripe necesita el body CRUDO (sin parsear) para validar la firma del
// webhook, por eso esa ruta usa express.raw() en vez de express.json().
app.use("/api/payments/stripe/webhook", express.raw({ type: "application/json" }));
// El "verify" acá abajo guarda el buffer crudo original en req.rawBody
// ANTES de parsearlo — lo necesita el webhook de DocuSign Connect para
// validar su firma HMAC (ver isValidDocuSignSignature en docusign.js).
// No interfiere con la línea de Stripe de arriba: como esa ruta ya parseó
// el body con express.raw(), cuando el pedido llega hasta acá este
// middleware lo detecta y no vuelve a leerlo.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
// FRONTEND_URL puede ser un solo origen o una lista separada por comas
// (por ejemplo, cuando el dominio final tiene que responder tanto en
// "https://ditellicapital.com" como en "https://www.ditellicapital.com").
// El .replace(/\/+$/, '') saca una barra final si quedó cargada por error
// (con ella, "https://dominio.com/" nunca matchea el Origin real que manda
// el navegador, que nunca trae esa barra).
const ALLOWED_ORIGINS = (process.env.FRONTEND_URL || "")
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Sin header Origin (curl, llamadas servidor-a-servidor, Postman) se
      // permite: no es un pedido de navegador, CORS no aplica.
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origen ${origin} no permitido por CORS.`));
      }
    },
    // Lo necesita el panel de admin (src/adminAuth.js): la cookie de sesión
    // solo viaja en un fetch cross-site si el pedido va con
    // credentials:'include' Y el servidor responde credentials:true. No
    // afecta a las rutas de Miembro (van con Bearer token, no cookies) — y
    // como el origin de arriba sigue siendo una lista blanca explícita
    // (nunca "*"), esto no abre la cookie a cualquier sitio.
    credentials: true,
  })
);

/**
 * ORDEN RECOMENDADO DEL FLUJO (distinto al mockup inicial de la landing):
 *
 *   1) POST /api/members            → guarda la Ficha de Adhesión (Paso 1)
 *   2) POST /api/docusign/envelope  → genera el sobre y la URL de firma (Paso 2)
 *   3) [Miembro firma embebido en la landing]
 *   4) DocuSign Connect llama a /api/docusign/webhook → marca "firmado"
 *   5) POST /api/payments/... /preference → recién ahora se habilita el pago (Paso 3)
 *      (o /api/payments/transfer/notify si eligió transferencia bancaria)
 *   6) MP/Stripe llaman a su webhook → marca "pagado" → Miembro activo
 *      (la transferencia se confirma manualmente contra el resumen bancario)
 *
 * Por qué en este orden: es más prolijo que el Miembro nunca transfiera
 * dinero antes de tener el Acuerdo firmado.
 */

// ---------- Rate limiting ----------
// Sin esto, POST /api/docusign/envelope se puede disparar en bucle: cada
// llamada crea un sobre FACTURABLE en DocuSign, así que un script agota el
// plan y de paso deja a los Miembros reales sin poder firmar. Y
// POST /api/members permite llenar la base sin ningún costo para el atacante.
//
// Los webhooks (MP, Stripe, DocuSign Connect) quedan deliberadamente AFUERA:
// los proveedores reintentan en ráfagas legítimas y ya están autenticados por
// firma HMAC. Limitarlos por IP solo lograría descartar notificaciones de pago
// reales, que es exactamente el problema que no queremos tener.
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Esperá unos minutos y reintentá." },
});

// Más estricto: crear Fichas y generar sobres son las dos operaciones que
// dejan rastro persistente (filas en la base, sobres facturados).
const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiados intentos. Esperá unos minutos y reintentá." },
});

app.use("/api/members", apiLimiter);
app.use("/api/membership-requests", apiLimiter);
app.use("/api/docusign/envelope", apiLimiter);
app.use("/api/payments/mp/preference", apiLimiter);
app.use("/api/payments/stripe/checkout", apiLimiter);
app.use("/api/payments/transfer/notify", apiLimiter);
app.use("/api/payments/transfer/quote", apiLimiter);
app.use("/api/admin/members", apiLimiter);
app.use("/api/admin/export.csv", apiLimiter);

// ---------- Comprobante de transferencia ----------
// En memoria (no a disco): el archivo se sube a Postgres como BYTEA (ver
// db.saveTransferReceipt) apenas llega, no queda nada tirado en el
// filesystem del proceso.
const uploadComprobante = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8 MB — de sobra para una foto de comprobante o un PDF del banco
  fileFilter: (req, file, cb) => {
    const permitidos = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (permitidos.includes(file.mimetype)) return cb(null, true);
    cb(new Error("Formato no soportado. Subí una imagen (JPG/PNG/WEBP) o un PDF."));
  },
}).single("comprobante");

// Envoltorio propio: sin esto, un archivo inválido (muy pesado o de un tipo
// no soportado) termina en el manejador de errores genérico como un 500 —
// es un error del Miembro (400), no del servidor.
function withComprobante(req, res, next) {
  uploadComprobante(req, res, (err) => {
    if (!err) return next();
    const demasiadoGrande = err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE";
    res.status(400).json({
      error: demasiadoGrande ? "El comprobante no puede pesar más de 8 MB." : (err.message || "No se pudo procesar el archivo."),
    });
  });
}

/**
 * Revisión legal pre-lanzamiento (punto B): el sitio no puede seguir
 * ofreciendo firma y pago directos a cualquier visitante. En vez de borrar
 * las rutas de DocuSign/pago (las va a necesitar el portal privado de
 * Miembros aprobados, apenas exista ese estado), quedan detrás de este gate
 * — un simple 403 mientras FLUJO_PUBLICO_HABILITADO no sea exactamente
 * "true". Por defecto (variable ausente) queda CERRADO: no depende de que
 * nadie recuerde setear nada en Railway para estar seguro.
 *
 * A propósito NO toca los webhooks (/api/docusign/webhook,
 * /api/payments/mp/webhook, /api/payments/stripe/webhook): esos siguen
 * activos porque DocuSign/MP/Stripe les pegan igual aunque el alta pública
 * esté cerrada, y son rutas servidor-a-servidor autenticadas por firma, no
 * por navegación de un visitante.
 */
function requireFlujoPublicoHabilitado(req, res, next) {
  if (process.env.FLUJO_PUBLICO_HABILITADO === "true") return next();
  return res.status(403).json({
    error: "Este paso está temporalmente deshabilitado. Te contactaremos cuando tu solicitud sea aprobada.",
  });
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/;

// Capital objetivo de la ronda (SELON II). Es el denominador de la
// Participación Proporcional que se imprime en el Acuerdo y el mismo valor
// que usa el simulador de la landing — si cambia, tiene que cambiar en los
// dos lados a la vez.
const APP_BASE_URL = (process.env.APP_BASE_URL || "").replace(/\/+$/, "");
const CAPITAL_OBJETIVO_USD = Number(process.env.CAPITAL_OBJETIVO_USD || 500000);
// Mismo criterio que CAPITAL_OBJETIVO_USD: antes el mínimo de USD 1.000
// estaba escrito a mano acá Y en el simulador de la landing. Ahora ambos
// valores viven en /api/config (ver más abajo) y el backend es la única
// fuente de verdad.
const APORTE_MINIMO_USD = Number(process.env.APORTE_MINIMO_USD || 1000);

// ---------- Enlaces de acceso de un solo uso (magic link) ----------
const MAGIC_LINK_TTL_MIN = 30;

const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");

/**
 * Emite un enlace de un solo uso y se lo manda por correo al Miembro.
 *
 * El token viaja en el correo; en la base solo queda su hash. Antes de emitir
 * uno nuevo se invalidan los anteriores sin usar, así "pedí el link tres veces"
 * no deja tres puertas abiertas: vale el último.
 *
 * Devuelve true/false solo para el log. Quien la llama NUNCA debe cambiar su
 * respuesta HTTP según ese resultado: eso le confirmaría a un desconocido si
 * un email+DNI existe o no en la base.
 */
async function enviarMagicLink(member) {
  try {
    const token = crypto.randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);
    await db.invalidateMagicLinks(member.id);
    await db.createMagicLink(member.id, hashToken(token), expiresAt);

    const url = `${APP_BASE_URL}/api/session/${token}`;
    return await mailer.sendMagicLink({ to: member.email, name: member.name, url });
  } catch (err) {
    console.error(`❌ No se pudo emitir el enlace de acceso para ${member.id}:`, err.message);
    return false;
  }
}

// ---------- Recuperar el acceso ----------
/**
 * Pide un enlace para retomar una solicitud. Público y con límite estricto.
 *
 * Responde SIEMPRE lo mismo, exista o no el Miembro. Es la diferencia entre
 * una recuperación de acceso y un buscador de clientes: si contestara distinto
 * cuando encuentra a alguien, cualquiera podría probar emails hasta descubrir
 * quién invirtió en Ditelli.
 */
app.post("/api/session/recover", strictLimiter, async (req, res) => {
  try {
    const emailRaw = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";
    const docId = typeof req.body.docId === "string" ? req.body.docId.trim() : "";
    if (EMAIL_REGEX.test(emailRaw) && docId) {
      const member = await db.findActiveOrPendingMember(emailRaw, docId);
      if (member) await enviarMagicLink(member);
      else console.log(`ℹ️  Pedido de recuperación sin coincidencia (${emailRaw}).`);
    }
  } catch (err) {
    // Ni siquiera un error interno debe cambiar la respuesta.
    console.error("Error procesando la recuperación de acceso:", err);
  }
  res.status(202).json({
    ok: true,
    message: "Si los datos coinciden con una solicitud, te mandamos un correo con el enlace para retomarla.",
  });
});

/**
 * Canjea el enlace del correo por una sesión y devuelve al Miembro a la
 * landing, ya identificado.
 *
 * El token se consume acá (un solo uso) y lo que viaja a la landing es el JWT
 * de sesión normal. Sí, queda un instante en la URL; la landing lo guarda y
 * limpia la barra de direcciones enseguida (ver checkSesionRecuperada). El
 * enlace del correo —que es lo que puede quedar en un historial o ser
 * reenviado a otra persona— ya no sirve para nada después del primer uso.
 */
app.get("/api/session/:token", async (req, res) => {
  const destinoBase = ALLOWED_ORIGINS[0] || process.env.FRONTEND_URL || "";
  try {
    const memberId = await db.consumeMagicLink(hashToken(req.params.token || ""));
    if (!memberId) {
      console.warn("⚠️  Enlace de acceso inválido, vencido o ya usado.");
      return res.redirect(302, `${destinoBase}/?sesion=invalida`);
    }
    const member = await db.getMember(memberId);
    if (!member) return res.redirect(302, `${destinoBase}/?sesion=invalida`);

    const sessionToken = auth.issueMemberToken(member.id);
    console.log(`🔑 Sesión recuperada por enlace para el Miembro ${member.id}.`);
    return res.redirect(
      302,
      `${destinoBase}/?sesion=${encodeURIComponent(sessionToken)}&memberId=${encodeURIComponent(member.id)}`
    );
  } catch (err) {
    console.error("Error canjeando el enlace de acceso:", err);
    return res.redirect(302, `${destinoBase}/?sesion=invalida`);
  }
});

/**
 * Reenvía el Acuerdo firmado por correo. Requiere sesión.
 *
 * Se vuelve a descargar de DocuSign en el momento, en vez de leerlo de un
 * storage propio. Eso permite ofrecer "mandame otra copia" hoy mismo, sin
 * esperar a montar el storage — aunque el storage sigue haciendo falta para
 * no depender de DocuSign a largo plazo.
 */
app.post("/api/members/:id/acuerdo/reenviar", apiLimiter, auth.requireMemberSession((req) => req.params.id), async (req, res) => {
  try {
    const member = await db.getMember(req.params.id);
    if (!member) return res.status(404).json({ error: "Miembro no encontrado." });
    if (!member.envelopeId) {
      return res.status(400).json({ error: "Todavía no hay un Acuerdo firmado para reenviar." });
    }
    const pdfBytes = await docusignModule.downloadSignedDocument(member.envelopeId);
    const enviado = await mailer.sendAcuerdoFirmado({
      to: member.email,
      name: member.name,
      pdfBytes,
      amountUsd: member.amountUsd,
      proportionalPct: member.proportionalPct,
    });
    if (!enviado) {
      return res.status(502).json({ error: "No pudimos enviar el correo en este momento. Reintentá en unos minutos." });
    }
    res.json({ ok: true, message: `Te reenviamos el Acuerdo a ${member.email}.` });
  } catch (err) {
    console.error("Error reenviando el Acuerdo:", err);
    res.status(500).json({ error: "No se pudo reenviar el Acuerdo." });
  }
});

// ---------- Configuración pública ----------
// Auditoría: el simulador de la landing (index.html) tenía CAPITAL_OBJETIVO_USD
// y el Aporte mínimo hardcodeados por separado del backend, con un
// comentario pidiendo no olvidarse de mantenerlos sincronizados. La landing
// ya está escrita para pedir esto acá (fetch a /api/config en
// applyPublicConfig) — pero esta ruta nunca se había implementado del lado
// del backend, así que ese fetch fallaba en silencio y el simulador quedaba
// funcionando SOLO con sus valores por defecto (500.000 / 1.000), que hoy
// coinciden por casualidad con los de acá. El día que alguien cambie
// CAPITAL_OBJETIVO_USD en Railway sin agregar esta ruta, el simulador le
// muestra al inversor un % y el Acuerdo firmado imprime otro — exactamente
// el tipo de inconsistencia con validez legal que el resto del código se
// cuida tanto de evitar. No expone nada sensible: son dos números públicos.
app.get("/api/config", (req, res) => {
  res.json({
    capitalObjetivoUsd: CAPITAL_OBJETIVO_USD,
    aporteMinimoUsd: APORTE_MINIMO_USD,
    // Rama demo: la landing usa estas dos banderas para decidir qué
    // formulario mostrar. Es la MISMA landing en los dos casos — no hay un
    // index.html de demo y otro de producción. Con las banderas en false
    // (producción) el comportamiento es idéntico al de hoy.
    flujoPublicoHabilitado: process.env.FLUJO_PUBLICO_HABILITADO === "true",
    modoDemo: MODO_DEMO,
  });
});

// ---------- Solicitud de membresía (revisión legal pre-lanzamiento) -------
// Punto C del plan: reemplaza a POST /api/members como entrada pública.
// No pide DNI ni monto, no emite token de sesión, y no dispara nada de
// DocuSign ni de pago — solo guarda el interés en `membership_requests`
// (tabla separada, ver schema.sql) con status='solicitud_recibida'. Nace
// ahí y se queda: acá no hay KYC ni aprobación individual, todavía no
// existe ese flujo. POST /api/members sigue abajo, intacto — la landing ya
// no le pega, pero lo va a necesitar el portal privado de Miembros
// aprobados en cuanto ese estado exista.
const WHATSAPP_REGEX = /^[0-9+()\-\s]{6,20}$/;

app.post("/api/membership-requests", strictLimiter, async (req, res) => {
  try {
    let { name, whatsapp, email, cityProvince, activity, interest, privacyAccepted } = req.body;

    if (typeof name !== "string" || typeof whatsapp !== "string" || typeof email !== "string") {
      return res.status(400).json({ error: "Formato de datos inválido." });
    }
    name = name.trim().slice(0, 150);
    whatsapp = whatsapp.trim().slice(0, 30);
    email = email.trim().toLowerCase().slice(0, 150);
    cityProvince = typeof cityProvince === "string" ? cityProvince.trim().slice(0, 150) : null;
    activity = typeof activity === "string" ? activity.trim().slice(0, 150) : null;
    interest = typeof interest === "string" ? interest.trim().slice(0, 60) : null;

    if (!name || !whatsapp || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Completá nombre, WhatsApp y un correo electrónico válido." });
    }
    if (!WHATSAPP_REGEX.test(whatsapp)) {
      return res.status(400).json({ error: "El WhatsApp no es válido. Usá solo números (podés incluir +, espacios, guiones o paréntesis)." });
    }
    if (privacyAccepted !== true) {
      return res.status(400).json({ error: "Hace falta aceptar la política de privacidad y contacto." });
    }

    const solicitud = await db.createMembershipRequest({
      isTest: MODO_DEMO,
      name, whatsapp, email, cityProvince, activity, interest, privacyAccepted,
    });

    // Aviso al equipo — mismo criterio que el aviso de transferencias
    // (ver /api/payments/transfer/notify): es el único paso que no avanza
    // solo, alguien tiene que verlo para contactar a la persona.
    if (process.env.MAIL_ADMIN) {
      const e = mailer.escapar;
      const filas = [
        ["Nombre", solicitud.name],
        ["WhatsApp", solicitud.whatsapp],
        ["Email", solicitud.email],
        ["Ciudad / provincia", solicitud.cityProvince],
        ["Actividad", solicitud.activity],
        ["Interés", solicitud.interest],
      ].filter(([, v]) => v);
      await mailer.send({
        to: process.env.MAIL_ADMIN,
        subject: `Nueva solicitud de membresía — ${solicitud.name}`,
        html:
          `<p>Nueva solicitud de acceso en la landing.</p>` +
          `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#3C4A5A;">` +
          filas.map(([k, v]) => `<tr><td style="padding:4px 16px 4px 0;color:#7A8899;">${e(k)}</td><td style="font-weight:600;">${e(v)}</td></tr>`).join("") +
          `</table>` +
          `<p style="color:#7A8899;">Código interno: <code>${solicitud.id}</code></p>`,
      });
    }

    res.status(201).json({
      ok: true,
      message: "Recibimos tu solicitud. Nuestro equipo la revisará y se comunicará con vos.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo registrar tu solicitud." });
  }
});

// ---------- 1) Ficha de Adhesión (sin usar por la landing — ver arriba) ---
app.post("/api/members", strictLimiter, async (req, res) => {
  try {
    let { name, docId, email, phone, amountUsd } = req.body;
    // El formulario de la landing ya valida esto en el navegador, pero eso
    // es solo comodidad para el usuario — no protege nada, porque cualquiera
    // puede pegarle directo a este endpoint sin pasar por el formulario.
    // La validación real tiene que estar acá: tipos, largos razonables, y
    // formato de email — no solo "¿vino algo?".
    if (
      typeof name !== "string" ||
      typeof docId !== "string" ||
      typeof email !== "string" ||
      typeof amountUsd !== "number"
    ) {
      return res.status(400).json({ error: "Formato de datos inválido." });
    }
    name = name.trim().slice(0, 150);
    docId = docId.trim().slice(0, 50);
    email = email.trim().toLowerCase().slice(0, 150);
    phone = typeof phone === "string" ? phone.trim().slice(0, 30) : null;

    if (!name || !docId || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Datos de contacto inválidos o incompletos." });
    }
    // El tope de 10.000.000 que había acá no tenía relación con la ronda: se
    // podía comprometer un Aporte 20 veces mayor al Capital Objetivo y el
    // Acuerdo salía firmado con una Participación del 2000%.
    if (!Number.isFinite(amountUsd) || amountUsd < APORTE_MINIMO_USD || amountUsd > CAPITAL_OBJETIVO_USD) {
      return res.status(400).json({
        error: `El Aporte debe ser un número válido, de USD ${APORTE_MINIMO_USD.toLocaleString("es-AR")} a USD ${CAPITAL_OBJETIVO_USD.toLocaleString("es-AR")}.`,
      });
    }

    // Si esta persona (MISMO email Y MISMO DNI/CUIT a la vez) ya había
    // arrancado el proceso y todavía no pagó, en teoría es el mismo
    // registro — pero esta request todavía NO está autenticada, así que no
    // podemos confiar en que quien la manda sea realmente esa persona.
    //
    // Auditoría de seguridad (Problema 2): antes acá se hacía
    // `WHERE email = $1 OR doc_id = $2` (con OR, alcanzaba con el email
    // de un inversor real para "engancharse" a su Ficha) y encima se
    // devolvía su memberId real a cualquiera. Ahora el match exige AMBOS
    // datos (ver findActiveOrPendingMember) y, aunque matcheen, NO se
    // actualiza el registro ni se revela su memberId a una request sin
    // autenticar — solo una respuesta neutra.
    const existing = await db.findActiveOrPendingMember(email, docId);
    if (existing) {
      // Se manda el enlace al email REGISTRADO, no al que vino en la request:
      // si quien manda esto no es el titular, el enlace le llega igual al
      // dueño de la Ficha y el impostor no se entera de nada.
      //
      // La respuesta es idéntica exista o no el Miembro, y salga o no el
      // correo. Es a propósito: si cambiara según el caso, este endpoint se
      // convertiría en una forma de averiguar qué email+DNI están registrados.
      await enviarMagicLink(existing);
      return res.status(202).json({
        ok: true,
        message: "Si ya habías empezado una solicitud con estos datos, te mandamos un correo con el enlace para retomarla.",
      });
    }

    const member = await db.createMember({ name, docId, email, phone, amountUsd, isTest: MODO_DEMO });
    const token = auth.issueMemberToken(member.id);
    res.json({ memberId: member.id, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo crear el Miembro." });
  }
});

// ---------- 2) Firma con DocuSign ----------
app.post("/api/docusign/envelope", requireFlujoPublicoHabilitado, strictLimiter, auth.requireMemberSession((req) => req.body.memberId), async (req, res) => {
  try {
    const { memberId } = req.body;

    // Todo lo que sigue va dentro de un bloqueo de fila (SELECT ... FOR
    // UPDATE). Sin esto, dos pestañas del mismo Miembro apretando "Firmar"
    // casi a la vez leían ambas status='nuevo', ambas pasaban el guard de
    // abajo, y se creaban DOS sobres en DocuSign. El segundo pisaba el
    // envelope_id del primero: si el Miembro después firmaba en la pestaña
    // vieja, el webhook llegaba con un envelopeId desconocido y la firma —
    // legalmente válida — se perdía en silencio.
    // OJO: el bloqueo tiene que abarcar TODO — chequeo de estado, creación del
    // sobre y guardado. Si se cerrara la transacción apenas leído el Miembro,
    // el lock se soltaría antes de crear el sobre y las dos pestañas
    // volverían a pisarse, que es justo lo que se quiere evitar. Por eso la
    // llamada a DocuSign queda dentro de la transacción; es de un par de
    // segundos y el volumen de esta ruta es bajo.
    const resultado = await db.withMemberLock(memberId, async (member, client) => {
    if (!member) return { httpStatus: 404, body: { error: "Miembro no encontrado." } };

    // Si ya firmó o ya pagó, no generamos un sobre nuevo — evita que se
    // pueda "resetear" a un Miembro que ya está activo simplemente
    // volviendo a pegarle a este endpoint con su memberId conocido.
    if (member.status !== "nuevo" && member.status !== "firma_pendiente") {
      return { httpStatus: 400, body: {
        error: `No se puede generar un sobre nuevo: el Miembro ya está en estado "${member.status}".`,
      } };
    }

    // Ya tiene un sobre en curso: en vez de crear otro (que sería facturable
    // y dejaría huérfano al anterior), se reutiliza pidiéndole a DocuSign una
    // URL de firma nueva sobre el MISMO sobre. Esto además cubre el caso
    // normal de "la URL venció": las recipientView duran 5 minutos y son de
    // un solo uso, así que reintentar es algo que pasa seguido.
    if (member.envelopeId) {
      try {
        const estado = await docusignModule.getEnvelopeStatus(member.envelopeId);
        if (estado === "sent" || estado === "delivered") {
          const signingUrl = await docusignModule.createSigningUrlForEnvelope({
            envelopeId: member.envelopeId,
            memberId: member.id,
            memberName: member.name,
            memberEmail: member.email,
            returnUrl: `${process.env.FRONTEND_URL}/docusign-return.html?memberId=${member.id}`,
          });
          console.log(`♻️  Reutilizando el sobre ${member.envelopeId} del Miembro ${member.id} en vez de crear uno nuevo.`);
          return { httpStatus: 200, body: { signingUrl, proportionalPct: member.proportionalPct } };
        }
      } catch (dsErr) {
        console.warn(`⚠️  No se pudo reutilizar el sobre ${member.envelopeId}, se genera uno nuevo:`, dsErr.message);
      }
    }

    // Participación Proporcional: Aporte sobre el CAPITAL OBJETIVO del
    // Proyecto, no sobre el capital captado hasta este momento.
    //
    // Antes acá se dividía por (capital ya captado + este aporte). Eso hacía
    // que el número dependiera del orden de llegada y no cerrara nunca en
    // 100%: el PRIMER Miembro de la ronda firmaba un Acuerdo que decía
    // 100,00%, el segundo 50,00%, el décimo 10,00% — todos con el mismo
    // Aporte de USD 5.000, y todos después de que el simulador de la landing
    // les mostró 1,00%. Un documento con validez legal no puede decir algo
    // distinto de lo que se le prometió al inversor antes de firmar.
    //
    // El denominador es el mismo que usa el simulador (index.html), así que
    // los dos números coinciden por construcción y no pueden volver a
    // divergir. Vive en una env var para que se pueda ajustar sin deploy si
    // la ronda cambia de tamaño.
    const proportionalPct = (member.amountUsd / CAPITAL_OBJETIVO_USD) * 100;

    const { envelopeId, signingUrl } = await docusignModule.createEnvelopeAndGetSigningUrl({
      memberId: member.id,
      memberName: member.name,
      memberEmail: member.email,
      amountUsd: member.amountUsd,
      proportionalPct,
      // Importante: el returnUrl apunta al FRONTEND (no al backend), a un
      // archivo estático que vive en el mismo origen que la landing.
      // Esto permite que, al terminar de firmar, el <iframe> quede en el
      // mismo origen que la página padre y el JS pueda detectarlo sin
      // problemas de CORS. Ver docusign-return.html.
      returnUrl: `${process.env.FRONTEND_URL}/docusign-return.html?memberId=${member.id}`,
    });

    // Guardamos el % calculado (no solo envelopeId/status): así el frontend
    // no tiene que recalcularlo con un total hardcodeado, y el número que
    // se muestra en el resumen final es siempre el mismo que quedó
    // impreso en el Acuerdo firmado, aunque después se sumen más Miembros.
    await db.updateMember(member.id, { envelopeId, proportionalPct, status: "firma_pendiente" }, client);
    // Además del envelope_id "vigente" en members, se registra en el
    // historial: así, si más adelante llega el webhook de este sobre cuando
    // ya no es el vigente, se puede resolver igual a qué Miembro pertenece.
    await db.recordEnvelope(member.id, envelopeId, client);
    return { httpStatus: 200, body: { signingUrl, proportionalPct } };
    });

    res.status(resultado.httpStatus).json(resultado.body);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo generar el sobre de firma." });
  }
});

// Webhook de DocuSign Connect — se configura en la cuenta de DocuSign
app.post("/api/docusign/webhook", async (req, res) => {
  await docusignModule.handleConnectWebhook(req, res, {
    onEnvelopeCompleted: async ({ envelopeId }) => {
      const member = await db.getMemberByEnvelopeId(envelopeId);
      if (!member) {
        // Puede pasar con sobres de prueba, de otra cuenta, o si el
        // webhook llegó desincronizado. No es un error del servidor — no
        // hay nada roto, simplemente no hay a quién actualizar.
        console.warn(`⚠️  No se encontró ningún Miembro para envelopeId=${envelopeId} — se ignora.`);
        return;
      }
      // Solo avanzamos el estado si el Miembro sigue en un estado previo al
      // pago. Si ya está "activo" o en "transferencia_pendiente_confirmacion",
      // significa que el aviso de pago le ganó de mano a este webhook (puede
      // pasar por reintentos o latencia de DocuSign Connect) — en ese caso
      // NO lo pisamos, porque sería degradar a alguien que ya pagó de vuelta
      // a "tenés que pagar".
      if (member.status === "nuevo" || member.status === "firma_pendiente") {
        await db.updateMember(member.id, { status: "firmado_pendiente_pago" });
        // Acá podrías disparar un email: "¡Firmaste! Ahora completá el pago."
      } else {
        console.log(`ℹ️  Miembro ${member.id} ya está en estado "${member.status}" — se conserva, no se pisa con "firmado_pendiente_pago".`);
      }
    },

    // El PDF se guarda aparte, DESPUÉS de que el estado ya avanzó: si esto
    // falla, el Miembro no queda trabado (ver el comentario de orden en
    // handleConnectWebhook).
    onDocumentDownloaded: async ({ envelopeId, pdfBytes }) => {
      const member = await db.getMemberByEnvelopeId(envelopeId);
      if (!member) return;
      // uploadSignedPdf devuelve null si src/storage.js no está configurado
      // (sin credenciales de bucket reales) — en ese caso se seguía guardando
      // solo el tamaño, igual que antes de esta integración.
      const uploaded = await storage.uploadSignedPdf({ memberId: member.id, envelopeId, pdfBytes });
      await db.saveSignedDocument(member.id, pdfBytes, uploaded && uploaded.url);

      // Copia del Acuerdo al Miembro, con el PDF adjunto. Se manda acá porque
      // es el único momento en que tenemos los bytes sin volver a pedírselos a
      // DocuSign. Si el envío falla no se reintenta solo, pero el Miembro
      // siempre puede pedir otra copia desde POST /:id/acuerdo/reenviar.
      await mailer.sendAcuerdoFirmado({
        to: member.email,
        name: member.name,
        pdfBytes,
        amountUsd: member.amountUsd,
        proportionalPct: member.proportionalPct,
        envelopeId,
      });
    },
  });
});

// ---------- 3) Pago — Mercado Pago ----------
app.post("/api/payments/mp/preference", requireFlujoPublicoHabilitado, auth.requireMemberSession((req) => req.body.memberId), async (req, res) => {
  try {
    const { memberId } = req.body;
    const member = await db.getMember(memberId);
    if (!member) return res.status(404).json({ error: "Miembro no encontrado." });
    if (member.status !== "firmado_pendiente_pago") {
      return res.status(400).json({ error: "El Acuerdo todavía no fue firmado." });
    }
    const result = await mercadopago.createPreference({
      memberId: member.id,
      memberName: member.name,
      memberEmail: member.email,
      amountUsd: member.amountUsd,
    });

    // Se guardan ANTES de devolver la URL: si el Miembro paga y el webhook
    // no llega, esto es lo único que permite ir a preguntarle a Mercado Pago
    // si el pago existe (ver la sincronización activa en /status).
    // También queda registrado a qué cotización se le cobró.
    await db.updateMember(member.id, {
      mpPreferenceId: result.preferenceId,
      amountArs: result.amountArs,
      fxRateArsPerUsd: result.fxRate,
    });

    res.json(result);
  } catch (err) {
    console.error(err);
    // Si lo que falló fue la cotización, el pago NO se inicia a propósito
    // (ver src/fx.js): es preferible frenar a cobrar un monto incorrecto.
    if (/cotización/i.test(err.message || "")) {
      return res.status(503).json({
        error: "No pudimos obtener la cotización del dólar en este momento. Reintentá en unos minutos — no se generó ningún cargo.",
      });
    }
    res.status(500).json({ error: "No se pudo iniciar el pago." });
  }
});

app.get("/api/payments/mp/webhook", (req, res) => handleMpWebhook(req, res));
app.post("/api/payments/mp/webhook", (req, res) => handleMpWebhook(req, res));
function handleMpWebhook(req, res) {
  return mercadopago.handleWebhook(req, res, {
    onPaymentApproved: async ({ memberId, paymentId }) => {
      // Auditoría: el read-then-write de markPaid necesita el mismo lock de
      // fila que ya usa /docusign/envelope (ver withMemberLock en db.js) —
      // si no, dos webhooks de DOS pagos APROBADOS distintos para el mismo
      // Miembro llegando casi juntos pueden leer ambos "todavía sin pago" y
      // el segundo UPDATE pisa el mp_payment_id del primero sin que la
      // guarda de "cobro duplicado" llegue a dispararse — el mismo bug de
      // condición de carrera que C-6 resolvió para los sobres de DocuSign,
      // pero sin corregir del lado de los pagos.
      const r = await db.withMemberLock(memberId, async (member, client) => {
        if (!member) {
          console.warn(`⚠️  Webhook de pago para un memberId desconocido: ${memberId}`);
          return null;
        }
        const despues = await markPaid(member, { mpPaymentId: String(paymentId) }, "Mercado Pago", client);
        return { antes: member, despues };
      });
      // Fuera del lock: la fila ya está liberada antes de salir a la red.
      if (r) await avisarPagoConfirmado(r.antes, r.despues, "Mercado Pago");
    },
  });
}

// ---------- 3-bis) Pago — Stripe (tarjeta internacional en USD) ----------
app.post("/api/payments/stripe/checkout", requireFlujoPublicoHabilitado, auth.requireMemberSession((req) => req.body.memberId), async (req, res) => {
  try {
    const { memberId } = req.body;
    const member = await db.getMember(memberId);
    if (!member) return res.status(404).json({ error: "Miembro no encontrado." });
    if (member.status !== "firmado_pendiente_pago") {
      return res.status(400).json({ error: "El Acuerdo todavía no fue firmado." });
    }
    const result = await stripeModule.createCheckoutSession({
      memberId: member.id,
      memberName: member.name,
      memberEmail: member.email,
      amountUsd: member.amountUsd,
    });

    // Mismo criterio que en Mercado Pago: sin la referencia guardada no hay
    // reconciliación posible si el webhook se pierde.
    await db.updateMember(member.id, { stripeSessionId: result.sessionId });

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo iniciar el pago." });
  }
});

app.post("/api/payments/stripe/webhook", (req, res) => {
  return stripeModule.handleWebhook(req, res, {
    onPaymentApproved: async ({ memberId, paymentId }) => {
      // Mismo lock que en el webhook de Mercado Pago — ver el comentario ahí.
      const r = await db.withMemberLock(memberId, async (member, client) => {
        if (!member) {
          console.warn(`⚠️  Webhook de Stripe para un memberId desconocido: ${memberId}`);
          return null;
        }
        const despues = await markPaid(member, { stripePaymentId: String(paymentId) }, "Stripe", client);
        return { antes: member, despues };
      });
      if (r) await avisarPagoConfirmado(r.antes, r.despues, "Stripe");
    },
  });
});

// ---------- 3-ter) Pago — Transferencia bancaria (confirmación manual) ----------
// No hay pasarela involucrada — por eso, a diferencia de MP/Stripe, acá hace
// falta mostrarle al Miembro el monto en pesos ANTES de que transfiera (con
// esos dos, la página de checkout del proveedor se lo muestra sola).
app.get("/api/payments/transfer/quote", requireFlujoPublicoHabilitado, auth.requireMemberSession((req) => req.query.memberId), async (req, res) => {
  try {
    const member = await db.getMember(req.query.memberId);
    if (!member) return res.status(404).json({ error: "Miembro no encontrado." });
    if (member.status !== "firmado_pendiente_pago") {
      return res.status(400).json({ error: "El Acuerdo todavía no fue firmado." });
    }
    const { amountArs, rate: fxRate, source: fxSource } = await fx.usdToArs(member.amountUsd);
    res.json({ amountUsd: member.amountUsd, amountArs, fxRate, fxSource });
  } catch (err) {
    console.error(err);
    if (/cotización/i.test(err.message || "")) {
      return res.status(503).json({
        error: "No pudimos obtener la cotización del dólar en este momento. Reintentá en unos minutos.",
      });
    }
    res.status(500).json({ error: "No se pudo calcular el monto a transferir." });
  }
});

// Auditoría: antes esto solo registraba que el Miembro "avisó" que
// transfirió — sin ninguna evidencia, alcanzaba con apretar un botón para
// quedar en "transferencia_pendiente_confirmacion". Ahora el comprobante es
// OBLIGATORIO (se rechaza con 400 si no viene) y se guarda completo en la
// base (ver db.saveTransferReceipt) — es lo que el equipo de Ditelli revisa
// a mano antes de pasar a "activo"; esta ruta nunca activa a nadie por sí
// sola, eso sigue siendo una confirmación manual aparte.
app.post("/api/payments/transfer/notify", requireFlujoPublicoHabilitado, withComprobante, auth.requireMemberSession((req) => req.body.memberId), async (req, res) => {
  try {
    const { memberId } = req.body;
    const member = await db.getMember(memberId);
    if (!member || member.status !== "firmado_pendiente_pago") {
      return res.status(400).json({ error: "El Acuerdo todavía no fue firmado." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Hace falta adjuntar el comprobante de la transferencia." });
    }

    await db.saveTransferReceipt(member.id, {
      data: req.file.buffer,
      contentType: req.file.mimetype,
      filename: req.file.originalname,
    });

    // Se recalcula acá (no se confía en lo que haya visto el Miembro en
    // pantalla) para que el equipo de Ditelli tenga un monto de referencia
    // contra el cual cotejar el comprobante. No bloqueante: el Miembro YA
    // transfirió plata real por fuera de este sistema, así que un hipo de
    // la cotización no le puede impedir dejar constancia de que lo hizo.
    try {
      const { amountArs, rate: fxRate } = await fx.usdToArs(member.amountUsd);
      await db.updateMember(member.id, { status: "transferencia_pendiente_confirmacion", amountArs, fxRateArsPerUsd: fxRate });
    } catch (fxErr) {
      console.warn(`⚠️  No se pudo calcular el monto en ARS de referencia para ${member.id} (se guarda igual el aviso):`, fxErr.message);
      await db.updateMember(member.id, { status: "transferencia_pendiente_confirmacion" });
    }

    // Acuse al Miembro: la transferencia es el único método donde la persona
    // queda sin ninguna señal hasta que alguien la confirma a mano.
    await mailer.sendTransferenciaRegistrada({
      to: member.email,
      name: member.name,
      amountUsd: member.amountUsd,
    });

    // Y aviso al equipo, si hay casilla configurada: es el único estado que no
    // avanza solo, así que alguien tiene que enterarse de que hay un
    // comprobante para cotejar contra el extracto.
    if (process.env.MAIL_ADMIN) {
      await mailer.send({
        to: process.env.MAIL_ADMIN,
        subject: `Transferencia a verificar — ${member.name} (USD ${member.amountUsd})`,
        html:
          `<p>El Miembro <strong>${member.name}</strong> (${member.docId}, ${member.email}) ` +
          `subió el comprobante de una transferencia por <strong>USD ${member.amountUsd}</strong>.</p>` +
          `<p>Descargalo con <code>node scripts/export-transfer-receipt.js ${member.id}</code>, ` +
          `cotejalo contra el extracto y, si está acreditado, marcalo como activo.</p>` +
          `<p>Código del Miembro: <code>${member.id}</code></p>`,
      });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo registrar el aviso de transferencia." });
  }
});

/**
 * Marca a un Miembro como "activo" registrando el pago — con guarda contra
 * el cobro duplicado.
 *
 * El problema que resuelve: si el Miembro pagaba dos veces (algo que el
 * propio mensaje de error de la landing lo invitaba a hacer cuando el
 * webhook tardaba), llegaban dos webhooks y el segundo pisaba el
 * mp_payment_id del primero con un simple UPDATE. Resultado: el Miembro
 * pagó dos veces, la base guardaba un solo pago, y nadie se enteraba.
 *
 * Ahora, si ya hay un pago registrado y llega OTRO distinto, no se pisa:
 * se loguea como cobro duplicado a devolver. El objetivo es que la plata de
 * más nunca sea invisible.
 *
 * IMPORTANTE — condición de carrera: esto hace un read-then-write (decide
 * en base al `member` que le pasó el caller, después escribe). Para que la
 * guarda de arriba sea confiable, TODO caller tiene que envolver la llamada
 * en `db.withMemberLock` y pasar acá el `client` de esa transacción — igual
 * que ya hace /api/docusign/envelope contra el mismo tipo de problema (dos
 * pestañas / dos webhooks casi simultáneos leyendo el mismo estado viejo
 * antes de que cualquiera de los dos escriba). Sin el lock, dos webhooks de
 * DOS pagos aprobados distintos casi al mismo tiempo pueden leer ambos
 * "todavía sin pago" y el segundo UPDATE pisa el pago del primero sin que
 * esta guarda llegue a dispararse.
 */
async function markPaid(member, patch, origen, client) {
  // Defensa en profundidad: un pago solo puede activar a un Miembro que ya
  // firmó el Acuerdo (o que ya está activo/con transferencia en curso — ahí
  // es un no-op idempotente más abajo). Ninguna ruta actual llega a llamar
  // markPaid en otro estado (mp/preference, stripe/checkout y
  // transfer/notify ya exigen "firmado_pendiente_pago" antes de arrancar el
  // pago), pero el chequeo vive también acá para no depender de que ningún
  // caller futuro se olvide de validarlo — activar a alguien sin Acuerdo
  // firmado es exactamente el tipo de estado inconsistente que este
  // proyecto no se puede permitir.
  const ESTADOS_VALIDOS_PARA_PAGO = ["firmado_pendiente_pago", "transferencia_pendiente_confirmacion", "activo"];
  if (!ESTADOS_VALIDOS_PARA_PAGO.includes(member.status)) {
    console.error(
      `🚨 Pago (${origen}) recibido para el Miembro ${member.id} en estado "${member.status}" — NO se activa. ` +
      `Un pago no puede confirmar a alguien que todavía no firmó el Acuerdo. Revisar manualmente.`
    );
    return member;
  }

  const nuevoPagoId = patch.mpPaymentId || patch.stripePaymentId;
  const pagoExistente = member.mpPaymentId || member.stripePaymentId;

  if (pagoExistente && nuevoPagoId && String(pagoExistente) !== String(nuevoPagoId)) {
    console.error(
      `🚨 COBRO DUPLICADO — Miembro ${member.id}: ya tenía el pago ${pagoExistente} y llegó ${nuevoPagoId} (${origen}). ` +
      `NO se pisa el registro. Revisar en el panel de ${origen} y devolver el importe de más.`
    );
    return member;
  }

  if (member.status === "activo" && pagoExistente) return member;

  const actualizado = await db.updateMember(member.id, { status: "activo", ...patch }, client);
  console.log(`✅ Pago confirmado (${origen}) — Miembro ${member.id} pasa a "activo".`);
  return actualizado;
}

/**
 * Manda el correo de "pago confirmado", pero SOLO si este pago fue el que
 * activó al Miembro.
 *
 * Va aparte de markPaid a propósito. markPaid corre dentro de
 * db.withMemberLock, o sea con la fila del Miembro bloqueada por una
 * transacción abierta; mandar un correo ahí adentro significaría mantener ese
 * lock tomado durante toda la llamada HTTP a Resend (hasta 10 segundos si el
 * proveedor se cuelga). Con webhooks que reintentan en ráfaga, eso serializa
 * pagos detrás de un servidor de correo y puede agotar el pool de conexiones.
 *
 * Comparar el estado de antes contra el de después es además lo que evita el
 * correo repetido: un webhook reintentado encuentra al Miembro ya en
 * "activo", markPaid no cambia nada, y acá no se manda nada.
 */
async function avisarPagoConfirmado(antes, despues, origen) {
  if (!antes || !despues) return;
  if (antes.status === "activo") return;      // ya estaba activo: no es una novedad
  if (despues.status !== "activo") return;    // no se activó (duplicado, estado inválido)
  await mailer.sendPagoConfirmado({
    to: despues.email,
    name: despues.name,
    amountUsd: despues.amountUsd,
    proportionalPct: despues.proportionalPct,
    metodo: origen,
    paymentId: despues.mpPaymentId || despues.stripePaymentId,
  });
}

// ---------- Estado de un Miembro (para que el frontend haga polling) ----------
// Se usa tanto durante el flujo normal como al volver de Mercado Pago/Stripe
// (ver mercadopago.js/stripe.js back_urls y el bloque de reapertura del
// modal en la landing) — por eso además del status devuelve name y
// amountUsd: cuando la página se recarga tras un pago externo, el
// formulario está vacío y no hay otra forma de reconstruir el resumen.
app.get("/api/members/:id/status", auth.requireMemberSession((req) => req.params.id), async (req, res) => {
  try {
    let member = await db.getMember(req.params.id);
    if (!member) return res.status(404).json({ error: "Miembro no encontrado." });

    // Sincronización activa en tiempo real con DocuSign:
    // Si el miembro sigue en "firma_pendiente" y tiene un envelopeId,
    // consultamos el estado del sobre directamente en DocuSign por si el
    // webhook de Connect se demoró, falló o se perdió en el camino.
    if (member.status === "firma_pendiente" && member.envelopeId) {
      try {
        const envelopeStatus = await docusignModule.getEnvelopeStatus(member.envelopeId);
        if (envelopeStatus === "completed") {
          const pdfBytes = await docusignModule.downloadSignedDocument(member.envelopeId);
          const uploaded = await storage.uploadSignedPdf({ memberId: member.id, envelopeId: member.envelopeId, pdfBytes });
          await db.saveSignedDocument(member.id, pdfBytes, uploaded && uploaded.url);
          member = await db.updateMember(member.id, { status: "firmado_pendiente_pago" });
          console.log(`✅ Sincronización activa con DocuSign: envelope ${member.envelopeId} está 'completed'. Estado actualizado a "firmado_pendiente_pago".`);
        } else if (envelopeStatus === "declined" || envelopeStatus === "voided") {
          return res.json({
            status: member.status,
            envelopeStatus,
            interrupted: true,
            name: member.name,
            amountUsd: member.amountUsd,
            proportionalPct: member.proportionalPct,
            message: "La firma fue cancelada o rechazada en DocuSign.",
          });
        }
      } catch (dsErr) {
        console.warn(`⚠️ No se pudo consultar DocuSign directamente para member ${member.id}:`, dsErr.message);
      }
    }

    // Sincronización activa con Mercado Pago / Stripe — el equivalente a lo
    // que ya se hacía con DocuSign, y que faltaba del lado del pago.
    //
    // Si el Miembro firmó pero sigue sin figurar como pagado, y tenemos una
    // referencia del intento de pago, le preguntamos DIRECTAMENTE al
    // proveedor. Esto cubre el caso más caro de todos: el Miembro pagó, la
    // plata está acreditada en la cuenta de Ditelli, y el webhook nunca
    // llegó (firma mal configurada en el panel, backend dormido, un deploy
    // justo en ese minuto). Sin esto, ese pago quedaba invisible hasta que
    // el Miembro escribía por su cuenta.
    if (member.status === "firmado_pendiente_pago") {
      // Mismo lock que en los webhooks (ver el comentario en markPaid): dos
      // pestañas del mismo Miembro haciendo polling de /status casi al mismo
      // tiempo no deberían poder pisarse la una a la otra acá tampoco.
      const estadoAntes = member;
      member = await db.withMemberLock(member.id, async (lockedMember, client) => {
        if (!lockedMember) return member;
        let current = lockedMember;
        if (current.status === "firmado_pendiente_pago" && current.mpPreferenceId) {
          const pago = await mercadopago.findApprovedPayment(current.id);
          if (pago) {
            current = await markPaid(current, { mpPaymentId: pago.paymentId }, "Mercado Pago", client);
          }
        }
        if (current.status === "firmado_pendiente_pago" && current.stripeSessionId) {
          const sesion = await stripeModule.getSessionPaymentStatus(current.stripeSessionId);
          if (sesion && sesion.paid) {
            current = await markPaid(current, { stripePaymentId: sesion.paymentId }, "Stripe", client);
          }
        }
        return current;
      });
      // Fuera del lock, igual que en los webhooks.
      await avisarPagoConfirmado(estadoAntes, member, "reconciliación");
    }

    res.json({
      status: member.status,
      name: member.name,
      amountUsd: member.amountUsd,
      proportionalPct: member.proportionalPct,
      // Para que la landing pueda mostrar cuánto se cobró en pesos y a qué
      // cotización, sin tener que recalcularlo (ni adivinarlo).
      amountArs: member.amountArs,
      fxRateArsPerUsd: member.fxRateArsPerUsd,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo consultar el estado del Miembro." });
  }
});

// ---------- Panel de administración (Fase 2 post-Beta) ----------
//
// Separado a propósito de todo lo de arriba: las rutas de Miembro usan
// auth.requireMemberSession (un token autoriza a UNA persona a ver SU
// propia Ficha); acá auth.requireAdminSession de adminAuth.js autoriza a
// un operador de Ditelli a ver y tocar CUALQUIER Miembro. No toca la
// máquina de estados existente (nuevo → firma_pendiente →
// firmado_pendiente_pago → activo | transferencia_pendiente_confirmacion),
// solo la opera desde una pantalla en vez de a mano por SQL.

function medioDePago(m) {
  if (m.mpPaymentId) return "Mercado Pago";
  if (m.stripePaymentId) return "Stripe";
  if (m.hasTransferReceipt || m.status === "transferencia_pendiente_confirmacion") return "Transferencia";
  return "—";
}

function toAdminMemberSummary(m) {
  return {
    id: m.id,
    name: m.name,
    email: m.email,
    status: m.status,
    amountUsd: m.amountUsd,
    medioDePago: medioDePago(m),
    updatedAt: m.updatedAt,
    hasTransferReceipt: m.hasTransferReceipt,
    // Rama demo: el panel lo usa para marcar la fila como dato de prueba.
    isTest: m.isTest,
  };
}

function toAdminMemberDetail(m) {
  return { ...m, medioDePago: medioDePago(m) };
}

app.post("/api/admin/login", strictLimiter, async (req, res) => {
  try {
    const username = typeof req.body.username === "string" ? req.body.username.trim() : "";
    const password = typeof req.body.password === "string" ? req.body.password : "";
    if (!username || !password) {
      return res.status(400).json({ error: "Usuario y contraseña son obligatorios." });
    }

    if (adminAuth.estaBloqueado(username)) {
      return res.status(429).json({ error: "Demasiados intentos fallidos. Esperá unos minutos y volvé a intentar." });
    }

    const admin = await db.findAdminByUsername(username);
    // Se compara SIEMPRE contra un hash (real o dummy — ver adminAuth.js),
    // para que "no existe ese usuario" y "existe pero la clave está mal"
    // tarden lo mismo: mismo criterio anti-enumeración que ya usa
    // /api/session/recover con email+DNI.
    const passwordOk = await adminAuth.verifyPassword(password, admin && admin.password_hash);

    if (!admin || !passwordOk) {
      adminAuth.registrarFallo(username);
      return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    }

    adminAuth.registrarExito(username);
    const token = adminAuth.issueAdminToken(admin.username);
    const csrfToken = adminAuth.issueCsrfToken();
    res.cookie(adminAuth.COOKIE_NAME, token, adminAuth.cookieOptions(true));
    res.cookie(adminAuth.CSRF_COOKIE_NAME, csrfToken, adminAuth.cookieOptions(false));
    res.json({ ok: true, username: admin.username });
  } catch (err) {
    console.error("Error en login de admin:", err);
    res.status(500).json({ error: "No se pudo iniciar sesión." });
  }
});

app.post("/api/admin/logout", (req, res) => {
  res.clearCookie(adminAuth.COOKIE_NAME, { path: "/" });
  res.clearCookie(adminAuth.CSRF_COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

// Listado — filtrable por estado. Sin filtro, trae todos.
app.get("/api/admin/members", adminAuth.requireAdminSession, async (req, res) => {
  try {
    const status = typeof req.query.status === "string" && req.query.status ? req.query.status : undefined;
    const members = await db.listMembers({ status });
    res.json({ members: members.map(toAdminMemberSummary) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo obtener el listado de Miembros." });
  }
});

app.get("/api/admin/members/:id", adminAuth.requireAdminSession, async (req, res) => {
  try {
    const member = await db.getMember(req.params.id);
    if (!member) return res.status(404).json({ error: "Miembro no encontrado." });
    res.json({ member: toAdminMemberDetail(member) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo obtener el Miembro." });
  }
});

// El endpoint prioritario de esta fase: hoy esto se hace a mano contra la
// base (ver el comentario en db.confirmTransfer y en
// /api/payments/transfer/notify más arriba) — es la única ruta que faltaba
// para que la cola de transferencia_pendiente_confirmacion sea operable
// de punta a punta desde una pantalla.
app.post("/api/admin/members/:id/confirmar-transferencia", adminAuth.requireAdminSession, async (req, res) => {
  try {
    const actualizado = await db.confirmTransfer(req.params.id, req.adminUsername);
    if (!actualizado) {
      return res.status(400).json({
        error: 'El Miembro no está en estado "transferencia_pendiente_confirmacion" (¿ya se confirmó, o todavía no llegó a esa etapa?).',
      });
    }
    // Mismo aviso que ya recibe un Miembro que paga con MP/Stripe — para
    // quien transfiere, esto ES la confirmación de pago.
    await mailer.sendPagoConfirmado({
      to: actualizado.email,
      name: actualizado.name,
      amountUsd: actualizado.amountUsd,
      proportionalPct: actualizado.proportionalPct,
      metodo: "Transferencia bancaria",
    });
    console.log(`✅ Transferencia confirmada por "${req.adminUsername}" — Miembro ${actualizado.id} pasa a "activo".`);
    res.json({ ok: true, member: toAdminMemberDetail(actualizado) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo confirmar la transferencia." });
  }
});

const ESTADOS_ALTA_MANUAL = ["nuevo", "firma_pendiente", "firmado_pendiente_pago", "transferencia_pendiente_confirmacion", "activo"];

// Alta de un Miembro que entró por reunión, no por la web.
app.post("/api/admin/members", adminAuth.requireAdminSession, async (req, res) => {
  try {
    let { name, docId, email, phone, amountUsd, status, notify } = req.body;
    if (
      typeof name !== "string" ||
      typeof docId !== "string" ||
      typeof email !== "string" ||
      typeof amountUsd !== "number"
    ) {
      return res.status(400).json({ error: "Formato de datos inválido." });
    }
    name = name.trim().slice(0, 150);
    docId = docId.trim().slice(0, 50);
    email = email.trim().toLowerCase().slice(0, 150);
    phone = typeof phone === "string" ? phone.trim().slice(0, 30) : null;
    status = typeof status === "string" && ESTADOS_ALTA_MANUAL.includes(status) ? status : "nuevo";

    if (!name || !docId || !EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: "Datos de contacto inválidos o incompletos." });
    }
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res.status(400).json({ error: "El Aporte debe ser un número mayor a cero." });
    }

    // Mismo cálculo que usa /api/docusign/envelope para el alta automática
    // — así el % de Participación de un alta manual significa lo mismo que
    // el de cualquier otro Miembro, esté o no todavía firmado.
    const proportionalPct = (amountUsd / CAPITAL_OBJETIVO_USD) * 100;
    const member = await db.createMemberManual({ name, docId, email, phone, amountUsd, status, proportionalPct, isTest: MODO_DEMO });

    // Si no se dispara el mismo efecto secundario que el alta automática
    // (emitir un acceso), alguien cargado como "activo" tras una reunión
    // queda sin forma de entrar al área privada hasta que un operador se
    // acuerde de mandarle el enlace a mano. Tildado por default; el
    // operador lo destilda si ya se habló todo en persona.
    let accesoEnviado = false;
    if (notify !== false) {
      accesoEnviado = await enviarMagicLink(member);
    }

    console.log(`➕ Alta manual por "${req.adminUsername}" — Miembro ${member.id} en estado "${status}".`);
    res.status(201).json({ ok: true, member: toAdminMemberDetail(member), accesoEnviado });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo dar de alta al Miembro." });
  }
});

// Comprobante de transferencia (BYTEA ya guardado en la fila — ver
// db.saveTransferReceipt). Antes solo se podía bajar con
// scripts/export-transfer-receipt.js desde la consola.
app.get("/api/admin/members/:id/comprobante", adminAuth.requireAdminSession, async (req, res) => {
  try {
    const receipt = await db.getTransferReceipt(req.params.id);
    if (!receipt) return res.status(404).json({ error: "Este Miembro no tiene ningún comprobante cargado." });
    res.setHeader("Content-Type", receipt.contentType);
    res.setHeader("Content-Disposition", `inline; filename="${receipt.filename.replace(/[".\\/]+/g, "_")}"`);
    res.send(receipt.data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo obtener el comprobante." });
  }
});

// Acuerdo firmado — se vuelve a pedir a DocuSign en el momento, mismo
// patrón que POST /api/members/:id/acuerdo/reenviar: el PDF no queda
// persistido en este backend salvo que STORAGE_S3_* esté configurado (ver
// src/storage.js), así que re-descargarlo es la única fuente confiable hoy.
app.get("/api/admin/members/:id/acuerdo", adminAuth.requireAdminSession, async (req, res) => {
  try {
    const member = await db.getMember(req.params.id);
    if (!member) return res.status(404).json({ error: "Miembro no encontrado." });
    if (!member.envelopeId) return res.status(404).json({ error: "Este Miembro todavía no tiene un Acuerdo firmado." });
    const pdfBytes = await docusignModule.downloadSignedDocument(member.envelopeId);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="Acuerdo-${member.name.replace(/[^a-zA-Z0-9]+/g, "_")}.pdf"`);
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo descargar el Acuerdo desde DocuSign." });
  }
});

function csvEscape(v) {
  // Fechas como ISO 8601 (no el toString() largo de JS) — es lo que un
  // contador espera poder ordenar/filtrar en una planilla.
  const s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Exportación para el contador. Delimitador ";" (no ",") porque Excel en
// configuración regional es-AR usa la coma como separador decimal y abre
// mal un CSV separado por comas. BOM al principio para que los acentos se
// vean bien al abrirlo directo, sin pasar por el asistente de importación.
app.get("/api/admin/export.csv", adminAuth.requireAdminSession, async (req, res) => {
  try {
    const members = await db.listMembers({});
    const columnas = [
      // Rama demo: isTest va PRIMERO a propósito. Si este CSV termina en una
      // planilla o en el mail de un contador, lo primero que se lee tiene que
      // ser si la fila es de prueba o real.
      "isTest",
      "id", "name", "docId", "email", "phone", "status", "medioDePago",
      "amountUsd", "amountArs", "fxRateArsPerUsd", "proportionalPct",
      "transferConfirmedBy", "transferConfirmedAt", "createdAt", "updatedAt",
    ];
    const filas = members.map((m) => {
      const fila = toAdminMemberDetail(m);
      return columnas.map((c) => csvEscape(fila[c])).join(";");
    });
    const csv = "﻿" + [columnas.join(";"), ...filas].join("\r\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="ditelli-miembros-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "No se pudo generar el CSV." });
  }
});

// ---------- Healthcheck ----------
// Lo usa el monitor de uptime de Railway y sirve para saber en 1 segundo si
// lo que está caído es el proceso o la base. No expone nada sensible.
app.get("/health", async (req, res) => {
  try {
    await db.ping();
    res.json({ ok: true, db: "up" });
  } catch (err) {
    console.error("❌ Healthcheck: la base no responde:", err.message);
    res.status(503).json({ ok: false, db: "down" });
  }
});

// Manejador global de errores — va al final de las rutas, pero ANTES de
// app.listen() (por convención de Express, aunque funcionalmente el orden
// con listen() no importa acá). Atrapa cualquier error no controlado (uno
// que se nos haya escapado sin su propio try/catch) para que el Miembro
// nunca vea un stack trace ni el servidor se caiga en silencio.
app.use((err, req, res, next) => {
  console.error("💥 Error no controlado:", err.stack || err);
  // Auditoría: esto antes mostraba err.message salvo que NODE_ENV fuera
  // EXACTAMENTE "production" — o sea, fail-OPEN. Railway no setea NODE_ENV
  // por defecto (a diferencia de otros PaaS), así que si nadie lo carga a
  // mano como variable de entorno, este handler filtraba el mensaje interno
  // de CUALQUIER error no controlado a cualquier cliente. Invertido a
  // fail-CLOSED: se esconde por defecto, y solo se muestra el detalle si
  // alguien puso explícitamente NODE_ENV=development (o "test", para que
  // los scripts de test que llegan a pegarle a rutas reales sigan viendo el
  // mensaje real). Nunca depende de que una variable esté bien puesta en
  // Railway para ser seguro.
  const mostrarDetalle = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  res.status(err.status || 500).json({
    error: mostrarDetalle ? err.message : "Ocurrió un error interno en el servidor.",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Ditelli Capital backend corriendo en :${PORT}`));
