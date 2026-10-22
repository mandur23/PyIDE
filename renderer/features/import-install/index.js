// Quick fix "Install package '<dist>'" on an import Pyright cannot resolve (reportMissingImports,
// reportMissingModuleSource), like PyCharm's. The import name maps to its PyPI distribution (cv2 -> opencv-python);
// standard library names and the project's own modules get no fix. The install runs with the project's tool through
// ide.dependencies (uv pip install in a uv project, pip otherwise) in the Python Packages console, and Pyright
// resolves imports again afterwards (the lsp plugin listens to packagesChanged). "Install package '<dist>' and add to
// <file>" also writes the requirement through the packages plugin's "Add to requirements". Safe Mode: no fix.
(() => {
  const { monaco } = ide;
  const { basename } = ide.util;
  const CODES = new Set(['reportMissingImports', 'reportMissingModuleSource']);

  // Import names whose distribution has another name. Dotted keys match a module and its submodules first.
  const DIST = {
    cv2: 'opencv-python', PIL: 'Pillow', sklearn: 'scikit-learn', skimage: 'scikit-image', yaml: 'PyYAML',
    bs4: 'beautifulsoup4', dateutil: 'python-dateutil', dotenv: 'python-dotenv', attr: 'attrs', jwt: 'PyJWT',
    serial: 'pyserial', Crypto: 'pycryptodome', Cryptodome: 'pycryptodomex', docx: 'python-docx', pptx: 'python-pptx',
    magic: 'python-magic', win32api: 'pywin32', win32con: 'pywin32', win32gui: 'pywin32', win32com: 'pywin32',
    win32process: 'pywin32', win32file: 'pywin32', win32event: 'pywin32', win32clipboard: 'pywin32', win32service: 'pywin32',
    win32serviceutil: 'pywin32', win32print: 'pywin32', win32ui: 'pywin32', pythoncom: 'pywin32', pywintypes: 'pywin32',
    OpenGL: 'PyOpenGL', usb: 'pyusb', fitz: 'PyMuPDF', git: 'GitPython', MySQLdb: 'mysqlclient', telegram: 'python-telegram-bot',
    discord: 'discord.py', socketio: 'python-socketio', engineio: 'python-engineio', jose: 'python-jose',
    multipart: 'python-multipart', slugify: 'python-slugify', Xlib: 'python-xlib', wx: 'wxPython', gi: 'PyGObject',
    kafka: 'kafka-python', ldap: 'python-ldap', OpenSSL: 'pyOpenSSL', zmq: 'pyzmq', nacl: 'PyNaCl', cairo: 'pycairo',
    Bio: 'biopython', websocket: 'websocket-client', dns: 'dnspython', hamcrest: 'PyHamcrest', faiss: 'faiss-cpu',
    umap: 'umap-learn', mpl_toolkits: 'matplotlib', pkg_resources: 'setuptools', _cffi_backend: 'cffi',
    google: null, 'google.protobuf': 'protobuf', 'google.generativeai': 'google-generativeai', 'google.cloud.storage': 'google-cloud-storage',
    psycopg2: 'psycopg2-binary', speech_recognition: 'SpeechRecognition', pyaudio: 'PyAudio', ruamel: 'ruamel.yaml',
    'snowflake.connector': 'snowflake-connector-python', sentry_sdk: 'sentry-sdk',
  };
  // Standard library modules (Python 3.14's sys.stdlib_module_names without private ones, plus modules removed since
  // 3.8): they are never installed from PyPI.
  const STDLIB = new Set(('__future__ abc aifc annotationlib antigravity argparse array ast asynchat asyncio asyncore atexit audioop '
    + 'base64 bdb binascii bisect builtins bz2 cProfile calendar cgi cgitb chunk cmath cmd code codecs codeop collections '
    + 'colorsys compileall compression concurrent configparser contextlib contextvars copy copyreg crypt csv ctypes curses '
    + 'dataclasses datetime dbm decimal difflib dis distutils doctest email encodings ensurepip enum errno faulthandler fcntl '
    + 'filecmp fileinput fnmatch formatter fractions ftplib functools gc genericpath getopt getpass gettext glob graphlib grp '
    + 'gzip hashlib heapq hmac html http idlelib imaplib imghdr imp importlib inspect io ipaddress itertools json keyword '
    + 'lib2to3 linecache locale logging lzma mailbox mailcap marshal math mimetypes mmap modulefinder msilib msvcrt '
    + 'multiprocessing netrc nis nntplib nt ntpath nturl2path numbers opcode operator optparse os ossaudiodev parser pathlib '
    + 'pdb pickle pickletools pipes pkgutil platform plistlib poplib posix posixpath pprint profile pstats pty pwd py_compile '
    + 'pyclbr pydoc pydoc_data pyexpat queue quopri random re readline reprlib resource rlcompleter runpy sched secrets '
    + 'select selectors shelve shlex shutil signal site smtpd smtplib sndhdr socket socketserver spwd sqlite3 sre_compile '
    + 'sre_constants sre_parse ssl stat statistics string stringprep struct subprocess sunau symbol symtable sys sysconfig '
    + 'syslog tabnanny tarfile telnetlib tempfile termios textwrap this threading time timeit tkinter token tokenize tomllib '
    + 'trace traceback tracemalloc tty turtle turtledemo types typing unicodedata unittest urllib uu uuid venv warnings wave '
    + 'weakref webbrowser winreg winsound wsgiref xdrlib xml xmlrpc zipapp zipfile zipimport zlib zoneinfo _thread').split(' '));

  // The distribution to install for an import, or null (standard library, relative import, unknown namespace).
  function distFor(module) {
    if (!module || module.startsWith('.')) return null;
    const top = module.split('.')[0];
    if (STDLIB.has(top) || !/^[A-Za-z_]\w*$/.test(top)) return null;
    const parts = module.split('.');
    for (let i = parts.length; i > 0; i--) {
      const key = parts.slice(0, i).join('.');
      if (Object.hasOwn(DIST, key)) return DIST[key];
    }
    return top.replace(/_/g, '-');
  }

  const tabOf = (model) => ide.tabs.find((t) => t.kind === 'file' && t.model === model);
  // The imported name: the diagnostic's range covers it (`requests.adapters` in `import requests.adapters`); the
  // quoted name in Pyright's message is the fallback (messages can be translated, quotes stay).
  function moduleOf(model, d) {
    const text = model.getValueInRange(new monaco.Range(d.range.start.line + 1, d.range.start.character + 1, d.range.end.line + 1, d.range.end.character + 1)).trim();
    if (/^\.*[A-Za-z_][\w.]*$/.test(text)) return text;
    return /["“]([^"”]+)["”]/.exec(d.message)?.[1] || null;
  }

  // Whether a top-level name is one of the project's modules; cached briefly (the lightbulb asks on caret moves).
  const localCache = new Map();
  ide.on('filesChanged', () => localCache.clear());
  ide.on('projectOpened', () => localCache.clear());
  function isLocal(top) {
    const key = `${ide.root}|${top}`;
    const hit = localCache.get(key);
    if (hit && Date.now() - hit.at < 10000) return hit.value;
    const value = ide.api.invoke('import-install:isLocal', ide.root, top).catch(() => false);
    localCache.set(key, { at: Date.now(), value });
    return value;
  }

  const INSTALL = 'pyide.importInstall.install';
  monaco.editor.registerCommand(INSTALL, (_accessor, dist, addToRequirements) => install(dist, addToRequirements));

  async function install(dist, addToRequirements) {
    if (ide.trusted === false || !ide.dependencies) return;
    const interp = ide.currentInterp();
    if (!interp) { ide.ui.alert(tr('No Python interpreter found.')); return; }
    const code = await ide.dependencies.installSpecs([dist]);
    if (code !== 0 || !addToRequirements) return;
    const version = await ide.api.invoke('import-install:version', ide.root, interp, dist).catch(() => null);
    await ide.dependencies.addRequirement({ name: dist, version });
  }

  // The actions for one missing import; untrusted projects, the standard library and local modules get none.
  async function actionsFor(model, d, markers) {
    const module = moduleOf(model, d);
    const dist = distFor(module);
    if (!dist || await isLocal(module.split('.')[0])) return [];
    const line = d.range.start.line + 1;
    const diagnostics = markers.filter((m) => m.source === 'pyright' && m.startLineNumber === line);
    const out = [{
      title: tr("Install package '{name}'", { name: dist }),
      kind: 'quickfix', isPreferred: true, diagnostics,
      command: { id: INSTALL, title: tr("Install package '{name}'", { name: dist }), arguments: [dist, false] },
    }];
    const file = ide.dependencies.requirementsFile();
    if (file) {
      const title = tr("Install package '{name}' and add to {file}", { name: dist, file: basename(file) });
      out.push({ title, kind: 'quickfix', diagnostics, command: { id: INSTALL, title, arguments: [dist, true] } });
    }
    return out;
  }

  monaco.languages.registerCodeActionProvider('python', {
    async provideCodeActions(model, range, context, token) {
      if (!ide.root || ide.trusted === false || !ide.lsp?.diagnostics || !ide.dependencies) return undefined;
      const path = tabOf(model)?.path;
      const diags = ide.lsp.diagnostics(path).filter((d) => CODES.has(d.code)
        && d.range.start.line + 1 <= range.endLineNumber && d.range.end.line + 1 >= range.startLineNumber);
      if (!diags.length) return undefined;
      const actions = [];
      for (const d of diags) {
        for (const a of await actionsFor(model, d, context.markers)) if (!actions.some((x) => x.title === a.title)) actions.push(a);
      }
      if (token.isCancellationRequested) return undefined;
      return { actions, dispose() {} };
    },
  }, { providedCodeActionKinds: ['quickfix'] });

  ide.importInstall = { distFor, install };
})();
