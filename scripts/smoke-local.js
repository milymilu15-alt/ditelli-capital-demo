#!/usr/bin/env node
/**
 * Smoke test local — levanta el server con variables FALSAS y comprueba que
 * arranca y que las rutas protegidas rechazan sin token.
 *
 *   node scripts/smoke-local.js
 *
 * No usa credenciales reales ni toca la base: las llamadas que necesitarían
 * Postgres nunca llegan a ejecutarse, porque el middleware de sesión corta
 * antes. Sirve para verificar en 10 segundos que un cambio no rompió el boot
 * ni el cableado de las rutas.
 */
const { spawn } = require("child_process");
const path = require("path");

const PORT = 3999;
const env = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: "development",
  APP_BASE_URL: `http://127.0.0.1:${PORT}`,
  FRONTEND_URL: "http://127.0.0.1:8080",
  DATABASE_URL: "postgresql://falso:falso@127.0.0.1:1/falso",
  SESSION_JWT_SECRET: "smoke-test-secret-no-usar-en-produccion",
  DOCUSIGN_ACCOUNT_ID: "falso", DOCUSIGN_INTEGRATION_KEY: "falso",
  DOCUSIGN_USER_ID: "falso", DOCUSIGN_BASE_PATH: "https://demo.docusign.net/restapi",
  DOCUSIGN_TEMPLATE_ID: "falso", DOCUSIGN_CONNECT_HMAC_KEY: "falso",
  DOCUSIGN_PRIVATE_KEY_CONTENT: "-----BEGIN RSA PRIVATE KEY-----\nfalso\n-----END RSA PRIVATE KEY-----",
  MP_ACCESS_TOKEN: "falso", MP_WEBHOOK_SECRET: "falso",
  STRIPE_SECRET_KEY: "sk_test_falso", STRIPE_WEBHOOK_SECRET: "whsec_falso",
  // Este smoke verifica la POSTURA DE PRODUCCIÓN: las rutas de firma y pago
  // tienen que responder 403 (compuerta cerrada). Se fijan explícitamente
  // acá para que el resultado no dependa de lo que diga el .env de la
  // máquina donde se corre — en la rama demo ese archivo las tiene en true
  // y, sin esta línea, el smoke daría 401 en vez de 403 y parecería roto.
  FLUJO_PUBLICO_HABILITADO: "false",
  MODO_DEMO: "false",
};
delete env.DOCUSIGN_PRIVATE_KEY_PATH;

let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

const srv = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
let salida = "";
srv.stdout.on("data", d => { salida += d; });
srv.stderr.on("data", d => { salida += d; });

const esperar = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`\nLevantando el server en :${PORT} con variables falsas…\n`);
  let arrancó = false;
  for (let i = 0; i < 30 && !arrancó; i++) {
    await esperar(400);
    try { await fetch(`http://127.0.0.1:${PORT}/health`); arrancó = true; } catch {}
    if (srv.exitCode !== null) break;
  }

  if (!arrancó) {
    console.log("  ❌ el server no llegó a responder");
    console.log("\n--- salida del proceso ---\n" + salida.slice(0, 1500));
    srv.kill(); process.exit(1);
  }
  chk("el server arranca y responde", true);

  console.log("\nRutas protegidas sin token:");
  // GET /status no tiene el gate de la revisión legal (solo consulta, no
  // dispara firma ni pago) — ahí sí se llega a auth.requireMemberSession y
  // sin token da 401. Las otras cuatro pasan primero por
  // requireFlujoPublicoHabilitado (FLUJO_PUBLICO_HABILITADO no está seteada
  // acá arriba, en `env`, así que el gate corta ANTES de llegar a pedir
  // token): 403, no 401. Si algún día se prueba esto con el flag en "true",
  // hay que volver a esperar 401 en esas cuatro.
  for (const [m, p, esperado] of [
    ["GET", "/api/members/1/status", 401],
    ["POST", "/api/docusign/envelope", 403],
    ["POST", "/api/payments/mp/preference", 403],
    ["POST", "/api/payments/stripe/checkout", 403],
    ["POST", "/api/payments/transfer/notify", 403],
  ]) {
    const r = await fetch(`http://127.0.0.1:${PORT}${p}`,
      m === "POST" ? { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" } : {});
    chk(`${m} ${p}`, r.status === esperado, `${r.status}`);
  }

  console.log("\nSolicitud de membresía (ruta pública, revisión legal pre-lanzamiento):");
  const solicitudVacia = await fetch(`http://127.0.0.1:${PORT}/api/membership-requests`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  chk("POST /api/membership-requests existe y valida (400 con body vacío, no 404)", solicitudVacia.status === 400, `${solicitudVacia.status}`);

  console.log("\nCabeceras y healthcheck:");
  const h = await fetch(`http://127.0.0.1:${PORT}/health`);
  chk("/health responde (503 es correcto: la base es falsa)", h.status === 503 || h.status === 200, String(h.status));
  chk("helmet activo (X-Content-Type-Options)", !!h.headers.get("x-content-type-options"));
  chk("X-Powered-By oculto", !h.headers.get("x-powered-by"));

  console.log(`\n  ${ok} OK · ${ko} fallidos\n`);
  srv.kill();
  process.exit(ko ? 1 : 0);
})();
