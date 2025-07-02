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

  // 6) Confirmar en el grupo origen
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
  // 1) Si no hay mensaje citado, salimos
  if (!message.hasQuotedMsg) return;

  // 2) Extraer ID desde el mensaje citado (después normalizamos y quitamos asteriscos)
  const quoted = await message.getQuotedMessage();
  const rawQuoted = quoted.body.replace(/\*/g, '').trim();
  const match = rawQuoted.match(/ID:\s*(\d+)/i);
  if (!match) return;
  const incidenciaId = match[1];

  // 3) Cargar la incidencia de la base de datos
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

  // 4) Determinar de qué equipo viene la respuesta
  const chat    = await message.getChat();
  const chatId  = chat.id._serialized;
  let equipo    = '';
  if (chatId === config.groupBotDestinoId)         equipo = 'it';
  else if (chatId === config.groupMantenimientoId) equipo = 'man';
  else if (chatId === config.groupAmaId)           equipo = 'ama';
  else if (chatId === config.groupRoomServiceId)  equipo = 'rs';
  else if (chatId === config.groupSeguridadId)     equipo = 'seg';
  else {
    // Si no coincide con ninguno de los grupos destino, salimos
    return;
  }

  // 5) Construir el registro de “feedbackrespuesta” para agregar a feedbackHistory
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

  // 6) Persistir el historial actualizado en la BD (solo una llamada)
  try {
    await new Promise(res => incidenceDB.updateFeedbackHistory(incidenciaId, history, res));
  } catch (err) {
    console.error('❌ Error al actualizar feedbackHistory:', err);
    // Si falla la persistencia, salimos sin notificar
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

    // 2. Notificar al grupo destino (desde donde se responde)
    try {
      await chat.sendMessage(
        `✅ *Respuesta enviada al emisor ${whoName} para la tarea ${incidenciaId}*`
      );
    } catch (e) {
      console.error(`❌ Error al enviar confirmación de respuesta en grupo destino:`, e);
    }
    // 3. Si fue reportado por DM, también responder directo al usuario
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
