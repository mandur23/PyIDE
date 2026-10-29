// A language server stand-in for verify/language-servers.mjs, run with the IDE as Node: `standin-lsp.cjs <id>`.
// Completion lists `<id>_item`, hover says `<id> hover`, Go to Declaration goes to the file's first line, formatting
// puts `// formatted by <id>` on top, and every line containing BAD gets an error.
const id = process.argv[2] || 'server';
const docs = new Map();
let buf = Buffer.alloc(0);
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
function diagnose(uri) {
  const lines = (docs.get(uri) || '').split(/\r?\n/);
  const diagnostics = [];
  lines.forEach((l, i) => { const c = l.indexOf('BAD'); if (c >= 0) diagnostics.push({ range: { start: { line: i, character: c }, end: { line: i, character: c + 3 } }, severity: 1, source: id, message: `${id}: BAD is not allowed` }); });
  send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics } });
}
function handle(msg) {
  const { id: rid, method, params } = msg;
  const reply = (result) => send({ id: rid, result });
  switch (method) {
    case 'initialize':
      return reply({ capabilities: { textDocumentSync: 1, completionProvider: { triggerCharacters: ['.'] }, hoverProvider: true, definitionProvider: true, documentFormattingProvider: true }, serverInfo: { name: `${id} stand-in` } });
    case 'shutdown': return reply(null);
    case 'exit': return process.exit(0);
    case 'textDocument/didOpen': docs.set(params.textDocument.uri, params.textDocument.text); return diagnose(params.textDocument.uri);
    case 'textDocument/didChange': docs.set(params.textDocument.uri, params.contentChanges.at(-1).text); return diagnose(params.textDocument.uri);
    case 'textDocument/completion': return reply({ isIncomplete: false, items: [{ label: `${id}_item`, kind: 3, detail: `from ${id}` }] });
    case 'textDocument/hover': return reply({ contents: { kind: 'markdown', value: `**${id} hover**` } });
    case 'textDocument/definition': return reply([{ uri: params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } }]);
    case 'textDocument/formatting': {
      const text = docs.get(params.textDocument.uri) || '';
      return reply([{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: `// formatted by ${id}\n` }].filter(() => !text.startsWith('// formatted')));
    }
    default: if (rid !== undefined && method) return reply(null);
  }
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.slice(0, end).toString())?.[1]);
    if (buf.length < end + 4 + len) return;
    const body = buf.slice(end + 4, end + 4 + len).toString('utf8');
    buf = buf.slice(end + 4 + len);
    try { handle(JSON.parse(body)); } catch {}
  }
});
