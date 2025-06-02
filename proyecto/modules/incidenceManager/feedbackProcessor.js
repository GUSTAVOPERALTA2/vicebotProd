// File: modules/incidenceManager/feedbackProcessor.js

const incidenceDB = require('./incidenceDB');
const config = require('../../config/config');
const { normalizeText } = require('../../config/stringUtils');
const { extractIdentifier } = require('./identifierExtractor');
const { getUser } = require('../../config/userManager');

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
  // 1) Obtener chat de quien envía el mensaje (originador)
  const originChat = await message.getChat();

  // 2) Extraer texto normalizado del mensaje para detectar si es solicitud
  const text = normalizeText(message.body);
  const { frases = [], palabras = [] } = client.keywordsData.identificadores.retro || {};
  const isPhrase = frases.some(p => text.includes(normalizeText(p)));
  const words = new Set(text.split(/\s+/));
  const isWord = palabras.some(w => words.has(normalizeText(w)));
  if (!isPhrase && !isWord) {
    // No es solicitud de feedback
    return;
  }

  // 3) Extraer ID de la incidencia citada
  const quoted = await message.getQuotedMessage();
  const incidenciaId = await extractIdentifier(quoted);
  if (!incidenciaId) {
    await originChat.sendMessage('❌ No pude identificar el ID de la tarea.');
    return;
  }

  // 4) Obtener la incidencia de la base de datos
  const inc = await new Promise((res, rej) =>
    incidenceDB.getIncidenciaById(incidenciaId, (err, row) => err ? rej(err) : res(row))
  );
  if (!inc) {
    await originChat.sendMessage(`❌ Incidencia ID ${incidenciaId} no encontrada.`);
    return;
  }

  // 5) Enviar solicitud a cada grupo destino
  const teams = inc.categoria.split(',').map(c => c.trim().toLowerCase());
  for (const team of teams) {
    const groupId = config.destinoGrupos[team];
    if (!groupId) continue;
    const destChat = await client.getChatById(groupId);
    await destChat.sendMessage(
      `📝 *SOLICITUD DE RETROALIMENTACIÓN*\n\n` +
      `*ID:* ${incidenciaId}\n` +
      `*Categoría:* ${team.toUpperCase()}\n\n` +
      `${inc.descripcion}\n\n` +
      `_Por favor, respondan citando este mensaje con su retroalimentación._`
    );
  }

  // 6) Confirmar en el grupo origen
  await originChat.sendMessage(
    `✅ Solicitud de feedback enviada para la incidencia ID ${incidenciaId}.`
  );
}

/**
 * handleTeamResponse - Procesa la respuesta de un equipo (feedback o confirmación parcial)
 * y persiste un registro en feedbackHistory, luego notifica al grupo de origen, al emisor del feedback,
 * al usuario que reportó originalmente la incidencia y confirma en el grupo destino.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 */
async function handleTeamResponse(client, message) {
  // 1) Extraer ID desde el mensaje citado
  if (!message.hasQuotedMsg) return;
  const quoted = await message.getQuotedMessage();
  const incidenciaId = await extractIdentifier(quoted);
  if (!incidenciaId) return;

  // 2) Cargar incidencia
  const inc = await new Promise((res, rej) =>
    incidenceDB.getIncidenciaById(incidenciaId, (err, row) => err ? rej(err) : res(row))
  );
  if (!inc) return;

  // 3) Determinar equipo
  const chat   = await message.getChat();
  const chatId = chat.id._serialized;
  let equipo   = '';
  if (chatId === config.groupBotDestinoId)         equipo = 'it';
  else if (chatId === config.groupMantenimientoId) equipo = 'man';
  else if (chatId === config.groupAmaId)           equipo = 'ama';

  // 4) Crear registro
  const now = new Date().toISOString();
  let history = [];
  try {
    history = JSON.parse(inc.feedbackHistory || '[]');
  } catch {}
  history.push({
    usuario:    message.author || message.from,
    equipo,
    comentario: message.body,
    fecha:      now,
    tipo:       'feedbackrespuesta'
  });

  // 5) Persistir en la base de datos
  await saveFeedbackRecord(incidenciaId, history);

  // 6) Formatear mensaje de feedback
  const teamName  = equipo.toUpperCase();
  const tareaText = inc.descripcion;
  const respuesta = message.body;

  const feedbackMsg =
    `💬 *Feedback recibido (ID ${incidenciaId}):*\n` +
    `✍️ *Tarea*:\n${tareaText}\n\n` +
    `🗣️ *${teamName} responde:*\n${respuesta}`;

  // 7) Notificar al grupo origen
  const originChat = await client.getChatById(inc.grupoOrigen);
  await originChat.sendMessage(feedbackMsg);

  // 8) Notificar al emisor del feedback (quien envió el mensaje)
  const sender     = message.author || message.from;
  const senderChat = await client.getChatById(sender);
  await senderChat.sendMessage(feedbackMsg);

  // 9) Notificar al usuario que reportó la incidencia originalmente (reportadoPor)
  const reporterJid = inc.reportadoPor;
  let reporterName  = reporterJid;
  if (reporterJid) {
    const userRec = getUser(reporterJid);
    if (userRec) {
      reporterName = `${userRec.nombre} (${userRec.cargo})`;
    }
    try {
      const reporterChat = await client.getChatById(reporterJid);
      await reporterChat.sendMessage(feedbackMsg);
    } catch (err) {
      console.error(`⚠️ No se pudo notificar al reportero JID ${reporterJid}:`, err);
    }
  }

  // 10) Confirmación en el grupo destino donde se envió el feedback
  const destinatario = reporterJid
    ? reporterName
    : inc.reportadoPor;

  const confirmationMsg =
    `💬 Feedback enviado (ID ${incidenciaId}):\n` +
    `Destinatario:\n` +
    `👤 ${destinatario}`;

  await chat.sendMessage(confirmationMsg);
}

/**
 * handleOriginResponse - Procesa la respuesta del originador después de feedback
 * (comentario adicional), y persiste el registro
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 */
async function handleOriginResponse(client, message) {
  // 1) Extraer ID desde el mensaje citado
  if (!message.hasQuotedMsg) return;
  const quoted = await message.getQuotedMessage();
  const incidenciaId = await extractIdentifier(quoted);
  if (!incidenciaId) return;

  // 2) Cargar incidencia
  const inc = await new Promise((res, rej) =>
    incidenceDB.getIncidenciaById(incidenciaId, (err, row) => err ? rej(err) : res(row))
  );
  if (!inc) return;

  // 3) Crear registro de tipo feedbackrespuesta (comentario del originador)
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

  // 4) Persistir en la base de datos
  await saveFeedbackRecord(incidenciaId, history);

  // 5) Confirmar al originador
  const originChat = await message.getChat();
  await originChat.sendMessage(`✅ Tu comentario ha sido registrado para la incidencia ID ${incidenciaId}.`);
}

module.exports = {
  requestFeedback,
  handleTeamResponse,
  handleOriginResponse,
  saveFeedbackRecord
};
