(() => {
  const { el, joinPath } = ide.util;
  let cwd = null;
  let termId = null;
  const history = [];
  let historyIdx = 0;
  let con, prompt, input;

  const normalize = (p) => {
    const parts = [];
    for (const seg of p.split(/[\\/]+/)) {
      if (seg === '..') { if (parts.length > 1) parts.pop(); } else if (seg && seg !== '.') parts.push(seg);
    }
    return parts.join('\\');
  };
  const updatePrompt = () => (prompt.textContent = `PS ${cwd || ''}> `);

  async function exec(cmd) {
    con.append(`${prompt.textContent}${cmd}\n`, 'cmd');
    if (!cmd) return;
    history.push(cmd);
    historyIdx = history.length;
    if (cmd === 'cls' || cmd === 'clear') return con.clear();
    const cd = cmd.match(/^(cd|Set-Location)\s+(.+)$/i);
    if (cd) {
      const target = cd[2].replace(/^["']|["']$/g, '');
      const next = normalize(/^[a-zA-Z]:|^\\/.test(target) ? target : joinPath(cwd, target));
      if (await ide.api.exists(next)) { cwd = next; updatePrompt(); }
      else con.append(`cd: cannot find path '${target}'\n`, 'err');
      return;
    }
    if (termId) return ide.proc.input(termId, `${cmd}\n`);
    input.disabled = true;
    const id = (termId = await ide.api.invoke('term:exec', cmd, cwd || undefined));
    ide.proc.attach(id, {
      data: (text, stream) => con.append(text, stream === 'err' ? 'err' : null),
      exit() {
        termId = null;
        input.disabled = false;
        input.focus();
      },
    });
  }

  ide.registerToolWindow({
    id: 'Terminal', title: 'Terminal', icon: '❯', side: 'bottom', keys: 'Alt+F12', order: 30,
    mount(container, tw) {
      con = ide.ui.console(container);
      con.out.id = 'termOut';
      const line = el('div', 'term-line');
      prompt = el('span', 'term-prompt');
      prompt.id = 'termPrompt';
      input = el('input', 'console-in');
      input.id = 'termIn';
      line.append(prompt, input);
      container.appendChild(line);
      input.onkeydown = (e) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          historyIdx = Math.max(0, Math.min(history.length, historyIdx + (e.key === 'ArrowUp' ? -1 : 1)));
          input.value = history[historyIdx] || '';
          return e.preventDefault();
        }
        if (e.key === 'c' && e.ctrlKey && termId) return ide.proc.kill(termId);
        if (e.key !== 'Enter') return;
        const cmd = input.value.trim();
        input.value = '';
        exec(cmd);
      };
      tw.setActions([{ icon: '⌫', title: 'Clear', run: () => con.clear() }]);
      updatePrompt();
    },
  });

  ide.on('projectOpened', (root) => { cwd = root; updatePrompt(); });
})();
