// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::fmt;

/// Configuration errors. Each diagnostic names its place in the document when
/// its check knows it, and none quotes a value.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError {
    diagnostics: Vec<Diagnostic>,
}

/// One configuration error.
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct Diagnostic {
    /// The field or object in the schema's path style, such as
    /// `spec.sandboxes.coding.agent.auth`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// The 1-based line where the value starts, when the document was parsed
    /// from text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    /// The 1-based character column where the value starts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
    pub message: String,
    /// The JSON pointer of the rejected value, from which parsing derives
    /// `path` and the position.
    #[serde(skip)]
    pub pointer: Option<String>,
    /// The mapping key under `pointer` that the error is about. The error
    /// takes the key's position, and never shows the key.
    #[serde(skip)]
    pub key: Option<String>,
}

impl ConfigError {
    /// The most diagnostics an error lists.
    const SHOWN: usize = 20;

    pub fn new(message: &'static str) -> Self {
        Self::from(message.to_owned())
    }

    /// An error about the value at the JSON pointer `pointer`.
    pub fn at(pointer: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            diagnostics: vec![Diagnostic {
                pointer: Some(pointer.into()),
                message: message.into(),
                ..Diagnostic::default()
            }],
        }
    }

    /// Places each diagnostic that names no place at `pointer`, the value its
    /// check examined.
    #[must_use]
    pub fn or_at(mut self, pointer: &str) -> Self {
        for diagnostic in &mut self.diagnostics {
            if diagnostic.pointer.is_none() && diagnostic.path.is_none() {
                diagnostic.pointer = Some(pointer.to_owned());
            }
        }
        self
    }

    /// Joins the errors of independent checks, once each, or `None` when
    /// there are none.
    pub fn collect(errors: impl IntoIterator<Item = Self>) -> Option<Self> {
        let mut diagnostics = Vec::new();
        for diagnostic in errors.into_iter().flat_map(Self::into_diagnostics) {
            if !diagnostics.contains(&diagnostic) {
                diagnostics.push(diagnostic);
            }
        }
        (!diagnostics.is_empty()).then_some(Self { diagnostics })
    }

    /// The errors the message lists: the first 20.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics[..self.diagnostics.len().min(Self::SHOWN)]
    }

    pub fn into_diagnostics(self) -> Vec<Diagnostic> {
        self.diagnostics
    }
}

impl From<Diagnostic> for ConfigError {
    fn from(diagnostic: Diagnostic) -> Self {
        Self {
            diagnostics: vec![diagnostic],
        }
    }
}

impl From<String> for ConfigError {
    fn from(message: String) -> Self {
        Self {
            diagnostics: vec![Diagnostic {
                message,
                ..Diagnostic::default()
            }],
        }
    }
}

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        if let [diagnostic] = self.diagnostics.as_slice() {
            return diagnostic.fmt(formatter);
        }
        write!(formatter, "{} configuration errors", self.diagnostics.len())?;
        if self.diagnostics.len() > Self::SHOWN {
            write!(formatter, ", showing the first {}", Self::SHOWN)?;
        }
        formatter.write_str(":")?;
        for diagnostic in self.diagnostics() {
            write!(formatter, "\n  {diagnostic}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ConfigError {}

impl fmt::Display for Diagnostic {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = &self.message;
        match (&self.path, self.line.zip(self.column)) {
            (Some(path), Some((line, column))) => {
                write!(
                    formatter,
                    "{path} (line {line}, column {column}): {message}"
                )
            }
            (Some(path), None) => write!(formatter, "{path}: {message}"),
            (None, Some((line, column))) => {
                write!(formatter, "{message} at line {line}, column {column}")
            }
            (None, None) => formatter.write_str(message),
        }
    }
}
