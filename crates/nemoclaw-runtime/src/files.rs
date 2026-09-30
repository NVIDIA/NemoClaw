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
        .map_err(|_| Error::State("cannot create atomic state write"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| Error::State("cannot protect state file"))?;
    }
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| Error::State("cannot write and sync state file"))?;
    file.persist(path)
        .map_err(|_| Error::State("cannot commit state file"))?;
    #[cfg(unix)]
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::State("cannot sync state directory"))?;
    Ok(())
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
