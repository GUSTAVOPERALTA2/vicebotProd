const sqlite3 = require('sqlite3').verbose();
const path = require('path');
let db;

function initDB() {
  const dbPath = path.join(__dirname, '../../data/incidencias.db');
  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error("Error al abrir la BD:", err);
    } else {
      console.log("Base de datos iniciada.");
      db.run(`CREATE TABLE IF NOT EXISTS incidencias (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                uniqueMessageId TEXT,
                originalMsgId TEXT,
                descripcion TEXT,
                reportadoPor TEXT,
                fechaCreacion TEXT,
                estado TEXT,
                categoria TEXT,
                confirmaciones TEXT,
                feedbackHistory TEXT,
                grupoOrigen TEXT,
                media TEXT,
                fechaCancelacion TEXT,
                fechaFinalizacion   TEXT,
                completadoPorJid    TEXT,
                completadoPorNombre TEXT,
                faseActual          TEXT,
                ultimoRecordatorio TEXT,
                mediaPath TEXT
              )`);
    }
  });
}

function getDB() {
  return db;
}

/**
 * pauseIncidencia - Actualiza el estado de la incidencia a "en pausa".
 * 
 * @param {number|string} incidenciaId - ID de la incidencia
 * @param {function} callback - Callback de finalización
 */
function pauseIncidencia(incidenciaId, callback) {
  const sql = "UPDATE incidencias SET estado = 'en pausa' WHERE id = ?";
  db.run(sql, [incidenciaId], function(err) {
    if (err) {
      callback(err);
    } else if (this.changes === 0) {
      callback(new Error("No se actualizó ninguna incidencia; verifica que el ID exista."));
    } else {
      callback(null);
    }
  });
}

/**
 * pauseIncidenciaAsync - Versión asíncrona de pauseIncidencia
 */
function pauseIncidenciaAsync(incidenciaId) {
  return new Promise((resolve, reject) => {
    const sql = "UPDATE incidencias SET estado = 'en pausa' WHERE id = ?";
    db.run(sql, [incidenciaId], function(err) {
      if (err) return reject(err);
      if (this.changes === 0) {
        return reject(new Error("No se actualizó ninguna incidencia; verifica que el ID exista."));
      }
      resolve();
    });
  });
}

function insertarIncidencia(incidencia, callback) {
  const sql = `INSERT INTO incidencias 
    (uniqueMessageId, originalMsgId, descripcion, reportadoPor, fechaCreacion, estado, categoria, confirmaciones, feedbackHistory, grupoOrigen, media, mediaPath, fechaFinalizacion, completadoPorJid, completadoPorNombre) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  db.run(sql, [
    incidencia.uniqueMessageId,
    incidencia.originalMsgId,
    incidencia.descripcion,
    incidencia.reportadoPor,
    incidencia.fechaCreacion,
    incidencia.estado,
    incidencia.categoria,
    incidencia.confirmaciones ? JSON.stringify(incidencia.confirmaciones) : null,
    JSON.stringify([]),
    incidencia.grupoOrigen,
    incidencia.media,              // base64 para fotos
    null,                          // fechaFinalizacion
    null,                          // completadoPorJid
    null,                          // completadoPorNombre
    incidencia.mediaPath || null    // path para videos
  ], function(err) {
    callback(err, this.lastID);
  });
}
function insertarIncidenciaAsync(incidencia) {
  return new Promise((resolve, reject) => {
    insertarIncidencia(incidencia, (err, id) => {
      if (err) reject(err);
      else resolve(id);
    });
  });
}

function buscarIncidenciaPorUniqueIdAsync(uniqueId) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT * FROM incidencias WHERE uniqueMessageId = ? LIMIT 1";
    db.get(sql, [uniqueId], (err, row) => {
      if (err) return reject(err);
      if (row && row.confirmaciones) {
        try {
          row.confirmaciones = JSON.parse(row.confirmaciones);
        } catch (e) {
          console.error("Error al parsear confirmaciones:", e);
        }
      }
      resolve(row);
    });
  });
}

function buscarIncidenciaPorOriginalMsgIdAsync(originalMsgId) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT * FROM incidencias WHERE originalMsgId = ? LIMIT 1";
    db.get(sql, [originalMsgId], (err, row) => {
      if (err) return reject(err);
      if (row && row.confirmaciones) {
        try {
          row.confirmaciones = JSON.parse(row.confirmaciones);
        } catch (e) {
          console.error("Error al parsear confirmaciones:", e);
        }
      }
      resolve(row);
    });
  });
}

function getIncidenciaById(incidenciaId, callback) {
  const sql = "SELECT * FROM incidencias WHERE id = ?";
  db.get(sql, [incidenciaId], (err, row) => {
    if (row && row.confirmaciones) {
      try {
        row.confirmaciones = JSON.parse(row.confirmaciones);
      } catch (e) {
        console.error("Error al parsear confirmaciones:", e);
      }
    }
    callback(err, row);
  });
}

function getIncidenciaByIdAsync(incidenciaId) {
  return new Promise((resolve, reject) => {
    const sql = "SELECT * FROM incidencias WHERE id = ?";
    db.get(sql, [incidenciaId], (err, row) => {
      if (err) return reject(err);
      if (row && row.confirmaciones) {
        try {
          row.confirmaciones = JSON.parse(row.confirmaciones);
        } catch (e) {
          console.error("Error al parsear confirmaciones:", e);
        }
      }
      resolve(row);
    });
  });
}

async function filtrarIncidencias(filtros) {
  return new Promise((resolve, reject) => {
    const condiciones = [];
    const params = [];

    // Estado: manejar array o string
    if (filtros.estado) {
      if (Array.isArray(filtros.estado)) {
        const placeholders = filtros.estado.map(() => '?').join(',');
        condiciones.push(`estado IN (${placeholders})`);
        params.push(...filtros.estado);
      } else {
        condiciones.push("estado = ?");
        params.push(filtros.estado);
      }
    }

    // Categoría
    if (filtros.categoria) {
      condiciones.push("categoria = ?");
      params.push(filtros.categoria);
    }

    // Fecha inicio
    if (filtros.startDate) {
      condiciones.push("fechaCreacion >= ?");
      params.push(filtros.startDate);
    }

    // Fecha fin
    if (filtros.endDate) {
      condiciones.push("fechaCreacion <= ?");
      params.push(filtros.endDate);
    }

    const whereClause = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
    const sql = `SELECT * FROM incidencias ${whereClause}`;

    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error("Error en filtrarIncidencias:", err);
        return resolve([]);
      }
      if (rows) {
        rows.forEach(row => {
          try {
            row.confirmaciones = JSON.parse(row.confirmaciones || '[]');
          } catch (e) {
            console.error("Error parseando confirmaciones:", e);
          }
        });
      }
      resolve(rows || []);
    });
  });
}

function updateIncidenciaStatus(incidenciaId, estado, callback) {
  const sql = "UPDATE incidencias SET estado = ? WHERE id = ?";
  db.run(sql, [estado, incidenciaId], function(err) {
    callback(err);
  });
}

function updateConfirmaciones(incidenciaId, confirmaciones, callback) {
  const sql = "UPDATE incidencias SET confirmaciones = ? WHERE id = ?";
  db.run(sql, [confirmaciones, incidenciaId], function(err) {
    callback(err);
  });
}

function updateFeedbackHistory(incidenciaId, newFeedback, callback) {
  const sqlSelect = "SELECT feedbackHistory FROM incidencias WHERE id = ?";
  db.get(sqlSelect, [incidenciaId], (err, row) => {
    if (err) return callback(err);
    let history = [];
    if (row && row.feedbackHistory) {
      try {
        history = JSON.parse(row.feedbackHistory);
      } catch (e) {
        console.error("Error al parsear feedbackHistory:", e);
      }
    }
    if (Array.isArray(newFeedback)) {
      history = newFeedback;
    } else {
      history.push(newFeedback);
    }
    const sqlUpdate = "UPDATE incidencias SET feedbackHistory = ? WHERE id = ?";
    db.run(sqlUpdate, [JSON.stringify(history), incidenciaId], function(err) {
      callback(err);
    });
  });
}

function cancelarIncidencia(incidenciaId, callback) {
  const sql = `
    UPDATE incidencias 
    SET estado = ?, fechaCancelacion = ? 
    WHERE id = ? AND estado IN ('pendiente', 'en proceso')`;
  const fechaCancelacion = new Date().toISOString();
  db.run(sql, ["cancelada", fechaCancelacion, incidenciaId], function(err) {
    if (err) {
      callback(err);
    } else if (this.changes === 0) {
      callback(new Error("No se actualizó ninguna incidencia; verifica que el ID exista y esté en estado pendiente o en proceso."));
    } else {
      callback(null);
    }
  });
}

function cancelarIncidenciaAsync(incidenciaId) {
  return new Promise((resolve, reject) => {
    const sql = `
      UPDATE incidencias
      SET estado = 'cancelada',
          fechaCancelacion = ?
      WHERE id = ? AND estado IN ('pendiente', 'en proceso')`;

    const fechaCancelacion = new Date().toISOString();
    db.run(sql, [fechaCancelacion, incidenciaId], function(err) {
      if (err) return reject(err);
      if (this.changes === 0) {
        return reject(new Error("No se actualizó ninguna incidencia; verifica que el ID exista y esté en estado pendiente o en proceso."));
      }
      resolve();
    });
  });
}
function updateDescripcion(id, descripcion, callback) {
  const sql = "UPDATE incidencias SET descripcion = ? WHERE id = ?";
  db.run(sql, [descripcion, id], err => callback(err));
}

function updateCategoria(id, categoria, callback) {
  const sql = "UPDATE incidencias SET categoria = ? WHERE id = ?";
  db.run(sql, [categoria, id], err => callback(err));
}

function completeIncidencia(id, completedJid, completedName, completionTime, cb) {
  const sql = `
    UPDATE incidencias
    SET
      estado              = ?,
      fechaFinalizacion   = ?,
      completadoPorJid    = ?,
      completadoPorNombre = ?
    WHERE id = ?
  `;
  db.run(
    sql,
    ["completada", completionTime, completedJid, completedName, id],
    cb
  );
}

function updateFase(incidenciaId, fase, cb) {
  const sql = `UPDATE incidencias SET faseActual = ? WHERE id = ?`;
  db.run(sql, [fase, incidenciaId], cb);
}

function updateFaseAsync(incidenciaId, fase) {
  return new Promise((resolve, reject) => {
    const sql = `UPDATE incidencias SET faseActual = ? WHERE id = ?`;
    db.run(sql, [fase, incidenciaId], function(err) {
      if (err) reject(err);
      else resolve();
    });
  });
}

function markInProcessAsync(incidenciaId) {
  return new Promise((resolve, reject) => {
    const sql = "UPDATE incidencias SET estado = 'en proceso' WHERE id = ? AND estado != 'completada' AND estado != 'cancelada'";
    db.run(sql, [incidenciaId], function (err) {
      if (err) return reject(err);
      resolve();
    });
  });
}
function markInProcess(incidenciaId, callback) {
  const sql = "UPDATE incidencias SET estado = 'en proceso' WHERE id = ? AND estado != 'completada' AND estado != 'cancelada'";
  db.run(sql, [incidenciaId], function (err) {
    if (err) {
      callback(err);
    } else {
      callback(null);
    }
  });
}
module.exports = {
  initDB,
  markInProcess,
  markInProcessAsync,
  getDB,
  insertarIncidencia,
  insertarIncidenciaAsync,
  buscarIncidenciaPorUniqueIdAsync,
  buscarIncidenciaPorOriginalMsgIdAsync,
  getIncidenciaById,
  getIncidenciaByIdAsync,
  updateIncidenciaStatus,
  updateConfirmaciones,
  updateFeedbackHistory,
  cancelarIncidencia,
  cancelarIncidenciaAsync,
  updateDescripcion,
  updateCategoria,
  completeIncidencia,
  updateFase,
  updateFaseAsync,
  filtrarIncidencias,
  pauseIncidencia,        // ✅ Nuevo
  pauseIncidenciaAsync    // ✅ Nuevo
};
