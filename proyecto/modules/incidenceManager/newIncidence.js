// vicebot/modules/incidenceManager/newIncidence.js
const config = require('../../config/config');
const incidenceDB = require('./incidenceDB');
const { MessageMedia } = require('whatsapp-web.js');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
const { normalizeText, similarity, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const { getUser, loadUsers } = require('../../config/userManager');

async function processNewIncidence(client, message) {
  const chat = await message.getChat();
  const chatId = chat.id._serialized;

  const rawText = message.body || '';
  const normalizedText = normalizeText(rawText);
  const cleanedTokens = normalizedText.split(/\s+/);
  const keywords = client.keywordsData;

  let foundCategories = [];
  let directRecipients = [];

  // === FILTRO 1: Usuarios mencionados (con fallback manual) ===
  const mentionedIds = message.mentionedIds && message.mentionedIds.length
    ? message.mentionedIds
    : [...rawText.matchAll(/@([0-9]{11,15}@c\.us)/g)].map(m => m[1]);

  console.log('🔍 Menciones detectadas:', mentionedIds);

  for (const id of mentionedIds) {
    console.log(`🔍 Evaluando mención: ${id}`);
    const user = getUser(id);
    console.log('🧠 Usuario cargado:', user);
    if (user?.team) {
      if (!foundCategories.includes(user.team)) {
        foundCategories.push(user.team);
        console.log(`✅ Filtro 1 → Categoría detectada por mención: ${user.team}`);
      }
      if (user.team === 'exp' && !directRecipients.includes(id)) {
        directRecipients.push(id);
        console.log(`📬 Usuario con destino directo agregado: ${id}`);
      }
    }
  }

  // === FILTRO 2: Coincidencia exacta con palabras clave explícitas ===
  if (!foundCategories.length) {
    const filtro1 = {
      man: ['mant', 'manto', 'mantto', 'mantenimiento'],
      it: ['sistemas', 'it'],
      rs: ['roomservice'],
      seg: ['seguridad']
    };
    for (const [cat, palabras] of Object.entries(filtro1)) {
      if (palabras.some(p => cleanedTokens.includes(p))) {
        foundCategories.push(cat);
        console.log(`✅ Filtro 2 → Categoría detectada: ${cat}`);
      }
    }
  }

  // === FILTRO 3: Coincidencias por keywords.json ===
  if (!foundCategories.length) {
    const categorias = ['it', 'man', 'ama', 'rs', 'seg', 'exp'];
    for (const cat of categorias) {
      const data = keywords.identificadores[cat];
      if (!data) continue;

      const matchPalabra = data.palabras?.some(p =>
        cleanedTokens.some(t => adaptiveSimilarityCheck(t, normalizeText(p)))
      );
      const matchFrase = data.frases?.some(f =>
        normalizedText.includes(normalizeText(f))
      );

      if (matchPalabra || matchFrase) {
        foundCategories.push(cat);
        console.log(`✅ Filtro 3 → Coincidencia encontrada para categoría: ${cat}`);
      }
    }
  }

  // === Si aún no hay categorías válidas ===
  if (!foundCategories.length) {
    try {
      await chat.sendMessage(
        "🤖 No pude identificar el área correspondiente. Por favor revisa tu mensaje o menciona al área (ej. @IT, @Mantenimiento).",
        { quotedMessageId: message.id._serialized }
      );
    } catch (err) {
      console.error("❌ Error al enviar advertencia sin categoría (con cita):", err);
      await chat.sendMessage(
        "🤖 No pude identificar el área correspondiente. Por favor revisa tu mensaje o menciona al área (ej. @IT, @Mantenimiento)."
      );
    }
    console.warn("⚠️ No se detectó categoría. Mensaje ignorado.");
    return;
  }

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

    async function forwardMessage(targetId, label) {
      try {
        const targetChat = await client.getChatById(targetId);
        const caption = `*Nueva tarea recibida (ID: ${lastID}):*\n\n✅ *${message.body}*`;
        if (mediaData) {
          const mediaMsg = new MessageMedia(mediaData.mimetype, mediaData.data);
          await targetChat.sendMessage(mediaMsg, { caption });
        } else {
          await targetChat.sendMessage(caption);
        }
      } catch (e) {
        console.error(`Error al reenviar a ${label || targetId}:", e`);
      }
    }

    if (foundCategories.includes('it')) await forwardMessage(config.groupBotDestinoId, 'IT');
    if (foundCategories.includes('man')) await forwardMessage(config.groupMantenimientoId, 'Mantenimiento');
    if (foundCategories.includes('ama')) await forwardMessage(config.groupAmaId, 'Ama de Llaves');
    if (directRecipients.length) {
      for (const id of directRecipients) {
        await forwardMessage(id, 'Viceroy Connect');
      }
    }

    const teamNames = { it:'IT', ama:'Ama de Llaves', man:'Mantenimiento', exp:'Experiencia' };
    const teams = foundCategories.map(c=>teamNames[c] || c);
    let teamList = teams.join(teams.length>1?' y ':'');
    try {
      await chat.sendMessage(
        `*🤖 El mensaje se ha enviado al equipo:* \n\n ✅ ${teamList}\n\n*ID: ${lastID}*`,
        { quotedMessageId: message.id._serialized }
      );
    } catch (err) {
      console.error("❌ Error al citar el mensaje original. Enviando sin cita:", err);
      await chat.sendMessage(
        `*🤖 El mensaje se ha enviado al equipo:* \n\n ✅ ${teamList}\n\n*ID: ${lastID}*`
      );
    }
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
