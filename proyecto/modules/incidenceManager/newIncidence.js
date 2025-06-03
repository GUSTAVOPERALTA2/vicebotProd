// vicebot/modules/incidenceManager/newIncidence.js
const config = require('../../config/config');
const incidenceDB = require('./incidenceDB');
const { MessageMedia } = require('whatsapp-web.js');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
const { normalizeText, similarity, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const { getUser } = require('../../config/userManager');

async function processNewIncidence(client, message) {
  const chat = await message.getChat();
  const chatId = chat.id._serialized;
  console.log("Procesando mensaje de Grupo de Incidencias.");

  // Normalizamos y limpiamos el mensaje eliminando puntuación
  const normalizedMessage = normalizeText(message.body);
  const cleanedMessage = normalizedMessage.replace(/[.,!?()]/g, '');
  console.log(`Mensaje original: "${message.body}"`);
  console.log(`Mensaje normalizado y limpio: "${cleanedMessage}"`);

  if (!cleanedMessage.trim()) {
    console.log("El mensaje está vacío tras la limpieza. Se omite.");
    return;
  }
  const wordsSet = new Set(cleanedMessage.split(/\s+/));

  // Detectar categorías
  const categories = ['it','ama','man'];
  let foundCategories = [];
  const keywordsData = client.keywordsData;
  for (let category of categories) {
    const data = keywordsData.identificadores[category];
    if (!data) continue;

    // Palabras clave con similitud
    const foundKeyword = data.palabras.some(keyword => {
      const normKey = normalizeText(keyword);
      return Array.from(wordsSet).some(word => adaptiveSimilarityCheck(word, normKey));
    });
    // Frases exactas
    const foundPhrase = data.frases.some(phrase => normalizedMessage.includes(normalizeText(phrase)));
    if (foundKeyword || foundPhrase) foundCategories.push(category);
  }

  if (!foundCategories.length) {
    console.log("No se encontró ninguna categoría en el mensaje.");
    return;
  }
  console.log(`Categorías detectadas: ${foundCategories.join(', ')}`);

  // Preparar incidencia
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

    // Función para reenviar a equipo
    async function forwardMessage(targetGroupId, label) {
      try {
        const targetChat = await client.getChatById(targetGroupId);
        const caption = `*Nueva tarea recibida (ID: ${lastID}):* \n\n`+
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

    // Construir teamList
    const teamNames = { it:'IT', ama:'Ama de Llaves', man:'Mantenimiento' };
    const teams = foundCategories.map(c=>teamNames[c]);
    let teamList = teams.join(teams.length>1?' y ':'');

    // Responder al usuario
    await chat.sendMessage(`🤖 *El mensaje se ha enviado al equipo:* \n\n` + 
      `✅ ${teamList}\n\n` +
      `*ID:* ${lastID}`);

    // Si es chat 1:1, notificar al grupo principal
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
