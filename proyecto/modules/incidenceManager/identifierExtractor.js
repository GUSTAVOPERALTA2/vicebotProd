// File: modules/incidenceManager/identifierExtractor.js

const incidenceDB = require('./incidenceDB');
const { normalizeText } = require('../../config/stringUtils');

/**
 * extractIdentifier(quotedMsg)
 *
 * Dado un mensaje citado (quotedMsg), intenta devolver el `incidencia.id` al que se refiere:
 * 1) Si en quotedMsg.body aparece “ID: <número>” (o “id: <número>”), devolvemos ese número.
 * 2) Si no hay “ID: …” en el texto, usamos quotedMsg.id._serialized para:
 *    2.A) Buscar en BD por uniqueMessageId (función buscarIncidenciaPorUniqueIdAsync).
 *    2.B) Si no coincide con uniqueMessageId, buscar en BD por originalMsgId (buscarIncidenciaPorOriginalMsgIdAsync).
 *
 * Si nada coincide, devolvemos null.
 *
 * @param {import('whatsapp-web.js').Message} quotedMsg
 * @returns {Promise<string|null>} El ID de la incidencia (como string), o null si no se encuentra.
 */
async function extractIdentifier(quotedMsg) {
  // 1) Intentar extraer “ID: 123” directamente del texto citado
  const textoSinAsteriscos = quotedMsg.body.replace(/\*/g, '').trim();
  const match = textoSinAsteriscos.match(/(?:\(ID:\s*(\d+)\)|ID:\s*(\d+)|id:\s*(\d+))/i);
  if (match) {
    const incidenciaId = match[1] || match[2] || match[3];
    return incidenciaId;
  }

  // 2) Si no apareció “ID: número” en el cuerpo, usar quotedMsg.id._serialized
  const quotedMsgId = quotedMsg.id._serialized;
  if (quotedMsgId) {
    try {
      // 2.A) Buscar por uniqueMessageId
      const incUnique = await incidenceDB.buscarIncidenciaPorUniqueIdAsync(quotedMsgId);
      if (incUnique && incUnique.id) {
        return incUnique.id.toString();
      }
      // 2.B) Si no coincide con uniqueMessageId, buscar por originalMsgId
      const incOriginal = await incidenceDB.buscarIncidenciaPorOriginalMsgIdAsync(quotedMsgId);
      if (incOriginal && incOriginal.id) {
        return incOriginal.id.toString();
      }
    } catch (err) {
      console.error('❌ Error en identifierExtractor, buscando por unique/originalId:', err);
      return null;
    }
  }

  return null;
}

module.exports = {
  extractIdentifier
};
