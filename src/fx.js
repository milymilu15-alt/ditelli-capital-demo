/**
 * Conversión USD → ARS para los Aportes cotizados en dólares.
 *
 * Mercado Pago Argentina liquida en pesos, así que el Aporte (definido en
 * USD en el Acuerdo de Participación) tiene que convertirse antes de crear
 * la preferencia de pago.
 *
 * Fuente: dolarapi.com (dólar oficial). Es pública, gratuita, sin API key,
 * y publica el mismo valor que el BCRA. Si Ditelli decide con su contador
 * usar otra cotización (MEP, tarjeta, una fija pactada), se cambia
 * DOLARAPI_URL o FX_FIXED_RATE_ARS_PER_USD y no hace falta tocar nada más.
 *
 * Tres decisiones importantes acá:
 *
 * 1) CACHÉ de 10 minutos. La cotización no se mueve dentro de ese lapso, y
 *    así no le pegamos a la API en cada creación de preferencia.
 *
 * 2) FALLA CERRADA. Si no se puede obtener una cotización confiable, esta
 *    función LANZA en vez de devolver un número inventado. Antes había un
 *    FALLBACK_RATE_ARS_PER_USD = 1250 fijo: con cualquier cotización real
 *    por encima de ese valor, Ditelli cobraba de menos en cada operación,
 *    en silencio y de forma acumulativa. Es preferible que el pago no
 *    arranque y el Miembro vea un error claro, a cobrarle mal.
 *
 * 3) Se devuelve TAMBIÉN la cotización usada, no solo el monto. Sin
 *    registrar a qué tipo de cambio se cobró cada operación no hay
 *    auditoría contable posible (ver columnas fx_rate_ars_per_usd y
 *    amount_ars en schema.sql).
 */

const DOLARAPI_URL = process.env.DOLARAPI_URL || "https://dolarapi.com/v1/dolares/oficial";
const CACHE_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

// Escotilla de emergencia: si la API está caída y hay que cobrar igual, se
// setea FX_FIXED_RATE_ARS_PER_USD en el entorno con la cotización del día
// acordada con el contador. Es explícito y auditable — muy distinto de un
// número hardcodeado en el código que nadie recuerda que existe.
function fixedRateFromEnv() {
  const raw = process.env.FX_FIXED_RATE_ARS_PER_USD;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

let cache = { rate: null, fetchedAt: 0 };

async function fetchRate() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(DOLARAPI_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`dolarapi respondió ${res.status}`);
    const data = await res.json();
    // dolarapi devuelve { compra, venta, ... }. Para cobrarle a un Miembro
    // corresponde "venta": es el precio al que se compran los dólares.
    const rate = Number(data && data.venta);
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new Error(`cotización inesperada en la respuesta: ${JSON.stringify(data)}`);
    }
    return rate;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Devuelve la cotización ARS por USD, con caché de 10 minutos.
 *
 * Auditoría: antes esto devolvía solo el número, y usdToArs adivinaba el
 * `source` de vuelta comparando el estado ACTUAL de `cache`/env — eso podía
 * mentir. Ejemplo real: dolarapi respondió bien una vez (cache.rate queda
 * seteado), después empieza a fallar, y Ditelli carga
 * FX_FIXED_RATE_ARS_PER_USD como respaldo manual. La cotización realmente
 * USADA en ese momento es la fija del entorno — pero como `cache.rate`
 * seguía teniendo el valor viejo (nunca se limpia), la condición vieja
 * (`!cache.rate`) daba falso y el `source` reportado quedaba como
 * "dolarapi.com", contradiciendo el propio log de warning de la línea de
 * arriba. Ahora cada rama devuelve su propio `source` explícito en el
 * mismo momento en que decide qué número usar, sin tener que reconstruirlo
 * después a partir de estado que pudo haber cambiado.
 */
async function getRate() {
  const now = Date.now();
  if (cache.rate && now - cache.fetchedAt < CACHE_TTL_MS) {
    return { rate: cache.rate, source: DOLARAPI_URL };
  }

  try {
    const rate = await fetchRate();
    cache = { rate, fetchedAt: now };
    return { rate, source: DOLARAPI_URL };
  } catch (err) {
    console.error("❌ No se pudo obtener la cotización USD→ARS:", err.message);

    // Cotización fija cargada a mano en el entorno: es una decisión
    // consciente del equipo, así que se respeta.
    const fixed = fixedRateFromEnv();
    if (fixed) {
      console.warn(`⚠️  Usando FX_FIXED_RATE_ARS_PER_USD=${fixed} (cargada manualmente en el entorno).`);
      return { rate: fixed, source: "env:FX_FIXED_RATE_ARS_PER_USD" };
    }

    // Caché vencida pero existente: mejor una cotización de hace un rato
    // que ninguna. Se avisa fuerte para que quede en los logs.
    if (cache.rate) {
      const mins = Math.round((now - cache.fetchedAt) / 60000);
      console.warn(`⚠️  Usando la última cotización conocida (${cache.rate}), de hace ${mins} min.`);
      return { rate: cache.rate, source: `${DOLARAPI_URL} (caché vencida hace ${mins} min)` };
    }

    throw new Error(
      "No se pudo obtener la cotización USD→ARS y no hay ninguna de respaldo. " +
      "El pago no se inicia para no cobrar un monto incorrecto."
    );
  }
}

/**
 * Convierte un monto en USD a ARS.
 * @returns {Promise<{ amountArs: number, rate: number, source: string }>}
 */
async function usdToArs(amountUsd) {
  const { rate, source } = await getRate();
  return { amountArs: Math.round(amountUsd * rate), rate, source };
}

module.exports = { usdToArs, getRate, _resetCacheForTests: () => { cache = { rate: null, fetchedAt: 0 }; } };
