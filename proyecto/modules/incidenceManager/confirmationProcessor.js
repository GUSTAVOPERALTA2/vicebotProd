// File: modules/incidenceManager/confirmationProcessor.js

const config = require('../../config/config');
const { completeIncidencia, updateFase } = require('./incidenceDB');
const { getUser }                       = require('../../config/userManager');
const incidenceDB                       = require('./incidenceDB');
const moment                            = require('moment-timezone');
const { normalizeText }                 = require('../../config/stringUtils');
const { formatDate }                    = require('../../config/dateUtils');
const { extractIdentifier }             = require('./identifierExtractor');
const { safeReplyOrSend }               = require('../../utils/messageUtils');
const { resolveRealJid } = require('../../utils/jidUtils');



/**
 * processConfirmation - Procesa un mensaje de confirmación recibido en los grupos destino
 *                       o desde DM citando un ACK ("El mensaje se ha enviado al equipo:")
 *                       o citando “Detalles de la incidencia (ID: X)”.
 */
async function processConfirmation(client, message) {
  const chat   = await message.getChat();
  const chatId = chat.id._serialized;

  if (!message.hasQuotedMsg) {
    console.log('❌ processConfirmation: no hay mensaje citado, saliendo');
    return;
  }

  const quotedMsg = await message.getQuotedMessage();

  const incidenciaId = await extractIdentifier(quotedMsg);
  console.log('🔍 processConfirmation extraído incidenciaId:', incidenciaId);
  if (!incidenciaId) {
    console.log('❌ processConfirmation: no se encontró ID en la cita, saliendo');
    return;
  }

  const textLow  = message.body.toLowerCase();
  const tokens   = new Set(textLow.split(/\s+/));
  const phraseOk = (client.keywordsData.respuestas.confirmacion.frases || [])
                    .some(p => textLow.includes(p.toLowerCase()));
  const wordOk   = (client.keywordsData.respuestas.confirmacion.palabras || [])
                    .some(w => tokens.has(w.toLowerCase()));
  console.log('🔍 processConfirmation textLow:', textLow, 'phraseOk:', phraseOk, 'wordOk:', wordOk);
  if (!(phraseOk || wordOk)) {
    console.log('❌ processConfirmation: no es palabra/frase de confirmación, saliendo');
    return;
  }

  incidenceDB.getIncidenciaById(incidenciaId, async (err, incidencia) => {
    if (err || !incidencia) {
      console.error('❌ Error al obtener incidencia en processConfirmation:', err);
      return;
    }
    const requiredTeams = incidencia.categoria
      .split(',')
      .map(c => c.trim().toLowerCase());

    let categoriaEquipo = '';
    if (chatId === config.groupBotDestinoId)         categoriaEquipo = 'it';
    else if (chatId === config.groupMantenimientoId) categoriaEquipo = 'man';
    else if (chatId === config.groupAmaId)           categoriaEquipo = 'ama';
    else if (chatId === config.groupRoomServiceId)   categoriaEquipo = 'rs';
    else if (chatId === config.groupSeguridadId)     categoriaEquipo = 'seg';
    else {
      categoriaEquipo = requiredTeams[0];
      console.log('🔍 processConfirmation: confirmación desde DM, categoría asumida =', categoriaEquipo);
    }
    
    // ⛔ Validar si ya fue confirmada por este equipo
    if (incidencia.confirmaciones && incidencia.confirmaciones[categoriaEquipo]) {
      console.log(`⚠️ La incidencia ${incidenciaId} ya fue confirmada por ${categoriaEquipo}, ignorando duplicado.`);
      await safeReplyOrSend(chat, message, `🤖 Esta tarea ya fue marcada como completada por *${categoriaEquipo.toUpperCase()}* anteriormente.`);
      return;
    }
    console.log('✅ Incidencia cargada en processConfirmation:', incidencia);

    const nowTs = new Date().toISOString();
    incidencia.confirmaciones = (incidencia.confirmaciones && typeof incidencia.confirmaciones === 'object')
      ? incidencia.confirmaciones
      : {};
    incidencia.confirmaciones[categoriaEquipo] = nowTs;

    let historyArray = [];
    try {
      historyArray = typeof incidencia.feedbackHistory === 'string'
        ? JSON.parse(incidencia.feedbackHistory)
        : incidencia.feedbackHistory || [];
    } catch {
      historyArray = [];
    }
    const senderJid = await resolveRealJid(message);
    historyArray.push({
      usuario:    senderJid,
      comentario: message.body,
      fecha:      nowTs,
      equipo:     categoriaEquipo,
      tipo:       'confirmacion'
    });

    await new Promise(res =>
      incidenceDB.updateFeedbackHistory(incidenciaId, historyArray, res)
    );
    await new Promise(res =>
      incidenceDB.updateConfirmaciones(
        incidenciaId,
        JSON.stringify(incidencia.confirmaciones),
        res
      )
    );
    console.log('✅ Se actualizó feedbackHistory y confirmaciones para incidencia ID', incidenciaId);

    const EMOJIS = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP', rs: '🍷 RS', seg: '🦺 SEG' };

    if (requiredTeams.length === 1) {
      const completedJid   = await resolveRealJid(message);
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
            console.error('❌ Error al completar incidencia:', err);
            return;
          }

          await safeReplyOrSend(chat, message, `🤖✅ *Incidencia (ID: ${incidenciaId}) completada por ${completedName} el ${formatDate(completionTime)}*`);

          incidencia.completadoPorNombre = completedName;
          incidencia.fechaFinalizacion   = completionTime;
          incidencia.faseActual          = '1/1';
          const finalMsg = buildFinalMessage(incidencia, requiredTeams);

          const originChat = await client.getChatById(incidencia.grupoOrigen);
          await originChat.sendMessage(finalMsg);

          const mainChat = await client.getChatById(config.groupPruebaId);
          await mainChat.sendMessage(finalMsg);
          // Notificar a cada grupo destino individual cuando ya se completaron todas las fases
          for (const team of requiredTeams) {
            const groupId = config.destinoGrupos[team];
            if (!groupId) continue;
            try {
              const teamChat = await client.getChatById(groupId);
              await teamChat.sendMessage(`✅ *La incidencia ID ${inc.id} ha sido completada por:* ${inc.completadoPorNombre}`);
            } catch (e) {
              console.warn(`⚠️ No se pudo notificar al grupo de ${team}:`, e);
            }
          }
        }
      );
      return;
    }

    const originChat = await client.getChatById(incidencia.grupoOrigen);
    const mainChat   = await client.getChatById(config.groupPruebaId);

    const confirmedTeams = Object.entries(incidencia.confirmaciones)
      .filter(([team, ts]) =>
        requiredTeams.includes(team) &&
        typeof ts === 'string' &&
        !isNaN(Date.parse(ts))
      )
      .map(([team]) => team);

    const totalTeams   = requiredTeams.length;
    const currentPhase = confirmedTeams.length;
    const faseString   = `${currentPhase}/${totalTeams}`;
    await new Promise(res => updateFase(incidenciaId, faseString, res));

    const completedJid  = message.author || message.from;
    const userRec       = getUser(completedJid);
    const completedName = userRec ? userRec.nombre : completedJid;
    const formattedTime = formatDate(nowTs);
    const confirmMsg    = `🤖✅ *Incidencia (ID: ${incidenciaId}) confirmada fase ${faseString} por ${completedName} el ${formattedTime}*`;

    // ✅ Enviar confirmación inmediata al grupo que respondió
    await chat.sendMessage(confirmMsg);

    if (currentPhase < totalTeams) {
      const partial = buildPartialMessage(incidencia, requiredTeams, confirmedTeams, historyArray, faseString);

      // ✅ Enviar resumen de fase al grupo origen y principal
      await originChat.sendMessage(partial);
      await mainChat.sendMessage(partial);

      // ✅ También repetir confirmación en grupo propio si no es el mismo que "chat"
      const ownGroupId = config.destinoGrupos[categoriaEquipo];
      if (ownGroupId && ownGroupId !== chatId) {
        const groupChat = await client.getChatById(ownGroupId);
        await groupChat.sendMessage(confirmMsg);
      }
    }
    else {
      const confirmersList = confirmedTeams
        .map(team => {
          const rec = historyArray.filter(r => r.equipo === team && r.tipo === 'confirmacion').pop();
          const u   = rec ? getUser(rec.usuario) : null;
          return u ? u.nombre : (rec ? rec.usuario : 'Desconocido');
        })
        .join(', ');

      const completionTime = moment().tz('America/Mazatlan').toISOString();
      incidencia.completadoPorNombre = confirmersList;
      incidencia.fechaFinalizacion   = completionTime;
      incidencia.faseActual          = faseString;
      
      const senderJid = await resolveRealJid(message);
      await new Promise(res =>
        completeIncidencia(
          incidenciaId,
          senderJid,
          confirmersList,
          completionTime,
          res
        )
      );

      const finalMsg = buildFinalMessage(incidencia, requiredTeams);
      await originChat.sendMessage(finalMsg);
      await mainChat.sendMessage(finalMsg);
    }
  });
}

function formatDuration(start, end) {
  const d = moment.duration(moment(end).diff(moment(start)));
  return `${Math.floor(d.asDays())} día(s), ${d.hours()} hora(s), ${d.minutes()} minuto(s)`;
}

function generarComentarios(inc, requiredTeams) {
  const emojis = { it: '*IT*', man: '*MANT*', ama: '*HSKP*', rs: '*RS*', seg: '*SEG*' };
  let text = '';
  let historyArr = [];
  try {
    historyArr = typeof inc.feedbackHistory === 'string'
      ? JSON.parse(inc.feedbackHistory)
      : inc.feedbackHistory || [];
  } catch {
    historyArr = [];
  }
  requiredTeams.forEach(team => {
    const rec = historyArr.filter(r => r.equipo === team).pop();
    const comment = rec
      ? (rec.comentario?.trim() || (rec.tipo === 'confirmacion' ? 'Listo' : 'Sin comentarios'))
      : 'Sin comentarios';
    text += `${emojis[team] || team.toUpperCase()}: ${comment}\n`;
  });
  return text;
}

function buildPartialMessage(inc, required, confirmed, historyArr, fase) {
  const emojis = { it: 'IT', man: 'MANT', ama: 'HSKP', rs: 'RS', seg: 'SEG' };
  const diffStr     = formatDuration(inc.fechaCreacion, new Date().toISOString());
  const comentarios = generarComentarios(inc, required);
  const confirmers  = confirmed
    .map(team => {
      const rec = historyArr.filter(r => r.equipo === team && r.tipo === 'confirmacion').pop();
      const u   = rec ? getUser(rec.usuario) : null;
      return u ? u.nombre : (rec ? rec.usuario : 'Desconocido');
    })
    .join(', ') || 'Ninguno';

  return (
    `*${inc.descripcion}* \n\n` +
    `*🟢 Terminado por:* ${confirmed.map(t => emojis[t]).join(', ') || 'Ninguno'}\n` +
    `*👤 Colega:* ${confirmers}\n\n` +
    `*🔴 Falta:* ${required.filter(t => !confirmed.includes(t)).map(t => emojis[t]).join(', ') || 'Ninguno'}\n\n` +
    `*🟡 TAREA EN FASE ${fase}*\n\n` +
    `*💬 Comentarios:*\n${comentarios}\n\n` +
    `*⏱️ Tiempo transcurrido:* ${diffStr}`
  );
}

function buildFinalMessage(inc, required) {
  const emojis   = { it: 'IT', man: 'MANT', ama: 'HSKP', rs: 'RS', seg: 'SEG' };
  const createdAt   = formatDate(inc.fechaCreacion);
  const concludedAt = formatDate(inc.fechaFinalizacion);
  const totalStr    = formatDuration(inc.fechaCreacion, inc.fechaFinalizacion);
  const cronos      = required.map(team => {
    const ts  = inc.confirmaciones[team];
    return ts
      ? `*⌛ ${emojis[team]}:* ${formatDuration(inc.fechaCreacion, ts)
          .replace(/ día\(s\), /, 'd ')
          .replace(/ hora\(s\), /, 'h ')
          .replace(/ minuto\(s\)/, 'm')}`
      : `*⌛ ${emojis[team]}:* NaNd NaNh NaNm`;
  }).join('\n');

  return (
    `${inc.descripcion}\n\n` +
    `*ha sido COMPLETADA*\n\n` +
    `*👤 Colega(s):* ${inc.completadoPorNombre}\n\n` +
    `*📅Creación:* ${createdAt}\n` +
    `*📅Conclusión:* ${concludedAt}\n\n` +
    `*⏱️ Tiempo total:* ${totalStr
      .replace(/ día\(s\), /, 'd ')
      .replace(/ hora\(s\), /, 'h ')
      .replace(/ minuto\(s\)/, 'm')}\n` +
    `${cronos}\n\n` +
    `*🤖✅ FASE ${inc.faseActual} ✅🤖*\n\n` +
    `*ID:* ${inc.id}\n\n` +
    `*MUCHAS GRACIAS POR SU PACIENCIA* 😊`
  );
}

module.exports = { processConfirmation };
