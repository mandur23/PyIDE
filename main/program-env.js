// main.js sets NoDefaultCurrentDirectoryInExePath for the IDE's own process, so that nothing it starts is picked up
// from a project folder. Programs the user runs (terminals, Run, Debug) get the environment without it: cmd.exe there
// finds a program in the current folder, as it does outside the IDE. Spawning such a program stays protected, because
// the lookup reads the IDE's own environment, not the child's.
module.exports = function programEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath') delete env[key];
  return env;
};
