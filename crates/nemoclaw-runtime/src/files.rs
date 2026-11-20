// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::Error;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    path::Path,
};
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), Error> {
    let parent = path.parent().ok_or(Error::State("invalid state path"))?;
    let mut file = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| write_failed(&error, "cannot create atomic state write"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| Error::State("cannot protect state file"))?;
    }
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|error| write_failed(&error, "cannot write and sync state file"))?;
    file.persist(path)
        .map_err(|error| write_failed(&error.error, "cannot commit state file"))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| write_failed(&error, "cannot sync state directory"))?;
    Ok(())
}

/// The error for a state write step that failed with `error`, keeping
/// whether its file system ran out of space.
fn write_failed(error: &std::io::Error, step: &'static str) -> Error {
    if error.kind() == std::io::ErrorKind::StorageFull {
        Error::StorageFull(step)
    } else {
        Error::State(step)
    }
}
pub fn save_json(path: &Path, value: &impl Serialize) -> Result<(), Error> {
    let mut bytes =
        serde_json::to_vec_pretty(value).map_err(|_| Error::State("cannot serialize state"))?;
    bytes.push(b'\n');
    atomic_write(path, &bytes)
}

pub fn hash_file(path: &Path) -> Result<String, Error> {
    let mut file =
        File::open(path).map_err(|_| Error::State("cannot open artifact for verification"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0_u8; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| Error::State("cannot read artifact for verification"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(hash.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod write_failure_tests {
    use super::*;

    #[test]
    fn a_full_file_system_is_kept_apart_from_other_write_failures() {
        let full = std::io::Error::from(std::io::ErrorKind::StorageFull);
        assert!(matches!(
            write_failed(&full, "cannot write and sync state file"),
            Error::StorageFull("cannot write and sync state file")
        ));
        assert_eq!(
            write_failed(&full, "cannot write and sync state file").to_string(),
            "cannot write and sync state file: no space left on device"
        );
        let denied = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        assert!(matches!(
            write_failed(&denied, "cannot write and sync state file"),
            Error::State("cannot write and sync state file")
        ));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn atomic_writes_are_private_to_their_owner() {
        let directory = tempfile::tempdir().unwrap();
        for (name, existing) in [("new.json", false), ("replaced.json", true)] {
            let path = directory.path().join(name);
            if existing {
                std::fs::write(&path, b"{}").unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
            }
            save_json(&path, &serde_json::json!({"private": true})).unwrap();
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "{name} is readable by others: {mode:o}");
        }
    }
}
