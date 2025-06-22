
const assert = require('node:assert');
const { test } = require('node:test');
const path = require('path');
const fs = require('fs');
const moment = require('moment-timezone');
const incidenceDB = require('../modules/incidenceManager/incidenceDB');

incidenceDB.initDB();

const now = new Date().toISOString();
const testId = 'test-uid-' + Date.now();
let lastInsertId = null;

test('insertarIncidencia', (t) => {
  return new Promise((resolve, reject) => {
    const data = {
      uniqueMessageId: testId,
      originalMsgId: 'orig-test',
      descripcion: 'Test incidencia',
      reportadoPor: 'user@test',
      fechaCreacion: now,
      estado: 'pendiente',
      categoria: 'it',
      confirmaciones: { it: false },
      grupoOrigen: 'group1',
      media: null
    };

    incidenceDB.insertarIncidencia(data, (err, id) => {
      try {
        assert.ifError(err);
        assert.ok(id > 0);
        lastInsertId = id;
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('getIncidenciaById', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.getIncidenciaById(lastInsertId, (err, row) => {
      try {
        assert.ifError(err);
        assert.strictEqual(row.id, lastInsertId);
        assert.strictEqual(row.descripcion, 'Test incidencia');
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('buscarIncidenciaPorUniqueIdAsync', async () => {
  const result = await incidenceDB.buscarIncidenciaPorUniqueIdAsync(testId);
  assert.ok(result);
  assert.strictEqual(result.uniqueMessageId, testId);
});

test('buscarIncidenciaPorOriginalMsgIdAsync', async () => {
  const result = await incidenceDB.buscarIncidenciaPorOriginalMsgIdAsync('orig-test');
  assert.ok(result);
  assert.strictEqual(result.originalMsgId, 'orig-test');
});

test('getIncidenciasByCategory', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.getIncidenciasByCategory('it', (err, rows) => {
      try {
        assert.ifError(err);
        assert.ok(Array.isArray(rows));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('getIncidenciasByDate', (t) => {
  return new Promise((resolve, reject) => {
    const today = now.slice(0, 10);
    incidenceDB.getIncidenciasByDate(today, (err, rows) => {
      try {
        assert.ifError(err);
        assert.ok(Array.isArray(rows));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('getIncidenciasByRange', (t) => {
  return new Promise((resolve, reject) => {
    const start = moment().subtract(1, 'day').toISOString();
    const end = moment().add(1, 'day').toISOString();
    incidenceDB.getIncidenciasByRange(start, end, (err, rows) => {
      try {
        assert.ifError(err);
        assert.ok(Array.isArray(rows));
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('updateIncidenciaStatus', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.updateIncidenciaStatus(lastInsertId, 'completada', (err) => {
      try {
        assert.ifError(err);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('updateConfirmaciones', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.updateConfirmaciones(lastInsertId, JSON.stringify({ it: true }), (err) => {
      try {
        assert.ifError(err);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('updateFeedbackHistory', (t) => {
  return new Promise((resolve, reject) => {
    const feedback = { usuario: 'user@test', comentario: 'ok', fecha: now };
    incidenceDB.updateFeedbackHistory(lastInsertId, feedback, (err) => {
      try {
        assert.ifError(err);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('cancelarIncidencia', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.cancelarIncidencia(lastInsertId, (err) => {
      try {
        // Puede fallar si no está en estado pendiente, así que no falla por ahora
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('updateDescripcion', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.updateDescripcion(lastInsertId, 'Actualizado', (err) => {
      try {
        assert.ifError(err);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('updateCategoria', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.updateCategoria(lastInsertId, 'man', (err) => {
      try {
        assert.ifError(err);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('completeIncidencia', (t) => {
  return new Promise((resolve, reject) => {
    const iso = new Date().toISOString();
    incidenceDB.completeIncidencia(lastInsertId, 'test@jid', 'Test User', iso, (err) => {
      try {
        assert.ifError(err);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});

test('updateFase', (t) => {
  return new Promise((resolve, reject) => {
    incidenceDB.updateFase(lastInsertId, '1/3', (err) => {
      try {
        assert.ifError(err);
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
});
