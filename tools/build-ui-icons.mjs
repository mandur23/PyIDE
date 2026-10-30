// Builds renderer/core/icons-ui.js: the New UI action, node and file type icons PyIDE's toolbars, menus and lists use,
// fetched from the IntelliJ Community repository (Apache License 2.0) at a fixed commit, and the dark drawings of
// the colored icons in icons.js.
// Usage: node tools/build-ui-icons.mjs
import { writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const COMMIT = '0a475cae9a97466f56b09f4bda55df170c3827fb';
const UI = 'platform/icons/src/expui';
const SOURCES = {
  refresh: `${UI}/general/refresh.svg`,
  rerun: `${UI}/run/rerun.svg`,
  rerunFailed: `${UI}/run/restartFailedTests.svg`,
  rerunAuto: `${UI}/actions/rerunAutomatically.svg`,
  pause: `${UI}/run/pause.svg`,
  resume: `${UI}/run/resume.svg`,
  testPassed: `${UI}/run/testPassed.svg`,
  testFailed: `${UI}/run/testFailed.svg`,
  testTerminated: `${UI}/run/testTerminated.svg`,
  testError: `${UI}/run/testError.svg`,
  testIgnored: `${UI}/run/testIgnored.svg`,
  testNotRun: `${UI}/run/testNotRunYet.svg`,
  error: `${UI}/status/error.svg`,
  runConfig: `${UI}/runConfigurations/application.svg`,
  closeSmall: `${UI}/general/closeSmall.svg`,
  stepOver: `${UI}/run/stepOver.svg`,
  stepInto: `${UI}/run/stepInto.svg`,
  stepOut: `${UI}/run/stepOut.svg`,
  runToCursor: `${UI}/run/runToCursor.svg`,
  evaluate: `${UI}/run/evaluateExpression.svg`,
  breakpoints: `${UI}/run/viewBreakpoints.svg`,
  profile: `${UI}/run/profile.svg`,
  runWithCoverage: `${UI}/run/runWithCoverage.svg`,
  coverage: `${UI}/toolwindows/coverage.svg`,
  profiler: `${UI}/toolwindows/profiler.svg`,
  dataView: `${UI}/toolwindows/toolWindowDataView.svg`,
  web: `${UI}/toolwindows/web.svg`,
  up: `${UI}/general/up.svg`,
  down: `${UI}/general/down.svg`,
  moveUp: `${UI}/general/moveUp.svg`,
  moveDown: `${UI}/general/moveDown.svg`,
  zoomIn: `${UI}/image/zoomIn.svg`,
  zoomOut: `${UI}/image/zoomOut.svg`,
  fit: `${UI}/image/fitContent.svg`,
  actualZoom: `${UI}/image/actualZoom.svg`,
  clearOutputs: `${UI}/actions/clearCash.svg`,
  desktop: `${UI}/nodes/desktop.svg`,
  expandAll: `${UI}/general/expandAll.svg`,
  collapseAll: `${UI}/general/collapseAll.svg`,
  sortAlpha: `${UI}/objectBrowser/sortAlphabetically.svg`,
  splitRight: `${UI}/general/splitVertically.svg`,
  splitDown: `${UI}/general/splitHorizontally.svg`,
  home: `${UI}/general/home.svg`,
  clear: `${UI}/general/delete.svg`,
  remove: `${UI}/general/remove.svg`,
  edit: `${UI}/general/edit.svg`,
  copy: `${UI}/general/copy.svg`,
  externalLink: `${UI}/ide/externalLink.svg`,
  download: `${UI}/general/download.svg`,
  history: `${UI}/general/history.svg`,
  reset: `${UI}/general/reset.svg`,
  runAnything: `${UI}/general/runAnything.svg`,
  check: `${UI}/actions/checked.svg`,
  exclude: `${UI}/actions/addExcludedRoot.svg`,
  newFolder: `${UI}/actions/newFolder.svg`,
  warning: `${UI}/status/warning.svg`,
  info: `${UI}/status/info.svg`,
  abort: `${UI}/vcs/abort.svg`,
  diff: `${UI}/vcs/diff.svg`,
  merge: `${UI}/vcs/merge.svg`,
  push: `${UI}/vcs/push.svg`,
  update: `${UI}/vcs/update.svg`,
  revert: `${UI}/vcs/revert.svg`,
  shelve: `${UI}/vcs/shelve.svg`,
  unshelve: `${UI}/vcs/unshelve.svg`,
  package: `${UI}/nodes/package.svg`,
  class: `${UI}/nodes/class.svg`,
  modelClass: `${UI}/nodes/modelClass.svg`,
  field: `${UI}/nodes/field.svg`,
  function: `${UI}/nodes/function.svg`,
  securityRole: `${UI}/nodes/securityRole.svg`,
  dataSchema: `${UI}/nodes/dataSchema.svg`,
  dataTable: `${UI}/nodes/dataTables.svg`,
  dataColumn: `${UI}/nodes/dataColumn.svg`,
  test: `${UI}/nodes/test.svg`,
  plugin: `${UI}/nodes/plugin.svg`,
  text: `${UI}/fileTypes/text.svg`,
  java: `${UI}/fileTypes/java.svg`,
  cpp: `${UI}/fileTypes/cpp.svg`,
  shell: `${UI}/fileTypes/shell.svg`,
  windows: `${UI}/fileTypes/microsoftWindows.svg`,
  gradle: `${UI}/fileTypes/gradle.svg`,
  diagram: `${UI}/fileTypes/diagram.svg`,
  maven: 'plugins/maven/src/main/resources/images/expui/toolwindow/maven.svg',
  pullRequests: 'plugins/github/github-core/resources/org/jetbrains/plugins/github/expui/pullRequests.svg',
};

// The colored icons of icons.js (built from the IDE's jars, light drawings only) get their dark drawings here.
const DARK_OF_ICONS_JS = {
  runRun: `${UI}/run/run.svg`,
  runDebug: `${UI}/run/debug.svg`,
  runStop: `${UI}/run/stop.svg`,
  folder: `${UI}/nodes/folder.svg`,
  newProject: `${UI}/welcome/createNewProjectTab.svg`,
  openProject: `${UI}/welcome/open.svg`,
  fromVcs: `${UI}/welcome/fromVCSTab.svg`,
  pinSelected: `${UI}/general/pinSelected.svg`,
  python: 'python/python-parser/resources/icons/com/jetbrains/python/parser/expui/python.svg',
};

// As in tools/build-icons.mjs, the gray of the main drawing becomes currentColor so CSS colors it (Gray7 in the light
// variants, Gray10 in the dark ones). An icon with other colors also keeps its dark drawing, which ide.icon shows in
// the dark themes.
const GRAYS = /#6C707E|#818594|#CED0D6/gi;
const fetchSvg = async (rel) => {
  const res = await fetch(`https://raw.githubusercontent.com/JetBrains/intellij-community/${COMMIT}/${rel}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  return (await res.text())
    .replace(/<\?xml[^>]*>\s*/, '')
    .replace(/<!--[\s\S]*?-->\s*/g, '')
    .replace(GRAYS, 'currentColor')
    .replace(/\s+/g, ' ')
    .trim()
    .replace('<svg ', '<svg aria-hidden="true" ');
};
const icons = {};
const dark = {};
for (const [name, rel] of Object.entries(SOURCES)) {
  icons[name] = await fetchSvg(rel);
  if (!icons[name]) throw new Error(`${rel}: not found`);
  if (!/#[0-9a-f]{6}/i.test(icons[name])) continue;
  const d = await fetchSvg(rel.replace(/\.svg$/, '_dark.svg'));
  if (d && d !== icons[name]) dark[name] = d;
}
for (const [name, rel] of Object.entries(DARK_OF_ICONS_JS)) {
  dark[name] = await fetchSvg(rel.replace(/\.svg$/, '_dark.svg'));
  if (!dark[name]) throw new Error(`${rel}: no dark drawing`);
}

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'core', 'icons-ui.js');
writeFileSync(out, `// Generated by tools/build-ui-icons.mjs from the IntelliJ Platform's New UI icons (Apache License 2.0). Do not edit.
Object.assign(window.PYIDE_ICONS, ${JSON.stringify(icons, null, 2)});
window.PYIDE_ICONS_DARK = Object.assign(window.PYIDE_ICONS_DARK || {}, ${JSON.stringify(dark, null, 2)});
`);
console.log(`wrote ${Object.keys(icons).length} icons (${Object.keys(dark).length} with a dark drawing) to ${out}`);
