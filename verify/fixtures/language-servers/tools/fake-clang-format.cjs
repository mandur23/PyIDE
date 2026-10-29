// clang-format stand-in for verify/language-servers.mjs: echoes stdin with `// clang-format <fallback style>` on top.
const style = process.argv.find((a) => a.startsWith('--fallback-style=')) || '';
let text = '';
process.stdin.on('data', (d) => { text += d; }).on('end', () => {
  process.stdout.write(`// clang-format ${style.slice('--fallback-style='.length)}\n${text.replace(/^\/\/ clang-format.*\n/, '')}`);
});
