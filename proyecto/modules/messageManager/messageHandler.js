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
const { safeReplyOrSend } = require('../../utils/messageUtils');
const moment = require('moment-timezone');

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
    const normalizedBody = (message.body||'').toLowerCase();
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
    // Intención: ayuda
    const ayudaKW = client.keywordsData.ayuda || {};
    const ayudaFrases = ayudaKW.frases || [];
    const ayudaPalabras = ayudaKW.palabras || [];

    let activaAyuda = false;
    for (let frase of ayudaFrases) {
      if (normalizedText.includes(normalizeText(frase))) {
        activaAyuda = true;
        break;
      }
    }
    if (!activaAyuda) {
      for (let palabra of ayudaPalabras) {
        if (tokens.has(normalizeText(palabra))) {
          // Seguridad: mensaje corto o contiene "bot"
          if ((normalizedText.length < 25 && tokens.size <= 7) || normalizedText.includes("bot")) {
            activaAyuda = true;
            break;
          }
        }
      }
    }
    if (activaAyuda) {
      message.body = '/ayuda';
      console.log('→ Intención "ayuda" detectada, redirigiendo a /ayuda');
    }

    // === INTENCIÓN NATURAL: detalles de incidencia ===
    const detallesMatch = normalizedText.match(
      /(?:ver|mu[eé]strame|mostrar).*(?:detalle|detalles|info|informaci[oó]n).*?(\d{1,6})/
    );
    if (detallesMatch && !normalizedBody.startsWith('/tareadetalles')) {
      const incidenciaId = detallesMatch[1];
      message.body = `/tareaDetalles ${incidenciaId}`;
      console.log(`  → Intención "detalles" detectada, redirigiendo a ${message.body}`);
    }


    
    // === INTENCIÓN: mostrar tareas por categoría ===
    const tareasIntent = intents.tareas || {};
    const tareasFrases = tareasIntent.frases || [];
    const tareasPalabras = tareasIntent.palabras || [];

    let activaTareas = false;
    for (let frase of tareasFrases) {
      if (normalizedText.includes(normalizeText(frase))) {
        activaTareas = true;
        break;
      }
    }
    if (!activaTareas) {
      for (let palabra of tareasPalabras) {
        if (tokens.has(normalizeText(palabra))) {
          activaTareas = true;
          break;
        }
      }
    }

    if (activaTareas && !/^\/tareas(\s|$)/.test(normalizedText)) {
    const partes = [];
    const today = moment().tz("America/Hermosillo").format("YYYY-MM-DD");

    // 🗓️ Alias de fecha
    if (/\b(hoy|actual|del dia)\b/.test(normalizedText)) {
      partes.push('hoy');
    }
    if (/\bayer\b/.test(normalizedText)) {
      const ayer = moment().tz("America/Hermosillo").subtract(1, 'day').format("YYYY-MM-DD");
      partes.push(ayer);
    }
    if (/\bmañana\b/.test(normalizedText)) {
      const manana = moment().tz("America/Hermosillo").add(1, 'day').format("YYYY-MM-DD");
      partes.push(manana);
    }
    if (/\bsemana pasada\b/.test(normalizedText)) {
      const semanaPasadaInicio = moment().tz("America/Hermosillo").subtract(7, 'day').format("YYYY-MM-DD");
      partes.push(`${semanaPasadaInicio}:${today}`);
    }

    // 📆 Rango explícito YYYY-MM-DD:YYYY-MM-DD
    const rangoMatch = normalizedText.match(/\b(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})\b/);
    if (rangoMatch) {
      partes.push(`${rangoMatch[1]}:${rangoMatch[2]}`);
    }

    // 🔁 Estado
    if (/\b(pendiente|pendientes|falta|faltan|quedan)\b/.test(normalizedText)) partes.push('pendiente');
    if (/\b(completada|completadas|finalizada|terminada)\b/.test(normalizedText)) partes.push('completada');
    if (/\b(cancelada|canceladas|anulada|anularon)\b/.test(normalizedText)) partes.push('cancelada');

    // 📂 Categoría
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

    // Si encontramos al menos un parámetro, generamos el comando
    if (partes.length > 0) {
      const generated = `/tareas ${partes.join(' ')}`;
      console.log('  → Activando tareas con mensaje:', generated);
      message.body = generated;
    }
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
              await safeReplyOrSend(chat, message, `❌ No se pudo cancelar la incidencia ID ${incidenciaId}.`);
            } else {
              const sender = message.author || message.from;
              const user   = getUser(sender);
              const who    = user ? `${user.nombre}(${user.cargo})` : sender;
              await safeReplyOrSend(chat, message, `🤖✅  La incidencia ID: ${incidenciaId} ha sido cancelada por ${who}`);
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
              await safeReplyOrSend(chat, message, `❌ No se pudo cancelar la incidencia ID ${incidenciaId}.`);
            } else {
              const sender = message.author || message.from;
              const user   = getUser(sender);
              const who    = user ? `${user.nombre}(${user.cargo})` : sender;
              await safeReplyOrSend(chat, message, `🤖✅  *La incidencia ID: ${incidenciaId} ha sido cancelada por ${who}*`);
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
