// electron-builder msiProjectCreated hook (package.json build.msiProjectCreated): edits the generated WiX project.
// - "Open with Nano Studio" for .py, the same registry entries as build/installer.nsh for the NSIS installer. HKMU is
//   HKCU for the default per-user install and HKLM for a per-machine one (ALLUSERS=1), and Windows Installer removes
//   the values on uninstall.
// - WiX 4.0's light.exe is not long-path aware, and pyright's typeshed stubs pass MAX_PATH (260) when the checkout
//   sits in a deep folder (8.3 names do not help: .NET expands them). Then the file sources go through a directory
//   junction in %TEMP% to the packed app, removed (the link only, never its target) when the build exits.
const fs = require('fs');
const os = require('os');
const path = require('path');

const SOURCE = /Source="\$\(var\.appDir\)([^"]*)"/g;

// electron-builder stages the project in dist/__msi-x64 next to the packed app in dist/win-unpacked.
function shortAppDir(projectFile, wxs) {
  const appDir = path.resolve(path.dirname(projectFile), '..', 'win-unpacked');
  const longest = Math.max(0, ...[...wxs.matchAll(SOURCE)].map((m) => m[1].length));
  if (appDir.length + longest < 250 || !fs.existsSync(path.join(appDir, 'Nano Studio.exe'))) return null;
  const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pyide-msi-')), 'app');
  fs.symlinkSync(appDir, link, 'junction');
  process.on('exit', () => {
    try { fs.rmdirSync(link); fs.rmdirSync(path.dirname(link)); } catch {}
  });
  return link;
}

const EXE = '[APPLICATIONFOLDER]Nano Studio.exe';
const OPEN = `&quot;${EXE}&quot; &quot;%1&quot;`;
const VALUES = [
  ['Software\\Classes\\NanoStudio.py', null, 'Python File'],
  ['Software\\Classes\\NanoStudio.py\\DefaultIcon', null, `${EXE},0`],
  ['Software\\Classes\\NanoStudio.py\\shell\\open', null, 'Open with Nano Studio'],
  ['Software\\Classes\\NanoStudio.py\\shell\\open\\command', null, OPEN],
  ['Software\\Classes\\.py\\OpenWithProgids', 'NanoStudio.py', ''],
  ['Software\\Classes\\Applications\\Nano Studio.exe', 'FriendlyAppName', 'Nano Studio'],
  ['Software\\Classes\\Applications\\Nano Studio.exe\\SupportedTypes', '.py', ''],
  ['Software\\Classes\\Applications\\Nano Studio.exe\\shell\\open\\command', null, OPEN],
];

const component = `<Component Id="openWithPy" Guid="{9B353E42-8D03-4F18-8DFA-D15DDA1CEBE9}">
${VALUES.map(([key, name, value], i) => `        <RegistryValue Root="HKMU" Key="${key}"${name ? ` Name="${name}"` : ''} Value="${value}" Type="string"${i === 0 ? ' KeyPath="yes"' : ''}/>`).join('\n')}
      </Component>
    </ComponentGroup>`;

module.exports = async function msiProjectCreated(projectFile) {
  let wxs = fs.readFileSync(projectFile, 'utf8');
  if (!wxs.includes('</ComponentGroup>')) throw new Error(`msi-project.js: no </ComponentGroup> in ${projectFile}`);
  wxs = wxs.replace('</ComponentGroup>', component);
  const appDir = shortAppDir(projectFile, wxs);
  if (appDir) wxs = wxs.replace(SOURCE, (_m, rel) => `Source="${appDir}${rel}"`);
  fs.writeFileSync(projectFile, wxs);
};
