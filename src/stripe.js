/**
 * Integración con Stripe Checkout — para Miembros que pagan con tarjeta
 * internacional directamente en USD (evita el problema de conversión a ARS
 * de Mercado Pago).
 */

const Stripe = require("stripe");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const { frontendBase } = require("./config");

/**
 * Crea una sesión de Stripe Checkout (página de pago alojada por Stripe).
 */
async function createCheckoutSession({ memberId, memberName, memberEmail, amountUsd }) {
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: memberEmail,
    client_reference_id: memberId,
    line_items: [
      {
        price_data: {
          currency: "usd",
          product_data: {
            name: "Aporte de Capital — Ditelli Capital (SELON II)",
            description: `Aporte proporcional al Proyecto — Miembro ${memberName}`,
          },
          unit_amount: Math.round(amountUsd * 100), // Stripe usa centavos
        },
        quantity: 1,
      },
    ],
    // Mismo criterio que en mercadopago.js: volvemos al mismo HTML con
    // query params, no a una ruta que no existe en un sitio estático.
    success_url: `${frontendBase()}/?payment=exitoso&memberId=${memberId}&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${frontendBase()}/?payment=error&memberId=${memberId}`,
  });

  return { checkoutUrl: session.url, sessionId: session.id };
}

/**
 * Handler del webhook de Stripe. Stripe firma cada evento — por eso acá
 * (a diferencia de Mercado Pago) SÍ hay que verificar la firma con el
 * STRIPE_WEBHOOK_SECRET antes de confiar en el contenido.
 */
async function handleWebhook(req, res, { onPaymentApproved }) {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    // req.body debe ser el buffer crudo — ver server.js (express.raw en esta ruta)
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Firma de webhook de Stripe inválida:", err.message);
    return res.sendStatus(400);
  }

  console.log(`📩 Webhook de Stripe recibido — event.type=${event.type}`);

  try {
    // Auditoría: antes solo se escuchaba "checkout.session.completed". La
    // documentación oficial de Stripe (Fulfill orders / How Checkout works)
    // dice explícitamente que, para métodos de pago asincrónicos (débito,
    // algunas transferencias — hoy NO habilitados en el dashboard, solo
    // tarjeta), ese evento puede llegar con payment_status="unpaid", y que
    // hay que escuchar TAMBIÉN "checkout.session.async_payment_succeeded"
    // (que sí llega con payment_status="paid") para no perder ese pago. Con
    // tarjeta esto es y seguirá siendo un no-op (payment_status ya viene
    // "paid" en checkout.session.completed), pero si el día de mañana se
    // habilita otro método de pago en el dashboard de Stripe sin tocar
    // código acá, esos pagos quedarían invisibles — la reconciliación activa
    // de /status los rescataría eventualmente, pero solo si el Miembro
    // vuelve a abrir la página.
    if (event.type === "checkout.session.async_payment_failed") {
      const session = event.data.object;
      console.warn(`⚠️  Pago asincrónico fallido — sesión ${session.id}, Miembro ${session.client_reference_id || "(desconocido)"}.`);
      return res.sendStatus(200);
    }

    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
      const session = event.data.object;

      // checkout.session.completed se dispara cuando el Miembro termina el
      // paso en pantalla — con tarjeta (lo único habilitado hoy) eso
      // coincide con el cobro real, pero si en el dashboard de Stripe se
      // habilita algún método de pago asincrónico (débito, transferencia,
      // etc.), la sesión puede completarse con el pago todavía sin
      // acreditar. payment_status === "paid" es la confirmación real.
      if (session.payment_status !== "paid") {
        console.log(`⏳ Sesión ${session.id} completada pero fondos no acreditados todavía (payment_status=${session.payment_status}).`);
        return res.sendStatus(200);
      }
      if (!session.client_reference_id) {
        console.error(`❌ Sesión ${session.id} aprobada pero sin client_reference_id — no sabemos a qué Miembro corresponde.`);
        return res.sendStatus(200);
      }

      await onPaymentApproved({
        memberId: session.client_reference_id,
        paymentId: session.id,
        amountUsd: session.amount_total / 100,
        payerEmail: session.customer_email,
      });
      console.log(`✅ Pago aprobado — Miembro ${session.client_reference_id} actualizado a "activo".`);
    }
    res.sendStatus(200);
  } catch (err) {
    // Separado del try/catch de arriba a propósito: si esto falla, la firma
    // YA fue validada, así que le devolvemos 500 (no 400) para que Stripe
    // reintente el mismo evento más tarde — no es un problema del webhook
    // en sí, sino algo que falló de nuestro lado (ej. la base de datos).
    console.error("Error procesando webhook de Stripe:", err);
    res.sendStatus(500);
  }
}

/**
 * Reconciliación: consulta el estado real de una sesión de Checkout.
 * Misma idea que findApprovedPayment en mercadopago.js — no depender al 100%
 * de que el webhook haya llegado.
 *
 * @returns {Promise<{paid: boolean, paymentId: string, amountUsd: number} | null>}
 */
async function getSessionPaymentStatus(sessionId) {
  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    return {
      paid: session.payment_status === "paid",
      paymentId: session.id,
      amountUsd: session.amount_total != null ? session.amount_total / 100 : undefined,
    };
  } catch (err) {
    console.warn(`⚠️  No se pudo reconciliar contra Stripe la sesión ${sessionId}:`, err.message || err);
    return null;
  }
}

module.exports = { createCheckoutSession, handleWebhook, getSessionPaymentStatus };
