const moment = require('moment-timezone');
const config = require('./config');
const incidenceDB = require('../modules/incidenceManager/incidenceDB');
const { MessageMedia } = require('whatsapp-web.js');
const { getUser } = require('./userManager');

function calcularTiempoSinRespuesta(fechaCreacion) {
  const ahora = moment();
  const inicio = moment(fechaCreacion);
  const duracion = moment.duration(ahora.diff(inicio));
  const dias = Math.floor(duracion.asDays());
  const horas = duracion.hours();
  const minutos = duracion.minutes();
  return `${dias} día(s), ${horas} hora(s), ${minutos} minuto(s)`;
}

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

      // 📌 Calcular próximo recordatorio si está en pausa
      let proximoRecordatorioTxt = '';
      if (row.estado === 'en pausa') {
        const lastReminder = row.ultimoRecordatorio ? moment(row.ultimoRecordatorio) : null;
        const nextReminder = lastReminder
          ? lastReminder.clone().add(24, 'hours')
          : now.clone().add(24, 'hours');

        proximoRecordatorioTxt = `\n\n⏸️ *Próximo recordatorio:* ${nextReminder.format('DD/MM/YYYY HH:mm')}`;

        // Actualizamos timestamp de último recordatorio solo si no se envió antes
        if (!lastReminder || now.diff(lastReminder, 'hours') >= 24) {
          const sqlUpdate = `UPDATE incidencias SET ultimoRecordatorio = ? WHERE id = ?`;
          db.run(sqlUpdate, [now.toISOString(), row.id], err => {
            if (err) console.error("❌ Error actualizando último recordatorio:", err);
          });
        } else {
          console.log(`⏸️ Incidencia ${row.id} pausada, recordatorio enviado hace menos de 24h.`);
          return; // No enviamos aún
        }
      }

      // Últimos 5 comentarios
      let comentariosTxt = '';
      if (row.feedbackHistory) {
        try {
          const history = JSON.parse(row.feedbackHistory);
          const ultimos = history
            .filter(h => h.tipo === 'feedbackrespuesta')
            .slice(-5);

          if (ultimos.length > 0) {
            comentariosTxt = '\n\n💬 *Últimos comentarios:*\n';
            ultimos.forEach(c => {
              const usr = getUser(c.usuario);
              const userLabel = usr ? `${usr.nombre} (${usr.cargo})` : c.usuario;
              comentariosTxt += `• ${userLabel}: ${c.comentario}\n`;
            });
          }
        } catch (err) {
          console.error("Error al parsear feedbackHistory:", err);
        }
      }

      const categorias = row.categoria.split(',').map(c => c.trim().toLowerCase());
      categorias.forEach(categoria => {
        const groupId = config.destinoGrupos[categoria];
        if (!groupId) {
          console.warn(`No hay grupo asignado para la categoría: ${categoria}`);
          return;
        }
        if (confirmaciones[categoria]) {
          console.log(`La incidencia ${row.id} ya tiene confirmación para la categoría ${categoria}.`);
          return;
        }

        const tiempoSinRespuesta = calcularTiempoSinRespuesta(row.fechaCreacion);
        const msg =
          `*RECORDATORIO*\n\n` +
          `${row.descripcion}\n\n\n` +
          `*Si la tarea ya se terminó, marca "Listo".*\n\n` +
          `⏱️ Tiempo sin respuesta: ${tiempoSinRespuesta}\n\n` +
          `ID: ${row.id}` +
          comentariosTxt +
          proximoRecordatorioTxt;

        console.log(`Enviando recordatorio para incidencia ${row.id} a grupo ${groupId} (${categoria})`);

        client.getChatById(groupId)
          .then(async chat => {
            try {
              let media = null;
              
              if (row.mediaPath) {
                // 🎥 Video
                try {
                  media = MessageMedia.fromFilePath(row.mediaPath);
                } catch (e) {
                  console.error("❌ Error cargando video desde ruta:", e);
                }
              } else if (row.media) {
                // 🖼️ Imagen
                try {
                  const parsed = JSON.parse(row.media);
                  if (parsed?.data && parsed?.mimetype) {
                    let base64Data = parsed.data;
                    const match = base64Data.match(/^data:.*;base64,(.*)$/);
                    if (match) base64Data = match[1];
                    media = new MessageMedia(parsed.mimetype, base64Data);
                  }
                } catch (e) {
                  console.error("❌ Error procesando imagen base64:", e);
                }
              }

              if (media) {
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

function startReminder(client) {
  checkPendingIncidences(client, true);
  setInterval(() => {
    checkPendingIncidences(client, false);
  }, 3600000);
}

module.exports = { startReminder };
