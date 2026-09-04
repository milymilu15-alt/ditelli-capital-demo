/**
 * Prueba del módulo de correo SIN mandar ningún correo real: se intercepta
 * fetch y se inspecciona la petición que se le habría hecho a Resend.
 *
 *   node scripts/test-email.js
 */
process.env.RESEND_API_KEY = "re_falsa_para_test";
process.env.MAIL_FROM = "Ditelli Capital <no-reply@ejemplo.com>";
process.env.MAIL_REPLY_TO = "hola@ejemplo.com";

const email = require("../src/email");
let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

let ultima = null;
function stubFetch(status = 200, body = { id: "abc-123" }) {
  global.fetch = async (url, opts) => {
    ultima = { url, headers: opts.headers, body: JSON.parse(opts.body) };
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

(async () => {
  console.log("\n— Enlace de acceso —");
  stubFetch();
  await email.sendMagicLink({ to: "juan@test.com", name: "Juan Pérez", url: "https://api.test/api/session/TOK" });
  chk("pega al endpoint correcto", ultima.url === "https://api.resend.com/emails");
  chk("manda el Bearer", (ultima.headers.Authorization || "").startsWith("Bearer re_"));
  chk("destinatario como array", Array.isArray(ultima.body.to) && ultima.body.to[0] === "juan@test.com");
  chk("incluye reply_to", ultima.body.reply_to === "hola@ejemplo.com");
  chk("el enlace está en el cuerpo", ultima.body.html.includes("https://api.test/api/session/TOK"));
  chk("avisa que vence y es de un solo uso", /30 minutos/.test(ultima.body.html) && /una sola vez/.test(ultima.body.html));
  chk("saluda por el nombre de pila", ultima.body.html.includes("Juan") && !ultima.body.html.includes("Juan Pérez"));

  console.log("\n— Acuerdo firmado con PDF adjunto —");
  stubFetch();
  const pdf = Buffer.from("%PDF-1.7 contenido de prueba");
  await email.sendAcuerdoFirmado({ to: "juan@test.com", name: "Juan", pdfBytes: pdf,
    amountUsd: 5000, proportionalPct: 1, envelopeId: "env-9" });
  const adj = (ultima.body.attachments || [])[0];
  chk("adjunta un archivo", !!adj);
  chk("el adjunto es PDF", adj && adj.content_type === "application/pdf");
  chk("va en base64 y se puede reconstruir",
      adj && Buffer.from(adj.content, "base64").toString() === "%PDF-1.7 contenido de prueba");
  chk("usa clave de idempotencia por sobre", ultima.headers["Idempotency-Key"] === "acuerdo-env-9");
  chk("muestra el aporte formateado", /USD\s*5\.000/.test(ultima.body.html));
  chk("muestra la participación", ultima.body.html.includes("1.00%"));

  console.log("\n— Acuerdo sin PDF (la descarga falló) —");
  stubFetch();
  await email.sendAcuerdoFirmado({ to: "j@t.com", name: "J", pdfBytes: null, amountUsd: 1000 });
  chk("no inventa un adjunto vacío", !ultima.body.attachments || ultima.body.attachments.length === 0);
  chk("avisa que falta el adjunto", /No pudimos adjuntar/.test(ultima.body.html));

  console.log("\n— Pago confirmado —");
  stubFetch();
  await email.sendPagoConfirmado({ to: "j@t.com", name: "Ana López", amountUsd: 5000,
    proportionalPct: 1, metodo: "Mercado Pago", paymentId: "P1" });
  chk("idempotencia por pago", ultima.headers["Idempotency-Key"] === "pago-P1");
  chk("nombra el método", ultima.body.html.includes("Mercado Pago"));

  console.log("\n— Escapado de HTML (nombre malicioso) —");
  stubFetch();
  await email.sendPagoConfirmado({ to: "j@t.com", name: "<script>alert(1)</script>", amountUsd: 1000 });
  chk("no inyecta etiquetas", !ultima.body.html.includes("<script>alert"));

  console.log("\n— Falla blanda —");
  stubFetch(422, { message: "domain not verified" });
  chk("un 4xx devuelve false, no lanza", (await email.sendMagicLink({ to: "a@b.com", url: "x" })) === false);
  global.fetch = async () => { throw new Error("ECONNREFUSED"); };
  chk("una caída de red devuelve false, no lanza", (await email.sendMagicLink({ to: "a@b.com", url: "x" })) === false);

  console.log("\n— Sin configurar —");
  delete process.env.RESEND_API_KEY;
  delete require.cache[require.resolve("../src/email")];
  const email2 = require("../src/email");
  chk("queda desactivado", email2.isEnabled() === false);
  chk("no rompe si lo llaman igual", (await email2.sendMagicLink({ to: "a@b.com", url: "x" })) === false);

  console.log(`\n  ${ok} OK · ${ko} fallidos\n`);
  process.exit(ko ? 1 : 0);
})();
