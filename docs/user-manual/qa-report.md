# Stitchline Arabic user manual: QA report

Date: 2026-10-19. App version checked: Stitchline 1.0.0 at commit `651e2f2` (main), debug build from
`tests/dev_run.ps1`, Arabic interface, light theme, window 1480 × 874 at 125 % (screenshots are 1850 × 1093 px).

## Deliverables

| File | What it is |
|---|---|
| `user-manual-ar.pdf` | The manual: 71 A4 pages, 19 chapters, 84 bookmarks, 344 internal links, searchable Arabic text |
| `feature-inventory.csv` | 105 user-visible features: where, how verified, which section covers them |
| `screenshots/` | 55 original screenshots and `rects.json` (where each part of the window is, per picture) |
| `annotated/` | 36 pictures with numbered call-outs, as used in the PDF |
| `source/` | Everything needed to rebuild: `capture.mjs`, `annotate.py`, `parts/*.html`, `manual.css`, `build.mjs`, `postpdf.py`, `make_inventory.py` |

No `.docx` was made: the editable source is the HTML in `source/parts/` (one file per group of chapters).

## Rebuilding after the interface changes

```
powershell -File tests/dev_run.ps1
node docs/user-manual/source/capture.mjs
python docs/user-manual/source/annotate.py
node docs/user-manual/source/build.mjs
```

`capture.mjs` drives the running test build over DevTools and records the position of every part it photographs,
so the call-outs follow layout changes. Wording changes in the interface still need the text in `parts/` updated.

## Interface changes found while the manual was being written

Three commits landed during the work (`de3d4bc`, `13238b5`, `651e2f2`). All screenshots were retaken from the
new build and the text was updated:

- the program name and logo left the top bar (Home keeps them);
- the five stages moved to their own step bar with short descriptions, done ticks and Previous / Next step buttons
  (Page Up / Page Down; Next becomes "Save machine file" in Output);
- the drawing grid is now off by default;
- sewing order numbers no longer pile up, and pointing at a shape highlights it with the ones before and after.

## What was verified, and how

- **In the running app (GUI):** every screen, panel, menu and dialog that appears in the manual was opened and
  photographed; opening files (recent list, dropped file), new job, selection tools, context menus, laser layer and
  "Speed up laser paths", simulation, settings pages, command palette, unsaved-changes question, error messages.
- **Through the engine CLI** (`stitchline-cli`, the same `Session` code the window uses): saving a job, saving the
  machine file (4555 records), PLT / DXF / SVG / CSV export, "Nothing to sew", USB drive no longer connected,
  unsupported / not-yet-supported / empty / broken files.
- **From the code only** (marked in the inventory): installer steps (not run, it would install on this computer),
  window close question, autosave restore, USB save buttons (no USB stick connected), layer colour / rename / drag,
  clean-up tools, back-tack and corner settings' effect on stitches.
- Native Windows Open / Save dialogs were opened but not photographed: automating them on this Windows build was
  unreliable and a screen grab could include the user's desktop.

## PDF checks

- All 71 pages rendered to images and reviewed; layout problems found and fixed in the source: cover with running
  footer (cover now printed full bleed and inserted as page 1), headings left alone at page bottoms (panel pictures
  made narrower), thin top-bar / step-bar strips (split in halves), key combinations reversed by RTL (now one LTR
  unit), a missing glyph (⌂) falling back to Times.
- Arabic shaping, RTL order, numbers and mixed Arabic / Latin checked at 120 dpi on sample pages.
- Contents and index page numbers come from the PDF's own link targets (two print passes), bookmarks from the headings.
- Text search works (e.g. «حفظ ملف الماكينة» found on 17 pages, «طول الغرزة» on 10). Fonts: Thmanyah Sans and
  Readex Pro from `ui/fonts` (embedded by Edge as Type 3), Segoe UI in the footer.

## Problems found in the app (documented in the manual, chapter 16.4, with workarounds)

1. **Needle button in a layer row does nothing visible** — `ui/app.js` opens the menu in the `#layers` click handler,
   then the document click handler (`if (!e.target.closest('#ctx')) $('#ctx').hidden = true`) hides it at once.
2. **Measure tool reading unreadable in Arabic** — the label is drawn with `textAlign = 'start'`, which is right-aligned
   in an RTL canvas, so the text lands outside the dark pill in the canvas colour (`paint()`, measure block).
3. **New job dialog size preset shows "800 × 1000"** in Arabic (bidi order of the chip), while it means 1000 × 800.
4. Some engine messages have no Arabic entry and show in English: "This is not an SLW machine file.",
   "No drawing paths were found in this AI file…".

## Open points

- The interface Arabic is still partly Egyptian ("شغلانة", "الشباك", "دي"). A move of the interface to فصحى with
  "مشروع" for a job is planned (project memory); when it lands, update the quoted button names in `parts/` and rebuild.
- Installer, USB-stick saving and the window-close question were not exercised end to end on this machine.
