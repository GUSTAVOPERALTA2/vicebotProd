// File: modules/incidenceManager/feedbackProcessor.js

const incidenceDB = require('./incidenceDB');
const config = require('../../config/config');
const { normalizeText } = require('../../config/stringUtils');
const { extractIdentifier } = require('./identifierExtractor');
const { getUser } = require('../../config/userManager');
const { safeReplyOrSend } = require('../../utils/messageUtils');

/**
 * saveFeedbackRecord - Persiste un array completo de registros de feedback
 * @param {string|number} incidenceId
 * @param {Array<Object>} history  Array de registros de feedback
 */
async function saveFeedbackRecord(incidenceId, history) {
  await new Promise(res =>
    incidenceDB.updateFeedbackHistory(incidenceId, history, res)
  );
}

/**
 * requestFeedback - Detecta y procesa una solicitud de feedback en un mensaje
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 */
async function requestFeedback(client, message) {
  const originChat = await message.getChat();
  const text = normalizeText(message.body);
  const { frases = [], palabras = [] } = client.keywordsData.identificadores.retro || {};
  const isPhrase = frases.some(p => text.includes(normalizeText(p)));
  const words = new Set(text.split(/\s+/));
  const isWord = palabras.some(w => words.has(normalizeText(w)));
  if (!isPhrase && !isWord) return;

  const quoted = await message.getQuotedMessage();
  const incidenciaId = await extractIdentifier(quoted);
  if (!incidenciaId) {
    await safeReplyOrSend(originChat, message, '❌ No pude identificar el ID de la tarea.');
    return;
  }
  const inc = await new Promise((res, rej) =>
    incidenceDB.getIncidenciaById(incidenciaId, (err, row) => err ? rej(err) : res(row))
  );
  if (!inc) {
    await safeReplyOrSend(originChat, message, `❌ Incidencia ID ${incidenciaId} no encontrada.`);
    return;
  }

  const teams = inc.categoria.split(',').map(c => c.trim().toLowerCase());
  for (const team of teams) {
    const groupId = config.destinoGrupos[team];
    if (!groupId) continue;
    try {
      const destChat = await client.getChatById(groupId);
      await destChat.sendMessage(
        `📝 *SOLICITUD DE RETROALIMENTACIÓN*\n\n` +
        `${inc.descripcion}\n\n` +
        `_Por favor, respondan citando este mensaje con su retroalimentación._ \n\n` +
        `*ID:* ${incidenciaId}\n` +
        `*Categoría:* ${team.toUpperCase()}`
      );
    } catch (e) {
      console.error(`❌ Error al enviar solicitud de feedback al grupo ${groupId}:`, e);
    }
  }

  try {
    await originChat.sendMessage(
      `✅ Solicitud de feedback enviada para la incidencia ID ${incidenciaId}.`
    );
  } catch (e) {
    console.error(`❌ Error al confirmar solicitud de feedback al originador:`, e);
  }
}

/**
 * handleTeamResponse - Procesa la respuesta de un equipo (confirmación o comentario)
 * y persiste un registro en feedbackHistory. Luego notifica UNA sola vez en el chat de origen.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 */
async function handleTeamResponse(client, message) {
  if (!message.hasQuotedMsg) return;

  const quoted = await message.getQuotedMessage();
  const rawQuoted = quoted.body.replace(/\*/g, '').trim();
  const match = rawQuoted.match(/ID:\s*(\d+)/i);
  if (!match) return;
  const incidenciaId = match[1];

  let inc;
  try {
    inc = await new Promise((resolve, reject) =>
      incidenceDB.getIncidenciaById(incidenciaId, (err, row) => (err ? reject(err) : resolve(row)))
    );
  } catch (err) {
    console.error('❌ Error al obtener la incidencia en handleTeamResponse:', err);
    return;
  }
  if (!inc) return;

  const chat    = await message.getChat();
  const chatId  = chat.id._serialized;
  let equipo    = '';
  if (chatId === config.groupBotDestinoId)         equipo = 'it';
  else if (chatId === config.groupMantenimientoId) equipo = 'man';
  else if (chatId === config.groupAmaId)           equipo = 'ama';
  else if (chatId === config.groupRoomServiceId)  equipo = 'rs';
  else if (chatId === config.groupSeguridadId)     equipo = 'seg';
  else return;

  const now = new Date().toISOString();
  let history = [];
  try {
    history = typeof inc.feedbackHistory === 'string'
      ? JSON.parse(inc.feedbackHistory)
      : inc.feedbackHistory || [];
  } catch {
    history = [];
  }

  const nuevoRegistro = {
    usuario:    message.author || message.from,
    equipo,
    comentario: message.body,
    fecha:      now,
    tipo:       'feedbackrespuesta'
  };
  history.push(nuevoRegistro);

  try {
    await new Promise(res => incidenceDB.updateFeedbackHistory(incidenciaId, history, res));
  } catch (err) {
    console.error('❌ Error al actualizar feedbackHistory:', err);
    return;
  }

  try {
    const originChat = await client.getChatById(inc.grupoOrigen);
    const teamName   = equipo.toUpperCase();
    const userRec    = getUser(message.author || message.from);
    const whoName    = userRec ? `${userRec.nombre} (${userRec.cargo})` : (message.author || message.from);

    const detailBlock =
      `💬 *Feedback recibido (ID ${incidenciaId}):*\n\n` +
      `✍️ *Tarea*: \n${inc.descripcion}\n\n` +
      `🗣️ *${teamName} responde:* \n${message.body}`;

    try {
      await chat.sendMessage(
        `✅ *Respuesta enviada al emisor ${whoName} para la tarea ${incidenciaId}*`
      );
    } catch (e) {
      console.error(`❌ Error al enviar confirmación de respuesta en grupo destino:`, e);
    }

    if (!inc.grupoOrigen.endsWith('@g.us')) {
      try {
        const userChat = await client.getChatById(inc.reportadoPor);
        await userChat.sendMessage(detailBlock);
        console.log(`📤 Feedback también enviado directamente a ${inc.reportadoPor}`);
      } catch (e) {
        console.error(`❌ No se pudo enviar el feedback al usuario ${inc.reportadoPor}:`, e);
      }
    }

    console.log(`✅ Notificación enviada al grupo origen ${inc.grupoOrigen} por ${whoName}`);
  } catch (err) {
    console.error('❌ Error al notificar feedback en grupo origen:', err);
  }
}

/**
 * handleOriginResponse - Procesa la respuesta del originador después de feedback
 * (comentario adicional), y persiste el registro
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 */
async function handleOriginResponse(client, message) {
  if (!message.hasQuotedMsg) return;
  const quoted = await message.getQuotedMessage();
  const incidenciaId = await extractIdentifier(quoted);
  if (!incidenciaId) return;

  const inc = await new Promise((res, rej) =>
    incidenceDB.getIncidenciaById(incidenciaId, (err, row) => err ? rej(err) : res(row))
  );
  if (!inc) return;

  const now = new Date().toISOString();
  let history = [];
  try {
    history = JSON.parse(inc.feedbackHistory || '[]');
  } catch {}
  history.push({
    usuario:    message.author || message.from,
    equipo:     'origin',
    comentario: message.body,
    fecha:      now,
    tipo:       'feedbackrespuesta'
  });

  await saveFeedbackRecord(incidenciaId, history);

  const originChat = await message.getChat();
  try {
    await originChat.sendMessage(`✅ *Tu comentario ha sido registrado para la incidencia ID ${incidenciaId}.*`);
  } catch (e) {
    console.error('❌ Error al confirmar comentario del originador:', e);
  }
}

module.exports = {
  requestFeedback,
  handleTeamResponse,
  handleOriginResponse,
  saveFeedbackRecord
};
