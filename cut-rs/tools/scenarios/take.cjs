// A function of a panel's source text (ui-*.js run inside the editor, so they cannot be required): the text of
// `function name(` or `const name =` up to the end of its body: balanced braces, else the line (an arrow whose body is
// an expression, which may hold `${…}`). The scenarios run it exactly as written.
module.exports = function take(src, name) {
  const m = new RegExp(`\\n\\s*(function ${name}\\(|const ${name} = )`).exec(src);
  if (!m) throw new Error(`${name} is not in the source`);
  const from = m.index + m[0].indexOf(m[1]);
  const line = src.slice(from, src.indexOf('\n', from));
  if (/=>\s*[^{\s]/.test(line) || (!line.includes('=>') && !line.startsWith('function') && line.trim().endsWith(';'))) return line;
  const open = src.indexOf('{', from);
  const semi = src.indexOf(';', from);
  if (semi >= 0 && (open < 0 || semi < open)) return src.slice(from, semi + 1);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error(`${name} does not end`);
};
