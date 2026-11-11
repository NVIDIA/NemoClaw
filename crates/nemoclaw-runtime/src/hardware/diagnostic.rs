// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::Error;

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
    /// A [`Self::Minimum`] on one of the selected GPUs.
    #[error("{gpu}: {field} requires at least {required}; observed {observed}")]
    GpuMinimum {
        gpu: GpuLabel,
        field: &'static str,
        required: u64,
        observed: u64,
    },
    /// A [`Self::Mismatch`] on one of the selected GPUs.
    #[error("{gpu}: {field} requires {required}; observed {observed}")]
    GpuMismatch {
        gpu: GpuLabel,
        field: &'static str,
        required: &'static str,
        observed: &'static str,
    },
}

/// Names a GPU in a diagnostic: its UUID when the observation reports one in
/// NVIDIA's `GPU-` form, held as a number so no host text is echoed, and
/// otherwise its `nvidia-smi` index.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GpuLabel {
    Uuid(u128),
    Index(u32),
}
impl GpuLabel {
    pub fn of(gpu: &super::Gpu) -> Self {
        let uuid = gpu.uuid.strip_prefix("GPU-").and_then(|uuid| {
            let groups: Vec<_> = uuid.split('-').collect();
            let lengths = groups.iter().map(|group| group.len()).collect::<Vec<_>>();
            (lengths == [8, 4, 4, 4, 12]
                && groups
                    .iter()
                    .all(|group| group.bytes().all(|byte| byte.is_ascii_hexdigit())))
            .then(|| u128::from_str_radix(&groups.concat(), 16).ok())
            .flatten()
        });
        uuid.map_or(Self::Index(gpu.index), Self::Uuid)
    }
}
impl std::fmt::Display for GpuLabel {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            Self::Uuid(uuid) => write!(
                f,
                "GPU-{:08x}-{:04x}-{:04x}-{:04x}-{:012x}",
                uuid >> 96,
                (uuid >> 80) & 0xffff,
                (uuid >> 64) & 0xffff,
                (uuid >> 48) & 0xffff,
                uuid & 0xffff_ffff_ffff
            ),
            Self::Index(index) => write!(f, "GPU {index}"),
        }
    }
}

/// Name `gpu` in a hardware diagnostic that one of its checks returns.
pub fn on_gpu(gpu: &super::Gpu, result: Result<(), Error>) -> Result<(), Error> {
    result.map_err(|error| match error {
        Error::Hardware(HardwareDiagnostic::Minimum {
            field,
            required,
            observed,
        }) => Error::Hardware(HardwareDiagnostic::GpuMinimum {
            gpu: GpuLabel::of(gpu),
            field,
            required,
            observed,
        }),
        Error::Hardware(HardwareDiagnostic::Mismatch {
            field,
            required,
            observed,
        }) => Error::Hardware(HardwareDiagnostic::GpuMismatch {
            gpu: GpuLabel::of(gpu),
            field,
            required,
            observed,
        }),
        error => error,
    })
}

pub fn at_least(field: &'static str, required: u64, observed: u64) -> Result<(), Error> {
    if observed < required {
        return Err(Error::Hardware(HardwareDiagnostic::Minimum {
            field,
            required,
            observed,
        }));
    }
    Ok(())
}

pub fn architecture(required: &str, observed: &str) -> Result<(), Error> {
    if required != observed {
        let label = |value: &str| match value {
            "amd64" => "amd64",
            "arm64" => "arm64",
            _ => "unsupported architecture",
        };
        return Err(Error::Hardware(HardwareDiagnostic::Mismatch {
            field: "hardware.architecture",
            required: label(required),
            observed: label(observed),
        }));
    }
    Ok(())
}
