const config = require('../../config/config');
const { completeIncidencia, updateFase } = require('./incidenceDB');
const { getUser }                       = require('../../config/userManager');
const incidenceDB                       = require('./incidenceDB');
const moment                            = require('moment-timezone');
const { normalizeText, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const { formatDate }                    = require('../../config/dateUtils');

/**
 * processConfirmation - Procesa un mensaje de confirmación recibido en los grupos destino.
 */
async function processConfirmation(client, message) {
  const chat   = await message.getChat();
  const chatId = chat.id._serialized;
  if (!message.hasQuotedMsg) return;
  const quotedMsg = await message.getQuotedMessage();

  // 1) Validar encabezado del mensaje citado
  const cleaned = quotedMsg.body.trim().replace(/^\*+/, '');
  const firstLine = cleaned.split('\n')[0].trim();
  const allowed = [
    /^recordatorio:\s*tarea\s+incompleta/i,
    /^nueva\s+tarea\s+recibida/i,
    /^recordatorio:\s*incidencia/i,
    /^solicitud\s+de\s+retroalimentacion\s+para\s+la\s+tarea/i
  ];
  if (!allowed.some(r => r.test(firstLine))) return;

  // 2) Extraer ID de la incidencia
  const idMatch = quotedMsg.body.match(
    /(?:\(ID:\s*(\d+)\)|ID:\s*(\d+)|solicitud\s+de\s+retroalimentacion\s+para\s+la\s+tarea\s*(\d+):)/i
  );
  if (!idMatch) return;
  const incidenciaId = idMatch[1] || idMatch[2] || idMatch[3];

  // 3) Detectar palabra/frase de confirmación
  const textLow  = message.body.toLowerCase();
  const tokens   = new Set(textLow.split(/\s+/));
  const phraseOk = client.keywordsData.respuestas.confirmacion.frases
    .some(p => textLow.includes(p.toLowerCase()));
  const wordOk   = client.keywordsData.respuestas.confirmacion.palabras
    .some(w => tokens.has(w.toLowerCase()));
  if (!(phraseOk || wordOk)) return;

  // 4) Cargar incidencia
  incidenceDB.getIncidenciaById(incidenciaId, async (err, incidencia) => {
    if (err || !incidencia) {
      console.error("Error al obtener incidencia:", err);
      return;
    }

    // 4.1) Destinos requeridos
    const requiredTeams = incidencia.categoria
      .split(',')
      .map(c => c.trim().toLowerCase());

    // 4.2) Determinar equipo que responde
    let categoria = '';
    if (chatId === config.groupBotDestinoId)         categoria = 'it';
    else if (chatId === config.groupMantenimientoId) categoria = 'man';
    else if (chatId === config.groupAmaId)           categoria = 'ama';

    // 4.3) Timestamp y registro de confirmación
    const nowTs = new Date().toISOString();
    incidencia.confirmaciones = incidencia.confirmaciones && typeof incidencia.confirmaciones === 'object'
      ? incidencia.confirmaciones
      : {};
    incidencia.confirmaciones[categoria] = nowTs;

    // 4.4) Registrar en feedbackHistory
    let history = [];
    try {
      history = typeof incidencia.feedbackHistory === 'string'
        ? JSON.parse(incidencia.feedbackHistory)
        : incidencia.feedbackHistory || [];
    } catch {
      history = [];
    }
    history.push({
      usuario:    message.author || message.from,
      comentario: message.body,
      fecha:      nowTs,
      equipo:     categoria,
      tipo:       'confirmacion'
    });

    // 4.5) Guardar cambios en BD
    await new Promise(res => incidenceDB.updateFeedbackHistory(incidenciaId, history, res));
    await new Promise(res => incidenceDB.updateConfirmaciones(
      incidenciaId,
      JSON.stringify(incidencia.confirmaciones),
      res
    ));

    // Helper de emojis de equipos
    const EMOJIS = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
    
    // --- Rama ÚNICA DESTINO: completar inmediatamente ---
    if (requiredTeams.length === 1) {
      const completedJid   = message.author || message.from;
      const userRec        = getUser(completedJid);
      const completedName  = userRec ? userRec.nombre : completedJid;
      const completionTime = moment().tz('America/Mazatlan').toISOString();
      
      completeIncidencia(
        incidenciaId,
        completedJid,
        completedName,
        completionTime,
        async (err) => {
          if (err) {
            console.error("Error al completar incidencia:", err);
            return;
          }
      
          // Reply mínimo al citado
          await quotedMsg.reply(
            `🤖✅ *Incidencia (ID: ${incidenciaId}) completada por ${completedName} el ${formatDate(completionTime)}*`
          );

          // Preparamos resumen
          incidencia.completadoPorNombre = completedName;
          incidencia.fechaFinalizacion   = completionTime;
          incidencia.faseActual          = '1/1';
          const finalMsg = buildFinalMessage(incidencia, requiredTeams);

          // Enviamos al chat de origen
          const originChat = await client.getChatById(incidencia.grupoOrigen);
          await originChat.sendMessage(finalMsg);

          // Y también al grupo principal
          const mainChat = await client.getChatById(config.groupPruebaId);
          await mainChat.sendMessage(finalMsg);
        }
      );
      return;
    }

    // --- MÚLTIPLES DESTINOS: sistema de fases ---
    const originChat = await client.getChatById(incidencia.grupoOrigen);
    const mainChat   = await client.getChatById(config.groupPruebaId);

    // 5.1) Computar equipos confirmados
    const confirmedTeams = Object.entries(incidencia.confirmaciones)
      .filter(([team, ts]) =>
      requiredTeams.includes(team) &&
      typeof ts === 'string' &&
      !isNaN(Date.parse(ts))
    )
    .map(([team]) => team);

    // 5.2) Fase actual y persistencia
    const totalTeams   = requiredTeams.length;
    const currentPhase = confirmedTeams.length;
    const faseString   = `${currentPhase}/${totalTeams}`;
    await new Promise(res => updateFase(incidenciaId, faseString, res));

    // 5.3) Envío de mensaje parcial o final
    if (currentPhase < totalTeams) {
      // Mensaje de fase parcial
      const partial = buildPartialMessage(incidencia, requiredTeams, confirmedTeams, history, faseString);
      await originChat.sendMessage(partial);
      await mainChat.sendMessage(partial);

      // Acknowledge al citado
      const completedJid  = message.author || message.from;
      const userRec       = getUser(completedJid);
      const completedName = userRec ? userRec.nombre : completedJid;
      const formattedTime = formatDate(nowTs);
      await quotedMsg.reply(
        `🤖✅ *Incidencia (ID: ${incidenciaId}) confirmada fase ${faseString} por ${completedName} el ${formattedTime}*`
      );
    } else {
    // Todos confirmaron: marcar completada y enviar resumen final
    const confirmersList = confirmedTeams
      .map(team => {
        const rec = history.filter(r => r.equipo === team && r.tipo === 'confirmacion').pop();
        const u   = rec ? getUser(rec.usuario) : null;
        return u ? u.nombre : rec ? rec.usuario : 'Desconocido';
      })
      .join(', ');

    const completionTime = moment().tz('America/Mazatlan').toISOString();
    incidencia.completadoPorNombre = confirmersList;
    incidencia.fechaFinalizacion   = completionTime;
    incidencia.faseActual          = faseString;

    await new Promise(res =>
      completeIncidencia(
        incidenciaId,
        message.author || message.from,
        confirmersList,
        completionTime,
        res
      )
    );

    const finalMsg = buildFinalMessage(incidencia, requiredTeams);
    await originChat.sendMessage(finalMsg);
    await mainChat.sendMessage(finalMsg);
  }
  }); // <-- This closes the getIncidenciaById callback
} // <-- This closes the processConfirmation function

/** Helpers **/

function formatDuration(start, end) {
  const d = moment.duration(moment(end).diff(moment(start)));
  return `${Math.floor(d.asDays())} día(s), ${d.hours()} hora(s), ${d.minutes()} minuto(s)`;
}

function generarComentarios(inc, requiredTeams) {
  const emojis = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
  let text = '';
  let history = [];
  try {
    history = typeof inc.feedbackHistory === 'string'
      ? JSON.parse(inc.feedbackHistory)
      : inc.feedbackHistory || [];
  } catch {
    history = [];
  }
  requiredTeams.forEach(team => {
    const rec = history.filter(r => r.equipo === team).pop();
    const comment = rec
      ? (rec.comentario?.trim() || (rec.tipo === 'confirmacion' ? 'Listo' : 'Sin comentarios'))
      : 'Sin comentarios';
    text += `${emojis[team] || team.toUpperCase()}: ${comment}\n`;
  });
  return text;
}

function buildPartialMessage(inc, required, confirmed, history, fase) {
  const emojis = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
  const createdAt = formatDate(inc.fechaCreacion);
  const diffStr = formatDuration(inc.fechaCreacion, new Date().toISOString());
  const comentarios = generarComentarios(inc, required);

  const confirmers = confirmed
    .map(team => {
      const rec = history.filter(r => r.equipo === team && r.tipo === 'confirmacion').pop();
      const u   = rec ? getUser(rec.usuario) : null;
      return u ? u.nombre : rec ? rec.usuario : 'Desconocido';
    })
    .join(', ') || 'Ninguno';

  return (
    `❗❗❗❗❗❗❗❗❗❗❗❗\n` +
    `🤖🟡 *ATENCIÓN TAREA EN FASE ${fase}*\n\n` +
    `*Tarea de ${required.map(t => emojis[t] || t).join(', ')}*:\n\n` +
    `${inc.descripcion}\n\n` +
    `*🟢 Confirmado:* ${confirmed.map(t => emojis[t]).join(', ') || 'Ninguno'}\n` +
    `*👤 Completado por:* ${confirmers}\n\n` +
    `*🔴 Falta:* ${required.filter(t => !confirmed.includes(t)).map(t => emojis[t]).join(', ') || 'Ninguno'}\n\n` +
    `*💬 Comentarios:*\n${comentarios}\n\n` +
    `*⏱️ Tiempo transcurrido:* ${diffStr}`
  );
}

function buildFinalMessage(inc, required) {
  const emojis = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
  const createdAt   = formatDate(inc.fechaCreacion);
  const concludedAt = formatDate(inc.fechaFinalizacion);
  const totalStr    = formatDuration(inc.fechaCreacion, inc.fechaFinalizacion);
  const cronos      = required.map(team => {
    const ts  = inc.confirmaciones[team];
    return ts
      ? `*⌛Tiempo ${emojis[team]}:* ${formatDuration(inc.fechaCreacion, ts).replace(/ día\(s\), /,'d ').replace(/ hora\(s\), /,'h ').replace(/ minuto\(s\)/,'m')}`
      : `*⌛Tiempo ${emojis[team]}:* NaNd NaNh NaNm`;
  }).join('\n');

  return (
    `❗❗❗❗❗❗❗❗❗❗❗❗\n` +
    `*🤖✅ ATENCIÓN FASE ${inc.faseActual} ✅🤖*\n\n` +
    `*Tarea de ${required.map(t => emojis[t]).join(', ')}*:\n\n` +
    `${inc.descripcion}\n\n` +
    `*ha sido COMPLETADA*\n\n` +
    `*📅Creación:* ${createdAt}\n` +
    `*📅Conclusión:* ${concludedAt}\n\n` +
    `*👤 Completado por:* ${inc.completadoPorNombre}\n\n` +
    `*⏱️ Total:* ${totalStr.replace(/ día\(s\), /,'d ').replace(/ hora\(s\), /,'h ').replace(/ minuto\(s\)/,'m')}\n` +
    `${cronos}\n\n` +
    `*ID:* ${inc.id}\n\n` +
    `*MUCHAS GRACIAS POR SU PACIENCIA* 😊`
  );
}

async function enviarConfirmacionGlobal(client, incidencia, incidenciaId) {
  // Enviar al chat desde donde se creó la incidencia
  const originId = incidencia.grupoOrigen;
  const chat     = await client.getChatById(originId);
  const message  = buildFinalMessage(
    incidencia,
    incidencia.categoria.split(',').map(c => c.trim().toLowerCase())
  );
  await chat.sendMessage(message);
}


module.exports = { processConfirmation };