# Nano Studio

Start at `docs/README.md`, which says which document to read for the work at hand.

- `docs/development.md`: structure, how to build a feature, coding rules, tests, and the commit and release steps. Read it before the first change.
- `docs/code-app.md` for Nano Studio Code (the IDE), `docs/craft-app.md` for Nano Studio Craft (the Minecraft app), `docs/cut-app.md` for Nano Studio Cut (the video editor).
- `docs/pitfalls.md`: the problems this project has already hit and the rule each one left. Read its common sections and the sections of the app you work on before coding or testing. Add a line in the right section when you fix a new one.
- `FEATURES.md` describes each feature and API in detail, `CHANGELOG.md` the releases.

## Every piece of work ends the same way

The owner asked for these three on 2026-11-20, for every task, without being asked again. Each is a command, so it is done and not remembered.

1. **Check what the change touches, not everything.** `node verify/affected.mjs` prints the suites and the Rust tests the changed files need (`--run` runs them one after another; `--since last-release` for work already committed). Run that plan, not the 195 suites or the whole Rust workspace: CI runs the rest on the pushed commit, and a release still waits for CI. A plan that says "wide change" is a sample; say so in the report.
2. **Write down what went wrong, where the next change will meet it.** One document: `docs/pitfalls.md`, a line in the section of the app, with the cause and the rule it leaves. When CI or a full run fails on something the plan left out, also add a line to `LEARNED` in `verify/affected.mjs` (the path, the checks, the date and why): the next change of that file then runs them in time. Read the pitfalls of the app before the next change there.
3. **Leave nothing behind.** `node verify/clean.mjs --all` once no suite, Rust test or release is running (test folders in %TEMP%, `verify/out`, trial builds), and delete the scratch scripts, pictures and logs made along the way. Never `dist/`, `cut-rs/target`, `verify/out/downloads-cache` or `verify/out/*-venv`.

Another session may be working in this same folder (on 2026-11-20 one was building a fourth app while this one worked on Cut). Before the three steps, `git status`: files that are not yours are left out of the commit (`git add` by path, never `-A`), no release is made while they are uncommitted (a build packs the working tree), and `clean.mjs --all` waits, since it removes that session's test folders too.

Scripts that edit files are written to a file and run with node (a shell here-document drops backslashes).
