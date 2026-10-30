// Python Console tool window: a persistent interpreter driven by pyide_repl.py, which reports its prompt state
// with \x02ps1\x03 / \x02ps2\x03 markers on stdout. ide.pyconsole.evaluate(expr) sends a \x05 query between
// statements and gets \x02q[id, ok, text]\x03 back; 'pyconsoleChanged' fires after each statement. A \x03 line is
// Interrupt (KeyboardInterrupt in the running statement).
(() => {
  const { el } = ide.util;
  const MARKER = /\x02(ps1|ps2|q[^\x03]*)\x03/;
  const HISTORY_KEY = 'pyconsole.history';
  let procId = null;
  let shownId = null; // the process whose output the console shows; a console cleared for a new one drops the old one's
  let con, promptEl, input;
  let carry = '';
  let ps = 'ps1';
  let ready = null; // resolves once the first prompt arrives
  let markReady = null;
  let starting = null;
  const history = ide.settings.get(HISTORY_KEY, []).slice(-200);
  let historyIdx = history.length;
  let draft = '';

  // Queries run only between statements, so a program reading input() never receives one.
  let busy = true;
  const idleWaiters = [];
  const queries = new Map();
  let querySeq = 0;
  function answerQuery(json) {
    let id, ok, text;
    try { [id, ok, text] = JSON.parse(json); } catch { return; }
    const q = queries.get(id);
    if (!q) return;
    queries.delete(id);
    if (ok) q.resolve(text); else q.reject(new Error(text));
  }
  async function evaluate(expr) {
    if (!procId) throw new Error(tr('The Python Console is not running.'));
    if (busy) await new Promise((r) => idleWaiters.push(r));
    if (!procId) throw new Error(tr('The Python Console is not running.'));
    const id = ++querySeq;
    const answer = new Promise((resolve, reject) => queries.set(id, { resolve, reject }));
    ide.proc.input(procId, `\x05${JSON.stringify([id, expr])}\n`);
    return answer;
  }
  function dropQueries() {
    for (const q of queries.values()) q.reject(new Error(tr('The Python Console is not running.')));
    queries.clear();
    for (const fn of idleWaiters.splice(0)) fn();
  }

  const fit = () => { input.rows = Math.min(12, input.value.split('\n').length); };
  const promptText = () => (ps === 'ps2' ? '... ' : '>>> ');
  // While a statement runs there is no prompt: what the user types then is the program's input.
  const setBusy = (on) => {
    busy = on;
    promptEl?.classList.toggle('pyc-running', on && prompted);
  };
  const setPrompt = (next) => {
    ps = next;
    promptEl.textContent = promptText();
  };

  // Entries submitted before the interpreter's first prompt (or while earlier ones wait): sent one per prompt, in order,
  // so each is echoed right before its own output rather than above the banner.
  const pending = [];
  let prompted = false;

  // \r, \b and ANSI colors go to the console as they are (ide.ui.console draws them as a terminal does), so a progress
  // bar updates its line in place.
  function onData(text, stream) {
    if (stream === 'err') return con.append(text, 'err');
    let rest = carry + text;
    carry = '';
    for (let m = rest.match(MARKER); m; m = rest.match(MARKER)) {
      if (m.index) con.append(rest.slice(0, m.index));
      rest = rest.slice(m.index + m[0].length);
      if (m[1][0] === 'q') { answerQuery(m[1].slice(1)); continue; }
      prompted = true;
      setPrompt(m[1]);
      setBusy(false);
      markReady?.();
      markReady = null;
      if (m[1] === 'ps1') ide.emit('pyconsoleChanged');
      // A queued entry goes first, so a query never lands in the input() of the statement it would run.
      if (pending.length) send(pending.shift());
      else {
        for (const fn of idleWaiters.splice(0)) fn();
        if (m[1] === 'ps2' && !input.value) { input.value = continuationIndent(); fit(); }
      }
    }
    // Keep a possibly split marker for the next chunk.
    const cut = rest.lastIndexOf('\x02');
    if (cut >= 0 && !rest.slice(cut).includes('\x03')) { carry = rest.slice(cut); rest = rest.slice(0, cut); }
    if (rest) con.append(rest);
  }

  let lastLine = '';
  // PyCharm keeps the block's indentation and indents after a colon.
  const continuationIndent = () => {
    const ind = lastLine.match(/^\s*/)[0];
    return /:\s*(#.*)?$/.test(lastLine) ? `${ind}    ` : ind;
  };

  async function start() {
    if (procId) return ready;
    if (starting) return starting;
    const interp = ide.currentInterp();
    if (!interp) {
      pending.length = 0;
      con.append(`${tr('No Python interpreter found.')}\n`, 'err');
      return null;
    }
    starting = (async () => {
      carry = '';
      prompted = false;
      setBusy(true);
      ready = new Promise((r) => (markReady = r));
      con.append(`${tr('{command} (Python Console)', { command: [interp.cmd, ...interp.args].join(' ') })}\n`, 'sys');
      const id = (procId = await ide.api.invoke('pyconsole:start', interp, ide.root || undefined, ide.root ? [ide.root] : []));
      input.disabled = false;
      shownId = id;
      ide.proc.attach(id, {
        data: (text, stream) => shownId === id && onData(text, stream),
        exit(code) {
          if (shownId === id) con.append(`\n${tr('Process finished with exit code {code}', { code: code ?? 0 })}\n`, 'sys');
          if (procId !== id) return;
          procId = null;
          ended();
          setPrompt('ps1');
          renderActions();
          ide.emit('pyconsoleChanged');
        },
      });
      renderActions();
      return ready;
    })();
    try { return await starting; } catch (err) { pending.length = 0; throw err; } finally { starting = null; }
  }

  // The process is gone (it exited, or stop() let go of it): a start still waiting for its first prompt is over, or
  // every later start() would return that start's promise forever.
  function ended() {
    markReady?.();
    markReady = null;
    pending.length = 0;
    prompted = false;
    setBusy(false);
    dropQueries();
  }

  async function stop() {
    if (!procId) return;
    const id = procId;
    procId = null;
    ended();
    await ide.proc.kill(id);
    renderActions();
    ide.emit('pyconsoleChanged');
  }

  // Ctrl+C in the console input and the toolbar's Interrupt: KeyboardInterrupt in the running statement (pyide_repl.py
  // keeps the session), or at the prompt the block being typed is dropped, as in a terminal. Entries waiting to run go too.
  function interrupt() {
    if (!procId) return;
    pending.length = 0;
    if (!busy) { input.value = ''; fit(); }
    ide.proc.input(procId, '\x03\n');
  }

  // After stop(): the old process ends a little later, and its last output must not land in the cleared console.
  const clearForNewProcess = () => { con.clear(); shownId = null; };

  async function restart() {
    await stop();
    clearForNewProcess();
    setPrompt('ps1');
    await start();
    input.focus();
  }

  function remember(line) {
    if (line.trim() && history[history.length - 1] !== line) {
      history.push(line);
      ide.settings.set(HISTORY_KEY, history.slice(-200));
    }
    historyIdx = history.length;
    draft = '';
  }

  // entry: {line} typed at the prompt, or {block} run in one go.
  function send(entry) {
    if (entry.block != null) {
      con.append(entry.block.split('\n').map((l, i) => `${i ? '... ' : '>>> '}${l}`).join('\n') + '\n', 'cmd');
      remember(entry.block);
      ide.proc.input(procId, `\x01${JSON.stringify(entry.block)}\n`);
    } else {
      con.append(`${promptText()}${entry.line}\n`, 'cmd');
      remember(entry.line);
      lastLine = entry.line;
      ide.proc.input(procId, `${entry.line}\n`);
    }
    setBusy(true);
  }

  function submit(entry) {
    if (procId && prompted && !busy && !pending.length) return send(entry);
    pending.push(entry);
    if (!procId) start().catch(() => {});
  }

  function submitLine(raw) {
    // A running statement reads it (input(), sys.stdin): it is the program's input, not a command.
    if (procId && prompted && busy && !pending.length) {
      con.append(`${raw}\n`, 'stdin');
      ide.proc.input(procId, `${raw}\n`);
      return;
    }
    // A whitespace-only line ends a block, like an empty one.
    submit({ line: raw.trim() ? raw : '' });
  }

  // Runs a multi-line block in one go (Execute Selection, multi-line paste).
  function executeBlock(code) {
    code = code.replace(/\r/g, '').replace(/\s+$/, '');
    if (!code.trim()) return;
    tw.show();
    submit({ block: code });
  }

  function renderActions() {
    tw.setActions([
      { icon: 'rerun', title: tr('Rerun Python Console'), run: restart },
      ...(procId ? [{ id: 'pyconsoleInterrupt', icon: 'abort', title: `${tr('Interrupt')} (Ctrl+C)`, run: interrupt },
        { icon: 'runStop', title: tr('Stop Console'), run: stop }] : []),
      { icon: 'clear', title: tr('Clear All'), run: () => con.clear() },
      ...(ide.dataView?.consoleVariables ? [{ icon: 'jupyterVariables', title: varsPane ? tr('Hide Variables') : tr('Show Variables'), run: toggleVariables }] : []),
    ]);
  }

  // Variables pane (PyCharm's "Show Variables"), drawn by the Data View plugin (sciview) when it is enabled.
  const VARS_KEY = 'pyconsole.showVariables';
  let root = null;
  let varsPane = null;
  function placeVariables() {
    const want = !!ide.dataView?.consoleVariables && ide.settings.get(VARS_KEY, true);
    if (want && !varsPane && root) {
      varsPane = ide.dataView.consoleVariables();
      root.appendChild(varsPane.el);
      varsPane.refresh();
    } else if (!want && varsPane) {
      varsPane.dispose();
      varsPane.el.remove();
      varsPane = null;
    }
    renderActions();
  }
  function toggleVariables() {
    ide.settings.set(VARS_KEY, !ide.settings.get(VARS_KEY, true));
    placeVariables();
  }
  ide.on('ready', placeVariables);

  const tw = ide.registerToolWindow({
    id: 'PythonConsole', title: tr('Python Console'), icon: '🐍', side: 'bottom', keys: 'Alt+8', order: 25,
    mount(container) {
      root = container;
      container.classList.add('pyc-root');
      const main = el('div', 'pyc-main');
      container.appendChild(main);
      con = ide.ui.console(main);
      con.out.id = 'pyconsoleOut';
      const line = el('div', 'pyc-line');
      promptEl = el('span', 'pyc-prompt', '>>> ');
      promptEl.id = 'pyconsolePrompt';
      // A textarea, so a pasted or recalled multi-line block can be edited before Enter runs it.
      input = el('textarea', 'console-in pyc-input');
      input.id = 'pyconsoleIn';
      input.rows = 1;
      input.spellcheck = false;
      input.oninput = fit;
      line.append(promptEl, input);
      main.appendChild(line);
      con.out.onclick = () => { if (!getSelection().toString()) input.focus(); };
      input.onkeydown = (e) => {
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !e.shiftKey) {
          // Inside a multi-line entry the arrows move the caret; on its first/last line they walk the history.
          const before = input.value.slice(0, input.selectionStart);
          const after = input.value.slice(input.selectionEnd);
          if ((e.key === 'ArrowUp' && before.includes('\n')) || (e.key === 'ArrowDown' && after.includes('\n'))) return;
          if (!history.length) return;
          e.preventDefault();
          if (historyIdx === history.length) draft = input.value;
          historyIdx = Math.max(0, Math.min(history.length, historyIdx + (e.key === 'ArrowUp' ? -1 : 1)));
          input.value = historyIdx === history.length ? draft : history[historyIdx];
          fit();
          return;
        }
        if (e.key === 'Tab') { e.preventDefault(); input.setRangeText('    ', input.selectionStart, input.selectionEnd, 'end'); return; }
        // With a selection Ctrl+C copies it.
        if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'KeyC' && input.selectionStart === input.selectionEnd && procId) {
          e.preventDefault();
          e.stopPropagation();
          interrupt();
          return;
        }
        if (e.key !== 'Enter') return;
        if (e.shiftKey) return setTimeout(fit);
        e.preventDefault();
        const text = input.value;
        input.value = '';
        fit();
        if (text.includes('\n')) executeBlock(text); else submitLine(text);
      };
    },
  });
  renderActions();

  ide.on('toolWindowShown', (id) => {
    // The console starts in the background; once it is ready it takes the keyboard, unless the keyboard moved somewhere
    // outside it meanwhile (Esc back to the editor while it was starting must stick).
    if (id === 'PythonConsole' && !procId) {
      let left = false;
      const watch = (e) => { if (!root?.contains(e.target)) left = true; };
      document.addEventListener('focusin', watch, true);
      start().finally(() => document.removeEventListener('focusin', watch, true)).then(() => {
        if (tw.isVisible() && !left) input.focus();
      });
    }
    else if (id === 'PythonConsole') varsPane?.refresh();
  });

  // The interpreter runs in the project root with it on sys.path, so another project gets a fresh one.
  ide.on('projectOpened', async () => {
    if (starting) await starting.catch(() => {});
    if (!procId) return;
    await stop();
    clearForNewProcess();
    setPrompt('ps1');
    if (tw.isVisible()) start();
  });
  // Close Project (back to the welcome screen): the interpreter belongs to the closed project and holds its venv.
  ide.on('projectClosed', async () => {
    if (starting) await starting.catch(() => {});
    if (!procId) return;
    await stop();
    clearForNewProcess();
    setPrompt('ps1');
  });

  // Alt+Shift+E: selection, or the current line (then the caret moves down), like PyCharm.
  function executeSelection(ed = ide.editor) {
    const model = ed?.getModel();
    if (!model) return;
    const sel = ed.getSelection();
    let code;
    if (sel && !sel.isEmpty()) code = model.getValueInRange(sel);
    else {
      const ln = ed.getPosition().lineNumber;
      code = model.getLineContent(ln);
      if (ln < model.getLineCount()) ed.setPosition({ lineNumber: ln + 1, column: 1 });
    }
    // Dedent a selection taken from inside a block.
    const lines = code.replace(/\r/g, '').split('\n');
    const ind = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length));
    executeBlock(lines.map((l) => l.slice(Number.isFinite(ind) ? ind : 0)).join('\n'));
  }

  ide.registerAction({
    id: 'ExecuteInPyConsoleAction', title: tr('Execute Selection in Python Console'), keys: 'Alt+Shift+E',
    when: () => ide.activeTab()?.kind === 'file' && /\.pyw?$/i.test(ide.activeTab().path),
    run: () => executeSelection(),
  });
  ide.registerAction({ id: 'RunPythonConsole', title: tr('Python Console'), run: () => tw.show() });

  // Every pane's context menu, run against the editor it was opened in.
  ide.onEditor((ed) => ed.addAction({
    id: 'pyide.executeInConsole',
    label: tr('Execute Selection in Python Console'),
    contextMenuGroupId: 'navigation',
    contextMenuOrder: 99,
    precondition: null,
    run: (editor) => executeSelection(editor),
  }));

  ide.pyconsole = { execute: executeBlock, restart, interrupt, isRunning: () => !!procId, evaluate };
})();
