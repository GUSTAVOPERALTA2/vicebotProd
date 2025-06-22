module.exports = {
  errores: {
    sinPermisos: "No tienes permisos para ejecutar este comando.",
    formatoInvalido: "Formato inválido.",
    incidenciaNoEncontrada: "No se encontró la incidencia con ese ID.",
    yaCompletada: "La incidencia ya está completada.",
    yaCancelada: "La incidencia está cancelada.",
  },

  comandos: {
    ayudaUsuario:
`🌀🌀 *COMANDOS USUARIOS*🌀🌀

🪪 */id* – Muestra tu ID
🆘 */ayuda* – Lista de comandos
✍️ */tareas <categoria>* – Ver incidencias (it, ama, man)
📅 */tareasFecha <YYYY-MM-DD>*
...
`,
    ayudaAdmin:
`*COMANDOS ADMINISTRADORES*

*KEYWORDS*
- /reloadKeywords
- /addKeyword <cat> <tipo> <entrada>
...

*USERS*
- /registerUser <id> | <nombre> | <cargo> | <rol>
...`
  },

  plantillas: {
    incidenciaCancelada: (id, desc, quien) =>
      `🤖 *La incidencia ID ${id}:* ${desc}\n\n*Ha sido cancelada por ${quien}.*`,

    mensajeEnviadoEquipos: (teams, id) =>
      `*🤖 El mensaje se ha enviado al equipo:* \n\n ✅ ${teams}\n\n*ID: ${id}*`,

    feedbackRetro: (desc, team, body, id) =>
      `RESPUESTA DE RETROALIMENTACION\n${desc}\n\n${team.toUpperCase()} RESPONDE:\n${body}\n\nID: ${id}`
  }
};
