// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::path::{Path, PathBuf};

#[derive(Debug)]
pub(crate) struct Check {
    pub required: String,
    pub path: Option<PathBuf>,
    pub detected: Option<String>,
}

impl Check {
    pub fn compatible(&self) -> bool {
        self.detected.as_deref() == Some(self.required.as_str())
    }
}

pub(crate) async fn inspect(required: &str, path: Option<PathBuf>) -> Check {
    let detected = if let Some(path) = &path {
        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            tokio::process::Command::new(path)
                .arg("--version")
                .kill_on_drop(true)
                .output(),
        )
        .await
        {
            Ok(Ok(output)) if output.status.success() => std::str::from_utf8(&output.stdout)
                .ok()
                .and_then(|text| text.trim().strip_prefix("openshell "))
                .filter(|version| !version.is_empty() && !version.contains(char::is_whitespace))
                .map(str::to_owned),
            _ => None,
        }
    } else {
        None
    };
    Check {
        required: required.to_owned(),
        path,
        detected,
    }
}

pub(crate) fn find(search_path: Option<&std::ffi::OsStr>) -> Option<PathBuf> {
    std::env::split_paths(search_path?)
        .map(|directory| {
            directory.join(if cfg!(windows) {
                "openshell.exe"
            } else {
                "openshell"
            })
        })
        .find(|path| executable(path))
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn release_pins_qualify_the_host_client_without_changing_other_installations() {
        let directory = tempfile::tempdir().unwrap();
        let client = directory.path().join("openshell");
        let script = "#!/bin/sh\nprintf 'openshell 0.1.9\\n'\n";
        std::fs::write(&client, script).unwrap();
        std::fs::set_permissions(&client, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Two release fixtures share a qualified client; a later fixture changes its pin.
        for (required, accepted) in [("0.1.9", true), ("0.1.9", true), ("0.1.10", false)] {
            let check = inspect(required, Some(client.clone())).await;
            assert_eq!(check.compatible(), accepted, "{check:?}");
            assert_eq!(check.detected.as_deref(), Some("0.1.9"));
            assert_eq!(std::fs::read_to_string(&client).unwrap(), script);
        }
        assert!(!inspect("0.1.9", None).await.compatible());
        let other = tempfile::tempdir().unwrap();
        let other_client = other.path().join("openshell");
        let other_script = script.replace("0.1.9", "0.1.10");
        std::fs::write(&other_client, &other_script).unwrap();
        std::fs::set_permissions(&other_client, std::fs::Permissions::from_mode(0o755)).unwrap();
        for (required, directories, expected) in [
            ("0.1.9", [directory.path(), other.path()], &client),
            ("0.1.10", [other.path(), directory.path()], &other_client),
        ] {
            let search_path = std::env::join_paths(directories).unwrap();
            let selected = find(Some(&search_path)).unwrap();
            assert_eq!(&selected, expected);
            assert!(inspect(required, Some(selected)).await.compatible());
        }
        assert_eq!(std::fs::read_to_string(client).unwrap(), script);
        assert_eq!(std::fs::read_to_string(other_client).unwrap(), other_script);
    }
}
