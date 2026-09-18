// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use serde_json::{Value, json};
use std::{
    io,
    path::PathBuf,
    time::{SystemTime, UNIX_EPOCH},
};

/// Incremental local evidence. Callers must select nonsecret values before recording.
/// A completed report is successful only after an explicit `finish`.
pub struct Evidence {
    path: PathBuf,
    data: Value,
}

impl Evidence {
    pub fn new(path: PathBuf, mut data: Value) -> io::Result<Self> {
        if !data.is_object() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "evidence must be an object",
            ));
        }
        data["passed"] = json!(false);
        let evidence = Self { path, data };
        evidence.save()?;
        Ok(evidence)
    }

    pub fn record(&mut self, name: &str, value: impl serde::Serialize) -> io::Result<()> {
        if ["passed", "finishedEpoch"].contains(&name) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "completion fields are reserved",
            ));
        }
        self.data[name] = serde_json::to_value(value)?;
        self.save()
    }

    pub fn finish(mut self) -> io::Result<()> {
        self.data["passed"] = json!(true);
        self.data["finishedEpoch"] = json!(epoch());
        let result = self.save();
        if result.is_err() {
            self.data["passed"] = json!(false);
        }
        result
    }

    fn save(&self) -> io::Result<()> {
        // Stage beside the destination so interrupted writes preserve the last complete report.
        let parent = self.path.parent().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "evidence path needs a parent")
        })?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer_pretty(file.as_file_mut(), &self.data)?;
        file.persist(&self.path).map_err(|error| error.error)?;
        Ok(())
    }
}

impl Drop for Evidence {
    fn drop(&mut self) {
        self.data["finishedEpoch"] = json!(epoch());
        if self.save().is_err() {
            // Never panic again while unwinding the original test failure.
            eprintln!("could not finalize local E2E evidence");
        }
    }
}

fn epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
