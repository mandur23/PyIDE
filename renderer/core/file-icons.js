// File type icons: ide.fileIcon(nameOrPath, {dir, open}) -> a 16px icon element, PyCharm New UI style. Exact file names
// win over extensions; anything unknown gets the generic file icon. Each icon holds its light and dark drawing and
// CSS shows the one for the current theme, so a theme switch needs no re-render.
(() => {
  const NAMES = {
    dockerfile: 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker', 'compose.yml': 'docker',
    'compose.yaml': 'docker', '.dockerignore': 'ignored', '.gitignore': 'gitignore', '.gitattributes': 'gitignore',
    '.gitmodules': 'gitignore', '.npmignore': 'ignored', '.editorconfig': 'editorConfig', '.env': 'config',
    'jenkinsfile': 'jenkins', makefile: 'shell', 'build.gradle': 'gradle', 'build.gradle.kts': 'gradle',
    'settings.gradle': 'gradle', 'manifest.in': 'manifest', 'manifest.mf': 'manifest', license: 'text', 'license.txt': 'text',
    pipfile: 'toml', 'pipfile.lock': 'json', 'poetry.lock': 'toml', 'uv.lock': 'toml', 'requirements.txt': 'text',
    'build.bazel': 'bazel', build: 'bazel', workspace: 'bazel', '.flake8': 'config', '.pylintrc': 'config', readme: 'text',
  };
  const EXTENSIONS = {
    py: 'python', pyw: 'python', pyi: 'python', pyx: 'python', pxd: 'python', ipynb: 'jupyter',
    txt: 'text', log: 'text', rst: 'rst', md: 'markdown', markdown: 'markdown',
    json: 'json', jsonc: 'json', json5: 'json', geojson: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml',
    ini: 'config', cfg: 'config', conf: 'config', env: 'config', properties: 'properties',
    xml: 'xml', xsd: 'xsd', xhtml: 'xhtml', wsdl: 'wsdl', html: 'html', htm: 'html', jinja: 'html', jinja2: 'html', j2: 'html',
    css: 'css', scss: 'css', sass: 'css', less: 'css', js: 'javaScript', mjs: 'javaScript', cjs: 'javaScript', jsx: 'javaScript',
    ts: 'typeScript', tsx: 'typeScript', mts: 'typeScript', cts: 'typeScript', vue: 'vue', map: 'sourceMap',
    sql: 'sql', csv: 'csv', tsv: 'csv', graphql: 'graphql', gql: 'graphql', http: 'http', rest: 'http',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', bat: 'microsoftWindows', cmd: 'microsoftWindows',
    ps1: 'microsoftWindows', psm1: 'microsoftWindows', reg: 'microsoftWindows',
    c: 'c', h: 'h', hpp: 'h', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', cs: 'Csharp', java: 'java', class: 'javaClass',
    groovy: 'groovy', gradle: 'gradle', kts: 'gradle', pl: 'perl', pm: 'perl', swift: 'swiftLang', tf: 'terraform',
    tfvars: 'terraform', jsp: 'jsp', jspx: 'jspx', regexp: 'regexp', patch: 'patch', diff: 'patch', bzl: 'bazel',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', ico: 'image', webp: 'image', svg: 'image',
    tif: 'image', tiff: 'image', avif: 'image',
    mp4: 'video', mov: 'video', avi: 'video', mkv: 'video', webm: 'video', m4v: 'video', wmv: 'video', flv: 'video',
    mp3: 'audio', wav: 'audio', flac: 'audio', ogg: 'audio', m4a: 'audio', aac: 'audio', wma: 'audio', opus: 'audio',
    pdf: 'pdf', ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
    zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', bz2: 'archive', xz: 'archive', '7z': 'archive',
    rar: 'archive', whl: 'archive', egg: 'archive', jar: 'archive',
    exe: 'binaryData', dll: 'binaryData', so: 'binaryData', pyd: 'binaryData', pyc: 'binaryData', pyo: 'binaryData',
    bin: 'binaryData', dat: 'binaryData', pkl: 'binaryData', pickle: 'binaryData', npy: 'binaryData', npz: 'binaryData',
    parquet: 'binaryData', h5: 'binaryData', hdf5: 'binaryData', onnx: 'binaryData', pt: 'binaryData', pth: 'binaryData',
    db: 'database', sqlite: 'database', sqlite3: 'database', db3: 'database', hprof: 'hprof', jfr: 'jfr',
  };
  const DEFAULT = 'anyType';

  const typeOf = (name, dir) => {
    if (dir) return 'folder';
    const lower = name.toLowerCase();
    if (NAMES[lower]) return NAMES[lower];
    if (/^requirements.*\.(txt|in)$/.test(lower)) return 'text';
    if (/^dockerfile\./.test(lower) || /\.dockerfile$/.test(lower)) return 'docker';
    const dot = lower.lastIndexOf('.');
    return (dot >= 0 && EXTENSIONS[lower.slice(dot + 1)]) || DEFAULT;
  };

  const svgOf = (variant, type) => window.PYIDE_FILE_ICONS?.[variant]?.[type];
  ide.fileIconType = (nameOrPath, { dir = false } = {}) => typeOf(nameOrPath.split(/[\\/]/).pop(), dir);
  ide.fileIcon = (nameOrPath, opts = {}) => {
    const type = opts.type || ide.fileIconType(nameOrPath, opts);
    const span = document.createElement('span');
    span.className = 'file-icon';
    span.dataset.type = type;
    if (type === 'database') {
      // The Database plugin's icon; it is drawn in currentColor, so one drawing serves both themes.
      span.appendChild(ide.icon('database', '⛁'));
      return span;
    }
    const lightSvg = svgOf('light', type) || svgOf('light', DEFAULT);
    // An icon without a dark drawing keeps its own light one rather than turning generic.
    const darkSvg = svgOf('dark', type) || (svgOf('light', type) ? lightSvg : svgOf('dark', DEFAULT)) || lightSvg;
    span.innerHTML = `<span class="fi-light">${lightSvg}</span><span class="fi-dark">${darkSvg}</span>`;
    return span;
  };
})();
