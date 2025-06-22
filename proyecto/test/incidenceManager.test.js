// File: test/incidenceManager.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const manager = require('../modules/incidenceManager/incidenceManager');

test('🧪 Verifica que el módulo exporte funciones necesarias', () => {
  assert.ok(typeof manager.handleIncidence === 'function', 'Debe exportar handleIncidence');
});
