
const { test } = require('node:test');
const assert = require('node:assert');
const { handleIncidence } = require('../modules/incidenceManager/incidenceManager');
const { normalizeText } = require('../config/stringUtils');
const config = require('../config/config');

// Simula un cliente de prueba
const fakeClient = {
  keywordsData: {
    retro: {
      frases: ['por favor completa', 'envía retroalimentación'],
      palabras: ['retro', 'comentario']
    }
  }
};

// Mocks
let calls = [];

const fakeMessage = (body, chatId, quoted = null) => ({
  body,
  hasQuotedMsg: !!quoted,
  getQuotedMessage: async () => quoted,
  getChat: async () => ({ id: { _serialized: chatId } }),
  reply: async (msg) => calls.push(`reply: ${msg}`)
});

// Simulación de funciones internas con rastreo
const mockFns = {};
function resetMocks() {
  calls = [];
  for (let fn of ['processNewIncidence', 'requestFeedback', 'handleTeamResponse', 'processConfirmation']) {
    mockFns[fn].calls = [];
  }
}
for (let fn of ['processNewIncidence', 'requestFeedback', 'handleTeamResponse', 'processConfirmation']) {
  mockFns[fn] = async (...args) => mockFns[fn].calls.push(args);
  mockFns[fn].calls = [];
}

// Reinyectar mocks
jest.mock('../modules/incidenceManager/newIncidence', () => ({
  processNewIncidence: mockFns.processNewIncidence
}));
jest.mock('../modules/incidenceManager/feedbackProcessor', () => ({
  requestFeedback: mockFns.requestFeedback,
  handleTeamResponse: mockFns.handleTeamResponse
}));
jest.mock('../modules/incidenceManager/confirmationProcessor', () => ({
  processConfirmation: mockFns.processConfirmation
}));

test('🔸 Mensaje sin cita en grupo principal → processNewIncidence', async () => {
  resetMocks();
  const msg = fakeMessage('hay fuga en 101', config.groupPruebaId);
  await handleIncidence(fakeClient, msg);
  assert(mockFns.processNewIncidence.calls.length > 0);
});

test('🔸 Cita de recordatorio en grupo principal → processConfirmation', async () => {
  resetMocks();
  const quoted = { body: '*Recordatorio: tarea incompleta (ID 22)*' };
  const msg = fakeMessage('listo', config.groupPruebaId, quoted);
  await handleIncidence(fakeClient, msg);
  assert(mockFns.processConfirmation.calls.length > 0);
});

test('🔸 Cita de nueva tarea en grupo principal → processConfirmation', async () => {
  resetMocks();
  const quoted = { body: '*Nueva tarea recibida (ID 33):* ...' };
  const msg = fakeMessage('ok', config.groupPruebaId, quoted);
  await handleIncidence(fakeClient, msg);
  assert(mockFns.processConfirmation.calls.length > 0);
});

test('🔸 Cita con frase de retroalimentación válida → requestFeedback', async () => {
  resetMocks();
  const quoted = { body: '*ID 55*' };
  const msg = fakeMessage('por favor completa el comentario', config.groupPruebaId, quoted);
  await handleIncidence(fakeClient, msg);
  assert(mockFns.requestFeedback.calls.length > 0);
});

test('🔸 Cita con mensaje irreconocible → reply de advertencia', async () => {
  resetMocks();
  const quoted = { body: '*ID 99*' };
  const msg = fakeMessage('???', config.groupPruebaId, quoted);
  await handleIncidence(fakeClient, msg);
  assert(calls.some(c => c.includes('no es válida para registrar una incidencia')));
});

test('🔸 Mensaje desde grupo de destino → handleTeamResponse', async () => {
  resetMocks();
  const msg = fakeMessage('ok', config.groupBotDestinoId);
  await handleIncidence(fakeClient, msg);
  assert(mockFns.handleTeamResponse.calls.length > 0);
});
