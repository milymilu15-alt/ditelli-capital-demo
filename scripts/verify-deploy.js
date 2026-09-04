#!/usr/bin/env node
/**
 * Verificación del deploy — los gates de la Fase 1 del roadmap, automatizados.
 *
 * Uso:
 *   node scripts/verify-deploy.js https://tu-backend.up.railway.app https://tu-landing.example.com
 *
 * O con variables de entorno:
 *   APP_BASE_URL=... FRONTEND_URL=... node scripts/verify-deploy.js
 *
 * No necesita credenciales ni toca la base: son todas peticiones públicas de
 * solo lectura. Sirve para correrlo antes y después de cada deploy.
 *
 * Sale con código 1 si algún control crítico falla, para poder encadenarlo
 * en un pipeline.
 */

const API = process.argv[2] || process.env.APP_BASE_URL;
const FRONT = process.argv[3] || process.env.FRONTEND_URL;

if (!API) {
  console.error("Falta la URL del backend.\n" +
    "  node scripts/verify-deploy.js https://tu-backend.up.railway.app [https://tu-landing]");
  process.exit(2);
}

const base = API.replace(/\/+$/, "");
const origin = (FRONT || "https://ditelli-capital.surge.sh").replace(/\/+$/, "");

let criticos = 0, avisos = 0;
const ok   = (t, d) => console.log(`  ✅ ${t}${d ? " — " + d : ""}`);
const fail = (t, d) => { criticos++; console.log(`  ❌ ${t}${d ? " — " + d : ""}`); };
const warn = (t, d) => { avisos++;  console.log(`  ⚠️  ${t}${d ? " — " + d : ""}`); };

async function pedir(path, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(base + path, { ...opts, signal: ctrl.signal });
    const texto = await res.text().catch(() => "");
    return { status: res.status, headers: res.headers, texto };
  } catch (err) {
    return { error: err.name === "AbortError" ? "timeout (15s)" : err.message };
  } finally { clearTimeout(t); }
}

(async () => {
  console.log(`\nVerificando ${base}\n`);

  // ---- 1) El IDOR tiene que estar cerrado ----
  console.log("1) Rutas protegidas sin token");
  for (const path of ["/api/members/1/status", "/api/members/00000000-0000-4000-8000-000000000000/status"]) {
    const r = await pedir(path);
    if (r.error) { fail(`GET ${path}`, r.error); continue; }
    if (r.status === 401) ok(`GET ${path}`, "401 como corresponde");
    else if (r.status === 200 && /"name"|"amountUsd"/.test(r.texto))
      fail(`GET ${path}`, `¡DEVUELVE DATOS DE UN MIEMBRO! (${r.status}) — el deploy no salió o requireMemberSession no está aplicado`);
    else warn(`GET ${path}`, `esperaba 401, llegó ${r.status}`);
  }

  // Revisión legal pre-lanzamiento: estas cuatro pasan primero por el gate
  // requireFlujoPublicoHabilitado (403 mientras FLUJO_PUBLICO_HABILITADO no
  // sea "true" en el entorno) y recién después por requireMemberSession
  // (401 sin token). Cualquiera de los dos "cerrado" está bien acá — lo
  // único que importa es que NUNCA llegue a ejecutar la ruta de verdad.
  const post = { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" };
  for (const path of ["/api/docusign/envelope", "/api/payments/mp/preference",
                      "/api/payments/stripe/checkout", "/api/payments/transfer/notify"]) {
    const r = await pedir(path, post);
    if (r.error) { fail(`POST ${path}`, r.error); continue; }
    if (r.status === 401) ok(`POST ${path}`, "401");
    else if (r.status === 403) ok(`POST ${path}`, "403 — gate de la revisión legal pre-lanzamiento activo");
    else fail(`POST ${path}`, `esperaba 401 o 403, llegó ${r.status}`);
  }

  // ---- 2) Healthcheck ----
  console.log("\n2) Healthcheck");
  {
    const r = await pedir("/health");
    if (r.error) fail("GET /health", r.error);
    else if (r.status === 404) fail("GET /health", "404 — el endpoint no existe: está corriendo una versión vieja del backend");
    else if (r.status === 200 && /"db"\s*:\s*"up"/.test(r.texto)) ok("GET /health", r.texto.slice(0, 60));
    else if (r.status === 503) fail("GET /health", "503 — el proceso responde pero la BASE no");
    else warn("GET /health", `${r.status} ${r.texto.slice(0, 60)}`);
  }

  // ---- 3) Preflight CORS con Authorization ----
  console.log("\n3) Preflight CORS con Authorization");
  {
    const r = await pedir("/api/members/x/status", {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
      },
    });
    if (r.error) fail("OPTIONS preflight", r.error);
    else {
      const permitidos = (r.headers.get("access-control-allow-headers") || "").toLowerCase();
      const allowOrigin = r.headers.get("access-control-allow-origin");
      if (r.status >= 200 && r.status < 300) ok("preflight responde", String(r.status));
      else fail("preflight responde", `${r.status} — el navegador va a bloquear TODAS las llamadas protegidas`);

      permitidos.includes("authorization")
        ? ok("Access-Control-Allow-Headers incluye authorization")
        : fail("Access-Control-Allow-Headers", `no incluye "authorization" (llegó: "${permitidos || "vacío"}") — authFetch no va a funcionar desde el navegador`);

      allowOrigin ? ok("Access-Control-Allow-Origin", allowOrigin)
                  : fail("Access-Control-Allow-Origin", `ausente para el origen ${origin}`);
    }
  }

  // ---- 4) Cabeceras de seguridad (helmet) ----
  console.log("\n4) Cabeceras de seguridad");
  {
    const r = await pedir("/health");
    if (r.error) warn("no se pudieron leer las cabeceras", r.error);
    else {
      r.headers.get("strict-transport-security")
        ? ok("Strict-Transport-Security", r.headers.get("strict-transport-security"))
        : warn("Strict-Transport-Security", "ausente — ¿helmet está activo?");
      r.headers.get("x-content-type-options")
        ? ok("X-Content-Type-Options", r.headers.get("x-content-type-options"))
        : warn("X-Content-Type-Options", "ausente");
      const powered = r.headers.get("x-powered-by");
      powered ? warn("X-Powered-By", `expuesto (${powered}) — helmet debería sacarlo`)
              : ok("X-Powered-By", "oculto");
    }
  }

  // ---- 5) Rate limiting ----
  console.log("\n5) Rate limiting en POST /api/members");
  {
    let visto429 = false, ultimo = 0;
    for (let i = 0; i < 14 && !visto429; i++) {
      const r = await pedir("/api/members", post);
      if (r.error) { warn("no se pudo probar", r.error); break; }
      ultimo = r.status;
      if (r.status === 429) visto429 = true;
    }
    visto429 ? ok("corta con 429", "el limiter estricto está activo")
             : warn("no llegó a 429 en 14 intentos", `último estado: ${ultimo} — revisá strictLimiter (o el proxy ya venía con contador)`);
  }

  console.log(`\n${"─".repeat(52)}`);
  console.log(criticos === 0
    ? `✅ Gate F1 SUPERADO${avisos ? ` (con ${avisos} aviso${avisos > 1 ? "s" : ""})` : ""}`
    : `❌ Gate F1 NO superado — ${criticos} control${criticos > 1 ? "es" : ""} crítico${criticos > 1 ? "s" : ""} fallando`);
  console.log(`${"─".repeat(52)}\n`);
  process.exit(criticos === 0 ? 0 : 1);
})();
