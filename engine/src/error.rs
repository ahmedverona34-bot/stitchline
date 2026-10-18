//! Errors of API actions, matching how the Python server reported them.
use std::fmt;

#[derive(Debug, Clone)]
pub enum Error {
    /// OpError / ImportError_ / ValueError: shown to the user as is (HTTP 400 in the Python app)
    Op(String),
    /// KeyError / StopIteration: 'That item no longer exists.'
    Missing,
    /// anything else (HTTP 500): 'Unexpected error: ...'
    Unexpected(String),
}

impl Error {
    pub fn op<S: Into<String>>(s: S) -> Error {
        Error::Op(s.into())
    }

    /// The text the window shows.
    pub fn text(&self) -> String {
        match self {
            Error::Op(s) if s.is_empty() => "Something went wrong.".into(),
            Error::Op(s) => s.clone(),
            Error::Missing => "That item no longer exists.".into(),
            Error::Unexpected(s) => format!("Unexpected error: {}", s),
        }
    }

    pub fn status(&self) -> u16 {
        match self {
            Error::Unexpected(_) => 500,
            _ => 400,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.text())
    }
}

impl From<String> for Error {
    fn from(s: String) -> Self {
        Error::Op(s)
    }
}

pub type Res<T> = Result<T, Error>;
