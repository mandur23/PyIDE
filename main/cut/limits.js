// Sizes the cut:* channels accept. Everything they move crosses IPC in one message, so each is bounded.
module.exports = {
  READ_LIMIT: 64 * 1024 * 1024, // one cut:read
  WRITE_LIMIT: 256 * 1024 * 1024, // one cut:writeAt
  CACHE_ENTRY_LIMIT: 512 * 1024 * 1024, // one cut:cachePut
  NCUT_TEXT_LIMIT: 200 * 1024 * 1024, // a project's JSON
  FONT_LIMIT: 128 * 1024 * 1024, // one font file
};
