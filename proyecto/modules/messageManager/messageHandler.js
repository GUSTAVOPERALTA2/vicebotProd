/* File: modules/messageManager/messageHandler.js */
const { handleCommands } = require('./commandsHandler');
const { handleIncidence } = require('../../modules/incidenceManager/incidenceHandler');
const { 
  detectRetroRequest,
  processRetroRequest,
  processTeamFeedbackResponse
} = require('../../modules/incidenceManager/feedbackProcessor');
const { processCancelationNewMethod } = require('../../modules/incidenceManager/cancelationProcessor');

async function handleMessage(client, message) {
  try {
    const chat = await message.getChat();

    // === Lógica para mensajes directos (DM) ===
    if (!chat.isGroup) {
      console.log(`📩 Mensaje privado recibido de ${message.from}: ${message.body}`);
      // 1) Cancelaciones
      const cancelHandled = await processCancelationNewMethod(client, message);
      if (cancelHandled) return;

      // 2) Feedback citando recordatorios o solicitudes
      if (message.hasQuotedMsg) {
        const quotedMessage = await message.getQuotedMessage();
        const quotedText = quotedMessage.body.toLowerCase();
        if (
          quotedText.startsWith("*solicitud de retroalimentacion para la tarea") ||
          quotedText.startsWith("*recordatorio: tarea incompleta") ||
          quotedText.startsWith("*recordatorio:")
        ) {
          await processTeamFeedbackResponse(client, message);
          return;
        }
        const isRetro = await detectRetroRequest(client, message);
        if (isRetro) {
          await processRetroRequest(client, message);
          return;
        }
      }

      // 3) Comandos privados
      if (message.body && message.body.trim().startsWith('/')) {
        console.log(`Comando privado detectado: ${message.body.trim()}`);
        const handled = await handleCommands(client, message);
        if (handled) return;
      }

      // 4) Incidencia nueva o detalles desde DM
      await handleIncidence(client, message);
      return;
    }

    // === Lógica para mensajes de grupo ===
    // 1) Cancelaciones en grupo
    const cancelHandled = await processCancelationNewMethod(client, message);
    if (cancelHandled) return;

    // 2) Feedback citando recordatorios o solicitudes
    if (message.hasQuotedMsg) {
      const quotedMessage = await message.getQuotedMessage();
      const quotedText = quotedMessage.body.toLowerCase();
      if (
        quotedText.startsWith("*solicitud de retroalimentacion para la tarea") ||
        quotedText.startsWith("*recordatorio: tarea incompleta") ||
        quotedText.startsWith("*recordatorio:")
      ) {
        await processTeamFeedbackResponse(client, message);
        return;
      }
      const isRetro = await detectRetroRequest(client, message);
      if (isRetro) {
        await processRetroRequest(client, message);
        return;
      }
    }

    // 3) Comandos en grupo
    if (message.body && message.body.trim().startsWith('/')) {
      console.log(`Comando detectado: ${message.body.trim()}`);
      const handled = await handleCommands(client, message);
      if (handled) return;
    }

    // 4) Incidencias en grupo
    await handleIncidence(client, message);

  } catch (err) {
    console.error("Error en handleMessage:", err);
  }
}

module.exports = handleMessage;
