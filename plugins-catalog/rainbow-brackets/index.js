(() => {
  const DARK = ['#e8ba36', '#54a857', '#359ff4', '#a87dd0', '#d0655a', '#3fb7a6'];
  const LIGHT = ['#b8860b', '#2e7d32', '#1565c0', '#7b3fb5', '#c0392b', '#00897b'];

  function apply() {
    const colors = document.documentElement.dataset.theme === 'light' ? LIGHT : DARK;
    const style = document.getElementById('rainbow-brackets-colors') || document.head.appendChild(Object.assign(document.createElement('style'), { id: 'rainbow-brackets-colors' }));
    style.textContent = colors.map((c, i) => `.monaco-editor .bracket-highlighting-${i} { color: ${c} !important; }`).join('\n');
    ide.editor.updateOptions({
      bracketPairColorization: { enabled: true, independentColorPoolPerBracketType: false },
      guides: { bracketPairs: 'active', indentation: true },
    });
  }

  ide.on('ready', apply);
  ide.on('settingsChanged', (key) => key === 'appearance.theme' && setTimeout(apply));
  ide.registerAction({ id: 'RainbowBracketsToggle', title: tr('Toggle Rainbow Brackets'), run: () => {
    const on = !ide.editor.getOption(ide.monaco.editor.EditorOption.bracketPairColorization).enabled;
    ide.editor.updateOptions({ bracketPairColorization: { enabled: on } });
  } });
})();
