/**
 * Test de la guarda anti-doble-cobro (markPaid) sin levantar el servidor:
 * se extrae la función de server.js y se la corre contra una base falsa.
 * Sirve porque markPaid es lógica pura salvo por la llamada a db.updateMember.
 */
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
const m = src.match(/async function markPaid\(member, patch, origen, client\) \{[\s\S]*?\n\}/);
if (!m) { console.error('No se encontró markPaid en server.js'); process.exit(1); }

let updates = [], errores = [];
const db = { updateMember: async (id, patch) => { updates.push({ id, patch }); return { ...patch, id }; } };
const console2 = { log(){}, error:(s)=>errores.push(s), warn(){} };
const markPaid = new Function('db', 'console', `${m[0]}; return markPaid;`)(db, console2);

let ok=0, ko=0;
const chk=(n,c,d)=>{c?ok++:ko++;console.log(`  ${c?'✅':'❌'} ${n}${d?' — '+d:''}`)};

(async () => {
  // 1) primer pago: marca activo
  updates=[]; errores=[];
  let r = await markPaid({ id:'m1', status:'firmado_pendiente_pago' }, { mpPaymentId:'P1' }, 'Mercado Pago');
  chk('primer pago marca activo', updates.length===1 && updates[0].patch.status==='activo' && updates[0].patch.mpPaymentId==='P1');

  // 2) MISMO pago repetido (webhook reintentado): no duplica ni alerta
  updates=[]; errores=[];
  await markPaid({ id:'m1', status:'activo', mpPaymentId:'P1' }, { mpPaymentId:'P1' }, 'Mercado Pago');
  chk('webhook reintentado es idempotente', updates.length===0 && errores.length===0);

  // 3) pago DISTINTO sobre un miembro que ya pagó: NO pisa y alerta
  updates=[]; errores=[];
  const antes = { id:'m1', status:'activo', mpPaymentId:'P1' };
  const desp = await markPaid(antes, { mpPaymentId:'P2' }, 'Mercado Pago');
  chk('cobro duplicado NO pisa el pago original', updates.length===0 && desp.mpPaymentId==='P1');
  chk('cobro duplicado deja alerta en el log', errores.some(e=>/COBRO DUPLICADO/.test(e)), errores[0]? errores[0].slice(0,58)+'…':'sin alerta');

  // 4) cruce de proveedores: pagó con MP y llega uno de Stripe
  updates=[]; errores=[];
  await markPaid({ id:'m2', status:'activo', mpPaymentId:'P1' }, { stripePaymentId:'S1' }, 'Stripe');
  chk('duplicado entre proveedores distintos también se detecta', updates.length===0 && errores.some(e=>/COBRO DUPLICADO/.test(e)));

  // 5) reconciliación sobre un miembro que nunca pagó
  updates=[]; errores=[];
  await markPaid({ id:'m3', status:'firmado_pendiente_pago' }, { stripePaymentId:'S9' }, 'Stripe');
  chk('reconciliación activa marca activo si no había pago', updates.length===1 && updates[0].patch.status==='activo');

  // 6) auditoría: un pago no puede activar a alguien que todavía no firmó
  updates=[]; errores=[];
  const noFirmado = await markPaid({ id:'m4', status:'nuevo' }, { mpPaymentId:'P4' }, 'Mercado Pago');
  chk('pago sobre Miembro sin firmar NO activa', updates.length===0 && noFirmado.status==='nuevo');
  chk('pago sobre Miembro sin firmar deja alerta en el log', errores.some(e=>/no se activa/i.test(e)));

  console.log(`\n  ${ok} OK · ${ko} fallidos`);
  process.exit(ko?1:0);
})();
