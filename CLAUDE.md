# CLAUDE.md

Stitchline: a Windows desktop app (Tauri 2 + WebView2) for pattern sewing machines that read **SLW** files
(the format of the original "Sew_Soft" CAD; needle 3 can be a laser head). Rust engine + plain HTML/JS UI
(app.js), with React + Ark UI parts mounted into it (ui-react/, built by esbuild). Arabic (default, RTL) and English. README.md has the user-facing overview.

The user writes in Egyptian Arabic; answer in the same language unless asked otherwise. Code, comments and
commit messages are in English.

## Layout (read only what the task needs)

```
engine/src/            stitchline-engine (Rust lib) — a port of an earlier Python version, bit-for-bit
  session.rs   (925)   Session::handle(op, args): EVERY UI action is a string op here. Edits go through
                       `fn edit` (match on op -> ops::*), wrapped in snapshot/undo/redo + autosave; returns state JSON
  ops.rs       (943)   the edit operations (move, rotate, join, layers, groups, order, instructions...)
  model.rs             Job, Layer, Shape, Instr, Snapshot
  importers.rs         DXF, AI, HPGL/PLT/PRT, DST, DSB, SLW readers
  exporters.rs         DXF, PLT, SVG, CSV
  stitches.rs          shapes -> needle positions;  program.rs: machine program + statistics
  machine.rs           SLW records (writer/reader); slw_container.rs: outer file scrambling
  laserfix.rs          laser (needle 3) slow-path check and fix
  py.rs                CPython-identical math/formatting (hypot, sum, round, ucrtbase sin) — don't "simplify"
  platform.rs          Windows paths, USB drives;  geom.rs: geometry helpers
  bin/cli.rs           stitchline-cli: runs a JSON script of ops, prints replies (used by compare_with_python.py)
engine/tests/          parity.rs (SLW vs reference/), session.rs, selection_tools.rs
src-tauri/src/main.rs  window, native dialogs, commands `api` / `upload` / `quit` / `set_zoom`, close guard.
                       FETCH_SHIM turns the UI's fetch('/api/<op>') into invoke('api', {op, args}).
                       A project passed on the command line (double-click) -> `launch_file`; single instance:
                       a second start hands its file to the open window (window.__stitchlineOpen)
src-tauri/windows/hooks.nsh  installer hook: .stitchline document icon (icons/project.ico, drawn by
                       icons/project-icon.py); the association itself is tauri.conf.json fileAssociations
ui/
  index.html           all markup (stages, inspector, sheets/dialogs, settings, palette, home)
  app.js     (~2100)   the whole UI in one IIFE. Sections marked `/* ---- name */`: state, engine calls
                       (`api(op,args,opts)`, `apply(d)`), render* (top, layers, inspector), canvas `paint()`,
                       hit testing/drag, tools, theme/settings, simulation, sheets (confirmSheet/askSave/
                       promptSheet/guardUnsaved), command palette (runTool), home page, toast
  selection.js         pure selection/transform geometry (tested with node)
  i18n.js              Arabic: `AR` exact-phrase table + `P` regex patterns; a MutationObserver translates
                       every text node/tooltip. UI is written in English; ADD AN ARABIC ENTRY for every new
                       visible string (Egyptian wording, e.g. "مشروع", "الشباك"). `data-notr` skips translation
  app.css              tokens for light/dark (`data-theme`), RTL handled via `dir`
  react/islands.js     BUILT from ui-react/ by `npm run build:ui` (gitignored; tauri build and dev_run.ps1 run it)
ui-react/islands.jsx   React + Ark UI components (`@ark-ui/react`), exposed as window.STL_REACT.mount*(el, opts)
                       -> { set, unmount }. app.js renders panels as HTML strings, so it mounts a component into a
                       placeholder after each render and unmounts it before replacing the panel (see lenSlider).
                       New Ark components go here; style them in app.css by their class / data-part
reference/             drawings + SLW files written by the original program (parity ground truth)
tests/                 data/, Python comparison scripts, CDP UI tests (ui_*.mjs), dev_run.ps1
tools/update-desktop.ps1  desktop copy rebuild (see below)
```

Data flow: UI calls `api('op', args)` → Tauri `api` → `Session::handle` → full new state JSON → `apply(d)` →
re-render. Engine messages are English strings; i18n.js translates them, so a new message text needs an
`AR`/`P` entry too. Adding a feature usually means: an op in `session.rs` (+ `ops.rs`), UI in `app.js` /
`index.html`, strings in `i18n.js`, maybe a test in `engine/tests/session.rs`.

## Build / run / test (Windows, GNU toolchain)

Toolchain: rustup `stable-x86_64-pc-windows-gnu`, Node, MinGW binutils (WinLibs via winget). Plain `cargo`
may fail to link; the scripts set PATH and `CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER` (see build.ps1).

- Engine tests: `cargo test -p stitchline-engine`
- UI unit tests: `npm test` (node --test tests/selection.test.mjs)
- Dev app: `powershell -File tests/dev_run.ps1` — builds debug, starts it with a fresh profile
  (`STITCHLINE_HOME=%TEMP%\sl_ui_dev`) and DevTools on port 9333; then `node tests/ui_shortcuts.mjs` /
  `node tests/ui_selection_tools.mjs` drive it over CDP. Only kills the debug exe, never an installed one.
  **Known failures (as of 2026-10-26, main 7dd9fdd), not caused by recent changes — don't re-verify against
  an older build:** `ui_shortcuts.mjs` fails 3 checks ("it says the keys follow Illustrator", Alt-drag "puts a
  moved copy where it was dropped", "Ctrl+D makes the next copy one more step along");
  `ui_selection_tools.mjs` stops with `TypeError: (intermediate value) is not iterable` in `mapping1` (finds no
  bare canvas point). Treat only failures beyond these as new; update this note when they are fixed.
- Installer: `powershell -ExecutionPolicy Bypass -File build.ps1 [-Test]` →
  `target\release\bundle\nsis\Stitchline_<version>_x64-setup.exe`
- Release an update: `tools/release.ps1 -Version x.y.z` bumps tauri.conf.json / src-tauri/Cargo.toml / package.json;
  commit + push, then `tools/release.ps1 -Notes "..."` signs with `%USERPROFILE%\.tauri\stitchline.key` and uploads
  the setup + `latest.json` to GitHub Releases. The app's updater (main.rs `update_*`, app.js `updates`) reads
  releases/latest/download/latest.json
- `tests/compare_with_python.py` needs the Python version (`STITCHLINE_PY_APP`), usually not available.

Prefs/autosave: `%APPDATA%\Stitchline` or `%STITCHLINE_HOME%`. UI-only prefs: localStorage keys `stl.*`.

## Rules

- **SLW output must stay identical** to `reference/` and `tests/data/parity_python.json`. Anything touching
  stitches/program/machine/py.rs must keep `cargo test -p stitchline-engine` green.
- Laser layers (needle 3) are special-cased in many places (settings copy, drawing colour, laserfix) — check
  that a sewing-layer change doesn't leak into them.
- Keep UI edits keyboard-friendly: buttons show their shortcut in the tooltip, `?`/F1 lists shortcuts,
  Esc closes sheets, focus is kept after edits.
- Commit messages: one plain-English sentence about the user-visible change (see `git log`).
- **The desktop shortcut's copy is built only on request** (no git hook): run
  `powershell -ExecutionPolicy Bypass -File tools/update-desktop.ps1` when the user asks for it; status in
  `target\desktop\update.log`. Don't build it after commits on your own.
