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

    const normalizedText = normalizeText(message.body || '');
    const tokens = new Set(normalizedText.split(/\s+/));
    const intents = client.keywordsData.intenciones || {};
    const genRep = intents.generarReporte || {};
    const frases = genRep.frases || [];
    const palabras = genRep.palabras || [];

    let activaReporte = false;
    for (let frase of frases) {
      if (normalizedText.includes(normalizeText(frase))) {
        activaReporte = true;
        break;
      }
    }
    if (!activaReporte) {
      for (let palabra of palabras) {
        if (tokens.has(normalizeText(palabra))) {
          activaReporte = true;
          break;
        }
      }
    }

    const requiereVerbo = /(ver|genera|muéstrame|quiero|dame|necesito).*reporte/.test(normalizedText);
if (activaReporte && requiereVerbo) {
      const lowerMsg = normalizedText;
      console.log('  → Activando reporte con frase:', lowerMsg);

      const parts = [];
      if (/(hoy|ahora|actual|del dia)/.test(lowerMsg)) parts.push('hoy');
      if (/(pendiente|pendientes|falta|faltan|quedan)/.test(lowerMsg)) parts.push('pendiente');
      if (/(completado|completados|completadas|finalizado|terminado|hecho)/.test(lowerMsg)) parts.push('completada');
      if (/(cancelada|canceladas|anulada|anularon)/.test(lowerMsg)) parts.push('cancelada');
      if (/(it|sistemas|soporte|tecnico)/.test(lowerMsg)) parts.push('it');
      if (/(ama|limpieza|hskp|camarista)/.test(lowerMsg)) parts.push('ama');
      if (/(room|room service|servicio de habitaciones|alimentos)/.test(lowerMsg)) parts.push('rs');
      if (/(seguridad|guardia|proteccion)/.test(lowerMsg)) parts.push('seg');
      if (/(mantenimiento|reparaciones|averia|tecnico)/.test(lowerMsg)) parts.push('man');

      const generatedCommand = '/generarReporte ' + parts.join(' ');
      message.body = generatedCommand;

      console.log('  → Activando reporte con mensaje:', generatedCommand);
    }

    if (message.body && message.body.trim().startsWith('/')) {
      console.log('→ Comando detectado:', message.body.trim());
      if (await handleCommands(client, message)) {
        console.log('    • Comando fue manejado por handleCommands');
        return; // ✅ evita continuar a handleIncidence
      }
    }

    if (!isGroup && message.hasQuotedMsg) {
      const quoted    = await message.getQuotedMessage();
      const rawQuoted = quoted.body
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\*/g, '')
        .toLowerCase()
        .trim();

      console.log('  → [DM + cita] rawQuoted:', JSON.stringify(rawQuoted));
      const normQuoted = normalizeText(rawQuoted);
      console.log('  → [DM + cita] normQuoted:', JSON.stringify(normQuoted));

      const incidenciaId = await extractIdentifier(quoted);
      console.log('    • [DM + cita] extractIdentifier devolvió:', incidenciaId);

      if (incidenciaId && /^\d+$/.test(incidenciaId)) {
        const responseText   = normalizeText(message.body);
        const responseTokens = new Set(responseText.split(/\s+/));
        const cancelKW       = client.keywordsData.cancelacion || {};
        const isCancelWord   = (cancelKW.palabras || []).some(w => responseTokens.has(normalizeText(w)));
        const isCancelPhrase = (cancelKW.frases   || []).some(f => responseText.includes(normalizeText(f)));

        if (isCancelWord || isCancelPhrase) {
          console.log('    • DM + cita → CANCELACIÓN detectada para ID', incidenciaId);
          incidenceDB.cancelarIncidencia(incidenciaId, async err => {
            if (err) {
              console.error('❌ Error cancelando incidencia:', err);
              await chat.sendMessage(`❌ No se pudo cancelar la incidencia ID ${incidenciaId}.`);
            } else {
              const sender = message.author || message.from;
              const user   = getUser(sender);
              const who    = user ? `${user.nombre}(${user.cargo})` : sender;
              await chat.sendMessage(`🤖✅  La incidencia ID: ${incidenciaId} ha sido cancelada por ${who}`);
            }
          });
          return;
        }

        const confirmKW       = client.keywordsData.respuestas.confirmacion || {};
        const isConfirmWord   = (confirmKW.palabras || []).some(w => responseTokens.has(normalizeText(w)));
        const isConfirmPhrase = (confirmKW.frases   || []).some(f => responseText.includes(normalizeText(f)));
        if (isConfirmWord || isConfirmPhrase) {
          console.log('    • DM + cita → CONFIRMACIÓN detectada para ID', incidenciaId);
          await processConfirmation(client, message);
          return;
        }

        console.log('    • DM + cita → SOLICITAR FEEDBACK para ID', incidenciaId);
        await requestFeedback(client, message);
        return;
      }

      console.log('    ✖️ DM + cita NO extrajo ID → seguir flujo normal');
    }

    if (await processCancelationNewMethod(client, message)) {
      console.log('  → processCancelationNewMethod DETECTÓ cancelación genérica');
      return;
    }

    if (isGroup && message.hasQuotedMsg) {
      const quoted    = await message.getQuotedMessage();
      const rawQuoted = quoted.body
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\*/g, '')
        .toLowerCase()
        .trim();

      console.log('  → [Grupo + cita] rawQuoted:', JSON.stringify(rawQuoted));
      const normQuoted = normalizeText(rawQuoted);
      console.log('  → [Grupo + cita] normQuoted:', JSON.stringify(normQuoted));

      const incidenciaId = await extractIdentifier(quoted);
      console.log('  → [Grupo + cita] extractIdentifier devolvió:', incidenciaId);

      if (incidenciaId && /^\d+$/.test(incidenciaId)) {
        const responseText   = normalizeText(message.body);
        const responseTokens = new Set(responseText.split(/\s+/));

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
              const sender = message.author || message.from;
              const user   = getUser(sender);
              const who    = user ? `${user.nombre}(${user.cargo})` : sender;
              await chat.sendMessage(`🤖✅  *La incidencia ID: ${incidenciaId} ha sido cancelada por ${who}*`);
            }
          });
          return;
        }

        const confirmKW3       = client.keywordsData.respuestas.confirmacion || {};
        const isConfirmWord3   = (confirmKW3.palabras || []).some(w => responseTokens.has(normalizeText(w)));
        const isConfirmPhrase3 = (confirmKW3.frases || []).some(f => responseText.includes(normalizeText(f)));
        if (isConfirmWord3 || isConfirmPhrase3) {
          console.log('    • Grupo + cita → CONFIRMACIÓN detectada para ID', incidenciaId);
          await processConfirmation(client, message);
          return;
        }

        console.log('    • Grupo + cita → FEEDBACK DE EQUIPO para ID', incidenciaId);
        await handleTeamResponse(client, message);
        return;
      }

      console.log('    ✖️ Grupo + cita NO extrajo ID válido → seguir flujo normal');
    }

    console.log('  → Ninguna condición anterior, delegando a handleIncidence');
    await handleIncidence(client, message);

  } catch (err) {
    console.error('🔥 Error en handleMessage:', err);
  }
}

module.exports = handleMessage;
