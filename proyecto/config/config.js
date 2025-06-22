const path = require('path');

module.exports = {
  // IDs de grupos generales (otros usos)
  groupPruebaId:        "120363389868056953@g.us",
  groupBotDestinoId:    "120363408965534037@g.us",
  groupMantenimientoId: "120363393791264206@g.us",
  groupAmaId:           "120363409776076000@g.us",
  groupRoomServiceId:   "120363417592827245@g.us", 
  groupSeguridadId:   "120363401098651762@g.us",   

  // Mapeo de categorías a grupos destino para recordatorios automáticos.
  destinoGrupos: {
    it:          "120363408965534037@g.us",
    man:         "120363393791264206@g.us",
    ama:         "120363409776076000@g.us",
    rs: "120363417592827245@g.us",
    seg:   "120363401098651762@g.us"           // ← Nuevo
  },

  // La ruta al archivo de keywords se encuentra en data/
  keywordsFile: path.join(__dirname, '../data/keywords.json')
};
