// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Owned OpenTofu workspaces for explicitly selected test executables.

use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};
use tempfile::TempDir;

pub struct TofuWorkspace {
    directory: TempDir,
    tofu: PathBuf,
}

impl TofuWorkspace {
    /// A workspace whose OpenTofu uses `provider` and, beside it, the
    /// `openshell` and `fabric` providers built with it.
    pub fn new(tofu: impl AsRef<Path>, provider: impl AsRef<Path>) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let provider = provider.as_ref();
        fs::copy(
            provider,
            directory.path().join(nemoclaw_sdk::bundle::executable(
                "terraform-provider-nemoclaw",
            )),
        )
        .unwrap();
        for name in ["openshell", "fabric"] {
            let binary = nemoclaw_sdk::bundle::executable(&format!("terraform-provider-{name}"));
            let sibling = provider.with_file_name(&binary);
            if sibling.exists() {
                fs::copy(sibling, directory.path().join(binary)).unwrap();
            }
        }
        let path = serde_json::to_string(directory.path()).unwrap();
        let overrides = ["nemoclaw", "openshell", "fabric"]
            .map(|name| format!("\"registry.opentofu.org/nvidia/{name}\" = {path}"))
            .join(" ");
        fs::write(
            directory.path().join("tofu.rc"),
            format!("provider_installation {{ dev_overrides {{ {overrides} }} direct {{}} }}"),
        )
        .unwrap();
        Self {
            directory,
            tofu: tofu.as_ref().to_owned(),
        }
    }

    pub fn path(&self) -> &Path {
        self.directory.path()
    }

    pub fn command(&self) -> Command {
        let mut command = Command::new(&self.tofu);
        command
            .current_dir(self.path())
            .env("TF_CLI_CONFIG_FILE", self.path().join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1");
        command
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn stages_only_the_selected_provider_and_cleans_only_its_workspace() {
        let sources = tempfile::tempdir().unwrap();
        let mut workspaces = Vec::new();
        for selected in ["production", "fixture"] {
            let provider = sources.path().join(selected);
            let script = format!("#!/bin/sh\nprintf '%s' '{selected}'\n");
            fs::write(&provider, &script).unwrap();
            let workspace = TofuWorkspace::new("/bin/sh", &provider);
            let staged = workspace.path().join(nemoclaw_sdk::bundle::executable(
                "terraform-provider-nemoclaw",
            ));
            let output = Command::new("/bin/sh").arg(&staged).output().unwrap();
            assert!(output.status.success());
            assert_eq!(output.stdout, selected.as_bytes());
            assert_eq!(fs::read_to_string(&provider).unwrap(), script);
            let config = fs::read_to_string(workspace.path().join("tofu.rc")).unwrap();
            assert!(config.contains("registry.opentofu.org/nvidia/nemoclaw"));
            assert!(config.contains(&serde_json::to_string(workspace.path()).unwrap()));
            workspaces.push(workspace);
        }
        assert_ne!(workspaces[0].path(), workspaces[1].path());
        let removed = workspaces.pop().unwrap();
        let path = removed.path().to_owned();
        drop(removed);
        assert!(!path.exists());
        assert!(workspaces[0].path().exists());
        assert!(sources.path().join("fixture").exists());
    }

    #[test]
    fn command_preserves_failure_output_and_allows_scenario_environment() {
        let sources = tempfile::tempdir().unwrap();
        let provider = sources.path().join("provider");
        fs::write(&provider, b"explicit provider").unwrap();
        let workspace = TofuWorkspace::new("/bin/sh", provider);
        let output = workspace.command()
            .args(["-c", r#"pwd -P; printf '%s\n' "$TF_CLI_CONFIG_FILE" "$TF_IN_AUTOMATION" "$CHECKPOINT_DISABLE" "$SCENARIO_VALUE"; printf 'expected failure' >&2; exit 23"#])
            .env("SCENARIO_VALUE", "literal scenario value")
            .output().unwrap();
        let working_directory = workspace.path().canonicalize().unwrap();
        assert_eq!(output.status.code(), Some(23));
        assert_eq!(output.stderr, b"expected failure");
        assert_eq!(
            String::from_utf8(output.stdout)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            [
                working_directory.to_str().unwrap(),
                workspace.path().join("tofu.rc").to_str().unwrap(),
                "1",
                "1",
                "literal scenario value",
            ]
        );
    }
}
