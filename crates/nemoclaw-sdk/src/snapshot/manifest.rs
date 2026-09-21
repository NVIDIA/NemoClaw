// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{File, Manifest, VerifiedFile, failure, safe_path};
use crate::Error;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path};

pub const MANIFEST_FILE: &str = ".nemoclaw-manifest.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelFile {
    #[serde(flatten)]
    pub file: File,
    /// Modification time after checksum verification; absent for unfinished files.
    pub modified: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Expected model files and download progress, stored together in the model directory.
pub struct ModelManifest {
    pub version: u8,
    pub repository: String,
    pub revision: String,
    pub files: Vec<ModelFile>,
}

impl ModelManifest {
    pub fn new(snapshot: &Manifest) -> Self {
        Self {
            version: 1,
            repository: snapshot.repository.clone(),
            revision: snapshot.revision.clone(),
            files: snapshot
                .files
                .iter()
                .cloned()
                .map(|file| ModelFile {
                    file,
                    modified: None,
                })
                .collect(),
        }
    }

    /// Immutable identity excludes verification progress.
    pub fn snapshot(&self) -> Manifest {
        Manifest {
            repository: self.repository.clone(),
            revision: self.revision.clone(),
            files: self.files.iter().map(|entry| entry.file.clone()).collect(),
        }
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, Error> {
        if bytes.len() > 4 << 20 {
            return Err(failure("model manifest exceeds size limit"));
        }
        let manifest: Self = serde_json::from_slice(bytes)
            .map_err(|_| failure("invalid or unsupported model manifest"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    fn validate(&self) -> Result<(), Error> {
        if self.version != 1 {
            return Err(failure("unsupported model manifest version"));
        }
        self.snapshot().validate()
    }

    pub fn validate_for(&self, expected: &Manifest) -> Result<(), Error> {
        self.validate()?;
        if self.snapshot() != *expected {
            return Err(failure("model manifest conflicts with pinned snapshot"));
        }
        Ok(())
    }

    pub fn verified_files(&self) -> Result<Vec<VerifiedFile>, Error> {
        self.validate()?;
        self.files
            .iter()
            .map(|entry| {
                Ok(VerifiedFile {
                    file: entry.file.clone(),
                    modified: entry
                        .modified
                        .ok_or(failure("model download is incomplete"))?,
                })
            })
            .collect()
    }

    pub fn read(directory: &Path) -> Result<Option<Self>, Error> {
        match fs::symlink_metadata(directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            _ => {}
        }
        let path = safe_path(directory, MANIFEST_FILE, false)?;
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && metadata.len() <= 4 << 20 => {
                Self::decode(&fs::read(path).map_err(|_| failure("cannot read model manifest"))?)
                    .map(Some)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            _ => Err(failure("model manifest is unobservable or invalid")),
        }
    }
}
