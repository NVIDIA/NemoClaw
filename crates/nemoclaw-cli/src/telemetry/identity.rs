// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The install ID file, `telemetry.json`, in the user configuration directory:
//! a random install ID and the version of the last run that sent a record.

use super::record::{INSTALL_ID_PATTERN, matches};
use serde::{Deserialize, Serialize};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

const FILE: &str = "telemetry.json";
const UNKNOWN: &str = "unknown";
const NONE: &str = "none";

/// The record's `installId`, `firstRun`, and `previousVersion`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Identity {
    pub install_id: String,
    pub first_run: bool,
    pub previous_version: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Stored {
    install_id: String,
    #[serde(default)]
    last_version: String,
}

/// The `nemoclaw` directory under the operating system's user configuration
/// directory, or `None` when it cannot be found.
pub fn directory() -> Option<PathBuf> {
    let var = |name| {
        std::env::var_os(name)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    let base = if cfg!(target_os = "macos") {
        var("HOME")?.join("Library").join("Application Support")
    } else if cfg!(windows) {
        var("APPDATA")?
    } else {
        var("XDG_CONFIG_HOME").or_else(|| Some(var("HOME")?.join(".config")))?
    };
    Some(base.join("nemoclaw"))
}

/// Reads the install ID file in `directory`, or creates it with a new install
/// ID, and records `version` as the last version that sent. Call it only when
/// a record will be sent.
pub fn load(directory: Option<&Path>, version: &str) -> Identity {
    let unknown = Identity {
        install_id: UNKNOWN.into(),
        first_run: false,
        previous_version: NONE.into(),
    };
    let Some(directory) = directory else {
        return unknown;
    };
    let path = directory.join(FILE);
    let found = read(&path);
    if let Ok(Some(stored)) = found {
        return seen(directory, &path, stored, version);
    }
    let Some(install_id) = new_install_id() else {
        return unknown;
    };
    let stored = Stored {
        install_id,
        last_version: version.into(),
    };
    // Create a missing file only if it is still missing, so two first runs at
    // the same moment keep one install ID. An invalid file is replaced.
    let missing = matches!(&found, Err(error) if error.kind() == ErrorKind::NotFound);
    match write(directory, &path, &stored, !missing) {
        Ok(()) => Identity {
            install_id: stored.install_id,
            first_run: true,
            previous_version: NONE.into(),
        },
        // Another run created the file first: use its install ID.
        Err(_) if missing => match read(&path) {
            Ok(Some(stored)) => seen(directory, &path, stored, version),
            _ => unknown,
        },
        // A new ID that cannot be kept would count this install again next run.
        Err(_) => unknown,
    }
}

/// The identity from a valid stored file, which then records `version`.
fn seen(directory: &Path, path: &Path, stored: Stored, version: &str) -> Identity {
    let identity = Identity {
        install_id: stored.install_id.clone(),
        first_run: false,
        previous_version: previous(&stored.last_version, version),
    };
    if stored.last_version != version {
        let stored = Stored {
            install_id: stored.install_id,
            last_version: version.into(),
        };
        let _ = write(directory, path, &stored, true);
    }
    identity
}

/// The stored file, `Ok(None)` when it exists but is not valid.
fn read(path: &Path) -> std::io::Result<Option<Stored>> {
    let bytes = std::fs::read(path)?;
    Ok(serde_json::from_slice::<Stored>(&bytes)
        .ok()
        .filter(|stored| {
            stored.install_id != UNKNOWN && matches(INSTALL_ID_PATTERN, &stored.install_id)
        }))
}

fn previous(last: &str, version: &str) -> String {
    match last {
        _ if last == version => NONE.into(),
        "" => NONE.into(),
        _ if last.chars().count() > 128 => UNKNOWN.into(),
        _ => last.into(),
    }
}

/// Writes the whole file or nothing, so a reader never sees half of it. With
/// `replace` false, fails if the file already exists.
fn write(directory: &Path, path: &Path, stored: &Stored, replace: bool) -> std::io::Result<()> {
    std::fs::create_dir_all(directory)?;
    let mut file = tempfile::NamedTempFile::new_in(directory)?;
    file.write_all(&serde_json::to_vec(stored)?)?;
    if replace {
        file.persist(path)?;
    } else {
        file.persist_noclobber(path)?;
    }
    Ok(())
}

/// A lowercase random UUID (v4), not derived from the machine.
fn new_install_id() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_runs_share_one_install_id_and_only_the_first_is_first() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("nemoclaw");
        let first = load(Some(&directory), "1.0.0-412");
        let second = load(Some(&directory), "1.0.0-412");
        assert!(matches(INSTALL_ID_PATTERN, &first.install_id));
        assert_ne!(first.install_id, UNKNOWN);
        assert!(first.first_run);
        assert_eq!(first.previous_version, NONE);
        assert_eq!(second.install_id, first.install_id);
        assert!(!second.first_run);
        assert_eq!(second.previous_version, NONE);
    }

    #[test]
    fn a_version_change_sets_previous_version_once() {
        let home = tempfile::tempdir().unwrap();
        let first = load(Some(home.path()), "1.0.0-412");
        let upgraded = load(Some(home.path()), "1.1.0-500");
        let again = load(Some(home.path()), "1.1.0-500");
        assert_eq!(upgraded.install_id, first.install_id);
        assert_eq!(upgraded.previous_version, "1.0.0-412");
        assert_eq!(again.previous_version, NONE);
    }

    #[test]
    fn a_missing_or_invalid_file_gets_a_new_install_id() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join(FILE);
        for content in [
            "not json",
            r#"{"installId":"unknown"}"#,
            r#"{"installId":"ABC"}"#,
        ] {
            std::fs::write(&path, content).unwrap();
            let identity = load(Some(home.path()), "1.0.0");
            assert!(identity.first_run, "{content}");
            assert_ne!(identity.install_id, UNKNOWN);
        }
        let kept = r#"{"installId":"0f8fad5b-d9cb-469f-a165-70867728950e"}"#;
        std::fs::write(&path, kept).unwrap();
        let identity = load(Some(home.path()), "1.0.0");
        assert_eq!(identity.install_id, "0f8fad5b-d9cb-469f-a165-70867728950e");
        assert!(!identity.first_run);
        assert_eq!(identity.previous_version, NONE);
    }

    #[test]
    fn an_unwritable_directory_sends_unknown() {
        let home = tempfile::tempdir().unwrap();
        let blocker = home.path().join("file");
        std::fs::write(&blocker, "").unwrap();
        for directory in [None, Some(blocker.join("nemoclaw"))] {
            let identity = load(directory.as_deref(), "1.0.0");
            assert_eq!(identity.install_id, UNKNOWN);
            assert!(!identity.first_run);
            assert_eq!(identity.previous_version, NONE);
        }
    }

    #[test]
    fn first_runs_at_the_same_moment_keep_one_install_id() {
        let home = tempfile::tempdir().unwrap();
        let directory = home.path().join("nemoclaw");
        let runs: Vec<Identity> = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| scope.spawn(|| load(Some(&directory), "1.0.0")))
                .collect();
            handles.into_iter().map(|run| run.join().unwrap()).collect()
        });
        let stored = read(&directory.join(FILE)).unwrap().unwrap();
        for run in &runs {
            assert_eq!(run.install_id, stored.install_id);
        }
        assert_eq!(runs.iter().filter(|run| run.first_run).count(), 1);
    }

    #[test]
    fn install_ids_are_random_v4() {
        let one = new_install_id().unwrap();
        assert!(matches(INSTALL_ID_PATTERN, &one));
        assert_ne!(one, new_install_id().unwrap());
    }

    #[test]
    fn an_overlong_last_version_is_unknown() {
        assert_eq!(previous(&"9".repeat(129), "1.0.0"), UNKNOWN);
        assert_eq!(previous("", "1.0.0"), NONE);
    }
}
