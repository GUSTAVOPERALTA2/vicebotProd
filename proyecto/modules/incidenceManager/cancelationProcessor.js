// vicebot/modules/incidenceManager/cancelationProcessor.js
const incidenceDB = require('./incidenceDB');
const { getUser } = require('../../config/userManager');
const { normalizeText, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const config = require('../../config/config');

/**
 * processCancelationNewMethod - Procesa la cancelación citando mensajes del bot o del sistema.
 * - Soporta fuzzy matching en palabras y frases de cancelación.
 * - Detecta citas de recordatorios, detalles de incidencia y del mensaje de envío a equipos.
 * - Al cancelar, notifica en el chat original, en destinos y (si procede) en el grupo principal.
 */
async function processCancelationNewMethod(client, message) {
  const chat = await message.getChat();
  const text = normalizeText(message.body);
  const cancelData = client.keywordsData.cancelacion;
  if (!cancelData) return false;

  // Validar palabra o frase de cancelación (fuzzy match)
  let validCancel = cancelData.palabras.some(w => adaptiveSimilarityCheck(text, normalizeText(w)));
  if (!validCancel) validCancel = cancelData.frases.some(f => text.includes(normalizeText(f)));
  if (!validCancel || !message.hasQuotedMsg) return false;

  // Extraer mensaje citado e identificar tipo
  const quoted = await message.getQuotedMessage();
  const qBody = quoted.body;
  const qNorm = normalizeText(qBody);
  let lookupMethod;
  let lookupId;

  // Cita de envío a equipos del bot
  if (qNorm.startsWith('🤖 el mensaje se ha enviado al equipo') || qNorm.includes('el mensaje se ha enviado al equipo')) {
    const m = qBody.match(/ID:\s*(\d+)/i);
    if (m) { lookupMethod = 'byId'; lookupId = m[1]; }
    else { await chat.sendMessage('No se pudo extraer el ID del mensaje del bot.'); return true; }
  }
  // Cita de recordatorio
  else if (qNorm.startsWith('recordatorio:') || qNorm.includes('recordatorio')) {
    const m = qBody.match(/ID:\s*(\d+)/i);
    if (m) { lookupMethod = 'byId'; lookupId = m[1]; }
    else { await chat.sendMessage('No se encontró el ID en el recordatorio.'); return true; }
  }
  // Cita de detalles de incidencia
  else if (qNorm.startsWith('detalles de la incidencia')) {
    const m = qBody.match(/ID:\s*(\d+)/i);
    if (m) { lookupMethod = 'byId'; lookupId = m[1]; }
    else { await chat.sendMessage('No se pudo extraer el ID de los detalles de incidencia.'); return true; }
  }
  // Otro, usar originalMsgId
  else {
    lookupMethod = 'byOriginalMsgId';
    lookupId = quoted.id._serialized;
  }

  // Recuperar incidencia
  let incidencia;
  try {
    if (lookupMethod === 'byId') {
      incidencia = await new Promise((res, rej) =>
        incidenceDB.getIncidenciaById(lookupId, (err, row) => err ? rej(err) : res(row))
      );
    } else {
      incidencia = await incidenceDB.buscarIncidenciaPorOriginalMsgIdAsync(lookupId);
    }
  } catch (e) {
    console.error('Error al buscar incidencia:', e);
    await chat.sendMessage('Error al buscar la incidencia.');
    return true;
  }
  if (!incidencia) {
    await chat.sendMessage('No se encontró la incidencia asociada.');
    return true;
  }

  // Validar permisos
  const sender = message.author || message.from;
  const user = getUser(sender);
  if (incidencia.reportadoPor !== sender && (!user || user.rol !== 'admin')) {
    await chat.sendMessage('No tienes permisos para cancelar esta incidencia.');
    return true;
  }
  if (incidencia.estado !== 'pendiente') {
    await chat.sendMessage('La incidencia no está pendiente y no se puede cancelar.');
    return true;
  }

  // Preparar datos para mensaje
  const who = user ? `${user.nombre}(${user.cargo})` : sender;
  const originalDesc = incidencia.descripcion;

  // Cancelar e informar
  return new Promise(res => {
    incidenceDB.cancelarIncidencia(incidencia.id, async err => {
      if (err) {
        await chat.sendMessage('Error al cancelar la incidencia.');
      } else {
        // Mensaje al chat que solicitó cancelación
        await chat.sendMessage(
          `🤖 *La incidencia ID ${incidencia.id}:* ${originalDesc}\n\n` +
          `*Ha sido cancelada por ${who}.*`
        );

        // Notificar a grupos destino
        const cats = incidencia.categoria.split(',').map(c => c.trim().toLowerCase());
        for (let cat of cats) {
          const grp = config.destinoGrupos[cat];
          if (grp) {
            try {
              const destChat = await client.getChatById(grp);
              await destChat.sendMessage(
                `🤖 *La incidencia ID ${incidencia.id}:* ${originalDesc}\n\n` +
                `*Ha sido cancelada por ${who}.*`
              );
            } catch (e) {
              console.error(`Error notificando cancelación al grupo ${grp}:`, e);
            }
          }
        }

        // Notificar al grupo principal si no fue allí originalmente
        if (chat.id._serialized !== config.groupPruebaId) {
          try {
            const main = await client.getChatById(config.groupPruebaId);
            await main.sendMessage(
              `🤖 *La incidencia ID ${incidencia.id}:* ${originalDesc}\n\n` +
              `*Ha sido cancelada por ${who}.*`
            );
          } catch (e) {
            console.error('Error notificando cancelación al grupo principal:', e);
          }
        }
      }
      res(true);
    });
  });
}

module.exports = { processCancelationNewMethod };
