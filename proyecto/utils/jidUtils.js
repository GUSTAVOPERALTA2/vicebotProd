// utils/jidUtils.js

/**
 * Normaliza un JID simple (sin acceso al objeto message).
 * Convierte solo el sufijo @lid a @c.us.
 */
function normalizeJid(jid) {
  if (!jid) return jid;
  return jid.replace('@lid', '@c.us');
}

/**
 * Obtiene el JID real del contacto que envió el mensaje.
 * Si el mensaje proviene de un Linked Device (@lid),
 * obtiene el número real usando getContact().
 *
 * @param {import('whatsapp-web.js').Message} message
 * @returns {Promise<string>} - JID real (siempre @c.us)
 */
async function resolveRealJid(message) {
  try {
    const jid = message.author || message.from;
    if (jid && jid.endsWith('@lid')) {
      const contact = await message.getContact();
      return contact.id._serialized; // Devuelve el número real @c.us
    }
    return jid;
  } catch (err) {
    console.error('❌ Error resolviendo JID real:', err);
    return message.author || message.from;
  }
}

module.exports = {
  normalizeJid,
  resolveRealJid
};
