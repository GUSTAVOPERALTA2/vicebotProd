// utils/categoriaDetector.js
const { normalizeText, adaptiveSimilarityCheck } = require('../../config/stringUtils');
const { getUser } = require('../../config/userManager');

/**
 * Detecta categorías a partir de un mensaje aplicando tres filtros en orden.
 * @param {string} text - Texto del mensaje.
 * @param {Array<string>} mentions - Lista de JIDs mencionados (message.mentionedIds).
 * @param {Object} keywordsData - Objeto de keywords cargado (client.keywordsData).
 * @returns {Array<string>} - Lista de categorías detectadas (['it'], ['man', 'ama'], etc.).
 */
function detectarCategoriaPorFiltros(text, mentions, keywordsData) {
  const categorias = [];

  // --- Filtro 1: Referencia explícita ---
  const referencias = {
    it: ['it', 'sistemas'],
    man: ['mantenimiento', 'manto', 'mant'],
    ama: ['hskp', 'ama de llaves'],
    room: ['roomservice', 'room service'],
    seg: ['seguridad']
  };
  const normText = normalizeText(text);

  for (const [cat, términos] of Object.entries(referencias)) {
    if (términos.some(t => normText.includes(normalizeText(t)))) {
      categorias.push(cat);
    }
  }
  if (categorias.length) return categorias;

  // --- Filtro 2: Usuario mencionado con team ---
  for (const id of mentions || []) {
    const user = getUser(id);
    if (user && user.team && !categorias.includes(user.team)) {
      categorias.push(user.team);
    }
  }
  if (categorias.length) return categorias;

  // --- Filtro 3: Coincidencias con keywords.json ---
  const categoriasKeys = ['it', 'man', 'ama'];
  const tokens = normText.split(/\s+/);

  for (let cat of categoriasKeys) {
    const data = keywordsData.identificadores[cat];
    if (!data) continue;

    const matchPalabra = data.palabras?.some(palabra =>
      tokens.some(token => adaptiveSimilarityCheck(token, normalizeText(palabra)))
    );

    const matchFrase = data.frases?.some(frase =>
      normText.includes(normalizeText(frase))
    );

    if (matchPalabra || matchFrase) {
      categorias.push(cat);
    }
  }

  return categorias;
}

module.exports = { detectarCategoriaPorFiltros };
