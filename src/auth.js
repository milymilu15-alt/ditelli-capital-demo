/**
 * Sesión de Miembro — auditoría de seguridad (Problema 1: IDOR).
 *
 * Antes, /api/members/:id/status y las rutas de DocuSign/pago no pedían
 * ninguna autenticación: alcanzaba con adivinar un id de members (un
 * SERIAL secuencial: 1, 2, 3...) para leer o mover el estado del registro
 * de OTRO inversor. Ahora, POST /api/members emite un JWT corto atado a
 * ESE memberId (que además pasó a ser un UUID no adivinable — ver
 * public_token en schema.sql/db.js), y estas rutas lo exigen.
 *
 * Por qué JWT en el header Authorization y no una cookie: el frontend
 * (ditelli-capital.surge.sh) y el backend (Railway) son dominios
 * distintos. Una cookie cross-site necesitaría SameSite=None + Secure y
 * credentials:'include' en cada fetch — el Bearer token evita esa
 * complejidad y funciona igual de bien acá.
 */

const jwt = require("jsonwebtoken");

const SECRET = process.env.SESSION_JWT_SECRET;

// 30 días: el flujo real incluye pasos que pueden tardar (la transferencia
// bancaria la confirma el equipo de Ditelli a mano, no al instante), y el
// Miembro puede volver a consultar /status varios días después. Un JWT
// corto tipo "2h" lo dejaría afuera de su propio proceso a mitad de camino.
const EXPIRES_IN = "30d";

/** Emite el token de sesión para un memberId (public_token, UUID). */
function issueMemberToken(memberPublicId) {
  return jwt.sign({ sub: memberPublicId }, SECRET, { expiresIn: EXPIRES_IN });
}

/**
 * Middleware de Express: exige un Bearer token válido cuyo "sub" coincida
 * con el memberId que la request está pidiendo tocar (sacado con
 * `getRequestedMemberId(req)` — por ejemplo req.params.id o
 * req.body.memberId, según la ruta).
 *
 * Un token válido de OTRO miembro devuelve 403 genérico (sin decir si el
 * id pedido existe o no) — no le damos a un atacante con UN token propio
 * válido una forma de usar esta misma ruta para enumerar ids ajenos.
 */
function requireMemberSession(getRequestedMemberId) {
  return (req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ error: "Falta el token de sesión." });
    }

    let payload;
    try {
      payload = jwt.verify(token, SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Token de sesión inválido o vencido." });
    }

    const requestedId = getRequestedMemberId(req);
    if (!requestedId || payload.sub !== requestedId) {
      return res.status(403).json({ error: "No autorizado para este Miembro." });
    }

    req.memberId = payload.sub;
    next();
  };
}

module.exports = { issueMemberToken, requireMemberSession };
