/* File: modules/incidenceManager/incidenceManager.js */
const config = require('../../config/config');
const { normalizeText } = require('../../config/stringUtils');

function createHandleIncidence({ processNewIncidence, requestFeedback, handleTeamResponse, processConfirmation }) {
  return async function handleIncidence(client, message) {
    const chat = await message.getChat();
    const chatId = chat.id._serialized;

    if (chatId === config.groupPruebaId) {
      if (message.hasQuotedMsg) {
        const quotedMessage = await message.getQuotedMessage();
        const normalizedQuoted = normalizeText(quotedMessage.body.replace(/\*/g, ''));

        if (normalizedQuoted.startsWith("recordatorio: tarea incompleta")) {
          console.log("Recordatorio detectado en grupo principal, redirigiendo a processConfirmation.");
          await processConfirmation(client, message);
          return;
        }

        if (normalizedQuoted.startsWith("nueva tarea recibida")) {
          console.log("Nueva tarea detectada en grupo principal, redirigiendo a processConfirmation.");
          await processConfirmation(client, message);
          return;
        }

        const normalizedText = normalizeText(message.body);
        const retroPhrases = client.keywordsData.retro?.frases || [];
        const retroWords = client.keywordsData.retro?.palabras || [];

        let foundIndicator = false;
        for (let phrase of retroPhrases) {
          if (normalizedText.includes(normalizeText(phrase))) {
            foundIndicator = true;
            break;
          }
        }
        if (!foundIndicator) {
          const responseWords = new Set(normalizedText.split(/\s+/));
          for (let word of retroWords) {
            if (responseWords.has(normalizeText(word))) {
              foundIndicator = true;
              break;
            }
          }
        }

        if (foundIndicator) {
          console.log("Indicadores retro detectados, procesando solicitud de feedback.");
          await requestFeedback(client, message);
          return;
        } else {
          await chat.sendMessage("🤖❌ *La forma de contestación no es válida para registrar una incidencia. Por favor, envía tu incidencia sin citar un mensaje.*");
          return;
        }
      }

      await processNewIncidence(client, message);
    } else if ([config.groupBotDestinoId, config.groupMantenimientoId, config.groupAmaId].includes(chatId)) {
      await handleTeamResponse(client, message);
    } else {
      console.log("Mensaje de grupo no gestionado. Se omite.");
    }
  };
}

module.exports = { createHandleIncidence };
