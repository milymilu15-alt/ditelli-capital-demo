/**
 * Integración con DocuSign eSignature API — firma embebida (Embedded Signing)
 * del Acuerdo de Participación (con Anexos I, II y III).
 *
 * Requisito previo (se hace UNA vez, desde la cuenta de DocuSign, no en código):
 *  1) Cargar el Acuerdo de Participación como PLANTILLA en DocuSign
 *     (Templates → New → Upload) e insertar los campos de firma / texto
 *     donde corresponda (nombre, DNI, monto, %, fecha, firma).
 *  2) Anotar el Template ID → va en DOCUSIGN_TEMPLATE_ID.
 *  3) Los campos de texto de la plantilla deben tener un "Data Label"
 *     (ej. "nombre_miembro", "monto_aporte", "porcentaje_asignado") para
 *     poder completarlos automáticamente desde acá.
 *
 * Autenticación: JWT Grant (server-to-server, sin que nadie tenga que
 * loguearse manualmente). Requiere el par de claves RSA generado en
 * DocuSign → Apps and Keys, con la clave privada guardada en el servidor.
 */

const fs = require("fs");
const crypto = require("crypto");
const docusign = require("docusign-esign");

const SCOPES = ["signature", "impersonation"];

// El token JWT dura 1 hora (ver el "3600" más abajo). Pedir uno nuevo en
// cada operación (crear sobre, descargar PDF firmado) suma una llamada de
// red extra innecesaria a cada request y te acerca más rápido al límite
// de pedidos de token que impone DocuSign. Lo cacheamos en memoria y solo
// pedimos uno nuevo cuando falta poco para que venza (o no hay ninguno).
let cachedApiClient = null;
let cachedTokenExpiresAt = 0; // epoch ms

async function getAuthenticatedApiClient() {
  const now = Date.now();
  // Renovamos 5 minutos antes de que venza, no justo al límite — así no
  // corremos el riesgo de que el token expire a mitad de un request.
  if (cachedApiClient && now < cachedTokenExpiresAt - 5 * 60 * 1000) {
    return cachedApiClient;
  }

  const apiClient = new docusign.ApiClient();
  apiClient.setOAuthBasePath(
    process.env.DOCUSIGN_BASE_PATH.includes("demo")
      ? "account-d.docusign.com"
      : "account.docusign.com"
  );

  // En tu compu, la clave vive en un archivo (keys/docusign_private.key,
  // fuera de git a propósito). En Railway no hay ese archivo — ahí la
  // clave se carga directo desde la variable de entorno
  // DOCUSIGN_PRIVATE_KEY_CONTENT (el contenido completo del PEM, pegado
  // tal cual). Usamos la que esté disponible; si están las dos, gana el
  // archivo (así el local no se ve afectado por nada que pase en Railway).
  // fs.existsSync (no solo "¿la variable está seteada?"): si por error
  // DOCUSIGN_PRIVATE_KEY_PATH queda cargada en Railway (por ejemplo,
  // copiando el .env completo sin sacar esa línea) pero el archivo no
  // existe ahí, queremos caer al contenido de la otra variable en vez de
  // explotar con un ENOENT.
  let privateKey = null;
  if (process.env.DOCUSIGN_PRIVATE_KEY_PATH && fs.existsSync(process.env.DOCUSIGN_PRIVATE_KEY_PATH)) {
    privateKey = fs.readFileSync(process.env.DOCUSIGN_PRIVATE_KEY_PATH);
  } else if (process.env.DOCUSIGN_PRIVATE_KEY_CONTENT) {
    // Los paneles de variables de entorno (Railway incluido) a veces guardan
    // los saltos de línea como la secuencia literal \n de dos caracteres en
    // vez de saltos reales. Un PEM así NO parsea y el error que devuelve
    // DocuSign no dice nada útil sobre la causa. Se normaliza acá: si el
    // valor ya viene con saltos reales, este replace no cambia nada.
    privateKey = process.env.DOCUSIGN_PRIVATE_KEY_CONTENT.replace(/\\n/g, "\n").trim();
  }

  if (!privateKey) {
    throw new Error(
      "Falta la clave privada de DocuSign: configurá DOCUSIGN_PRIVATE_KEY_PATH (local) o DOCUSIGN_PRIVATE_KEY_CONTENT (Railway)."
    );
  }

  const results = await apiClient.requestJWTUserToken(
    process.env.DOCUSIGN_INTEGRATION_KEY,
    process.env.DOCUSIGN_USER_ID,
    SCOPES,
    privateKey,
    3600 // duración del token en segundos
  );

  apiClient.setBasePath(process.env.DOCUSIGN_BASE_PATH);
  apiClient.addDefaultHeader("Authorization", `Bearer ${results.body.access_token}`);

  cachedApiClient = apiClient;
  cachedTokenExpiresAt = now + 3600 * 1000;
  return apiClient;
}

/**
 * Crea el sobre (envelope) a partir de la plantilla del Acuerdo, ya
 * completado con los datos del Miembro (equivalente a la Ficha de
 * Adhesión Individual — Anexo III), y devuelve la URL para firmar
 * embebido en la propia landing (sin salir a DocuSign ni usar email).
 */
async function createEnvelopeAndGetSigningUrl({
  memberId,
  memberName,
  memberEmail,
  amountUsd,
  proportionalPct,
  returnUrl,
}) {
  const apiClient = await getAuthenticatedApiClient();
  const envelopesApi = new docusign.EnvelopesApi(apiClient);

  // clientUserId identifica al firmante como "embebido" (no recibe email,
  // firma directo en nuestra web). Puede ser cualquier string estable,
  // usamos el memberId.
  const clientUserId = memberId;

  const envelopeDefinition = new docusign.EnvelopeDefinition();
  envelopeDefinition.templateId = process.env.DOCUSIGN_TEMPLATE_ID;
  envelopeDefinition.status = "sent";

  const signer = docusign.TemplateRole.constructFromObject({
    email: memberEmail,
    name: memberName,
    roleName: "Miembro", // debe coincidir con el nombre del rol definido en la plantilla
    clientUserId,
	tabs: {
	  textTabs: [
	    { tabLabel: "nombre_miembro", value: memberName, locked: "true" },
	    { tabLabel: "monto_aporte", value: `USD ${amountUsd.toLocaleString("es-AR")}`, locked: "true" },
	    { tabLabel: "porcentaje_asignado", value: `${proportionalPct.toFixed(2)}%`, locked: "true" },
	    { tabLabel: "fecha_aceptacion", value: new Date().toLocaleDateString("es-AR"), locked: "true" },
	  ],
	},
  });

  envelopeDefinition.templateRoles = [signer];

  const envelopeResult = await envelopesApi.createEnvelope(process.env.DOCUSIGN_ACCOUNT_ID, {
    envelopeDefinition,
  });

  const viewRequest = new docusign.RecipientViewRequest();
  viewRequest.returnUrl = returnUrl || process.env.DOCUSIGN_RETURN_URL;
  viewRequest.authenticationMethod = "none"; // el Miembro ya se autenticó en nuestro sitio
  viewRequest.email = memberEmail;
  viewRequest.userName = memberName;
  viewRequest.clientUserId = clientUserId;

  const viewResult = await envelopesApi.createRecipientView(
    process.env.DOCUSIGN_ACCOUNT_ID,
    envelopeResult.envelopeId,
    { recipientViewRequest: viewRequest }
  );

  return {
    envelopeId: envelopeResult.envelopeId,
    signingUrl: viewResult.url, // metés esta URL en un <iframe> o redirect en el frontend
  };
}

/**
 * Genera una URL de firma NUEVA sobre un sobre que ya existe.
 *
 * Las recipientView de DocuSign son de un solo uso y vencen a los 5 minutos,
 * así que "el link no anda, dame otro" es un caso normal, no un error. Antes
 * la única forma de reintentar era crear un sobre entero nuevo: facturable,
 * y dejando huérfano al anterior (con el riesgo de perder una firma ya hecha).
 */
async function createSigningUrlForEnvelope({ envelopeId, memberId, memberName, memberEmail, returnUrl }) {
  const apiClient = await getAuthenticatedApiClient();
  const envelopesApi = new docusign.EnvelopesApi(apiClient);

  const viewRequest = new docusign.RecipientViewRequest();
  viewRequest.returnUrl = returnUrl || process.env.DOCUSIGN_RETURN_URL;
  viewRequest.authenticationMethod = "none";
  viewRequest.email = memberEmail;
  viewRequest.userName = memberName;
  viewRequest.clientUserId = memberId;

  const viewResult = await envelopesApi.createRecipientView(
    process.env.DOCUSIGN_ACCOUNT_ID,
    envelopeId,
    { recipientViewRequest: viewRequest }
  );
  return viewResult.url;
}

/**
 * Descarga el PDF combinado y firmado, una vez que el sobre está "completed".
 * Se usa típicamente disparado por el webhook de abajo.
 */
async function downloadSignedDocument(envelopeId) {
  const apiClient = await getAuthenticatedApiClient();
  const envelopesApi = new docusign.EnvelopesApi(apiClient);
  const pdfBytes = await envelopesApi.getDocument(
    process.env.DOCUSIGN_ACCOUNT_ID,
    envelopeId,
    "combined" // "combined" = todos los documentos + certificado de firma en un solo PDF
  );
  return pdfBytes; // guardar en tu storage (S3, disco, etc.)
}

/**
 * Valida la firma HMAC que DocuSign Connect manda en el header
 * `X-DocuSign-Signature-1`, calculada con la "Connect Secret" que se
 * configura al crear la conexión (Settings → Connect → tu configuración
 * → HMAC). Requiere el body CRUDO (req.rawBody, capturado en server.js
 * vía la opción "verify" de express.json()) — calcularlo sobre
 * JSON.stringify(req.body) NO funciona, porque re-serializar el JSON ya
 * parseado no reproduce byte a byte lo que mandó DocuSign (orden de
 * claves, espacios), y el HMAC fallaría en casi todos los pedidos legítimos.
 */
function isValidDocuSignSignature(req) {
  const secret = process.env.DOCUSIGN_CONNECT_HMAC_KEY;
  if (!secret) {
    // validateEnv() en server.js previene que el servidor arranque sin esta
    // variable — si llegamos acá es por un error de configuración, y lo más
    // seguro es rechazar la notificación (fail-closed).
    console.error("❌ DOCUSIGN_CONNECT_HMAC_KEY no configurado — se rechaza el webhook de DocuSign.");
    return false;
  }
  const signature = req.headers["x-docusign-signature-1"];
  if (!signature || !req.rawBody) return false;

  const computedHash = crypto.createHmac("sha256", secret).update(req.rawBody).digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(computedHash), Buffer.from(signature));
  } catch {
    return false; // largos distintos u otro formato inesperado
  }
}

/**
 * Handler del webhook de DocuSign Connect. Se configura desde
 * Settings → Connect en la cuenta de DocuSign, apuntando a esta URL.
 *
 * El formato real del JSON de Connect (v2.1, el que usa DocuSign hoy)
 * anida los datos así:
 *   { "event": "envelope-completed",
 *     "data": { "envelopeId": "...", "envelopeSummary": { "status": "completed" } } }
 *
 * Pero según cómo quede configurado el Connect en la cuenta (hay
 * variantes más viejas / "legacy"), a veces vienen en la raíz del body
 * directamente, o dentro de un array "envelopeEvents". Probamos las tres
 * formas conocidas en vez de asumir una sola — así no se rompe en
 * silencio si Ditelli configuró Connect distinto a como lo probamos acá.
 */
async function handleConnectWebhook(req, res, { onEnvelopeCompleted, onDocumentDownloaded }) {
  try {
    if (!isValidDocuSignSignature(req)) {
      console.error("❌ Firma de DocuSign Connect inválida — se ignora la notificación.");
      // 200 igual, no 401: si devolvemos error, DocuSign reintenta
      // indefinidamente la misma notificación no válida.
      return res.sendStatus(200);
    }

    const body = req.body || {};
    const legacyEvent = Array.isArray(body.envelopeEvents) ? body.envelopeEvents[0] : null;

    const envelopeId = body.data?.envelopeId || legacyEvent?.envelopeId || body.envelopeId;
    const status = body.data?.envelopeSummary?.status || legacyEvent?.status || body.status;
    const eventName = body.event; // ej: "envelope-completed"

    console.log(`📩 Webhook de DocuSign recibido — event=${eventName || "(sin nombre)"} status=${status || "(sin status)"} envelopeId=${envelopeId || "(no reconocido)"}`);

    if (!envelopeId) {
      // No pudimos ubicar el envelopeId con ninguna de las 3 formas
      // conocidas — logueamos el body entero para poder ajustar esto en
      // cuanto veamos un webhook real de la cuenta de Ditelli (Fase 4).
      console.warn("Webhook de DocuSign sin envelopeId reconocible. Body recibido:", JSON.stringify(body));
      return res.sendStatus(200); // 200 igual, para que DocuSign no reintente indefinidamente
    }

    if (status !== "completed" && eventName !== "envelope-completed") {
      return res.sendStatus(200);
    }

    // Respondemos 200 ya mismo, antes de descargar el PDF: DocuSign
    // Connect tiene un timeout corto (5-10 segundos) y, si el PDF tarda o
    // la API está lenta, DocuSign puede darlo por perdido y reintentar en
    // bucle. El procesamiento sigue en segundo plano, protegido con su
    // propio try/catch para que un error ahí no quede sin registrar.
    res.sendStatus(200);
    setImmediate(async () => {
      // ORDEN IMPORTANTE: primero se avanza el estado del Miembro, después
      // se intenta bajar el PDF.
      //
      // Antes era al revés, y como ya respondimos 200 DocuSign no reintenta:
      // un hipo de la API al descargar el PDF dejaba al Miembro en
      // "firma_pendiente" PARA SIEMPRE, con el Acuerdo ya firmado. El estado
      // del negocio no puede depender de que un archivo se baje bien.
      try {
        await onEnvelopeCompleted({ envelopeId });
        console.log(`✅ Envelope ${envelopeId} completado — Miembro actualizado a "firmado_pendiente_pago".`);
      } catch (err) {
        console.error(`❌ Error actualizando el estado del sobre ${envelopeId}:`, err);
        return;
      }

      try {
        const pdfBytes = await downloadSignedDocument(envelopeId);
        if (typeof onDocumentDownloaded === "function") {
          await onDocumentDownloaded({ envelopeId, pdfBytes });
        }
      } catch (err) {
        // No es fatal: el Miembro ya avanzó. El PDF se puede recuperar
        // después desde DocuSign (queda pendiente el storage real).
        console.error(`⚠️  No se pudo descargar el PDF del sobre ${envelopeId} (el Miembro ya avanzó igual):`, err.message);
      }
    });
  } catch (err) {
    console.error("Error procesando webhook de DocuSign:", err);
    // Ojo: acá SÍ podemos usar res.sendStatus, porque este catch solo
    // cubre lo que pasa ANTES del res.sendStatus(200) de arriba (parseo
    // del body, validación de firma). Si ya respondimos, esto no se
    // vuelve a ejecutar dos veces porque el resto quedó en el setImmediate.
    if (!res.headersSent) res.sendStatus(500);
  }
}

/**
 * Consulta el estado actual de un sobre en DocuSign.
 * Devuelve el string de estado tal como lo reporta DocuSign:
 * 'sent', 'delivered', 'completed', 'declined', 'voided', etc.
 *
 * Se usa desde el endpoint /api/members/:id/envelope-status para que el
 * frontend pueda distinguir entre "el usuario SÍ firmó pero el webhook
 * tardó" (status = 'completed') y "el usuario NO llegó a firmar"
 * (status = 'sent' / 'delivered'), y darle la opción de reintentar la
 * firma solo en el segundo caso.
 */
async function getEnvelopeStatus(envelopeId) {
  const apiClient = await getAuthenticatedApiClient();
  const envelopesApi = new docusign.EnvelopesApi(apiClient);
  const result = await envelopesApi.getEnvelope(
    process.env.DOCUSIGN_ACCOUNT_ID,
    envelopeId,
    {}
  );
  return result.status; // 'completed' | 'sent' | 'delivered' | 'declined' | 'voided'
}

module.exports = { createEnvelopeAndGetSigningUrl, createSigningUrlForEnvelope, downloadSignedDocument, handleConnectWebhook, getEnvelopeStatus };
