Reference files written by the original machine program (Sew_Soft) from the drawings next to them.
engine/tests/parity.rs checks that Stitchline writes the same SLW records for each case:

parity/<name>.dxf|.plt        the drawing
parity/<name>.slw             saved by the original program with its default settings
parity/<name>.stitch.slw      saved with "Line to point" (stitch mode) on
test.dxf, test_default.slw    the first reference (saved under the name test_default.klw.slw)
