// File: modules/messageManager/messageHandler.js

const { handleCommands }    = require('./commandsHandler');
const { handleIncidence }    = require('../../modules/incidenceManager/incidenceHandler');
const { requestFeedback, handleTeamResponse } = require('../../modules/incidenceManager/feedbackProcessor');
const { processCancelationNewMethod } = require('../../modules/incidenceManager/cancelationProcessor');

async function handleMessage(client, message) {
  try {
    const chat    = await message.getChat();
    const isGroup = chat.isGroup;

    // -- 0) Cancelaciones --
    if (await processCancelationNewMethod(client, message)) return;

    // --- 1) Cancelar citando la solicitud de retroalimentación ---
    if (message.hasQuotedMsg) {
      const quoted      = await message.getQuotedMessage();
      // Normalizamos texto citado igual que en feedbackProcessor
      const rawQuoted   = quoted.body
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/\*/g, '')
        .toLowerCase()
        .trim();
      const normQuoted  = normalizeText(rawQuoted);

      if (normQuoted.startsWith('solicitud de retroalimentacion para la tarea')) {
        // Extraemos el ID usando el mismo método que para feedback
        const identifier = await extractFeedbackIdentifier(quoted);
        if (!identifier || !/^\d+$/.test(identifier)) {
          await chat.sendMessage('❌ No pude extraer el ID de la incidencia para cancelar.');
          return;
        }
        const incidenciaId = identifier;

        // Intentamos cancelar
        incidenceDB.cancelarIncidencia(incidenciaId, async err => {
          if (err) {
            console.error('❌ Error cancelando incidencia', err);
            await chat.sendMessage(`❌ No se pudo cancelar la incidencia ID ${incidenciaId}.`);
          } else {
            await chat.sendMessage(`✅ Incidencia ID ${incidenciaId} cancelada correctamente.`);
          }
        });
        return;
      }
    }


    // -- 1) Si cito cualquier mensaje en DM, es solicitud de feedback --
    if (!isGroup && message.hasQuotedMsg) {
      await requestFeedback(client, message);
      return;
    }

    // -- 2) Si cito cualquier mensaje en grupo destino, es respuesta de feedback --
    if (isGroup && message.hasQuotedMsg) {
      await handleTeamResponse(client, message);
      return;
    }

    // -- 3) Comandos --
    if (message.body && message.body.trim().startsWith('/')) {
      if (await handleCommands(client, message)) return;
    }

    // -- 4) Incidencias nuevas o detalles --
    await handleIncidence(client, message);

  } catch (err) {
    console.error('Error en handleMessage:', err);
  }
}

module.exports = handleMessage;
