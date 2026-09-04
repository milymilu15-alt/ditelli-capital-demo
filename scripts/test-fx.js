const path=require('path').join(__dirname, '..', 'src', 'fx.js');
let ok=0, ko=0;
const chk=(n,c,d)=>{c?ok++:ko++;console.log(`  ${c?'✅':'❌'} ${n}${d?' — '+d:''}`)};
(async()=>{
  // 1) camino feliz
  global.fetch = async () => ({ ok:true, json: async () => ({ compra: 1400, venta: 1450 }) });
  let fx = require(path); fx._resetCacheForTests();
  let r = await fx.usdToArs(5000);
  chk('usa "venta" y redondea', r.amountArs===7250000 && r.rate===1450, `ARS ${r.amountArs} @ ${r.rate}`);

  // 2) caché: segunda llamada no vuelve a pegarle a la API
  let hits=0; global.fetch = async () => { hits++; return { ok:true, json: async()=>({venta:9999}) }; };
  await fx.usdToArs(1000);
  chk('cachea 10 min', hits===0, `llamadas a la API: ${hits}`);

  // 3) API caída, sin caché y sin env → LANZA (no inventa un número)
  delete require.cache[require.resolve(path)];
  delete process.env.FX_FIXED_RATE_ARS_PER_USD;
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };
  fx = require(path); fx._resetCacheForTests();
  try { await fx.usdToArs(5000); chk('falla cerrada si no hay cotización', false, 'devolvió un monto igual'); }
  catch(e){ chk('falla cerrada si no hay cotización', /no se pudo obtener/i.test(e.message)); }

  // 4) API caída pero con cotización fija en el entorno
  delete require.cache[require.resolve(path)];
  process.env.FX_FIXED_RATE_ARS_PER_USD='1500';
  fx = require(path); fx._resetCacheForTests();
  r = await fx.usdToArs(2000);
  chk('respeta FX_FIXED_RATE_ARS_PER_USD', r.amountArs===3000000, `ARS ${r.amountArs}`);

  // 5) respuesta malformada de la API
  delete require.cache[require.resolve(path)];
  delete process.env.FX_FIXED_RATE_ARS_PER_USD;
  global.fetch = async () => ({ ok:true, json: async()=>({ mensaje:'mantenimiento' }) });
  fx = require(path); fx._resetCacheForTests();
  try { await fx.usdToArs(5000); chk('rechaza respuesta malformada', false, 'la aceptó'); }
  catch(e){ chk('rechaza respuesta malformada', true); }

  console.log(`\n  ${ok} OK · ${ko} fallidos`);
  process.exit(ko?1:0);
})();
