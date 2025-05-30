// modules/incidenceManager/feedbackProcessor.js

const incidenceDB = require('./incidenceDB');
const config = require('../../config/config');
const { normalizeText } = require('../../config/stringUtils');
const { getUser } = require('../../config/userManager');
const { processConfirmation } = require('./confirmationProcessor');

/**
 * extractFeedbackIdentifier - Extrae el identificador de una incidencia
 *   1) Busca un ID numérico en el texto citado ("ID: 123")
 *   2) Si no lo hay, busca "TAREA <número>"
 *   3) Si tampoco, devuelve quotedMessage.id._serialized para buscar en originalMsgId
 */
async function extractFeedbackIdentifier(quotedMessage) {
  const text = quotedMessage.body;

  // 1) Intentar extraer "ID: 123"
  let match = text.match(/ID:\s*(\d+)/i);
  if (match) {
    return match[1];
  }

  // 2) Intentar extraer "TAREA <número>"
  match = text.match(/TAREA\s*[:\s]\s*(\d+)/i);
  if (match) {
    return match[1];
  }

  // 3) Fallback: usar el identificador interno de Whatsapp
  if (quotedMessage.id && quotedMessage.id._serialized) {
    return quotedMessage.id._serialized;
  }

  return null;
}

/**
 * requestFeedback - Procesa la solicitud de feedback citando el mensaje original
 */
async function requestFeedback(client, message) {
  // Obtener mensaje citado y chat de origen
  const quoted     = await message.getQuotedMessage();
  const originChat = await message.getChat();

  // Extraer identificador (ID numérico o messageId)
  const identifier = await extractFeedbackIdentifier(quoted);
  if (!identifier) {
    await originChat.sendMessage('❌ No pude extraer el identificador de la incidencia citada.');
    return;
  }

  // Determinar incidencia en BD:
  // - Si identifier es sólo dígitos, lo tratamos como id interno
  // - Si no, lo buscamos en originalMsgId
  let inc;
  if (/^\d+$/.test(identifier)) {
    inc = await new Promise((res, rej) =>
      incidenceDB.getIncidenciaById(identifier, (err, row) => err ? rej(err) : res(row))
    );
  } else {
    inc = await incidenceDB.buscarIncidenciaPorOriginalMsgIdAsync(identifier);
  }
  if (!inc) {
    await originChat.sendMessage(`❌ No se encontró la incidencia para "${identifier}".`);
    return;
  }

  // Validación: si ya está cancelada, no pedimos feedback
  if (inc.estado.toLowerCase() === 'cancelada') {
    await originChat.sendMessage('❌ La incidencia está cancelada y no se puede solicitar feedback.');
    return;
  }

  // Enviar la solicitud a cada equipo destino
  const teams = inc.categoria.split(',').map(c => c.trim().toLowerCase());
  for (const team of teams) {
    const groupId = config.destinoGrupos[team];
    if (!groupId) continue;
    const chat = await client.getChatById(groupId);
    await chat.sendMessage(
      `📝 *SOLICITUD DE RETROALIMENTACIÓN PARA LA TAREA ${inc.id}:*\n\n` +
      `${inc.descripcion}\n\n` +
      `_Por favor, respondan citando este mensaje con su retroalimentación._`
    );
  }

  // Confirmar al emisor
  await originChat.sendMessage(`✅ Solicitud de feedback enviada para la incidencia ID ${inc.id}.`);
}

/**
 * handleTeamResponse - Cuando un equipo responde citando la solicitud,
 * si usa palabras de confirmación lanza processConfirmation;
 * en otro caso, guarda feedback y notifica.
 */
async function handleTeamResponse(client, message) {
  if (!message.hasQuotedMsg) return;

  // 0) Detectar si es un mensaje de confirmación (e.g. "listo", "confirmo", "finalizado", "ok") 
  const textNorm = normalizeText(message.body);
  const confData = client.keywordsData.respuestas.confirmacion || {};
  const isConfirmPhrase = (confData.frases || []).some(f => textNorm.includes(normalizeText(f)));
  const isConfirmWord   = (confData.palabras || []).some(w => new Set(textNorm.split(/\s+/)).has(normalizeText(w)));
  if (isConfirmPhrase || isConfirmWord) {
    // Derivamos al processConfirmation que maneja el cierre de la incidencia :contentReference[oaicite:0]{index=0}
    await processConfirmation(client, message);
    return;
  }

  // 1) Extraer identificador de la incidencia
  const quoted     = await message.getQuotedMessage();
  const identifier = await extractFeedbackIdentifier(quoted);
  if (!identifier) return;

  // 2) Localizar incidencia en BD (por ID numérico o originalMsgId)
  let inc;
  if (/^\d+$/.test(identifier)) {
    inc = await new Promise((res, rej) =>
      incidenceDB.getIncidenciaById(identifier, (err, row) => err ? rej(err) : res(row))
    );
  } else {
    inc = await incidenceDB.buscarIncidenciaPorOriginalMsgIdAsync(identifier);
  }
  if (!inc) return;

  // 3) Determinar equipo según el grupo
  const groupChat = await message.getChat();
  const chatId    = groupChat.id._serialized;
  let equipo      = '';
  if (chatId === config.groupBotDestinoId)         equipo = 'it';
  else if (chatId === config.groupMantenimientoId) equipo = 'man';
  else if (chatId === config.groupAmaId)           equipo = 'ama';
  if (!equipo) return;

  // 4) Construir y persistir registro de feedback
  const record = {
    usuario:    message.author || message.from,
    equipo,
    comentario: message.body,
    fecha:      new Date().toISOString(),
    tipo:       'feedbackrespuesta'
  };
  await new Promise(res =>
    incidenceDB.updateFeedbackHistory(inc.id, record, res)
  );

  // 5) Notificar al creador de la incidencia
  const originChat = await client.getChatById(inc.grupoOrigen);
  await originChat.sendMessage(
    `💬 *Feedback recibido* (ID ${inc.id}) de *${equipo.toUpperCase()}*:\n\n${message.body}`
  );

  // 6) Confirmar en el grupo destino
  const senderId = message.author || message.from;
  const userRec  = getUser(senderId);
  const displayName = userRec
    ? `${userRec.nombre} (${userRec.cargo})`
    : senderId;
  await groupChat.sendMessage(
    `✅ Retroalimentación enviada a ${displayName}\n\nGracias`
  );
}
module.exports = {
  extractFeedbackIdentifier,
  requestFeedback,
  handleTeamResponse
};
