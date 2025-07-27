/**
 * safeReplyOrSend
 * Intenta enviar un mensaje citado; si falla (por falta de sincronización),
 * lo envía sin cita.
 *
 * @param {Chat} chat           — Chat de destino (cliente.getChat())
 * @param {Message} message     — Mensaje original que queremos citar
 * @param {string} text         — Texto a enviar
 * @param {object} [opts]       — Opciones adicionales para sendMessage
 */
async function safeReplyOrSend(chat, message, text, opts = {}) {
  try {
    const quotedId = message.id && message.id._serialized
      ? message.id._serialized
      : undefined;
    // Intentamos enviar citando
    return await chat.sendMessage(text, {
      ...opts,
      ...(quotedId ? { quotedMessageId: quotedId } : {})
    });
  } catch (err) {
    console.warn('⚠️ safeReplyOrSend falló, enviando sin cita:', err.message);
    // Envío sin cita
    return await chat.sendMessage(text, opts);
  }
}

module.exports = { safeReplyOrSend };
