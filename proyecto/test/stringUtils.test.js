// stringUtils.test.js
const assert = require('node:assert');
const { test } = require('node:test');
const { normalizeText, similarity } = require('../config/stringUtils');

test('normalizeText elimina acentos y signos de puntuación', () => {
  const result = normalizeText('¡Hola, cómo estás?');
  assert.strictEqual(result, 'hola como estas');
});

test('similarity entre palabras iguales debe ser 1', () => {
  const result = similarity('café', 'cafe');
  assert(result >= 0.95);
});

test('similarity entre palabras distintas debe ser menor a 1', () => {
  const result = similarity('café', 'té');
  assert(result < 0.9);
});
