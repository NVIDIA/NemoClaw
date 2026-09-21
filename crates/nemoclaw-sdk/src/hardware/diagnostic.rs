// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Error, ObservationError};

/// Hardware failures contain only numeric observations and fixed labels, never
/// arbitrary host output, connection strings, or credential-bearing input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum HardwareDiagnostic {
    #[error("{field} requires at least {required}; observed {observed}")]
    Minimum {
        field: &'static str,
        required: u64,
        observed: u64,
    },
    #[error("{field} requires {required}; observed {observed}")]
    Mismatch {
        field: &'static str,
        required: &'static str,
        observed: &'static str,
    },
}

pub(crate) fn at_least(field: &'static str, required: u64, observed: u64) -> Result<(), Error> {
    if observed < required {
        return Err(ObservationError::Hardware(HardwareDiagnostic::Minimum {
            field,
            required,
            observed,
        })
        .into());
    }
    Ok(())
}

pub(crate) fn architecture(required: &str, observed: &str) -> Result<(), Error> {
    if required != observed {
        let label = |value: &str| match value {
            "amd64" => "amd64",
            "arm64" => "arm64",
            _ => "unsupported architecture",
        };
        return Err(ObservationError::Hardware(HardwareDiagnostic::Mismatch {
            field: "hardware.architecture",
            required: label(required),
            observed: label(observed),
        })
        .into());
    }
    Ok(())
}
