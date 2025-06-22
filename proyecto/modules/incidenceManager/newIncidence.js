// vicebot/modules/incidenceManager/newIncidence.js
const config = require('../../config/config');
const incidenceDB = require('./incidenceDB');
const { MessageMedia } = require('whatsapp-web.js');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
const { normalizeText, similarity } = require('../../config/stringUtils');
const { getUser } = require('../../config/userManager');

async function processNewIncidence(client, message) {
  const chat = await message.getChat();
  const chatId = chat.id._serialized;
  console.log("Procesando mensaje de Grupo de Incidencias.");

  const normalizedMessage = normalizeText(message.body);
  const cleanedMessage = normalizedMessage.replace(/[.,!?()]/g, '');
  console.log(`Mensaje original: "${message.body}"`);
  console.log(`Mensaje normalizado y limpio: "${cleanedMessage}"`);

  if (!cleanedMessage.trim()) {
    console.log("El mensaje está vacío tras la limpieza. Se omite.");
    return;
  }
  const wordsSet = new Set(cleanedMessage.split(/\s+/));

  const categories = ['it', 'ama', 'man', 'rs', 'seg'];
  const keywordsData = client.keywordsData;
  const categoryScores = {};

  for (let category of categories) {
    const data = keywordsData.identificadores[category];
    if (!data) continue;

    let score = 0;

    for (let keyword of data.palabras) {
      const normKey = normalizeText(keyword);
      for (let word of wordsSet) {
        const sim = similarity(word, normKey);
        if (sim >= 0.8) {
          score += sim;
          console.log(`✅ [${category}] "${word}" ~ "${keyword}" → +${sim.toFixed(2)}`);
        }
      }
    }

    for (let phrase of data.frases) {
      if (normalizedMessage.includes(normalizeText(phrase))) {
        score += 1.2;
        console.log(`✅ [${category}] coincidencia de frase: "${phrase}" → +1.2`);
      }
    }

    categoryScores[category] = score;
  }

  console.log("🏁 Resultado de puntuaciones por categoría:");
  Object.entries(categoryScores).forEach(([cat, score]) => {
    console.log(`→ ${cat.toUpperCase()}: ${score.toFixed(2)}`);
  });

  const threshold = 1.0;
  const foundCategories = Object.entries(categoryScores)
    .filter(([_, score]) => score >= threshold)
    .map(([cat]) => cat);

  if (!foundCategories.length) {
    console.log("No se encontró ninguna categoría en el mensaje.");
    await message.reply(
      "*🤖 No detecté ninguna incidencia en tu mensaje.*\n\n" +
      "*Por favor indica a qué área va dirigida:*  \n\n" +
      "▫️ IT (Sistemas) \n" +
      "▫️ Mantenimiento (Mantenimiento) \n" +
      "▫️ Ama de llaves (HSKP) \n" +
      "▫️ Room service (RoomService) \n" +
      "▫️ Seguridad (Seguridad) \n\n" +
      "_Vuelve a intentarlo con un mensaje más claro._\n" +
      "Ejemplo: 'Room service en 1010' para indicar Room Service."
    );
    return;
  }

  let confirmaciones = null;
  if (foundCategories.length > 1) {
    confirmaciones = {};
    foundCategories.forEach(cat => confirmaciones[cat] = false);
  }
  let mediaData = null;
  if (message.hasMedia) {
    try {
      const media = await message.downloadMedia();
      if (media && media.data && media.mimetype) {
        mediaData = { data: media.data, mimetype: media.mimetype };
      }
    } catch (err) {
      console.error("Error al descargar la media:", err);
    }
  }

  const uniqueMessageId = uuidv4();
  const originalMsgId = message.id._serialized;
  const nuevaIncidencia = {
    uniqueMessageId,
    originalMsgId,
    descripcion: message.body,
    reportadoPor: message.author || message.from,
    fechaCreacion: new Date().toISOString(),
    estado: 'pendiente',
    categoria: foundCategories.join(', '),
    confirmaciones,
    grupoOrigen: chatId,
    media: mediaData ? JSON.stringify(mediaData) : null
  };

  incidenceDB.insertarIncidencia(nuevaIncidencia, async (err, lastID) => {
    if (err) {
      console.error("Error al insertar incidencia en SQLite:", err);
      return;
    }
    console.log("Incidencia registrada con ID:", lastID);

    async function forwardMessage(targetGroupId, label) {
      try {
        const targetChat = await client.getChatById(targetGroupId);
        const caption = `*Nueva tarea recibida (ID: ${lastID}):* \n\n` +
          `✅ *${message.body}*`;
        if (mediaData) {
          const mediaMsg = new MessageMedia(mediaData.mimetype, mediaData.data);
          await targetChat.sendMessage(mediaMsg, { caption });
        } else {
          await targetChat.sendMessage(caption);
        }
      } catch (e) {
        console.error(`Error al reenviar a ${label}:`, e);
      }
    }

    if (foundCategories.includes('it')) await forwardMessage(config.groupBotDestinoId, 'IT');
    if (foundCategories.includes('man')) await forwardMessage(config.groupMantenimientoId, 'Mantenimiento');
    if (foundCategories.includes('ama')) await forwardMessage(config.groupAmaId, 'Ama de Llaves');
    if (foundCategories.includes('rs')) await forwardMessage(config.groupRoomServiceId, 'Room Service');
    if (foundCategories.includes('seg')) await forwardMessage(config.groupSeguridadId, 'Seguridad');

    const teamNames = {
      it: 'IT',
      ama: 'Ama de Llaves',
      man: 'Mantenimiento',
      rs: 'Room Service',
      seg: 'Seguridad'
    };
    const teams = foundCategories.map(c => teamNames[c]);
    const teamList = teams.join(teams.length > 1 ? ' y ' : '');

    await message.reply(`🤖 *El mensaje se ha enviado al equipo:* 

✅ ${teamList}

*ID:* ${lastID}`);

    if (!chat.isGroup) {
      try {
        const mainChat = await client.getChatById(config.groupPruebaId);
        const reporter = getUser(nuevaIncidencia.reportadoPor);
        const reporterLabel = reporter ? `${reporter.nombre} (${reporter.cargo})` : nuevaIncidencia.reportadoPor;
        const notification =
          `*Nueva incidencia (ID: ${lastID})*\n\n` +
          `${nuevaIncidencia.descripcion}\n\n` +
          `*Reportada por:* ${reporterLabel}\n\n` +
          `*Enviado a los equipos:*\n${teamList}`;
        await mainChat.sendMessage(notification);
      } catch (e) {
        console.error('No se pudo notificar al grupo principal:', e);
      }
    }
  });
}

module.exports = { processNewIncidence };
