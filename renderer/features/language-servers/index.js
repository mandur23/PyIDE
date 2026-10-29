// Code insight for C/C++, Rust, Go, Kotlin, C#, Ruby and PHP from their language servers (main/features/language-servers.js
// runs them), through the lsp plugin's client: completion, errors as you type, hover, Go to Declaration, Find Usages,
// Rename, Reformat Code and quick fixes. Each server is an Install Manager item under Language Servers; opening a file
// of its language offers the download once per session, and nothing is downloaded before the user says so. clang-format
// reformats C and C++ files when it is installed.
(() => {
  if (!ide.lsp?.createClient || !ide.toolchains) return;
  const { basename } = ide.util;

  // tool: the package manager a server is installed with (`via` in main/installer/toolchains.js).
  const SERVERS = [
    { id: 'clangd', toolchain: 'clangd', language: ['c', 'cpp'], match: /\.(c|h|cc|cpp|cxx|c\+\+|hh|hpp|hxx|ino)$/i, lang: 'C/C++',
      title: 'clangd', homepage: 'https://clangd.llvm.org/', size: '30 MB', triggers: ['.', '>', ':', '"', '<', '/'],
      description: () => tr('Completion, errors, navigation and refactoring for C and C++ from the LLVM project (Apache 2.0 with LLVM exceptions).') },
    { id: 'rust', toolchain: 'rustanalyzer', language: 'rust', match: /\.rs$/i, lang: 'Rust',
      title: 'rust-analyzer', homepage: 'https://rust-analyzer.github.io/', size: '18 MB', triggers: ['.', ':'],
      description: () => tr('Completion, errors, navigation and refactoring for Rust (MIT or Apache 2.0). Cargo projects need the Rust toolchain.') },
    { id: 'go', toolchain: 'gopls', language: 'go', match: /\.go$/i, lang: 'Go', tool: 'go',
      title: 'gopls', homepage: 'https://go.dev/gopls', triggers: ['.'],
      description: () => tr('The Go team\'s language server (BSD), installed with the Go toolchain on this computer.') },
    { id: 'kotlin', toolchain: 'kotlin', language: 'kotlin', match: /\.kts?$/i, lang: 'Kotlin',
      title: 'Kotlin Language Server', homepage: 'https://github.com/Kotlin/kotlin-lsp', size: '363 MB', triggers: ['.'],
      description: () => tr('JetBrains\' Kotlin language server with its own Java runtime (Apache 2.0), for Gradle and Maven projects.') },
    { id: 'csharp', toolchain: 'csharpls', language: 'csharp', match: /\.cs$/i, lang: 'C#', tool: 'dotnet',
      title: 'csharp-ls', homepage: 'https://github.com/razzmatazz/csharp-language-server', triggers: ['.'],
      description: () => tr('A Roslyn-based C# language server (MIT), installed with the .NET SDK on this computer.') },
    { id: 'ruby', toolchain: 'rubylsp', language: 'ruby', match: /\.(rb|rake|gemspec)$/i, lang: 'Ruby', tool: 'gem',
      title: 'Ruby LSP', homepage: 'https://shopify.github.io/ruby-lsp/', triggers: ['.', ':'],
      description: () => tr('Shopify\'s Ruby language server (MIT), installed with RubyGems on this computer.') },
    { id: 'php', toolchain: 'intelephense', language: 'php', match: /\.php$/i, lang: 'PHP', tool: 'npm',
      title: 'Intelephense', homepage: 'https://intelephense.com/', triggers: ['.', '$', '>', ':', '\\'],
      description: () => tr('A PHP language server (free features under its own licence), installed with npm on this computer.') },
  ];
  const TOOL_NAMES = { go: 'Go', dotnet: '.NET SDK', gem: 'Ruby', npm: 'Node.js' };

  let tools = {};
  const refreshTools = () => ide.api.invoke('language-servers:tools').then((t) => { tools = t || {}; }).catch(() => {});
  refreshTools();

  // ---------- Install Manager: Language Servers ----------
  const items = new Map();
  function itemFor(s, toolchain = s.toolchain, title = s.title, description = s.description()) {
    const item = ide.toolchains.installable(toolchain, title, description, s.homepage);
    item.category = 'languages';
    const status = item.status;
    item.status = async () => {
      const st = await status();
      if (!s.tool) return st;
      await refreshTools();
      const tool = TOOL_NAMES[s.tool];
      return { ...st, size: null, detail: st.installed ? st.detail : tr('Installed with {tool} into your user account.', { tool }),
        ...(!st.installed && !tools[s.tool] ? { available: false, reason: tr('Needs {tool} on PATH.', { tool }) } : {}) };
    };
    return item;
  }
  for (const s of SERVERS) items.set(s.id, itemFor(s));
  const clangFormat = itemFor(SERVERS[0], 'clangformat', 'clang-format',
    tr('Reformat Code for C and C++ with the project\'s .clang-format (LLVM style otherwise).'));
  (ide.installables ||= []).push(...items.values(), clangFormat);
  ide.emit('installablesChanged');

  // ---------- offers ----------
  const offered = new Set();
  function offer(s) {
    if (offered.has(s.id)) return;
    offered.add(s.id);
    const text = s.tool && !tools[s.tool]
      ? tr('Code insight for {language} needs {server}, which is installed with {tool}. Install {tool} first.', { language: s.lang, server: s.title, tool: TOOL_NAMES[s.tool] })
      : s.size
        ? tr('Completion, error checking and navigation for {language} need {server} (about {size}).', { language: s.lang, server: s.title, size: s.size })
        : tr('Completion, error checking and navigation for {language} need {server}.', { language: s.lang, server: s.title });
    ide.notifications?.notify({
      title: tr('{language} code insight', { language: s.lang }), kind: 'info', group: s.lang, text,
      actions: s.tool && !tools[s.tool] ? [] : [{ label: tr('Download'), run: (note) => { note.expire(); install(s); } }],
    });
  }
  async function install(s) {
    const id = `toolchain:${s.toolchain}`;
    try {
      await ide.installer?.run(id);
      if (ide.installer?.state(id)?.phase === 'failed') return;
    } catch (err) {
      console.warn(`${s.id} install failed`, err);
      return;
    }
    clients.get(s.id)?.restart();
  }

  // ---------- clients ----------
  const clients = new Map();
  for (const s of SERVERS) {
    const L = { language: s.lang };
    const REFUSED = {
      untrusted: () => ({ state: 'safe', message: tr('Safe Mode: {language} code insight starts once the project is trusted', L) }),
      missing: () => { offer(s); return { state: 'missing', message: tr('{server} is not installed. Click to download it.', { server: s.title }) }; },
      noruntime: () => ({ state: 'error', message: tr('{server} needs {tool} on PATH.', { server: s.title, tool: TOOL_NAMES[s.tool] }) }),
    };
    const client = ide.lsp.createClient({
      id: s.id, language: s.language, match: s.match, channel: `lsp-${s.id}`, source: s.id, serverName: s.title,
      statusId: `lsp-${s.id}-status`, statusOrder: 22, hideWhenOff: true, startOnOpen: true, formatting: true,
      text: {
        status: {
          off: () => tr('{language}: off', L), starting: () => tr('{language}: starting', L), ready: () => tr('{language}: ready', L),
          error: () => tr('{language}: error', L), missing: () => tr('{language}: not installed', L), safe: () => tr('{language}: Safe Mode', L),
        },
        server: () => tr('{language} language server', L),
        starting: (name) => tr('Starting {server} for {name}', { server: s.title, name }),
        failed: () => tr('{server} failed to start', { server: s.title }),
        ready: () => tr('{server} ready', { server: s.title }),
        exited: (code) => tr('{server} exited with code {code}', { server: s.title, code }),
        stopped: () => tr('{server} stopped', { server: s.title }),
        error: (message) => tr('{server} error: {message}', { server: s.title, message }),
        stoppedTitle: () => tr('{server} stopped', { server: s.title }),
        crashed: (count, minutes) => tr('{server} crashed {count} times in the last {minutes} minutes and is not restarted automatically.', { server: s.title, count, minutes }),
        notReady: () => tr('Cannot search for usages: {server} is not ready', { server: s.title }),
      },
      // Only once a file of the language is open: these servers index the project, which costs memory.
      start(c) {
        if (!c.docsList().length) return null;
        if (ide.trusted === false) return REFUSED.untrusted();
        return { key: s.id, args: [], detail: basename(ide.root || '') };
      },
      failed: (answer) => REFUSED[answer.code]?.() || null,
      restartOn: ['projectOpened', 'toolchainsChanged'],
      onStatusClick(c, state) {
        if (state === 'missing') return install(s);
        if (state === 'safe') return ide.trustProject?.();
        return c.restart();
      },
      completion: { triggerCharacters: s.triggers },
    });
    clients.set(s.id, client);
    // A running server holds its files open, and Windows would leave the folder half removed.
    const item = items.get(s.id);
    const removeFiles = item.uninstall;
    item.uninstall = (...args) => { client.stop(); return removeFiles(...args); };
  }

  // ---------- clang-format ----------
  const register = () => ide.tooling?.addFormatter?.(async (tab) => {
    const lang = tab.model.getLanguageId();
    if (lang !== 'c' && lang !== 'cpp') return null;
    const { tabSize, insertSpaces } = tab.model.getOptions();
    return ide.api.invoke('language-servers:clangFormat', tab.model.getValue(), tab.path, { tabSize, insertSpaces });
  });
  if (ide.tooling) register(); else ide.on('ready', register);

  ide.languageServers = { servers: () => SERVERS.map((s) => s.id), client: (id) => clients.get(id), install: (id) => install(SERVERS.find((s) => s.id === id)) };
})();
