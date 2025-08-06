const fs = require('fs');
const path = require('path');
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
    console.log(`⏰ Fuera del horario laboral (hora actual: ${currentHour}). No se enviará recordatorio.`);
    return;
  }

  const threshold = initialRun ? now.toISOString() : now.clone().subtract(1, 'hour').toISOString();
  console.log(`🕵️‍♂️ Chequeando incidencias pendientes (umbral ${initialRun ? '0h' : '1h'}): ${threshold}`);

  const db = incidenceDB.getDB();
  if (!db) {
    console.error("❌ La base de datos no está inicializada.");
    return;
  }

  const sql = "SELECT * FROM incidencias WHERE estado NOT IN ('completada','cancelada') AND fechaCreacion < ?";
  db.all(sql, [threshold], (err, rows) => {
    if (err) {
      console.error("❌ Error al consultar la base de datos:", err.message);
      return;
    }
    if (!rows || rows.length === 0) {
      console.log(`📭 No se encontraron incidencias pendientes.`);
      return;
    }

    rows.forEach(row => {
      console.log(`\n📌 Procesando incidencia ID: ${row.id}`);

      let confirmaciones = {};
      if (row.confirmaciones) {
        try {
          confirmaciones = JSON.parse(row.confirmaciones);
        } catch (err) {
          console.error("❌ Error al parsear confirmaciones:", err);
        }
      }

      // ⏸️ Estado en pausa
      let proximoRecordatorioTxt = '';
      if (row.estado === 'en pausa') {
        const lastReminder = row.ultimoRecordatorio ? moment(row.ultimoRecordatorio) : null;
        const nextReminder = lastReminder
          ? lastReminder.clone().add(24, 'hours')
          : now.clone().add(24, 'hours');
        proximoRecordatorioTxt = `\n\n⏸️ *Próximo recordatorio:* ${nextReminder.format('DD/MM/YYYY HH:mm')}`;

        if (!lastReminder || now.diff(lastReminder, 'hours') >= 24) {
          db.run(
            `UPDATE incidencias SET ultimoRecordatorio = ? WHERE id = ?`,
            [now.toISOString(), row.id],
            err => {
              if (err) console.error("❌ Error actualizando último recordatorio:", err);
            }
          );
        } else {
          console.log(`⏸️ Ya se envió un recordatorio hace menos de 24h. Omitiendo.`);
          return;
        }
      }

      // 💬 Comentarios
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
          console.error("❌ Error al parsear feedbackHistory:", err);
        }
      }

      const categorias = row.categoria.split(',').map(c => c.trim().toLowerCase());
      categorias.forEach(categoria => {
        const groupId = config.destinoGrupos[categoria];
        if (!groupId) {
          console.warn(`⚠️ No hay grupo asignado para la categoría: ${categoria}`);
          return;
        }
        if (confirmaciones[categoria]) {
          console.log(`✅ Incidencia ya confirmada por ${categoria}. Omitiendo.`);
          return;
        }

        const tiempoSinRespuesta = calcularTiempoSinRespuesta(row.fechaCreacion);
        const msg =
          `*RECORDATORIO*\n\n` +
          `${row.descripcion}\n\n` +
          `*Si la tarea ya se terminó, marca "Listo".*\n\n` +
          `⏱️ Tiempo sin respuesta: ${tiempoSinRespuesta}\n\n` +
          `ID: ${row.id}` +
          comentariosTxt +
          proximoRecordatorioTxt;

        console.log(`📤 Enviando recordatorio a grupo ${groupId} (${categoria})`);

        client.getChatById(groupId)
          .then(async chat => {
            try {
              let media = null;

              // 1) VIDEO
              if (row.mediaPath) {
                console.log(`📹 mediaPath de incidencia ${row.id}:`, row.mediaPath);
                const exists = fs.existsSync(row.mediaPath);
                console.log(`🗂️ Verificación existencia archivo: ${exists}`);
                if (exists) {
                  try {
                    const stat = fs.statSync(row.mediaPath);
                    console.log(`📏 Tamaño del archivo: ${stat.size} bytes`);
                    media = MessageMedia.fromFilePath(row.mediaPath);
                    console.log('✅ MessageMedia (video) generado:', {
                      mimetype: media.mimetype,
                      filename: media.filename,
                      dataLength: media.data.length
                    });
                  } catch (e) {
                    console.error(`❌ Error cargando video desde ruta:`, e);
                  }
                } else {
                  console.warn(`❗ Archivo de video no encontrado: ${row.mediaPath}`);
                }
              }
              // 2) FOTO
              else if (row.media) {
                console.log(`🖼️ media base64 detectada para incidencia ${row.id}`);
                try {
                  const parsed = JSON.parse(row.media);
                  if (parsed?.data && parsed?.mimetype) {
                    let base64Data = parsed.data;
                    const match = base64Data.match(/^data:.*;base64,(.*)$/);
                    if (match) base64Data = match[1];
                    media = new MessageMedia(parsed.mimetype, base64Data);
                    console.log('✅ MessageMedia (imagen) generado:', {
                      mimetype: media.mimetype,
                      dataLength: media.data.length
                    });
                  } else {
                    console.warn(`⚠️ Formato de imagen base64 inválido`);
                  }
                } catch (e) {
                  console.error("❌ Error parseando media base64:", e);
                }
              }

              // 3) Envío
              if (media) {
                await chat.sendMessage(media, {
                  caption: msg,
                  sendMediaAsDocument: false,
                  sendMediaAsSticker: false
                });
              } else {
                console.log("📄 Enviando solo mensaje de texto.");
                await chat.sendMessage(msg);
              }

              console.log(`✅ Recordatorio enviado para incidencia ${row.id}`);
            } catch (e) {
              console.error(`❌ Error al enviar recordatorio a grupo ${groupId}:`, e);
            }
          })
          .catch(e => {
            console.error(`❌ Error al obtener chat de grupo ${groupId}:`, e);
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
