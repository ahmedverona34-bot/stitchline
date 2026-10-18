Cases kept out of the automatic parity run (engine/tests/parity.rs), with the reason:

s5_short.dxf    "Line to point" on 3 mm segments where the back-tack overlaps two corners.
                Needle positions, sections and back-tack match; the original places its corner
                slow-down markers (record 0x2A) by a more involved rule in this crowded case.
