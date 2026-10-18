//! Stitchline engine: import, edit, stitch, sequence and export sewing jobs.
//! A Rust port of the earlier Python version of Stitchline that gives the same results, down to the bytes of SLW files.
//! Module notes "port of engine/x.py" name the Python module each one replaces.
pub mod error;
pub mod exporters;
pub mod geom;
pub mod importers;
pub mod laserfix;
pub mod machine;
pub mod model;
pub mod ops;
pub mod platform;
pub mod program;
pub mod py;
pub mod session;
pub mod slw_container;
pub mod stitches;

pub use error::Error;
pub use session::{Dialogs, FileTypes, Session};
