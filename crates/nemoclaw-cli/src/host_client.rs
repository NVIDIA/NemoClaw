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
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        metadata.is_file()
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[tokio::test]
    async fn the_first_openshell_on_path_qualifies_only_for_its_own_version() {
        let (first, second) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        for (directory, version) in [(&first, "0.1.9"), (&second, "0.1.10")] {
            let client = directory.path().join("openshell");
            std::fs::write(&client, format!("#!/bin/sh\necho 'openshell {version}'\n")).unwrap();
            std::fs::set_permissions(&client, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let search_path = std::env::join_paths([first.path(), second.path()]).unwrap();
        let found = find(Some(&search_path)).unwrap();
        assert_eq!(found, first.path().join("openshell"));
        assert!(inspect("0.1.9", Some(found.clone())).await.compatible());
        let check = inspect("0.1.10", Some(found)).await;
        assert_eq!(check.detected.as_deref(), Some("0.1.9"));
        assert!(!check.compatible());
        assert!(!inspect("0.1.9", None).await.compatible());
    }
}
