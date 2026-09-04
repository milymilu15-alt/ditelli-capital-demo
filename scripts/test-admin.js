/**
 * Test de src/adminAuth.js (sesión de admin, panel Fase 2) sin levantar el
 * servidor ni tocar la base — mismo criterio que test-markpaid.js: es
 * lógica que no depende de Postgres, así que se prueba aislada.
 */
process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "secreto-de-test-no-usar-en-produccion";

const adminAuth = require("../src/adminAuth");

let ok = 0, ko = 0;
const chk = (n, c, d) => { c ? ok++ : ko++; console.log(`  ${c ? "✅" : "❌"} ${n}${d ? " — " + d : ""}`); };

function fakeReq({ cookies = {}, method = "GET", headers = {} } = {}) {
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  return { headers: { cookie: cookieHeader || undefined, ...headers }, method };
}
function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

(async () => {
  // ---------- Contraseñas ----------
  const hash = await adminAuth.hashPassword("una-clave-bastante-larga-123");
  chk("hashPassword no devuelve la clave en texto plano", hash !== "una-clave-bastante-larga-123" && hash.length > 20);
  chk("verifyPassword acepta la clave correcta", await adminAuth.verifyPassword("una-clave-bastante-larga-123", hash));
  chk("verifyPassword rechaza una clave incorrecta", !(await adminAuth.verifyPassword("otra-clave", hash)));
  chk("verifyPassword no explota con hash undefined (admin inexistente)", !(await adminAuth.verifyPassword("cualquier-cosa", undefined)));

  // ---------- JWT + cookie de sesión ----------
  const token = adminAuth.issueAdminToken("ditelli");
  let req = fakeReq({ cookies: { [adminAuth.COOKIE_NAME]: token }, method: "GET" });
  let res = fakeRes();
  let nextCalled = false;
  adminAuth.requireAdminSession(req, res, () => { nextCalled = true; });
  chk("requireAdminSession deja pasar un token válido en GET (sin CSRF)", nextCalled);
  chk("requireAdminSession expone req.adminUsername", req.adminUsername === "ditelli");

  req = fakeReq({ cookies: {}, method: "GET" });
  res = fakeRes();
  nextCalled = false;
  adminAuth.requireAdminSession(req, res, () => { nextCalled = true; });
  chk("requireAdminSession rechaza sin cookie de sesión", !nextCalled && res.statusCode === 401);

  req = fakeReq({ cookies: { [adminAuth.COOKIE_NAME]: "token-invalido" }, method: "GET" });
  res = fakeRes();
  nextCalled = false;
  adminAuth.requireAdminSession(req, res, () => { nextCalled = true; });
  chk("requireAdminSession rechaza un token corrupto/firmado con otro secreto", !nextCalled && res.statusCode === 401);

  // Token con role distinto de "admin" (ej. si alguien reutilizara el
  // helper para otra cosa) no debe pasar.
  const jwt = require("jsonwebtoken");
  const tokenSinRol = jwt.sign({ sub: "ditelli" }, process.env.ADMIN_JWT_SECRET, { expiresIn: "1h" });
  req = fakeReq({ cookies: { [adminAuth.COOKIE_NAME]: tokenSinRol }, method: "GET" });
  res = fakeRes();
  nextCalled = false;
  adminAuth.requireAdminSession(req, res, () => { nextCalled = true; });
  chk('requireAdminSession exige role:"admin" en el claim', !nextCalled && res.statusCode === 401);

  // ---------- CSRF de doble cookie ----------
  const csrf = adminAuth.issueCsrfToken();
  req = fakeReq({
    cookies: { [adminAuth.COOKIE_NAME]: token, [adminAuth.CSRF_COOKIE_NAME]: csrf },
    method: "POST",
    headers: { [adminAuth.CSRF_HEADER_NAME]: csrf },
  });
  res = fakeRes();
  nextCalled = false;
  adminAuth.requireAdminSession(req, res, () => { nextCalled = true; });
  chk("POST con cookie y header CSRF coincidentes pasa", nextCalled);

  req = fakeReq({
    cookies: { [adminAuth.COOKIE_NAME]: token, [adminAuth.CSRF_COOKIE_NAME]: csrf },
    method: "POST",
    // Sin header X-Admin-CSRF: simula un form/fetch de OTRO sitio que no
    // puede leer la cookie admin_csrf (misma-origen) para repetirla acá.
  });
  res = fakeRes();
  nextCalled = false;
  adminAuth.requireAdminSession(req, res, () => { nextCalled = true; });
  chk("POST sin header CSRF se rechaza (protección contra CSRF cross-site)", !nextCalled && res.statusCode === 403);

  req = fakeReq({
    cookies: { [adminAuth.COOKIE_NAME]: token, [adminAuth.CSRF_COOKIE_NAME]: csrf },
    method: "POST",
    headers: { [adminAuth.CSRF_HEADER_NAME]: "valor-que-no-coincide" },
  });
  res = fakeRes();
  nextCalled = false;
  adminAuth.requireAdminSession(req, res, () => { nextCalled = true; });
  chk("POST con header CSRF que no matchea la cookie se rechaza", !nextCalled && res.statusCode === 403);

  // ---------- Lockout por fuerza bruta ----------
  const user = `test-lockout-${Date.now()}`;
  chk("usuario nuevo no arranca bloqueado", !adminAuth.estaBloqueado(user));
  for (let i = 0; i < 4; i++) adminAuth.registrarFallo(user);
  chk("4 intentos fallidos todavía no bloquean (umbral es 5)", !adminAuth.estaBloqueado(user));
  adminAuth.registrarFallo(user);
  chk("el 5º intento fallido bloquea al usuario", adminAuth.estaBloqueado(user));
  adminAuth.registrarExito(user);
  chk("un login exitoso limpia el bloqueo", !adminAuth.estaBloqueado(user));

  console.log(`\n  ${ok} OK · ${ko} fallidos`);
  process.exit(ko ? 1 : 0);
})();
