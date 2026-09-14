// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::fmt;
#[derive(Debug)]
pub enum Error {
    Configuration(crate::config::ConfigError),
    Observation(crate::ObservationError),
    State(&'static str),
    Bundle(&'static str),
    Conflict(&'static str),
    Execution {
        operation: String,
        diagnostic: String,
    },
    Cancelled,
    OllamaStarting,
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Configuration(error) => error.fmt(f),
            Self::Observation(error) => error.fmt(f),
            Self::State(message) | Self::Bundle(message) | Self::Conflict(message) => {
                f.write_str(message)
            }
            Self::Execution {
                operation,
                diagnostic,
            } => write!(f, "OpenTofu {operation} failed: {diagnostic}"),
            Self::OllamaStarting => {
                f.write_str("Ollama connection refused; model inventory is unknown")
            }
            Self::Cancelled => f.write_str(
                "operation interrupted; retain state and reapply the same configuration",
            ),
        }
    }
}
impl std::error::Error for Error {}
impl From<crate::config::ConfigError> for Error {
    fn from(error: crate::config::ConfigError) -> Self {
        Self::Configuration(error)
    }
}
impl From<crate::ObservationError> for Error {
    fn from(error: crate::ObservationError) -> Self {
        Self::Observation(error)
    }
}
