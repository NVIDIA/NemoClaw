// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::Error;
use std::path::Path;

/// The key a platform supplied through [`crate::INFERENCE_KEY_ENV`], if any: a
/// bearer token of 16 to 4096 printable characters without whitespace. Errors
/// never include the value.
pub(crate) fn supplied(value: Option<std::ffi::OsString>) -> Result<Option<String>, Error> {
    let Some(value) = value else {
        return Ok(None);
    };
    let key = value.into_string().map_err(|_| {
        Error::State("the supplied inference key must be printable text without whitespace")
    })?;
    if !(16..=4096).contains(&key.len()) || !key.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(Error::State(
            "the supplied inference key must be 16 to 4096 printable characters without whitespace",
        ));
    }
    Ok(Some(key))
}

// The caller holds the volume writer lock throughout initialization and use.
// Publish the key before the marker: a crash may recover that exact key, never
// silently generate a replacement for an initialized volume.
pub(crate) fn load(root: &Path) -> Result<String, Error> {
    use std::{
        fs,
        io::{Read, Write},
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    let failure = |_| Error::State("managed inference credential is unobservable or invalid");
    let path = root.join("inference-key");
    let marker = root.join("inference-key-initialized");
    match fs::symlink_metadata(&path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if !matches!(fs::symlink_metadata(&marker), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
            {
                return Err(Error::State(
                    "initialized inference credential is missing; storage retained",
                ));
            }
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes)
                .map_err(|_| Error::State("cannot generate inference credential"))?;
            let key: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&path)
                .map_err(failure)?;
            file.write_all(key.as_bytes())
                .and_then(|()| file.sync_all())
                .map_err(failure)?;
            fs::File::open(root)
                .and_then(|f| f.sync_all())
                .map_err(failure)?;
        }
        Err(error) => return Err(failure(error)),
    }
    let file = fs::File::from(
        rustix::fs::open(
            &path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK,
            rustix::fs::Mode::empty(),
        )
        .map_err(|_| Error::State("cannot open inference credential"))?,
    );
    let meta = file.metadata().map_err(failure)?;
    // Docker's service runs as root; never accept a key writable by a model tool.
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.len() != 64
        || meta.mode() & 0o7777 != 0o600
        || meta.uid() != rustix::process::geteuid().as_raw()
    {
        return Err(Error::State("invalid inference credential metadata"));
    }
    let mut key = String::new();
    file.take(65).read_to_string(&mut key).map_err(failure)?;
    if key.len() != 64
        || !key
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(Error::State("invalid inference credential bytes"));
    }
    match fs::symlink_metadata(&marker) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&marker)
                .map_err(failure)?;
            file.write_all(b"v1\n")
                .and_then(|()| file.sync_all())
                .map_err(failure)?;
            fs::File::open(root)
                .and_then(|f| f.sync_all())
                .map_err(failure)?;
        }
        Ok(meta)
            if meta.is_file()
                && meta.nlink() == 1
                && meta.len() == 3
                && meta.mode() & 0o7777 == 0o600 => {}
        _ => {
            return Err(Error::State(
                "invalid inference credential initialization marker",
            ));
        }
    }
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        os::unix::fs::{PermissionsExt, symlink},
    };

    #[test]
    fn credential_survives_restart_and_missing_initialized_key_is_rejected() {
        let root = tempfile::tempdir().unwrap();
        let first = load(root.path()).unwrap();
        assert_eq!(first.len(), 64);
        assert!(
            first
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        );
        assert_eq!(first, load(root.path()).unwrap());
        let path = root.path().join("inference-key");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_file(path).unwrap();
        assert!(load(root.path()).is_err());
    }

    #[test]
    fn credential_loading_rejects_symlinks_hardlinks_and_readable_or_corrupt_keys() {
        for corrupt in ["symlink", "hardlink", "permissions", "length", "contents"] {
            let root = tempfile::tempdir().unwrap();
            load(root.path()).unwrap();
            let path = root.path().join("inference-key");
            match corrupt {
                "symlink" => {
                    fs::rename(&path, root.path().join("target")).unwrap();
                    symlink("target", &path).unwrap();
                }
                "hardlink" => fs::hard_link(&path, root.path().join("alias")).unwrap(),
                "permissions" => {
                    fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap()
                }
                "length" => fs::write(&path, "short").unwrap(),
                "contents" => fs::write(&path, "z".repeat(64)).unwrap(),
                _ => unreachable!(),
            }
            assert!(load(root.path()).is_err(), "{corrupt}");
        }
    }

    #[test]
    fn a_supplied_key_is_used_only_when_it_is_a_usable_token() {
        use std::ffi::OsString;
        assert_eq!(supplied(None).unwrap(), None);
        let key = "sk-0123456789abcdef0123456789abcdef";
        assert_eq!(
            supplied(Some(OsString::from(key))).unwrap().as_deref(),
            Some(key)
        );
        for invalid in [
            "",
            "too-short",
            "has a space 0123456789",
            "tab\t0123456789abcdef",
            "line\n0123456789abcdef",
        ] {
            let error = supplied(Some(OsString::from(invalid)))
                .unwrap_err()
                .to_string();
            assert!(
                !invalid.is_empty() && !error.contains(invalid) || invalid.is_empty(),
                "{error}"
            );
        }
    }
}
