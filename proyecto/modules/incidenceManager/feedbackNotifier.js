// modules/incidenceManager/feedbackNotifier.js

const config = require('../../config/config');
const moment = require('moment-timezone');
const { formatDate } = require('../../config/dateUtils');

/**
 * sendFeedbackRequestToGroups
 * Envía una solicitud de retroalimentación a cada grupo correspondiente
 * a las categorías de la incidencia.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {Object} incidence — Objeto de incidencia tal como viene de la BD,
 *        debe incluir id, categoria (string “it,ama,man”), descripcion y fechaCreacion.
 */
async function sendFeedbackRequestToGroups(client, incidence) {
  const teams = incidence.categoria
    .split(',')
    .map(c => c.trim().toLowerCase());

  const createdAt = moment(incidence.fechaCreacion)
    .tz('America/Mazatlan')
    .format('DD/MM/YYYY HH:mm');

  for (const team of teams) {
    const groupId = config.destinoGrupos[team];
    if (!groupId) {
      console.warn(`No se encontró grupo destino para la categoría "${team}"`);
      continue;
    }

    const chat = await client.getChatById(groupId);
    const msg =
      `📝 *SOLICITUD DE RETROALIMENTACIÓN*\n\n` +
      `*ID:* ${incidence.id}\n` +
      `*Categoría:* ${team.toUpperCase()}\n` +
      `*Creada:* ${createdAt}\n\n` +
      `${incidence.descripcion}\n\n` +
      `_Por favor, respondan citando este mensaje con su retroalimentación._`;

    try {
      await chat.sendMessage(msg);
      console.log(`Solicitud de feedback enviada a ${groupId} (${team})`);
    } catch (err) {
      console.error(`Error al enviar solicitud de feedback a ${groupId}:`, err);
    }
  }
}

/**
 * sendFeedbackReminder
 * Reenvía un recordatorio a los equipos que aún no han respondido
 * con feedbackrespuesta, basado en el feedbackHistory de la incidencia.
 *
 * @param {import('whatsapp-web.js').Client} client
 * @param {Object} incidence — Debe incluir id, categoria y feedbackHistory (JSON-string).
 */
async function sendFeedbackReminder(client, incidence) {
  let history = [];
  try {
    history = JSON.parse(incidence.feedbackHistory || '[]');
  } catch {
    history = [];
  }

  const teams       = incidence.categoria.split(',').map(c => c.trim().toLowerCase());
  const responded   = new Set(
    history
      .filter(r => r.tipo === 'feedbackrespuesta')
      .map(r => r.equipo.toLowerCase())
  );
  const pendingTeams = teams.filter(t => !responded.has(t));

  if (pendingTeams.length === 0) {
    console.log(`Incidencia ${incidence.id}: no quedan equipos pendientes.`);
    return;
  }

  for (const team of pendingTeams) {
    const groupId = config.destinoGrupos[team];
    if (!groupId) {
      console.warn(`No se encontró grupo destino para recordatorio de "${team}"`);
      continue;
    }
    const chat = await client.getChatById(groupId);
    const msg =
      `⏰ *RECORDATORIO DE RETROALIMENTACIÓN*\n\n` +
      `*ID:* ${incidence.id}\n` +
      `*Categoría:* ${team.toUpperCase()}\n\n` +
      `Aún no hemos recibido tu retroalimentación. ` +
      `_Por favor, responde citando esta solicitud._`;

    try {
      await chat.sendMessage(msg);
      console.log(`Recordatorio de feedback enviado a ${groupId} (${team})`);
    } catch (err) {
      console.error(`Error al enviar recordatorio de feedback a ${groupId}:`, err);
    }
  }
}

module.exports = {
  sendFeedbackRequestToGroups,
  sendFeedbackReminder
};
