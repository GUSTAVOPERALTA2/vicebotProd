// File: modules/messageManager/messageHandler.js

const { handleCommands } = require('./commandsHandler');
const { handleIncidence } = require('../../modules/incidenceManager/incidenceHandler');
const {
  requestFeedback,
  handleTeamResponse,
  handleOriginResponse
} = require('../../modules/incidenceManager/feedbackProcessor');
const { processConfirmation } = require('../../modules/incidenceManager/confirmationProcessor');
const { processCancelationNewMethod } = require('../../modules/incidenceManager/cancelationProcessor');
const { extractIdentifier } = require('../../modules/incidenceManager/identifierExtractor');
const incidenceDB = require('../../modules/incidenceManager/incidenceDB');
const { normalizeText } = require('../../config/stringUtils');
const { getUser } = require('../../config/userManager');
const { safeReplyOrSend } = require('../../utils/messageUtils');
const moment = require('moment-timezone');
const { resolveRealJid } = require('../../utils/jidUtils');

// Patrón global para detectar mensajes del bot con ID
const BOT_MESSAGE_REGEX = /\b(id|incidencia)\s*[:#-]?\s*\d+\b/i;

function detectCancel(client, tokens, text) {
  const cancelKW = client.keywordsData.cancelacion || {};
  return (cancelKW.palabras || []).some(w => tokens.has(normalizeText(w))) ||
         (cancelKW.frases || []).some(f => text.includes(normalizeText(f)));
}
function detectPause(client, tokens, text) {
  const pauseWords = ['pausar', 'en pausa', 'pausa']; // puedes añadir más
  return pauseWords.some(w => tokens.has(normalizeText(w))) || 
         pauseWords.some(f => text.includes(normalizeText(f)));
}
function detectConfirm(client, tokens, text) {
  const confirmKW = client.keywordsData.respuestas.confirmacion || {};
  return (confirmKW.palabras || []).some(w => tokens.has(normalizeText(w))) ||
         (confirmKW.frases || []).some(f => text.includes(normalizeText(f)));
}

async function handlePause(client, chat, message, incidenciaId) {
  incidenceDB.updateIncidenciaStatus(incidenciaId, 'en pausa', async err => {
    if (err) {
      console.error('❌ Error pausando incidencia:', err);
      await safeReplyOrSend(chat, message, `❌ No se pudo pausar la incidencia ID ${incidenciaId}.`);
    } else {
      const senderJid = await resolveRealJid(message);
      const user = getUser(senderJid);
      const who = user ? `${user.nombre} (${user.cargo})` : senderJid;
      await safeReplyOrSend(chat, message, `🤖⏸️ La incidencia ID: ${incidenciaId} ha sido pausada por ${who}`);
    }
  });
}

async function handleCancel(client, chat, message, incidenciaId) {
  incidenceDB.cancelarIncidencia(incidenciaId, async err => {
    if (err) {
      console.error('❌ Error cancelando incidencia:', err);
      await safeReplyOrSend(chat, message, `❌ No se pudo cancelar la incidencia ID ${incidenciaId}.`);
    } else {
        const senderJid = await resolveRealJid(message);
        const user = getUser(senderJid);
      const who = user ? `${user.nombre} (${user.cargo})` : senderJid;
      await safeReplyOrSend(chat, message, `🤖✅ La incidencia ID: ${incidenciaId} ha sido cancelada por ${who}`);
    }
  });
}

async function handleMessage(client, message) {
  try {
    const chat = await message.getChat();
    const isGroup = chat.isGroup;

    console.log('\n–– handleMessage recibido ––');
    console.log('  • from:', message.from);
    console.log('  • isGroup:', isGroup);
    console.log('  • body:', message.body);
    console.log('  • hasQuotedMsg:', message.hasQuotedMsg);

    const normalizedText = normalizeText(message.body || '');
    const normalizedBody = (message.body || '').toLowerCase();
    const tokens = new Set(normalizedText.split(/\s+/));
    const intents = client.keywordsData.intenciones || {};
    const genRep = intents.generarReporte || {};
    const frases = genRep.frases || [];
    const palabras = genRep.palabras || [];

    // ======== DETECCIÓN DE INTENCIÓN PARA REPORTES ========
    let activaReporte = frases.some(f => normalizedText.includes(normalizeText(f))) ||
                        palabras.some(p => tokens.has(normalizeText(p)));
    const requiereVerbo = /(ver|genera|muéstrame|quiero|dame|necesito).*reporte/.test(normalizedText);

    if (activaReporte && requiereVerbo) {
      const parts = [];
      if (/(hoy|ahora|actual|del dia)/.test(normalizedText)) parts.push('hoy');
      if (/(pendiente|pendientes|falta|faltan|quedan)/.test(normalizedText)) parts.push('pendiente');
      if (/(completado|completados|completadas|finalizado|terminado|hecho)/.test(normalizedText)) parts.push('completada');
      if (/(cancelada|canceladas|anulada|anularon)/.test(normalizedText)) parts.push('cancelada');
      if (/(it|sistemas|soporte|tecnico)/.test(normalizedText)) parts.push('it');
      if (/(ama|limpieza|hskp|camarista)/.test(normalizedText)) parts.push('ama');
      if (/(room|room service|servicio de habitaciones|alimentos)/.test(normalizedText)) parts.push('rs');
      if (/(seguridad|guardia|proteccion)/.test(normalizedText)) parts.push('seg');
      if (/(mantenimiento|reparaciones|averia|tecnico)/.test(normalizedText)) parts.push('man');

      const generatedCommand = '/generarReporte ' + parts.join(' ');
      message.body = generatedCommand;
      console.log('  → Activando reporte con mensaje:', generatedCommand);
    }

    // ======== AYUDA ========
    const ayudaKW = client.keywordsData.ayuda || {};
    let activaAyuda = (ayudaKW.frases || []).some(f => normalizedText.includes(normalizeText(f))) ||
                      (ayudaKW.palabras || []).some(p => tokens.has(normalizeText(p)) &&
                        ((normalizedText.length < 25 && tokens.size <= 7) || normalizedText.includes("bot")));
    if (activaAyuda) {
      message.body = '/ayuda';
      console.log('→ Intención "ayuda" detectada, redirigiendo a /ayuda');
    }

    // ======== CANCELACIÓN NATURAL ========
    const cancelKW = client.keywordsData.intenciones.cancelarTarea || {};
    let activaCancel = (cancelKW.frases || []).some(f => normalizedText.includes(normalizeText(f))) ||
                       (cancelKW.palabras || []).some(p => tokens.has(normalizeText(p)));
    if (activaCancel) {
      const idMatch = normalizedText.match(/\b(\d{1,6})\b/);
      if (idMatch) {
        message.body = `/cancelarTarea ${idMatch[1]}`;
        console.log(`  → Intención "cancelar tarea" detectada, redirigiendo a ${message.body}`);
      }
    }

    // ======== DETALLES ========
    const detallesKW = client.keywordsData.intenciones.tareaDetalles || {};
    let activaDetalles = (detallesKW.frases || []).some(f => normalizedText.includes(normalizeText(f))) ||
                         (detallesKW.palabras || []).some(p => tokens.has(normalizeText(p)));
    if (activaDetalles && !normalizedBody.startsWith('/tareadetalles') && !normalizedBody.startsWith('/cancelar')) {
      const idMatch = normalizedText.match(/\b(\d{1,6})\b/);
      if (idMatch) {
        message.body = `/tareaDetalles ${idMatch[1]}`;
        console.log(`  → Intención "tareaDetalles" detectada, redirigiendo a ${message.body}`);
      }
    }

    // ======== TAREAS POR CATEGORÍA ========
    const tareasKW = intents.tareas || {};
    let activaTareas = (tareasKW.frases || []).some(f => normalizedText.includes(normalizeText(f))) ||
                       (tareasKW.palabras || []).some(p => tokens.has(normalizeText(p)));
    if (activaTareas && !/^\/tareas(\s|$)/.test(message.body || '') &&
        !/^\/generarReporte\b/.test(message.body || '')) {
      const partes = [];
      const today = moment().tz("America/Hermosillo").format("YYYY-MM-DD");
      if (/\b(hoy|actual|del dia)\b/.test(normalizedText)) partes.push('hoy');
      if (/\bayer\b/.test(normalizedText)) partes.push('ayer');
      if (/\bmañana\b/.test(normalizedText)) partes.push('mañana');
      if (/\bsemana pasada\b/.test(normalizedText)) {
        const semanaPasadaInicio = moment().tz("America/Hermosillo").subtract(7, 'day').format("YYYY-MM-DD");
        partes.push(`${semanaPasadaInicio}:${today}`);
      }
      const rangoMatch = normalizedText.match(/\b(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\b/);
      if (rangoMatch) {
        partes.push(`${rangoMatch[1]}:${rangoMatch[2]}`);
      } else {
        const solaMatch = normalizedBody.match(/\b(\d{4}-\d{2}-\d{2})\b/);
        if (solaMatch) partes.push(solaMatch[1]);
      }
      const pendientesKW = intents.tareasPendientes || {};
      const completadasKW = intents.tareasCompletadas || {};
      const canceladasKW = intents.tareasCanceladas || {};
      const enProcesoKW = intents.tareasEnProceso || {};
      const enPausaKW = intents.tareasEnPausa || {};
      if ((pendientesKW.palabras || []).some(p => tokens.has(normalizeText(p))) ||
          (pendientesKW.frases || []).some(f => normalizedText.includes(normalizeText(f)))) partes.push('pendiente');
      if ((completadasKW.palabras || []).some(p => tokens.has(normalizeText(p))) ||
          (completadasKW.frases || []).some(f => normalizedText.includes(normalizeText(f)))) partes.push('completada');
      // En proceso
      if ((enProcesoKW.palabras || []).some(p => tokens.has(normalizeText(p))) ||
          (enProcesoKW.frases || []).some(f => normalizedText.includes(normalizeText(f)))) {
        partes.push('en proceso');
      }
      // En pausa
      if ((enPausaKW.palabras || []).some(p => tokens.has(normalizeText(p))) ||
          (enPausaKW.frases || []).some(f => normalizedText.includes(normalizeText(f)))) {
        partes.push('en pausa');
      }
      if ((canceladasKW.palabras || []).some(p => tokens.has(normalizeText(p))) ||
          (canceladasKW.frases || []).some(f => normalizedText.includes(normalizeText(f)))) partes.push('cancelada');
      const categorias = {
        it: /(it|sistemas|soporte|t[eé]cnico)/,
        ama: /(ama|limpieza|hskp|camarista)/,
        rs: /(room|room service|habitaciones|alimentos)/,
        seg: /(seguridad|guardia|proteccion)/,
        man: /(mantenimiento|reparaciones|averia|t[eé]cnico)/
      };
      for (let [cat, regex] of Object.entries(categorias)) {
        if (regex.test(normalizedText)) {
          partes.push(cat);
          break;
        }
      }
      if (partes.length > 0) {
        message.body = `/tareas ${partes.join(' ')}`;
        console.log('  → Activando tareas con mensaje:', message.body);
      }
    }

    // ======== MANEJO DE COMANDOS ========
    if (message.body && message.body.trim().startsWith('/')) {
      console.log('→ Comando detectado:', message.body.trim());
      if (await handleCommands(client, message)) {
        console.log('    • Comando fue manejado por handleCommands');
        return;
      }
    }

    // ======== CITAS EN DM ========
    if (!isGroup && message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      const rawQuoted = normalizeText(quoted.body);
      const incidenciaId = await extractIdentifier(quoted);
      if (incidenciaId && BOT_MESSAGE_REGEX.test(rawQuoted)) {
        console.log(`→ DM: Respuesta a mensaje del bot (ID ${incidenciaId})`);
        if (detectCancel(client, tokens, normalizedText)) {
          await handleCancel(client, chat, message, incidenciaId);
          return;
        }
        if (detectConfirm(client, tokens, normalizedText)) {
          await processConfirmation(client, message);
          return;
        }
        if (detectPause(client, tokens, normalizedText)) {
          await handlePause(client, chat, message, incidenciaId);
          return;
        }
        await handleOriginResponse(client, message);
        return;
      }
    }

    // ======== CANCELACIÓN GLOBAL ========
    if (await processCancelationNewMethod(client, message)) {
      console.log('  → processCancelationNewMethod DETECTÓ cancelación genérica');
      return;
    }

    // ======== CITAS EN GRUPOS ========
    if (isGroup && message.hasQuotedMsg) {
      const quoted = await message.getQuotedMessage();
      const rawQuoted = normalizeText(quoted.body);
      const incidenciaId = await extractIdentifier(quoted);
      if (incidenciaId && BOT_MESSAGE_REGEX.test(rawQuoted)) {
        console.log(`→ Grupo: Respuesta a mensaje del bot (ID ${incidenciaId})`);
        if (detectCancel(client, tokens, normalizedText)) {
          await handleCancel(client, chat, message, incidenciaId);
          return;
        }
        if (detectConfirm(client, tokens, normalizedText)) {
          await processConfirmation(client, message);
          return;
        }
          if (detectPause(client, tokens, normalizedText)) {
          await handlePause(client, chat, message, incidenciaId);
          return;
        }
        await handleTeamResponse(client, message);
        return;
      }
    }

    console.log('  → Ninguna condición anterior, delegando a handleIncidence');
    await handleIncidence(client, message);
  } catch (err) {
    console.error('🔥 Error en handleMessage:', err);
  }
}

module.exports = handleMessage;
