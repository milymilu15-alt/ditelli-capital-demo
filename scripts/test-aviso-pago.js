/**
 * Test de avisarPagoConfirmado — la función que decide si mandar el correo de
 * "pago confirmado".
 *
 * Misma técnica que test-markpaid.js: se extrae la función real de server.js y
 * se la corre contra dobles, sin levantar Express ni tocar la base.
 *
 * Lo que importa verificar acá es que NO se mande el correo dos veces. Los
 * proveedores de pago reintentan sus webhooks de forma rutinaria; si cada
 * reintento disparara un correo, el Miembro recibiría el mismo aviso varias
 * veces por un único pago.
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const m = src.match(/async function avisarPagoConfirmado\(antes, despues, origen\) \{[\s\S]*?\n\}/);
if (!m) { console.error('No se encontró avisarPagoConfirmado en server.js'); process.exit(1); }

let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? '✅' : '❌'} ${n}${d ? ' — ' + d : ''}`); };

let correos = [];
const mailer = { sendPagoConfirmado: async (a) => { correos.push(a); return true; } };
const avisar = new Function('mailer', `${m[0]}; return avisarPagoConfirmado;`)(mailer);

const pagando = { id:'m1', status:'firmado_pendiente_pago', email:'a@t.com', name:'Ana', amountUsd:5000, proportionalPct:1 };
const activo  = { ...pagando, status:'activo', mpPaymentId:'P1' };

(async () => {
  // 1) primer pago: sí avisa
  correos = [];
  await avisar(pagando, activo, 'Mercado Pago');
  chk('avisa cuando el pago activa al Miembro', correos.length === 1 && correos[0].to === 'a@t.com');
  chk('el correo lleva el método y el id del pago',
      correos[0] && correos[0].metodo === 'Mercado Pago' && correos[0].paymentId === 'P1');

  // 2) webhook reintentado: el Miembro YA estaba activo
  correos = [];
  await avisar(activo, activo, 'Mercado Pago');
  chk('un webhook reintentado NO manda un segundo correo', correos.length === 0);

  // 3) cobro duplicado: markPaid devuelve el member sin cambios
  correos = [];
  await avisar(activo, activo, 'Stripe');
  chk('un cobro duplicado tampoco dispara correo', correos.length === 0);

  // 4) pago rechazado por estado inválido: markPaid devuelve el mismo member
  correos = [];
  const sinFirmar = { ...pagando, status:'nuevo' };
  await avisar(sinFirmar, sinFirmar, 'Mercado Pago');
  chk('si el pago no activó a nadie, no avisa', correos.length === 0);

  // 5) reconciliación desde /status
  correos = [];
  await avisar(pagando, activo, 'reconciliación');
  chk('la reconciliación activa también avisa', correos.length === 1 && correos[0].metodo === 'reconciliación');

  // 6) defensivo: valores nulos
  correos = [];
  await avisar(null, activo, 'x'); await avisar(pagando, null, 'x');
  chk('no rompe con valores nulos', correos.length === 0);

  console.log(`\n  ${ok} OK · ${ko} fallidos\n`);
  process.exit(ko ? 1 : 0);
})();
