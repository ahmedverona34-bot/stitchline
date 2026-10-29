# Changelog

What changed in each Stitchline release. Installers are on
[GitHub Releases](https://github.com/ahmedverona34-bot/stitchline/releases); installed copies pick up new versions
through the Update button.

## 1.0.4 — 2026-10-29

### Changed
- New Home page: a top bar with New, Open and the settings, a large card to pick up the job you left open (or start
  a new one on your machine table), and your recent files below.
- Press Enter on Home to go straight back to the open job.

### Fixed
- Projects, machine files and exports are saved through a temporary file, so a crash or power cut never leaves a
  half-written file.
- The window runs under a content security policy, so it only loads Stitchline's own code.

## 1.0.3 — 2026-10-21

### Added
- Each shape's sewing number shows on the drawing, like in Sew_Soft. Numbers are drawn large, kept from overlapping
  and keep their outline when they need a leader line.
- Up/Down and go-to-number controls for shapes and layers, and a numbering tool that works by clicking shapes in
  order.
- Double-clicking a Stitchline project opens it straight in the editor, in the open window if Stitchline is already
  running.
- Project files (.stitchline) have their own document icon.

### Changed
- The next travel move is no longer highlighted when you point at a shape.

## 1.0.2 — 2026-10-20

### Fixed
- SLW files saved by newer Sew_Soft versions open correctly. They used to show "This file has no drawing" or
  "The drawing is too large".

## 1.0.1 — 2026-10-20

The first public release.

### Added
- Opens DXF, AI, HPGL/PLT/PRT, DST, DSB and SLW drawings, and writes SLW machine files identical to the original
  Sew_Soft program. Exports DXF, PLT, SVG and CSV.
- Laser cutting on needle 3, with laser layers drawn in their own colour and left alone when a sewing layer's
  settings are copied to every layer.
- Home screen with New job, Open, continue and recent files.
- Simple mode with only the layers, tool rail, sewing or laser per layer, stitch length, size readout, simulation
  and saving. Advanced mode in Settings turns on the rest.
- Simulation in its own window that draws the job as the head moves, at a calm 1× speed with finer speed steps.
- Sequence window to drag the sewing and laser order into place, a Sewing then laser button and a suggestion to sew
  in the best order (each pattern piece finished before the next, laser pieces cut last).
- Reorder shapes and layers by dragging in the layers list, and Create group in its right-click menu.
- Adobe Illustrator keyboard shortcuts, black (V) and white (A) selection arrows, box selection that picks every
  shape it touches, and a Resize dialog to type the selection's width and height.
- Original shape view, lines that keep one width at every zoom, and an optional drawing grid (off by default).
- Arabic (default, right to left) and English, with the Thmanyah Sans font for Arabic.
- Settings window with language, light / dark, font, text size and interface options.
- Stitchline's own title bar, a step bar with the five steps and Previous / Next buttons, and a status bar with zoom
  and pointer position.
- Asks Save / Don't save / Cancel before closing or replacing unsaved work.
- Update button in the top bar and on Home when a new version is out (checked at start-up and every few hours), and
  Check for updates in Settings › General.
- An illustrated Arabic user manual (PDF).

### Fixed
- Bad settings and very large drawings no longer freeze or crash the app.
- The window opens maximized, and the simulation's line stays with the head along long laser segments.
