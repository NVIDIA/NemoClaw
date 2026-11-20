// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Writes that ran out of space: the storage, what the failure kept, and how
//! to retry.

use std::{fmt, path::PathBuf};

/// A write that ran out of space.
#[derive(Debug)]
pub struct OutOfSpace {
    pub writer: Writer,
    pub target: StorageTarget,
    /// The bytes free on the target's file system, when NemoClaw can measure
    /// them on this host.
    pub available: Option<u64>,
    pub kept: Kept,
    /// What the write reported, redacted.
    pub diagnostic: String,
}

/// What ran out of space.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Writer {
    /// An OpenTofu command, such as `apply`, and the resource whose operation
    /// reported it; `None` for OpenTofu's own files.
    OpenTofu {
        operation: String,
        resource: Option<String>,
    },
    /// NemoClaw writing one of the deployment's state files.
    NemoClaw { file: String },
}

/// The storage that a write ran out of space on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StorageTarget {
    /// An engine's image and container storage.
    DockerRoot { engine: String },
    /// A deployment's volume on an engine, which its local driver keeps in
    /// the engine's Docker root.
    Volume { engine: String, volume: String },
    /// The deployment's state directory.
    DeploymentState { directory: PathBuf },
}

/// What a write that ran out of space kept.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kept {
    /// Every resource, with what was written to them so far.
    Resources,
    /// The deployment's state as it was before the write.
    State,
    /// OpenTofu couldn't save the state and wrote it to `errored.tfstate`.
    ErroredState,
    /// OpenTofu couldn't save the state anywhere, so the state can miss what
    /// the run changed.
    UnsavedState,
}

/// Volumes that a sandbox mounts can come from the platform, without
/// NemoClaw's label.
const KEEP_VOLUMES: &str = "without removing volumes, because those labeled nemoclaw.nvidia.com/uid and any volume a sandbox mounts hold deployments' data";

impl fmt::Display for OutOfSpace {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.writer {
            Writer::OpenTofu {
                operation,
                resource: Some(resource),
            } => write!(f, "OpenTofu {operation} of {resource}")?,
            Writer::OpenTofu {
                operation,
                resource: None,
            } => write!(f, "OpenTofu {operation}")?,
            Writer::NemoClaw { file } => write!(f, "NemoClaw's write of {file}")?,
        }
        f.write_str(" ran out of space in ")?;
        match &self.target {
            StorageTarget::DockerRoot { engine } => {
                write!(f, "the Docker root of engine {engine}")?;
            }
            StorageTarget::Volume { engine, volume } => {
                write!(f, "volume {volume} on engine {engine}")?;
            }
            StorageTarget::DeploymentState { directory } => {
                write!(f, "the deployment state directory {}", directory.display())?;
            }
        }
        if let Some(available) = self.available {
            write!(f, ", which has {} free", byte_count(available))?;
        }
        match (&self.target, self.kept) {
            (StorageTarget::DockerRoot { engine }, _) => write!(
                f,
                "; free space there {KEEP_VOLUMES}, then run the command again; `docker --host {engine} system df` shows what uses it"
            )?,
            (StorageTarget::Volume { .. }, _) => write!(
                f,
                "; free space in the engine's Docker root, where the local driver keeps the volume, {KEEP_VOLUMES}, then run the command again",
            )?,
            (StorageTarget::DeploymentState { .. }, Kept::ErroredState) => f.write_str(
                "; free space there, then restore errored.tfstate as OpenTofu's message below says before any other operation, because another apply first would fork the state",
            )?,
            (StorageTarget::DeploymentState { .. }, Kept::UnsavedState) => f.write_str(
                "; free space there, keeping every file in it, then run the same command again with the same configuration, as after an interrupted operation",
            )?,
            (StorageTarget::DeploymentState { .. }, _) => f.write_str(
                "; free space there, keeping every file in it, then run the command again",
            )?,
        }
        match (&self.target, self.kept, &self.writer) {
            (StorageTarget::Volume { .. }, Kept::Resources, _) => {
                f.write_str("; the volume keeps what was written to it; resources retained")?;
            }
            (_, Kept::Resources, _) => f.write_str("; resources retained")?,
            (_, Kept::State, Writer::NemoClaw { file }) => {
                write!(f, "; {file} is unchanged; state retained")?;
            }
            (_, Kept::State, _) => f.write_str("; state retained")?,
            (_, Kept::ErroredState, _) => {
                f.write_str("; OpenTofu kept the state it couldn't save in errored.tfstate")?;
            }
            (_, Kept::UnsavedState, _) => f.write_str(
                "; OpenTofu couldn't save the state, so it can miss what this run changed",
            )?,
        }
        write!(f, "\n{}", self.diagnostic)
    }
}

fn byte_count(bytes: u64) -> String {
    for (unit, divisor) in [("GiB", 1_u64 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)] {
        if bytes >= divisor {
            return format!("{:.1} {unit}", bytes as f64 / divisor as f64);
        }
    }
    format!("{bytes} B")
}
