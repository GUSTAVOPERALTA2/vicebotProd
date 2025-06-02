// File: modules/incidenceManager/cancelationProcessor.js

const incidenceDB = require('./incidenceDB');
const { getUser } = require('../../config/userManager');
const { normalizeText, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const config = require('../../config/config');

/**
 * processCancelationNewMethod - Procesa la cancelación citando únicamente mensajes de recordatorio.
 *   - Solo actúa si el mensaje citado comienza con "recordatorio:" (formato de recordatorio enviado).
 *   - Si la respuesta contiene palabras o frases de cancelación, procede a cancelar la incidencia.
 *   - En cualquier otro caso, devuelve false para que otras lógicas puedan ejecutar feedback, etc.
 */
async function processCancelationNewMethod(client, message) {
  const chat = await message.getChat();
  const text = normalizeText(message.body);
  const cancelData = client.keywordsData.cancelacion;
  if (!cancelData || !message.hasQuotedMsg) return false;

  // 1) Validar si el texto coincide (fuzzy) con alguna palabra o frase de cancelación
  let isCancelWord = cancelData.palabras.some(w =>
    adaptiveSimilarityCheck(text, normalizeText(w))
  );
  let isCancelPhrase = cancelData.frases.some(f =>
    text.includes(normalizeText(f))
  );
  if (!isCancelWord && !isCancelPhrase) return false;

  // 2) Extraer el mensaje citado
  const quoted = await message.getQuotedMessage();
  const qBody = quoted.body;
  const qNorm = normalizeText(qBody);

  // Solo procesamos cancelar si el mensaje citado es un recordatorio
  if (!qNorm.startsWith('recordatorio:')) {
    return false;
  }

  // 3) Extraer el ID de la incidencia del contenido del recordatorio
  const match = qBody.match(/ID:\s*(\d+)/i);
  if (!match) {
    await chat.sendMessage('❌ No se pudo extraer el ID de la incidencia del recordatorio.');
    return true;
  }
  const incidenciaId = match[1];

  // 4) Recuperar la incidencia desde la BD
  let incidencia;
  try {
    incidencia = await new Promise((res, rej) =>
      incidenceDB.getIncidenciaById(incidenciaId, (err, row) => err ? rej(err) : res(row))
    );
  } catch (e) {
    console.error('Error al buscar incidencia en cancelación:', e);
    await chat.sendMessage('❌ Error al buscar la incidencia para cancelar.');
    return true;
  }
  if (!incidencia) {
    await chat.sendMessage('❌ No se encontró la incidencia asociada al recordatorio.');
    return true;
  }

  // 5) Validar permisos: solo el reportado o un admin pueden cancelar
  const sender = message.author || message.from;
  const user = getUser(sender);
  if (incidencia.reportadoPor !== sender && (!user || user.rol !== 'admin')) {
    await chat.sendMessage('❌ No tienes permisos para cancelar esta incidencia.');
    return true;
  }
  if (incidencia.estado !== 'pendiente') {
    await chat.sendMessage('❌ La incidencia no está pendiente y no se puede cancelar.');
    return true;
  }

  // 6) Procedemos a cancelar la incidencia
  return new Promise(res => {
    incidenceDB.cancelarIncidencia(incidencia.id, async err => {
      if (err) {
        console.error(`Error al cancelar incidencia ID ${incidencia.id}:`, err);
        await chat.sendMessage('❌ Error al cancelar la incidencia.');
      } else {
        // Identificador legible del usuario que cancela
        const who = user ? `${user.nombre}(${user.cargo})` : sender;
        const originalDesc = incidencia.descripcion;

        // Notificación al chat que solicitó la cancelación
        await chat.sendMessage(
          `🤖✅  La incidencia ID: ${incidencia.id} ha sido cancelada por ${who}`
        );

        // Notificar a cada grupo destino asociado a la categoría
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

        // Notificar al grupo principal si la incidencia no fue originada allí
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
