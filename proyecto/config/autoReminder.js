const moment = require('moment-timezone');
const config = require('./config');
const incidenceDB = require('../modules/incidenceManager/incidenceDB');
const { MessageMedia } = require('whatsapp-web.js');

/**
 * calcularTiempoSinRespuesta - Calcula el tiempo transcurrido entre la fecha de creación y el momento actual.
 */
function calcularTiempoSinRespuesta(fechaCreacion) {
  const ahora = moment();
  const inicio = moment(fechaCreacion);
  const duracion = moment.duration(ahora.diff(inicio));
  const dias = Math.floor(duracion.asDays());
  const horas = duracion.hours();
  const minutos = duracion.minutes();
  return `${dias} día(s), ${horas} hora(s), ${minutos} minuto(s)`;
}

/**
 * checkPendingIncidences - Revisa incidencias pendientes y envía recordatorios considerando "en pausa".
 */
function checkPendingIncidences(client, initialRun = false) {
  const now = moment().tz("America/Hermosillo");
  const currentHour = now.hour();
  if (currentHour < 6 || currentHour >= 23) {
    console.log(`Fuera del horario laboral (hora actual: ${currentHour}). No se enviará recordatorio.`);
    return;
  }

  const threshold = initialRun ? now.toISOString() : now.clone().subtract(1, 'hour').toISOString();
  console.log(`Chequeando incidencias pendientes (umbral ${initialRun ? '0h' : '1h'}): ${threshold}`);

  const db = incidenceDB.getDB();
  if (!db) {
    console.error("La base de datos no está inicializada.");
    return;
  }

  const sql = "SELECT * FROM incidencias WHERE estado NOT IN ('completada','cancelada') AND fechaCreacion < ?";
  db.all(sql, [threshold], (err, rows) => {
    if (err) {
      console.error("Error en recordatorio automático:", err.message);
      return;
    }
    if (!rows || rows.length === 0) {
      console.log(`No se encontraron incidencias pendientes (umbral ${initialRun ? '0h' : '1h'}).`);
      return;
    }

    rows.forEach(row => {
      let confirmaciones = {};
      if (row.confirmaciones) {
        try {
          confirmaciones = JSON.parse(row.confirmaciones);
        } catch (err) {
          console.error("Error al parsear confirmaciones:", err);
        }
      }

      // ⏸️ Si está en pausa, verificamos último recordatorio
      if (row.estado === 'en pausa') {
        const lastReminder = row.ultimoRecordatorio ? moment(row.ultimoRecordatorio) : null;
        if (lastReminder && now.diff(lastReminder, 'hours') < 24) {
          console.log(`⏸️ Incidencia ${row.id} en pausa, recordatorio enviado hace menos de 24h.`);
          return; // ❌ Saltar envío
        }

        // Actualizamos timestamp del último recordatorio
        const sqlUpdate = `UPDATE incidencias SET ultimoRecordatorio = ? WHERE id = ?`;
        db.run(sqlUpdate, [now.toISOString(), row.id], err => {
          if (err) console.error("❌ Error actualizando último recordatorio:", err);
        });
      }

      const categorias = row.categoria.split(',').map(c => c.trim().toLowerCase());
      categorias.forEach(categoria => {
        const groupId = config.destinoGrupos[categoria];
        if (!groupId) {
          console.warn(`No hay grupo asignado para la categoría: ${categoria}`);
          return;
        }
        if (confirmaciones[categoria]) {
          console.log(`La incidencia ${row.id} ya tiene confirmación para la categoría ${categoria}. No se enviará recordatorio a este equipo.`);
          return;
        }

        const tiempoSinRespuesta = calcularTiempoSinRespuesta(row.fechaCreacion);
        const msg =
          `*RECORDATORIO*\n\n` +
          `${row.descripcion}\n\n` +
          `*Si la tarea ya se terminó, marca "Listo".*\n\n` +
          `Tiempo sin respuesta: ${tiempoSinRespuesta}\n` +
          `ID: ${row.id}`;

        console.log(`Enviando recordatorio para incidencia ${row.id} a grupo ${groupId} (categoría ${categoria})`);

        client.getChatById(groupId)
          .then(async chat => {
            try {
              const mediaPath = row.mediaPath || row.media;
              if (mediaPath) {
                const media = MessageMedia.fromFilePath(mediaPath);
                await chat.sendMessage(media, { caption: msg });
              } else {
                await chat.sendMessage(msg);
              }
              console.log(`Recordatorio enviado para incidencia ${row.id} a grupo ${groupId}.`);
            } catch (e) {
              console.error(`❌ Error al enviar recordatorio para grupo ${groupId}:`, e);
            }
          })
          .catch(e => {
            console.error(`❌ Error al obtener chat para grupo ${groupId}:`, e);
          });
      });
    });
  });
}

/**
 * startReminder - Inicia verificación inmediata y periódica de incidencias pendientes.
 */
function startReminder(client) {
  checkPendingIncidences(client, true);
  setInterval(() => {
    checkPendingIncidences(client, false);
  }, 3600000); // 1 hora
}

module.exports = { startReminder };
