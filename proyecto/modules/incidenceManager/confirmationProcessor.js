// modules/incidenceManager/confirmationProcessor.js

const config = require('../../config/config');
const { completeIncidencia, updateFase } = require('./incidenceDB');
const { getUser }                       = require('../../config/userManager');
const incidenceDB                       = require('./incidenceDB');
const moment                            = require('moment-timezone');
const { normalizeText, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const { formatDate }                    = require('../../config/dateUtils');

async function processConfirmation(client, message) {
  console.log('🛠️ processConfirmation invoked:', { from: message.from, body: message.body });

  if (!message.hasQuotedMsg) {
    console.log('⚠️ No hay mensaje citado, abortando');
    return;
  }

  const chat     = await message.getChat();
  const chatId   = chat.id._serialized;
  const quotedMsg = await message.getQuotedMessage();

  // 1) Normalizar el texto citado:
  //    a) Descomponer y quitar diacríticos (acentos)
  //    b) Quitar asteriscos
  //    c) Pasar a minúsculas
  //    d) Filtrar todo salvo letras, dígitos, espacios y ':'
  let norm = quotedMsg.body
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
    .replace(/\*/g, '')                                // quita asteriscos
    .toLowerCase()
    .replace(/[^\p{L}\d\s:]/gu, ' ')                   // deja solo letras, dígitos, espacios, ':'
    .trim();
  console.log('🔍 normalized quoted:', norm);

  // 2) Extraer primera línea y quitar ':' para comparar
  const firstLine = norm.split('\n')[0].replace(/:/g, '').trim();
  console.log('🔍 firstLine:', firstLine);

  const allowedStarts = [
    'recordatorio tarea incompleta',
    'nueva tarea recibida',
    'recordatorio incidencia',
    'solicitud de retroalimentacion para la tarea'
  ];
  const headerOk = allowedStarts.some(pref => firstLine.startsWith(pref));
  console.log('🔍 headerOk:', headerOk);
  if (!headerOk) {
    console.log('❌ Encabezado no admite confirmación, saliendo');
    return;
  }

  // 3) Extraer ID: "id: X" o "tarea X"
  const idMatch = norm.match(/(?:id:\s*(\d+)|tarea\s+(\d+))/);
  if (!idMatch) {
    console.log('❌ No se encontró ID en normalized text, saliendo');
    return;
  }
  const incidenciaId = idMatch[1] || idMatch[2];
  console.log('🔍 incidenciaId extraído:', incidenciaId);
  
  // 4) Detectar confirmación por keywords
  const textLow  = normalizeText(message.body);
  const tokens   = new Set(textLow.split(/\s+/));
  const confData = client.keywordsData.respuestas.confirmacion || {};
  const phraseOk = (confData.frases || []).some(p => textLow.includes(normalizeText(p)));
  const wordOk   = (confData.palabras || []).some(w => tokens.has(normalizeText(w)));
  console.log('🔍 phraseOk:', phraseOk, 'wordOk:', wordOk);
  if (!(phraseOk || wordOk)) {
    console.log('❌ No es confirmación, saliendo');
    return;
  }

  // 5) Cargar incidencia de BD
  incidenceDB.getIncidenciaById(incidenciaId, async (err, incidencia) => {
    if (err || !incidencia) {
      console.error('❌ Error al cargar incidencia:', err);
      return;
    }
    console.log('🔍 Incidencia cargada:', incidencia);

    // 6) Lógica de confirmación...
    const requiredTeams = incidencia.categoria.split(',').map(c => c.trim().toLowerCase());
    let categoria = '';
    if (chatId === config.groupBotDestinoId)         categoria = 'it';
    else if (chatId === config.groupMantenimientoId) categoria = 'man';
    else if (chatId === config.groupAmaId)           categoria = 'ama';
    console.log('🔍 Equipo responde:', categoria);

    // Timestamp y registro en memoria
    const nowTs = new Date().toISOString();
    incidencia.confirmaciones = incidencia.confirmaciones && typeof incidencia.confirmaciones === 'object'
      ? incidencia.confirmaciones
      : {};
    incidencia.confirmaciones[categoria] = nowTs;

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
    console.log('🔍 Nuevo history:', history);

    // Persistir
    await new Promise(res =>
      incidenceDB.updateFeedbackHistory(incidenciaId, history, res)
    );
    await new Promise(res =>
      incidenceDB.updateConfirmaciones(
        incidenciaId,
        JSON.stringify(incidencia.confirmaciones),
        res
      )
    );
    console.log('✅ Cambios guardados en BD');

    // Helper de emojis de equipos
    const EMOJIS = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
    
    // --- Rama ÚNICA DESTINO: completar inmediatamente ---
    if (requiredTeams.length === 1) {
      console.log('Incidencia de un solo equipo, completando inmediatamente');
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
          console.log('📣 Mensajes finales enviados');
        }
      );
      return;
    }

    // --- MÚLTIPLES DESTINOS: sistema de fases ---
    console.log('Incidencia con múltiples equipos, procesando fases');
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

    // 5.2) Actualizar fase en BD
    const totalTeams   = requiredTeams.length;
    const currentPhase = confirmedTeams.length;
    const faseString   = `${currentPhase}/${totalTeams}`;
    await new Promise(res => updateFase(incidenciaId, faseString, res));

    // 5.3) Mensajes parciales o finales
    if (currentPhase < totalTeams) {
      // Parcial
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
      // Final: todos confirmaron
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
  }); // getIncidenciaById callback
} // processConfirmation

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
  const emojis = { it: '💻IT', man: '🔧MANT', ama: '🔑HSKP' };
  const createdAt   = formatDate(inc.fechaCreacion);
  const concludedAt = formatDate(inc.fechaFinalizacion);
  const totalStr    = formatDuration(inc.fechaCreacion, inc.fechaFinalizacion);
  const cronos      = required.map(team => {
    const ts  = inc.confirmaciones[team];
    return ts
      ? `*⌛Tiempo ${emojis[team]}:* ${formatDuration(inc.fechaCreacion, ts)
          .replace(/ día\(s\), /,'d ')
          .replace(/ hora\(s\), /,'h ')
          .replace(/ minuto\(s\)/,'m')}`
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
      .replace(/ día\(s\), /,'d ')
      .replace(/ hora\(s\), /,'h ')
      .replace(/ minuto\(s\)/,'m')}\n` +
    `${cronos}\n\n` +
    `*ID:* ${inc.id}\n\n` +
    `*MUCHAS GRACIAS POR SU PACIENCIA* 😊`
  );
}

module.exports = { processConfirmation };
