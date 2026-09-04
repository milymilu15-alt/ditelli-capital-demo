/**
 * Integración con Mercado Pago — Checkout Pro (página de pago alojada por MP).
 *
 * Por qué Checkout Pro y no un formulario de tarjeta propio:
 * el número de tarjeta nunca toca tu servidor, así que no quedás alcanzado
 * por el alcance más exigente de la certificación PCI-DSS.
 *
 * Flujo:
 *  1) El frontend llama a POST /api/payments/mp/preference con { memberId, amountUsd }
 *  2) Este módulo crea una "preferencia" de pago en Mercado Pago y devuelve la URL de checkout
 *  3) El frontend redirige al Miembro a esa URL
 *  4) Mercado Pago le pega a nuestro webhook cuando el pago cambia de estado
 */

const { MercadoPagoConfig, Preference, Payment, WebhookSignatureValidator, InvalidWebhookSignatureError } = require("mercadopago");
const { usdToArs } = require("./fx");
const { frontendBase } = require("./config");

const client = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
});

/**
 * Crea una preferencia de pago para el Aporte de un Miembro.
 * @param {{ memberId: string, memberName: string, memberEmail: string, amountUsd: number }} params
 */
async function createPreference({ memberId, memberName, memberEmail, amountUsd }) {
  // usdToArs ahora devuelve también la cotización usada y su origen. Si no
  // pudo conseguir una confiable, LANZA en vez de inventar un número: el
  // pago no arranca y el Miembro ve un error claro (ver src/fx.js).
  const { amountArs, rate: fxRate, source: fxSource } = await usdToArs(amountUsd);
  console.log(`💱 Aporte USD ${amountUsd} → ARS ${amountArs} (cotización ${fxRate}, fuente ${fxSource}).`);

  const preference = new Preference(client);

  const result = await preference.create({
    body: {
      items: [
        {
          id: `aporte-${memberId}`,
          title: "Aporte de Capital — Ditelli Capital (SELON II)",
          description: `Aporte proporcional al Proyecto — Miembro ${memberName}`,
          quantity: 1,
          currency_id: "ARS",
          unit_price: amountArs,
        },
      ],
      payer: { name: memberName, email: memberEmail },
      // external_reference es la clave que usamos para matchear el pago
      // con el registro del Miembro en nuestra base de datos.
      external_reference: memberId,
      // OJO: la landing es un único HTML estático, sin rutas propias.
      // Por eso estas back_urls no apuntan a paths tipo "/adhesion/..."
      // (que darían 404), sino al mismo documento con query params que
      // el script de la landing lee al cargar para reabrir el modal en
      // el paso de confirmación. Ver el bloque "Reapertura tras volver
      // de un pago externo" en el HTML.
      back_urls: {
        success: `${frontendBase()}/?payment=exitoso&memberId=${memberId}`,
        pending: `${frontendBase()}/?payment=pendiente&memberId=${memberId}`,
        failure: `${frontendBase()}/?payment=error&memberId=${memberId}`,
      },
      auto_return: "approved",
      notification_url: `${process.env.APP_BASE_URL}/api/payments/mp/webhook`,
      statement_descriptor: "DITELLI CAPITAL",
    },
  });

  return {
    preferenceId: result.id,
    checkoutUrl: result.init_point, // URL a la que redirigís al Miembro
    amountArs,
    // Se devuelven para poder registrarlos en la base (auditoría contable) y
    // para poder mostrarle al Miembro cuánto va a pagar en pesos y a qué
    // cotización, ANTES de mandarlo al checkout de Mercado Pago.
    fxRate,
    fxSource,
  };
}

/**
 * Valida que el webhook realmente venga de Mercado Pago, no de cualquiera
 * que le pegue a esta URL sabiendo el formato. MP manda un header
 * `x-signature` con un HMAC-SHA256 calculado con un secreto que vos
 * generás en tu cuenta de MP (no es el mismo valor que MP_ACCESS_TOKEN).
 *
 * Referencia: mercadopago.com.ar/developers → Tus integraciones → Webhooks
 * → ahí, además de la URL de notificación, te muestra la "Firma secreta"
 * — esa va en MP_WEBHOOK_SECRET.
 *
 * Auditoría: esto era una implementación HMAC a mano (parseo del header +
 * crypto.createHmac). Se reemplazó por WebhookSignatureValidator, el
 * validador OFICIAL que trae el propio SDK de Mercado Pago instalado
 * (mercadopago@3.4.0 — confirmado leyendo
 * node_modules/mercadopago/dist/utils/webhook/index.js), que implementa el
 * mismo algoritmo pero mantenido por MP en vez de por nosotros.
 *
 * A propósito NO se le pasa `toleranceSeconds` (que rechazaría firmas con
 * un `ts` viejo, mitigando replay): la documentación oficial de MP dice que
 * reintenta notificaciones fallidas cada 15 minutos, extendiéndose más
 * después del tercer intento, y NO aclara si cada reintento reusa el `ts`/
 * firma original o los recalcula. Agregar una ventana corta sin confirmar
 * eso arriesgaba rechazar reintentos legítimos — mismo tipo de suposición
 * sobre una API de terceros que ya salió mal una vez en este proyecto. Ver
 * la sección 3 del informe de auditoría para más detalle.
 *
 * IMPORTANTE antes de confiar en esto en producción: probá con el
 * simulador de webhooks del panel de MP y mirá los logs — si loguea
 * "Firma de Mercado Pago inválida" con una notificación real, algo no
 * coincide y hay que revisarlo ANTES de que esto empiece a rechazar pagos
 * reales.
 */
function isValidMpSignature(req) {
  const secret = process.env.MP_WEBHOOK_SECRET;
  if (!secret) {
    console.warn(
      "MP_WEBHOOK_SECRET no está configurado — no se puede validar el origen del webhook de Mercado Pago."
    );
    return false;
  }

  // Según la documentación de MP, para el tópico "payment" el data.id
  // suele venir en el query string de la URL — así lo venimos leyendo. Se
  // agrega el body como respaldo por si en algún caso llega solo ahí.
  const dataId = req.query["data.id"] || req.query.id || req.body?.data?.id || req.body?.id;

  try {
    WebhookSignatureValidator.validate({
      xSignature: req.headers["x-signature"],
      xRequestId: req.headers["x-request-id"],
      dataId,
      secret,
    });
    return true;
  } catch (err) {
    if (err instanceof InvalidWebhookSignatureError) {
      console.warn(`⚠️  Firma de Mercado Pago inválida (${err.reason}).`);
    } else {
      console.warn("⚠️  Error validando la firma de Mercado Pago:", err.message || err);
    }
    return false;
  }
}

/**
 * Handler del webhook de Mercado Pago (IPN).
 * MP pega acá cada vez que un pago cambia de estado.
 */
async function handleWebhook(req, res, { onPaymentApproved }) {
  try {
    // La firma HMAC es la primera línea de defensa para no procesar basura.
    // Aun así, la fuente de verdad real es la re-consulta a payment.get() de
    // abajo — nadie puede falsificar un pago aprobado con datos inventados
    // si siempre confirmamos contra los servidores de MP.
    if (!isValidMpSignature(req)) {
      console.warn("⚠️  Firma de Mercado Pago inválida — se ignora la notificación.");
      // Respondemos 200 aunque no procesemos: si devolvemos 4xx, MP
      // reintenta indefinidamente el mismo webhook no válido.
      return res.sendStatus(200);
    }

    const topic = req.query.type || req.query.topic;
    const paymentId = req.query["data.id"] || req.query.id || req.body?.data?.id || req.body?.id;
    console.log(`📩 Webhook de Mercado Pago recibido — topic=${topic || "(sin topic)"} paymentId=${paymentId || "(sin id)"}`);

    if (topic !== "payment" || !paymentId) {
      return res.sendStatus(200); // ack — no es un evento que nos interese
    }

    const payment = new Payment(client);
    let paymentInfo;
    try {
      paymentInfo = await payment.get({ id: paymentId });
    } catch (mpErr) {
      // Un paymentId que no existe en Mercado Pago (bot, escáner, ID
      // inventado a mano) no es un error nuestro — respondemos 200 para
      // que MP no reintente esto en bucle, y logueamos como advertencia,
      // no como error, para no generar alertas falsas.
      console.warn(`⚠️  No se pudo obtener el pago ${paymentId} desde Mercado Pago:`, mpErr.message || mpErr);
      return res.sendStatus(200);
    }
    console.log(`   → estado del pago en MP: ${paymentInfo.status}`);

    if (paymentInfo.status === "approved") {
      const memberId = paymentInfo.external_reference;
      if (!memberId) {
        console.warn(`⚠️  Pago aprobado ${paymentInfo.id} sin external_reference — no sabemos a qué Miembro corresponde.`);
        return res.sendStatus(200);
      }
      await onPaymentApproved({
        memberId,
        paymentId: paymentInfo.id,
        amountArs: paymentInfo.transaction_amount,
        payerEmail: paymentInfo.payer?.email,
      });
      console.log(`✅ Pago aprobado — Miembro ${memberId} actualizado a "activo".`);
    }

    // Siempre respondemos 200 rápido — si no, MP reintenta el webhook.
    res.sendStatus(200);
  } catch (err) {
    console.error("Error procesando webhook de Mercado Pago:", err);
    res.sendStatus(500);
  }
}

/**
 * Reconciliación: pregunta a Mercado Pago si existe un pago APROBADO para
 * este Miembro, usando el external_reference con el que se creó la
 * preferencia.
 *
 * Es la red de seguridad para cuando el webhook no llega — que pasa más
 * seguido de lo que uno quisiera: firma mal configurada en el panel, backend
 * dormido, un deploy justo en ese minuto. Sin esto, el Miembro pagó, la
 * plata está en la cuenta de Ditelli, y en la base figura como que no pagó.
 *
 * @returns {Promise<{paymentId: string, amountArs: number} | null>}
 */
async function findApprovedPayment(memberId) {
  try {
    const payment = new Payment(client);
    const result = await payment.search({
      options: { external_reference: memberId, sort: "date_created", criteria: "desc", limit: 10 },
    });
    const results = (result && (result.results || result.elements)) || [];
    const approved = results.find((p) => p.status === "approved");
    if (!approved) return null;
    return { paymentId: String(approved.id), amountArs: approved.transaction_amount };
  } catch (err) {
    console.warn(`⚠️  No se pudo reconciliar contra Mercado Pago para ${memberId}:`, err.message || err);
    return null;
  }
}

module.exports = { createPreference, handleWebhook, findApprovedPayment };
