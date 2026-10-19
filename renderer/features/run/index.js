(() => {
  const { el, basename, dirname } = ide.util;
  let runId = null;
  let con;

  const runBtn = el('button', 'tb-icon run-btn', '▶');
  runBtn.title = 'Run (Shift+F10)';
  const stopBtn = el('button', 'tb-icon stop-btn', '■');
  stopBtn.title = 'Stop (Ctrl+F2)';
  stopBtn.disabled = true;
  const target = el('span', 'run-target', 'Current File');
  ide.registerToolbarItem({ order: 60, el: target });
  ide.registerToolbarItem({ order: 70, el: runBtn });
  ide.registerToolbarItem({ order: 90, el: stopBtn });

  const tw = ide.registerToolWindow({
    id: 'Run', title: 'Run', icon: '▶', side: 'bottom', keys: 'Alt+4', order: 10,
    mount(container, tw) {
      con = ide.ui.console(container, {
        input: true,
        placeholder: 'stdin: type input and press Enter',
        onInput(text) {
          if (!runId) return;
          con.append(`${text}\n`, 'cmd');
          ide.proc.input(runId, `${text}\n`);
        },
      });
      con.input.id = 'runIn';
      con.out.id = 'runOut';
      con.input.disabled = true;
      tw.setActions([
        { icon: '⟳', title: 'Rerun', run: () => runFile(lastFile) },
        { icon: '⌫', title: 'Clear', run: () => con.clear() },
      ]);
    },
  });

  let lastFile = null;

  async function runFile(file) {
    if (!file) return;
    const interp = ide.currentInterp();
    tw.show();
    if (!interp) return con.append('No Python interpreter found.\n', 'err');
    if (runId) await ide.proc.kill(runId);
    await ide.saveAll();
    lastFile = file;
    con.clear();
    con.append(`${[interp.cmd, ...interp.args].join(' ')} ${file}\n`, 'sys');
    target.textContent = basename(file);
    const id = (runId = await ide.api.invoke('run:start', interp, file, dirname(file)));
    stopBtn.disabled = false;
    con.input.disabled = false;
    con.input.focus();
    ide.proc.attach(id, {
      data: (text, stream) => con.append(text, stream === 'err' ? 'err' : null),
      exit(code) {
        con.append(`\nProcess finished with exit code ${code ?? 1}\n`, 'sys');
        if (runId !== id) return;
        runId = null;
        stopBtn.disabled = true;
        con.input.disabled = true;
      },
    });
  }

  function runCurrent() {
    const tab = ide.activeTab();
    if (tab?.kind === 'file' && tab.path.endsWith('.py')) return runFile(tab.path);
    if (lastFile) return runFile(lastFile);
    tw.show();
    con.append('Open a .py file to run it.\n', 'sys');
  }

  const stop = () => runId && ide.proc.kill(runId);
  runBtn.onclick = runCurrent;
  stopBtn.onclick = stop;
  ide.registerAction({ id: 'Run', title: 'Run', keys: 'Shift+F10', run: runCurrent });
  ide.registerAction({ id: 'RunClass', title: 'Run Current File', keys: 'Ctrl+Shift+F10', run: () => {
    const tab = ide.activeTab();
    if (tab?.path.endsWith('.py')) runFile(tab.path);
  } });
  ide.registerAction({ id: 'Stop', title: 'Stop', keys: 'Ctrl+F2', run: stop });
  ide.registerTreeAction({ title: "Run '…'", when: (e) => !e.dir && e.name.endsWith('.py'), run: (e) => runFile(e.path) });
})();
