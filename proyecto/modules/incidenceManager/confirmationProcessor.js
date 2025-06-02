// File: modules/incidenceManager/confirmationProcessor.js

const config = require('../../config/config');
const { completeIncidencia, updateFase } = require('./incidenceDB');
const { getUser }                       = require('../../config/userManager');
const incidenceDB                       = require('./incidenceDB');
const moment                            = require('moment-timezone');
const { normalizeText }                 = require('../../config/stringUtils');
const { formatDate }                    = require('../../config/dateUtils');
// Importamos el extractor unificado de identificadores
const { extractIdentifier }             = require('./identifierExtractor');

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

  // 1) Extraer el ID de la incidencia usando el extractor unificado
  const incidenciaId = await extractIdentifier(quotedMsg);
  console.log('🔍 processConfirmation extraído incidenciaId:', incidenciaId);
  if (!incidenciaId) {
    console.log('❌ processConfirmation: no se encontró ID en la cita, saliendo');
    return;
  }

  // 2) Detectar palabra/frase de confirmación en el cuerpo del mensaje
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

  // 3) Cargar incidencia desde la base de datos
  incidenceDB.getIncidenciaById(incidenciaId, async (err, incidencia) => {
    if (err || !incidencia) {
      console.error('❌ Error al obtener incidencia en processConfirmation:', err);
      return;
    }
    console.log('✅ Incidencia cargada en processConfirmation:', incidencia);

    // 4) Destinos requeridos según la categoría de la incidencia
    const requiredTeams = incidencia.categoria
      .split(',')
      .map(c => c.trim().toLowerCase());

    // 5) Determinar “categoría” de quien confirma:
    //    - Si viene desde un grupo destino (IT, MAN, AMA), la tomamos de allí.
    //    - Si no, asumimos que viene desde DM (ACK) y tomamos la primera categoría en inc.categoria.
    let categoriaEquipo = '';
    if (chatId === config.groupBotDestinoId)         categoriaEquipo = 'it';
    else if (chatId === config.groupMantenimientoId) categoriaEquipo = 'man';
    else if (chatId === config.groupAmaId)           categoriaEquipo = 'ama';
    else {
      categoriaEquipo = requiredTeams[0];
      console.log('🔍 processConfirmation: confirmación desde DM, categoría asumida =', categoriaEquipo);
    }

    // 6) Registrar confirmación en memoria (objeto incidencia.confirmaciones)
    const nowTs = new Date().toISOString();
    incidencia.confirmaciones = (incidencia.confirmaciones && typeof incidencia.confirmaciones === 'object')
      ? incidencia.confirmaciones
      : {};
    incidencia.confirmaciones[categoriaEquipo] = nowTs;

    // 7) Añadir en feedbackHistory un objeto tipo “confirmacion”
    let historyArray = [];
    try {
      historyArray = typeof incidencia.feedbackHistory === 'string'
        ? JSON.parse(incidencia.feedbackHistory)
        : incidencia.feedbackHistory || [];
    } catch {
      historyArray = [];
    }
    historyArray.push({
      usuario:    message.author || message.from,
      comentario: message.body,
      fecha:      nowTs,
      equipo:     categoriaEquipo,
      tipo:       'confirmacion'
    });

    // 8) Persistir cambios en la base de datos
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

    // Helper de emojis de equipos
    const EMOJIS = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };

    // 9) Si solo hay un equipo destino, completamos la incidencia de inmediato
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
            console.error('❌ Error al completar incidencia:', err);
            return;
          }

          // Enviamos un reply mínimo al citado
          await quotedMsg.reply(
            `🤖✅ *Incidencia (ID: ${incidenciaId}) completada por ${completedName} el ${formatDate(completionTime)}*`
          );

          // Preparamos mensaje final
          incidencia.completadoPorNombre = completedName;
          incidencia.fechaFinalizacion   = completionTime;
          incidencia.faseActual          = '1/1';
          const finalMsg = buildFinalMessage(incidencia, requiredTeams);

          // Enviamos al chat de origen
          const originChat = await client.getChatById(incidencia.grupoOrigen);
          await originChat.sendMessage(finalMsg);

          // Y al grupo principal de incidencias
          const mainChat = await client.getChatById(config.groupPruebaId);
          await mainChat.sendMessage(finalMsg);
        }
      );
      return;
    }

    // 10) Si hay múltiples equipos, aplicamos lógica de fases parciales o finales
    const originChat = await client.getChatById(incidencia.grupoOrigen);
    const mainChat   = await client.getChatById(config.groupPruebaId);

    // 10.1) Computar qué equipos ya han confirmado
    const confirmedTeams = Object.entries(incidencia.confirmaciones)
      .filter(([team, ts]) =>
        requiredTeams.includes(team) &&
        typeof ts === 'string' &&
        !isNaN(Date.parse(ts))
      )
      .map(([team]) => team);

    // 10.2) Actualizar fase (número de confirmaciones / total equipos)
    const totalTeams   = requiredTeams.length;
    const currentPhase = confirmedTeams.length;
    const faseString   = `${currentPhase}/${totalTeams}`;
    await new Promise(res => updateFase(incidenciaId, faseString, res));

    // 10.3) Si no todos confirmaron aún, enviamos mensaje parcial
    if (currentPhase < totalTeams) {
      const partial = buildPartialMessage(incidencia, requiredTeams, confirmedTeams, historyArray, faseString);
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
    }
    else {
      // 10.4) Si todos confirmaron, marcamos como completada
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
  }); // Fin del callback de getIncidenciaById
} // Fin de processConfirmation

/** Helpers para formatear contenido **/

function formatDuration(start, end) {
  const d = moment.duration(moment(end).diff(moment(start)));
  return `${Math.floor(d.asDays())} día(s), ${d.hours()} hora(s), ${d.minutes()} minuto(s)`;
}

function generarComentarios(inc, requiredTeams) {
  const emojis = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
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
  const emojis = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
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
    `❗❗❗❗❗❗❗❗❗❗❗❗\n` +
    `🤖🟡 *ATENCIÓN TAREA EN FASE ${fase}*\n\n` +
    `*Tarea de ${required.map(t => emojis[t]).join(', ')}*:\n\n` +
    `${inc.descripcion}\n\n` +
    `*🟢 Confirmado:* ${confirmed.map(t => emojis[t]).join(', ') || 'Ninguno'}\n` +
    `*👤 Completado por:* ${confirmers}\n\n` +
    `*🔴 Falta:* ${required.filter(t => !confirmed.includes(t)).map(t => emojis[t]).join(', ') || 'Ninguno'}\n\n` +
    `*💬 Comentarios:*\n${comentarios}\n\n` +
    `*⏱️ Tiempo transcurrido:* ${diffStr}`
  );
}

function buildFinalMessage(inc, required) {
  const emojis   = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
  const createdAt   = formatDate(inc.fechaCreacion);
  const concludedAt = formatDate(inc.fechaFinalizacion);
  const totalStr    = formatDuration(inc.fechaCreacion, inc.fechaFinalizacion);
  const cronos      = required.map(team => {
    const ts  = inc.confirmaciones[team];
    return ts
      ? `*⌛Tiempo ${emojis[team]}:* ${formatDuration(inc.fechaCreacion, ts)
          .replace(/ día\(s\), /, 'd ')
          .replace(/ hora\(s\), /, 'h ')
          .replace(/ minuto\(s\)/, 'm')}`
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
    `*⏱️ Total:* ${totalStr
      .replace(/ día\(s\), /, 'd ')
      .replace(/ hora\(s\), /, 'h ')
      .replace(/ minuto\(s\)/, 'm')}\n` +
    `${cronos}\n\n` +
    `*ID:* ${inc.id}\n\n` +
    `*MUCHAS GRACIAS POR SU PACIENCIA* 😊`
  );
}

module.exports = { processConfirmation };
