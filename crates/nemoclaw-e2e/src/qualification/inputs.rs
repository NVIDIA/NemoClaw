// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{io, path::PathBuf};

/// Explicit caller-owned inputs. Loading these never creates or cleans up a deployment.
pub struct LiveInputs {
    pub config: PathBuf,
    pub state: PathBuf,
    pub bundle: PathBuf,
}

impl LiveInputs {
    pub fn from_env(config: &str, state: &str) -> io::Result<Self> {
        Ok(Self {
            config: explicit_path(config)?,
            state: explicit_path(state)?,
            bundle: explicit_path("NEMOCLAW_TEST_BUNDLE")?,
        })
    }
}

fn explicit_path(name: &str) -> io::Result<PathBuf> {
    let path = std::env::var_os(name).map(PathBuf::from).ok_or_else(|| {
        io::Error::new(io::ErrorKind::InvalidInput, format!("{name} must be set"))
    })?;
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{name} must be absolute"),
        ));
    }
    Ok(path)
}
