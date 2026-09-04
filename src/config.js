/**
 * Configuración derivada del entorno, compartida por todos los módulos.
 *
 * Existe por un bug concreto que ya apareció dos veces, en DocuSign y en
 * Mercado Pago: FRONTEND_URL puede ser una LISTA separada por comas
 * ("https://a.com,https://www.a.com"), porque CORS necesita aceptar varios
 * orígenes. Interpolar esa variable cruda dentro de una URL produce cosas
 * como "https://a.com,https://www.a.com/?payment=exitoso", que ningún
 * proveedor acepta como URL de retorno.
 *
 * La regla, para que no vuelva a pasar en un módulo nuevo:
 *   - CORS y validación de orígenes  -> allowedOrigins()
 *   - CUALQUIER URL que se construya -> frontendBase()
 *   - process.env.FRONTEND_URL directo -> nunca.
 *
 * Son funciones y no constantes a propósito: así el valor se lee cuando se
 * usa y no dependen de que dotenv se haya cargado antes de importar este
 * módulo.
 */

function allowedOrigins() {
  return (process.env.FRONTEND_URL || "")
    .split(",")
    .map((url) => url.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

/** Dominio canónico del frontend: el PRIMERO de FRONTEND_URL, sin barra final. */
function frontendBase() {
  return allowedOrigins()[0] || "";
}

module.exports = { allowedOrigins, frontendBase };
