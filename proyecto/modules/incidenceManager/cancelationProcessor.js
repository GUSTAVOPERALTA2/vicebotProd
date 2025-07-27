// File: modules/incidenceManager/cancelationProcessor.js

const incidenceDB = require('./incidenceDB');
const { getUser } = require('../../config/userManager');
const { normalizeText, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const config = require('../../config/config');
const { safeReplyOrSend } = require('../../utils/messageUtils');

async function processCancelationNewMethod(client, message) {
  const chat = await message.getChat();
  const text = normalizeText(message.body);
  const cancelData = client.keywordsData.cancelacion;
  if (!cancelData || !message.hasQuotedMsg) return false;

  let isCancelWord = cancelData.palabras.some(w =>
    adaptiveSimilarityCheck(text, normalizeText(w))
  );
  let isCancelPhrase = cancelData.frases.some(f =>
    text.includes(normalizeText(f))
  );
  if (!isCancelWord && !isCancelPhrase) return false;

  const quoted = await message.getQuotedMessage();
  const qBody = quoted.body;
  const qNorm = normalizeText(qBody);

  if (!qNorm.startsWith('recordatorio:')) return false;

  const match = qBody.match(/ID:\s*(\d+)/i);
  if (!match) {
    await safeReplyOrSend(chat, message, '❌ No se pudo extraer el ID de la incidencia del recordatorio.');
    return true;
  }
  const incidenciaId = match[1];

  let incidencia;
  try {
    incidencia = await new Promise((res, rej) =>
      incidenceDB.getIncidenciaById(incidenciaId, (err, row) => err ? rej(err) : res(row))
    );
  } catch (e) {
    console.error('Error al buscar incidencia en cancelación:', e);
    await safeReplyOrSend(chat, message, '❌ Error al buscar la incidencia para cancelar.');
    return true;
  }
  if (!incidencia) {
    await safeReplyOrSend(chat, message, '❌ No se encontró la incidencia asociada al recordatorio.');
    return true;
  }

  const sender = message.author || message.from;
  const user = getUser(sender);
  if (incidencia.reportadoPor !== sender && (!user || user.rol !== 'admin')) {
    await safeReplyOrSend(chat, message, '❌ No tienes permisos para cancelar esta incidencia.');
    return true;
  }
  if (incidencia.estado !== 'pendiente') {
    await safeReplyOrSend(chat, message, '❌ La incidencia no está pendiente y no se puede cancelar.');
    return true;
  }

  return new Promise(res => {
    incidenceDB.cancelarIncidencia(incidencia.id, async err => {
      if (err) {
        console.error(`Error al cancelar incidencia ID ${incidencia.id}:`, err);
        await safeReplyOrSend(chat, message, '❌ Error al cancelar la incidencia.');
      } else {
        const who = user ? `${user.nombre}(${user.cargo})` : sender;
        const originalDesc = incidencia.descripcion;

        await safeReplyOrSend(chat, message, `🤖✅  *La incidencia ID: ${incidencia.id} ha sido cancelada por ${who}* `);

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
