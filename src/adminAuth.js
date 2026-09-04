/**
 * Sesión de administrador — panel de operación (Fase 2 post-Beta).
 *
 * Separado a propósito de src/auth.js: ese módulo emite un JWT atado 1:1 a
 * UN Miembro puntual ("el dueño de esta Ficha puede ver esta Ficha"). Acá
 * hace falta lo opuesto — "un operador de Ditelli puede ver y tocar a
 * CUALQUIER Miembro" — así que es un secreto, un claim y un middleware
 * distintos, con su propia tabla (admin_users, ver schema.sql). Un solo rol
 * por ahora, sin sistema granular.
 *
 * El JWT viaja en una cookie httpOnly (no localStorage): así un XSS en
 * admin.html no puede robarlo con document.cookie ni leerlo de un `fetch`.
 * Como el frontend (Surge) y este backend (Railway) son dominios distintos,
 * la cookie necesita SameSite=None — y eso reabre la puerta a CSRF (un
 * formulario en OTRO sitio también puede disparar la cookie). Por eso viaja
 * una segunda cookie NO httpOnly con un token de CSRF de doble envío: el JS
 * de admin.html la lee y la repite en un header en cada request que cambia
 * algo; un sitio ajeno no puede leerla (mismo-origen) para repetirla.
 */

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const SECRET = process.env.ADMIN_JWT_SECRET;

// Sesión de un operador humano trabajando en horario administrativo — ni
// los 30 días del Miembro (acá si roban el token es plata, no solo datos),
// ni tan corta que lo desloguee a mitad de una confirmación de transferencia.
const EXPIRES_IN = "12h";
const COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

const COOKIE_NAME = "admin_session";
const CSRF_COOKIE_NAME = "admin_csrf";
const CSRF_HEADER_NAME = "x-admin-csrf";

// Hash de un valor fijo que nadie va a loguear jamás, calculado una vez al
// levantar el proceso. Se usa para que "el username no existe" y "el
// username existe pero la clave está mal" tarden lo mismo en responder —
// mismo criterio anti-enumeración que ya usa /api/session/recover.
const DUMMY_HASH = bcrypt.hashSync("no-existe-ningun-admin-con-esta-clave", 12);

// ---------- Fuerza bruta ----------
// En memoria: alcanza para un solo proceso (Railway corre esto como una
// instancia), y un reinicio de deploy despeja los contadores — aceptable
// para este panel, no hace falta una tabla nueva para esto.
const MAX_INTENTOS = 5;
const BLOQUEO_MS = 15 * 60 * 1000;
const intentosFallidos = new Map(); // username -> { count, lockedUntil }

function estaBloqueado(username) {
  const info = intentosFallidos.get(username);
  if (!info || !info.lockedUntil) return false;
  if (info.lockedUntil > Date.now()) return true;
  intentosFallidos.delete(username); // el bloqueo ya venció
  return false;
}

function registrarFallo(username) {
  const info = intentosFallidos.get(username) || { count: 0 };
  info.count += 1;
  if (info.count >= MAX_INTENTOS) info.lockedUntil = Date.now() + BLOQUEO_MS;
  intentosFallidos.set(username, info);
}

function registrarExito(username) {
  intentosFallidos.delete(username);
}

// ---------- Contraseñas ----------
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash || DUMMY_HASH);
}

// ---------- JWT + cookies ----------
function issueAdminToken(username) {
  return jwt.sign({ sub: username, role: "admin" }, SECRET, { expiresIn: EXPIRES_IN });
}

function issueCsrfToken() {
  return crypto.randomBytes(24).toString("hex");
}

// Express no trae parseo de cookies por defecto (y no hace falta sumar
// cookie-parser solo para esto): acá solo se lee UN header, entrada de
// texto simple, un split alcanza.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(";").forEach((par) => {
    const i = par.indexOf("=");
    if (i === -1) return;
    out[par.slice(0, i).trim()] = decodeURIComponent(par.slice(i + 1).trim());
  });
  return out;
}

/** Opciones comunes de cookie — cross-site (Surge ↔ Railway) exige SameSite=None + Secure. */
function cookieOptions(httpOnly) {
  return { httpOnly, secure: true, sameSite: "none", maxAge: COOKIE_MAX_AGE_MS, path: "/" };
}

function requireAdminSession(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Sesión de administrador requerida." });

  let payload;
  try {
    payload = jwt.verify(token, SECRET);
    if (payload.role !== "admin") throw new Error("rol inválido");
  } catch (err) {
    return res.status(401).json({ error: "Sesión de administrador inválida o vencida." });
  }

  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const csrfCookie = cookies[CSRF_COOKIE_NAME];
    const csrfHeader = req.headers[CSRF_HEADER_NAME];
    if (!csrfCookie || !csrfHeader || csrfCookie !== csrfHeader) {
      return res.status(403).json({ error: "Falta validación CSRF." });
    }
  }

  req.adminUsername = payload.sub;
  next();
}

module.exports = {
  COOKIE_NAME,
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  cookieOptions,
  hashPassword,
  verifyPassword,
  issueAdminToken,
  issueCsrfToken,
  requireAdminSession,
  estaBloqueado,
  registrarFallo,
  registrarExito,
};
