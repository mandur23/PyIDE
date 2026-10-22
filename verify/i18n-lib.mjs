// Finds English UI text left untranslated in a Korean session. User content (code, file names, paths, console
// output, package names) and product names are not UI text and are skipped.
export const KEEP_ENGLISH = [
  'PyIDE', 'PyCharm', 'Python', 'Pyright', 'Git', 'GitHub', 'ruff', 'Ruff', 'pytest', 'unittest', 'pip', 'venv',
  'virtualenv', 'debugpy', 'PowerShell', 'UTF-8', 'TODO', 'FIXME', 'HEAD', 'JSON', 'PyPI', 'PATH', 'PYTHONPATH',
  'Ctrl', 'Alt', 'Shift', 'Esc', 'Enter', 'Tab', 'Insert', 'Delete', 'Space', 'Backspace', 'noqa', 'Pyright',
  'OK', 'stdin', 'stdout', 'stderr', 'py', 'launcher', 'English', 'Windows', 'Monaco', 'LSP', 'DAP', 'regex', 'Regex',
  'Claude', 'Code', 'Anthropic', 'LF', 'CRLF', 'CR',
];

// Elements whose text is user data, not UI chrome.
const SKIP = [
  '.monaco-editor .view-lines', '.monaco-editor .margin', '.console', 'pre', 'code', '#tree .name', '.tab .name',
  '#statusPath', '#statusInterp', '#interpSelect', '#projectWidget', '[data-user-text]', '.monaco-diff-editor .view-lines',
  'input', 'textarea', 'option', '.monaco-alert', '.monaco-aria-container', '.xterm',
  // Code vision lenses show Git author names; their own words go through tr() (missingTranslations covers them).
  '.monaco-editor .codelens-decoration',
];

// Returns [{text, where}] for visible text under `selector` that still contains English words.
export async function englishLeaks(ctx, selector = 'body', extraAllowed = []) {
  return ctx.js(`(() => {
    const allowed = new Set(${JSON.stringify([...KEEP_ENGLISH, ...extraAllowed])});
    const skip = ${JSON.stringify(SKIP)}.join(',');
    const out = [];
    const roots = document.querySelectorAll(${JSON.stringify(selector)});
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const p = n.parentElement;
        if (!p || p.closest(skip)) continue;
        const style = getComputedStyle(p);
        if (style.display === 'none' || style.visibility === 'hidden' || !p.getClientRects().length) continue;
        const text = n.textContent.trim();
        // Already translated (Korean text may legitimately quote identifiers), or empty.
        if (!text || /[가-힣]/.test(text)) continue;
        // Skip things that look like paths, file names, identifiers, versions, or key chords.
        const words = text.replace(/[A-Za-z]:\\\\[^\\s]*|[\\w.-]+\\.(py|txt|md|json|toml|cfg|ini|exe|zip|yml|yaml)\\b|\\b[\\w.]+\\(\\)|\\b\\w+_\\w+\\b|v?\\d+(\\.\\d+)+/g, ' ')
          .match(/[A-Za-z][A-Za-z']{2,}/g) || [];
        const english = words.filter((w) => !allowed.has(w) && !/^[A-Z0-9_]+$/.test(w) && !/^F\\d+$/.test(w));
        if (english.length) out.push({ text: text.slice(0, 120), where: p.className || p.tagName });
      }
    }
    // Tooltips and placeholders are UI text too.
    for (const root of roots) {
      for (const n of root.querySelectorAll('[title],[placeholder]')) {
        if (n.closest(skip.replace(',input', '').replace(',textarea', ''))) continue;
        for (const attr of ['title', 'placeholder']) {
          const v = n.getAttribute(attr);
          if (!v || /^[A-Za-z]:\\\\/.test(v)) continue;
          const words = (v.match(/[A-Za-z][A-Za-z']{2,}/g) || []).filter((w) => !allowed.has(w) && !/^[A-Z0-9_]+$/.test(w) && !/^F\\d+$/.test(w));
          if (words.length && !/[가-힣]/.test(v)) out.push({ text: attr + ': ' + v.slice(0, 120), where: n.className || n.tagName });
        }
      }
    }
    return out;
  })()`);
}

// Strings passed through tr() that have no Korean entry.
export const missingTranslations = (ctx) => ctx.js('[...i18n.missing]');
