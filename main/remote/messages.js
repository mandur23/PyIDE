// Messages the remote layer shows to the user (process consoles, Settings forms). They are English here; the
// remote-interp plugin hands over its translations of these exact strings (renderer/features/remote-interp, MESSAGES).
let dict = {};
const setMessages = (d) => { dict = d || {}; };
const M = (text, vars = {}) => (dict[text] || text).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
module.exports = { M, setMessages };
