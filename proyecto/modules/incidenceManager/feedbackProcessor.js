// File: modules/incidenceManager/feedbackProcessor.js

const incidenceDB = require('./incidenceDB');
const config = require('../../config/config');
const { normalizeText } = require('../../config/stringUtils');
const { extractIdentifier } = require('./identifierExtractor');
const { getUser } = require('../../config/userManager');
const { safeReplyOrSend } = require('../../utils/messageUtils');
const { resolveRealJid } = require('../../utils/jidUtils');
const { markInProcessAsync } = require('./incidenceDB');


/**
 * buildFeedbackHistoryList - Construye texto con historial de comentarios
 * @param {string} feedbackHistory - JSON string o array de historial
 * @returns {string} Texto formateado con comentarios anteriores
 */
function buildFeedbackHistoryList(feedbackHistory) {
  let historyList = '';
  try {
    const parsedHistory = typeof feedbackHistory === 'string'
      ? JSON.parse(feedbackHistory)
      : feedbackHistory || [];
    
    historyList = parsedHistory
      .filter(r => r.tipo === 'feedbackrespuesta')
      .map(r => {
        const u = getUser(r.usuario);
        const userLabel = u ? `${u.nombre} (${u.cargo})` : r.usuario;
        return `• *${userLabel}*: ${r.comentario}`;
      })
      .join('\n');
  } catch (e) {
    console.error('❌ Error al construir historial de feedback:', e);
  }
  return historyList ? `*Comentarios anteriores:*\n\n${historyList}` : '';
}
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
 * @deprecated
 * requestFeedback - Esta función está obsoleta desde que implementamos
 * la retroalimentación bidireccional (emisor ↔ equipo).
 * 
 * Se mantiene temporalmente por compatibilidad, pero no debe usarse.
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
  else if (chatId === config.groupRoomServiceId)   equipo = 'rs';
  else if (chatId === config.groupSeguridadId)     equipo = 'seg';
  else return;

  // 🟠 Nuevo: Si la incidencia está pendiente, actualizar a "en proceso"
  if (inc.estado === 'pendiente' && inc.estado !== 'cancelada') {
    try {
      await new Promise(res => 
        incidenceDB.updateIncidenciaStatus(incidenciaId, 'en proceso', res)
      );
      console.log(`Incidencia ${incidenciaId} "en proceso" por equipo ${equipo}`);
    } catch (err) {
      console.error('❌ Error al actualizar estado a "en proceso":', err);
    }
  }

  const now = new Date().toISOString();
  let history = [];
  try {
    history = typeof inc.feedbackHistory === 'string'
      ? JSON.parse(inc.feedbackHistory)
      : inc.feedbackHistory || [];
  } catch {
    console.warn(`⚠️ Historial corrupto para incidencia ${incidenciaId}, inicializando vacío`);
    history = [];
  }

  const senderJid = await resolveRealJid(message);
  const nuevoRegistro = {
    usuario: senderJid,
    equipo,
    comentario: message.body || '[Archivo adjunto]',
    fecha: now,
    tipo: 'feedbackrespuesta'
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

    // Obtenemos el JID y nombre del EMISOR original
    const reporterJid = inc.reportadoPor;
    const reporterRec = getUser(reporterJid);
    const emitterName = reporterRec
      ? `${reporterRec.nombre} (${reporterRec.cargo})`
      : reporterJid;

    const historyList = buildFeedbackHistoryList(history);
    const textoFeedback =
      `${message.body || '[Archivo adjunto]'}\n\n` +
      `*Tarea ID:${incidenciaId}* \n\n` +
      `📓 ${inc.descripcion} \n\n` +
      historyList;
    try {
      await chat.sendMessage(
        `✅ *Respuesta enviada al emisor ${emitterName} para la tarea ID:${incidenciaId}*`
      );
    } catch (e) {
      console.error(`❌ Error al enviar confirmación de respuesta en grupo destino:`, e);
    }

    if (!inc.grupoOrigen.endsWith('@g.us')) {
      try {
        const userChat = await client.getChatById(inc.reportadoPor);

        if (message.hasMedia) {
          const media = await message.downloadMedia();
          await userChat.sendMessage(media, { caption: textoFeedback });
        } else {
          await userChat.sendMessage(textoFeedback);
        }

        console.log(`📤 Feedback también enviado directamente a ${inc.reportadoPor}`);
      } catch (e) {
        console.error(`❌ No se pudo enviar el feedback al usuario ${inc.reportadoPor}:`, e);
      }
    }

    console.log(`✅ Notificación enviada al grupo origen ${inc.grupoOrigen} por ${emitterName}`);
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

  // 🟠 Nuevo: Si la incidencia está pendiente, actualizar a "en proceso"
  if (inc.estado === 'pendiente') {
    try {
      await new Promise(res => 
        incidenceDB.updateIncidenciaStatus(incidenciaId, 'en proceso', res)
      );
      console.log(`🔄 Incidencia ${incidenciaId} "en proceso" por originador`);
    } catch (err) {
      console.error('❌ Error al actualizar estado a "en proceso":', err);
    }
  }

  const now = new Date().toISOString();
  let history = [];
  try {
    history = JSON.parse(inc.feedbackHistory || '[]');
  } catch {
    console.warn(`⚠️ Historial corrupto para incidencia ${incidenciaId}, inicializando vacío`);
    history = [];
  }
  const senderJid = await resolveRealJid(message);
  
  history.push({
    usuario:    senderJid,
    equipo:     'origin',
    comentario: message.body || '[Archivo adjunto]',
    fecha:      now,
    tipo:       'feedbackrespuesta'
  });

  await saveFeedbackRecord(incidenciaId, history);

  const teams = inc.categoria.split(',').map(c => c.trim().toLowerCase());
  const historyList = buildFeedbackHistoryList(history);

  for (const team of teams) {
    const groupId = config.destinoGrupos[team];
    if (!groupId) continue;

    try {
      const destChat = await client.getChatById(groupId);
      const textoFeedback =
        `${message.body || '[Archivo adjunto]'}\n\n` +
        `Tarea ID:${incidenciaId}\n` +
        `📓 ${inc.descripcion} \n\n` +
        historyList;

      if (message.hasMedia) {
        const media = await message.downloadMedia();
        await destChat.sendMessage(media, { caption: textoFeedback });
      } else {
        await destChat.sendMessage(textoFeedback);
      }
    } catch (e) {
      console.error(`❌ Error al reenviar comentario al grupo ${team}:`, e);
    }
  }

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
