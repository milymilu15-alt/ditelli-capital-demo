/**
 * Envío de correo transaccional vía Resend.
 *
 * Se usa la API REST con fetch nativo (Node 18+) en vez del SDK: es una sola
 * llamada HTTP, y evita sumar una dependencia más al proyecto.
 *
 * TRES REGLAS QUE VALEN PARA TODO ESTE MÓDULO:
 *
 * 1) FALLA BLANDA, SIEMPRE. Ninguna función de acá lanza. Si el correo no se
 *    puede mandar, se loguea y la operación de negocio sigue. Que un Miembro
 *    no reciba el mail de confirmación es molesto; que no quede registrado su
 *    pago porque el servidor de correo estaba caído sería mucho peor.
 *
 * 2) NADA DE SECRETOS EN EL CÓDIGO. La API key viene de RESEND_API_KEY.
 *
 * 3) SI NO ESTÁ CONFIGURADO, NO ROMPE. Sin RESEND_API_KEY el módulo queda
 *    desactivado y solo deja una advertencia en el log. Así el backend se
 *    puede levantar y probar sin cuenta de correo.
 */

const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 10000;

function isEnabled() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

/** Envío crudo. Devuelve true/false; nunca lanza. */
async function send({ to, subject, html, attachments, idempotencyKey }) {
  if (!isEnabled()) {
    console.warn(`✉️  Correo NO enviado a ${to} ("${subject}"): falta RESEND_API_KEY o MAIL_FROM.`);
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    };
    // Evita duplicados si un webhook se reintenta y vuelve a disparar el envío.
    if (idempotencyKey) headers["Idempotency-Key"] = String(idempotencyKey).slice(0, 256);

    const body = {
      from: process.env.MAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    };
    if (process.env.MAIL_REPLY_TO) body.reply_to = process.env.MAIL_REPLY_TO;
    if (attachments && attachments.length) body.attachments = attachments;

    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const detalle = await res.text().catch(() => "");
      console.error(`❌ Resend respondió ${res.status} al enviar "${subject}" a ${to}: ${detalle.slice(0, 300)}`);
      return false;
    }
    const data = await res.json().catch(() => ({}));
    console.log(`✉️  Correo enviado a ${to} ("${subject}") — id ${data.id || "(sin id)"}`);
    return true;
  } catch (err) {
    const motivo = err.name === "AbortError" ? `timeout (${TIMEOUT_MS} ms)` : err.message;
    console.error(`❌ No se pudo enviar el correo "${subject}" a ${to}: ${motivo}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plantillas
// ---------------------------------------------------------------------------

const escapar = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const fmtUsd = (n) =>
  `USD ${Number(n).toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;

/** Envoltorio visual común. Estilos en línea: es lo único que respetan los clientes de correo. */
function layout({ titulo, cuerpo, cta }) {
  const botón = cta
    ? `<tr><td style="padding:8px 0 24px;">
         <a href="${cta.url}" style="display:inline-block;background:#4F8F68;color:#ffffff;
            text-decoration:none;font-weight:600;font-size:15px;padding:14px 28px;border-radius:10px;">
           ${escapar(cta.texto)}
         </a>
       </td></tr>`
    : "";

  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:0;background:#F4F6F8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F4F6F8;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden;
                    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <tr><td style="background:#0C1A2B;padding:24px 32px;">
          <div style="color:#ffffff;font-size:17px;font-weight:600;letter-spacing:.02em;">Ditelli Capital</div>
        </td></tr>
        <tr><td style="padding:32px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="font-size:20px;font-weight:600;color:#16283D;padding-bottom:14px;">${escapar(titulo)}</td></tr>
            <tr><td style="font-size:15px;line-height:1.65;color:#3C4A5A;padding-bottom:20px;">${cuerpo}</td></tr>
            ${botón}
          </table>
        </td></tr>
        <tr><td style="background:#F4F6F8;padding:20px 32px;font-size:12px;line-height:1.6;color:#7A8899;">
          Ditelli Capital — Construimos edificios. Compartimos oportunidades.<br>
          ¿Dudas? Escribinos al +54 9 11 6533-8053.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

/** Enlace de acceso de un solo uso para retomar una solicitud. */
async function sendMagicLink({ to, name, url }) {
  return send({
    to,
    subject: "Retomá tu solicitud — Ditelli Capital",
    html: layout({
      titulo: `Hola${name ? ", " + escapar(String(name).split(" ")[0]) : ""}`,
      cuerpo:
        `Recibimos un pedido para retomar tu solicitud de Adhesión. ` +
        `Tocá el botón y seguís desde donde habías quedado.` +
        `<br><br><strong>El enlace vence en 30 minutos y se puede usar una sola vez.</strong>` +
        `<br><br>Si no fuiste vos, ignorá este mensaje: no se hizo ningún cambio en tu solicitud.`,
      cta: { url, texto: "Retomar mi solicitud" },
    }),
  });
}

/** Acuerdo firmado, con el PDF adjunto. */
async function sendAcuerdoFirmado({ to, name, pdfBytes, amountUsd, proportionalPct, envelopeId }) {
  const adjuntos = pdfBytes
    ? [{
        filename: "Acuerdo-de-Participacion-Ditelli-Capital.pdf",
        content: Buffer.from(pdfBytes).toString("base64"),
        content_type: "application/pdf",
      }]
    : [];

  return send({
    to,
    idempotencyKey: envelopeId ? `acuerdo-${envelopeId}` : undefined,
    subject: "Tu Acuerdo de Participación firmado — Ditelli Capital",
    html: layout({
      titulo: "Tu Acuerdo quedó firmado",
      cuerpo:
        `Adjuntamos la copia del <strong>Acuerdo de Participación</strong> que acabás de firmar, ` +
        `con su certificado de firma electrónica.` +
        `<br><br>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#3C4A5A;">
           <tr><td style="padding:4px 16px 4px 0;color:#7A8899;">Aporte</td><td style="font-weight:600;">${fmtUsd(amountUsd)}</td></tr>
           ${proportionalPct != null ? `<tr><td style="padding:4px 16px 4px 0;color:#7A8899;">Participación</td><td style="font-weight:600;">${Number(proportionalPct).toFixed(2)}%</td></tr>` : ""}
         </table>` +
        `<br>Guardalo: es el respaldo de tu participación en el Proyecto.` +
        (adjuntos.length ? "" : `<br><br><em>No pudimos adjuntar el PDF en este envío. Escribinos y te lo hacemos llegar.</em>`),
    }),
    attachments: adjuntos,
  });
}

/** Pago acreditado: el Miembro queda activo. */
async function sendPagoConfirmado({ to, name, amountUsd, proportionalPct, metodo, paymentId }) {
  return send({
    to,
    idempotencyKey: paymentId ? `pago-${paymentId}` : undefined,
    subject: "Aporte confirmado — ya sos Miembro de Ditelli Capital",
    html: layout({
      titulo: `¡Listo${name ? ", " + escapar(String(name).split(" ")[0]) : ""}!`,
      cuerpo:
        `Confirmamos la acreditación de tu Aporte. Ya figurás como <strong>Miembro</strong> del Proyecto.` +
        `<br><br>` +
        `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;color:#3C4A5A;">
           <tr><td style="padding:4px 16px 4px 0;color:#7A8899;">Aporte</td><td style="font-weight:600;">${fmtUsd(amountUsd)}</td></tr>
           ${proportionalPct != null ? `<tr><td style="padding:4px 16px 4px 0;color:#7A8899;">Participación</td><td style="font-weight:600;">${Number(proportionalPct).toFixed(2)}%</td></tr>` : ""}
           ${metodo ? `<tr><td style="padding:4px 16px 4px 0;color:#7A8899;">Método</td><td style="font-weight:600;">${escapar(metodo)}</td></tr>` : ""}
         </table>` +
        `<br>Vas a recibir reportes de avance del Proyecto de forma periódica.`,
    }),
  });
}

/** Aviso de transferencia registrado, pendiente de confirmación manual. */
async function sendTransferenciaRegistrada({ to, name, amountUsd }) {
  return send({
    to,
    subject: "Recibimos tu aviso de transferencia — Ditelli Capital",
    html: layout({
      titulo: "Aviso registrado",
      cuerpo:
        `Registramos tu aviso de transferencia por <strong>${fmtUsd(amountUsd)}</strong>.` +
        `<br><br>Vamos a verificarlo contra el extracto bancario y te confirmamos apenas esté acreditado ` +
        `— normalmente dentro de las 48 horas hábiles.` +
        `<br><br>Si pasado ese plazo no tenés novedades, escribinos.`,
    }),
  });
}

module.exports = {
  isEnabled,
  send,
  sendMagicLink,
  sendAcuerdoFirmado,
  sendPagoConfirmado,
  sendTransferenciaRegistrada,
  // Expuesto para que quien arme un HTML de correo por fuera de este módulo
  // (ver el aviso de solicitud de membresía en server.js) no tenga que
  // reimplementar el escape — meter datos que mandó un visitante sin
  // escapar en un mail HTML es una inyección esperando a pasar.
  escapar,
};
