// File: modules/messageManager/messageHandler.js

const { handleCommands }             = require('./commandsHandler');
const { handleIncidence }            = require('../../modules/incidenceManager/incidenceHandler');
const {
  requestFeedback,
  handleTeamResponse,
  handleOriginResponse
}                                      = require('../../modules/incidenceManager/feedbackProcessor');
const { processConfirmation }         = require('../../modules/incidenceManager/confirmationProcessor');
const { processCancelationNewMethod } = require('../../modules/incidenceManager/cancelationProcessor');
const { extractIdentifier }           = require('../../modules/incidenceManager/identifierExtractor');
const incidenceDB                     = require('../../modules/incidenceManager/incidenceDB');
const { normalizeText }               = require('../../config/stringUtils');
const { getUser }                     = require('../../config/userManager');

async function handleMessage(client, message) {
  try {
    const chat    = await message.getChat();
    const isGroup = chat.isGroup;

    console.log('\n–– handleMessage recibido ––');
    console.log('  • from:',         message.from);
    console.log('  • isGroup:',      isGroup);
    console.log('  • body:',         message.body);
    console.log('  • hasQuotedMsg:', message.hasQuotedMsg);

    // =======================================
    // 1) “DM + cita” A CUALQUIER MENSAJE CITADO
    //    → extraer incidencia con extractIdentifier
    //    → decidir acción: cancelar / confirmar / pedir feedback
    // =======================================
    if (!isGroup && message.hasQuotedMsg) {
      const quoted    = await message.getQuotedMessage();
      const rawQuoted = quoted.body
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\*/g, '')
        .toLowerCase()
        .trim();

      console.log('  → [DM + cita] rawQuoted:', JSON.stringify(rawQuoted));
      const normQuoted = normalizeText(rawQuoted);
      console.log('  → [DM + cita] normQuoted:', JSON.stringify(normQuoted));

      // Extraer ID con el nuevo extractor (identificador único u originalMsgId)
      const incidenciaId = await extractIdentifier(quoted);
      console.log('    • [DM + cita] extractIdentifier devolvió:', incidenciaId);

      if (incidenciaId && /^\d+$/.test(incidenciaId)) {
        // 1.A) Determinar si la respuesta contiene palabra/frase de CANCELACIÓN
        const responseText   = normalizeText(message.body);
        const responseTokens = new Set(responseText.split(/\s+/));
        const cancelKW       = client.keywordsData.cancelacion || {};
        const isCancelWord   = (cancelKW.palabras || []).some(w => responseTokens.has(normalizeText(w)));
        const isCancelPhrase = (cancelKW.frases   || []).some(f => responseText.includes(normalizeText(f)));

        if (isCancelWord || isCancelPhrase) {
          console.log('    • DM + cita → CANCELACIÓN detectada para ID', incidenciaId);
          // Cancelación directa usando incidenceDB
          incidenceDB.cancelarIncidencia(incidenciaId, async err => {
            if (err) {
              console.error('❌ Error cancelando incidencia:', err);
              await chat.sendMessage(`❌ No se pudo cancelar la incidencia ID ${incidenciaId}.`);
            } else {
              // Obtener nombre y cargo desde users.json
              const sender = message.author || message.from;
              const user   = getUser(sender);
              const who    = user ? `${user.nombre}(${user.cargo})` : sender;
              await chat.sendMessage(`🤖✅  La incidencia ID: ${incidenciaId} ha sido cancelada por ${who}`);
            }
          });
          return;
        }

        // 1.B) Determinar si la respuesta contiene palabra/frase de CONFIRMACIÓN
        const confirmKW       = client.keywordsData.respuestas.confirmacion || {};
        const isConfirmWord   = (confirmKW.palabras || []).some(w => responseTokens.has(normalizeText(w)));
        const isConfirmPhrase = (confirmKW.frases   || []).some(f => responseText.includes(normalizeText(f)));
        if (isConfirmWord || isConfirmPhrase) {
          console.log('    • DM + cita → CONFIRMACIÓN detectada para ID', incidenciaId);
          await processConfirmation(client, message);
          return;
        }

        // 1.C) Cualquier otro texto → SOLICITAR FEEDBACK
        console.log('    • DM + cita → SOLICITAR FEEDBACK para ID', incidenciaId);
        await requestFeedback(client, message);
        return;
      }

      console.log('    ✖️ DM + cita NO extrajo ID → seguir flujo normal');
    }

    // =======================================
    // 2) Cancelaciones genéricas (comando /cancelarTarea o keywords de cancelación)
    // =======================================
    if (await processCancelationNewMethod(client, message)) {
      console.log('  → processCancelationNewMethod DETECTÓ cancelación genérica');
      return;
    }

    // =======================================
    // 3) “Grupo + cita” A CUALQUIER MENSAJE CITADO
    //    → extraer incidenciaId con extractIdentifier
    //    → decidir acción: cancelar / confirmar / feedback de equipo
    // =======================================
    if (isGroup && message.hasQuotedMsg) {
      const quoted    = await message.getQuotedMessage();
      const rawQuoted = quoted.body
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\*/g, '')
        .toLowerCase()
        .trim();

      console.log('  → [Grupo + cita] rawQuoted:', JSON.stringify(rawQuoted));
      const normQuoted = normalizeText(rawQuoted);
      console.log('  → [Grupo + cita] normQuoted:', JSON.stringify(normQuoted));

      // Extraer ID con el nuevo extractor (identificador único u originalMsgId)
      const incidenciaId = await extractIdentifier(quoted);
      console.log('  → [Grupo + cita] extractIdentifier devolvió:', incidenciaId);

      if (incidenciaId && /^\d+$/.test(incidenciaId)) {
        const responseText   = normalizeText(message.body);
        const responseTokens = new Set(responseText.split(/\s+/));

        // 3.A) ¿Cancela?
        const cancelKW3       = client.keywordsData.cancelacion || {};
        const isCancelWord3   = (cancelKW3.palabras || []).some(w => responseTokens.has(normalizeText(w)));
        const isCancelPhrase3 = (cancelKW3.frases   || []).some(f => responseText.includes(normalizeText(f)));
        if (isCancelWord3 || isCancelPhrase3) {
          console.log('    • Grupo + cita → CANCELACIÓN detectada para ID', incidenciaId);
          incidenceDB.cancelarIncidencia(incidenciaId, async err => {
            if (err) {
              console.error('❌ Error cancelando desde grupo:', err);
              await chat.sendMessage(`❌ No se pudo cancelar la incidencia ID ${incidenciaId}.`);
            } else {
              // Obtener nombre y cargo desde users.json
              const sender = message.author || message.from;
              const user   = getUser(sender);
              const who    = user ? `${user.nombre}(${user.cargo})` : sender;
              await chat.sendMessage(`🤖✅  *La incidencia ID: ${incidenciaId} ha sido cancelada por ${who}*`);
            }
          });
          return;
        }

        // 3.B) ¿Confirma?
        const confirmKW3       = client.keywordsData.respuestas.confirmacion || {};
        const isConfirmWord3   = (confirmKW3.palabras || []).some(w => responseTokens.has(normalizeText(w)));
        const isConfirmPhrase3 = (confirmKW3.frases || []).some(f => responseText.includes(normalizeText(f)));
        if (isConfirmWord3 || isConfirmPhrase3) {
          console.log('    • Grupo + cita → CONFIRMACIÓN detectada para ID', incidenciaId);
          await processConfirmation(client, message);
          return;
        }

        // 3.C) Feedback de equipo
        console.log('    • Grupo + cita → FEEDBACK DE EQUIPO para ID', incidenciaId);
        await handleTeamResponse(client, message);
        return;
      }

      console.log('    ✖️ Grupo + cita NO extrajo ID válido → seguir flujo normal');
    }

    // =======================================
    // 4) Comandos (DM o grupo)
    // =======================================
    if (message.body && message.body.trim().startsWith('/')) {
      console.log('  → Comando detectado:', message.body.trim());
      if (await handleCommands(client, message)) {
        console.log('    • Comando fue manejado por handleCommands');
        return;
      }
    }

    // =======================================
    // 5) Incidencias nuevas o detalles sin cita
    // =======================================
    console.log('  → Ninguna condición anterior, delegando a handleIncidence');
    await handleIncidence(client, message);

  } catch (err) {
    console.error('🔥 Error en handleMessage:', err);
  }
}

module.exports = handleMessage;
