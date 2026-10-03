// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::fmt;

/// An authoring error associated with an input field or the whole document.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub(crate) field: &'static str,
    pub(crate) message: String,
}

impl Diagnostic {
    pub fn field(&self) -> &str {
        self.field
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

/// Validation failures with structured access for frontends and a text fallback.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostics {
    pub(crate) items: Vec<Diagnostic>,
}

impl Diagnostics {
    pub fn items(&self) -> &[Diagnostic] {
        &self.items
    }
}

impl fmt::Display for Diagnostics {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, diagnostic) in self.items.iter().enumerate() {
            if index > 0 {
                formatter.write_str("; ")?;
            }
            write!(formatter, "{}: {}", diagnostic.field, diagnostic.message)?;
        }
        Ok(())
    }
}

impl std::error::Error for Diagnostics {}

pub(crate) fn diagnostic(field: &'static str, message: &str) -> Diagnostics {
    Diagnostics {
        items: vec![Diagnostic {
            field,
            message: message.into(),
        }],
    }
}
