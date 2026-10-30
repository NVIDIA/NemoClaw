// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use std::path::{Path, PathBuf};

pub fn yaml_files(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(directory).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        if entry.file_type().unwrap().is_dir() {
            files.extend(yaml_files(&path));
        } else if path
            .extension()
            .is_some_and(|ext| ext == "yaml" || ext == "yml")
        {
            files.push(path);
        }
    }
    files.sort();
    files
}

/// A recipe directory can also contain Helm charts and monitoring YAML.
/// Those files are not NemoClaw configurations. `crates/nemoclaw-onboarding/build.rs`
/// uses this same `apiVersion` rule.
pub fn is_nemoclaw_config(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    String::from_utf8_lossy(&bytes).lines().any(|line| {
        let line = line.trim();
        line.starts_with("apiVersion:") && line.contains("nemoclaw.nvidia.com/")
    })
}

pub fn nemoclaw_config_files(directory: &Path) -> Vec<PathBuf> {
    yaml_files(directory)
        .into_iter()
        .filter(|path| is_nemoclaw_config(path))
        .collect()
}

#[test]
fn recipe_helm_charts_are_not_nemoclaw_examples() {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    let configs = nemoclaw_config_files(&directory);
    let relative = |path: &Path| {
        path.strip_prefix(&directory)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/")
    };
    let names: Vec<String> = configs.iter().map(|path| relative(path)).collect();
    assert!(
        names
            .iter()
            .any(|name| name == "kubernetes-gpu-autoscaling/hermes-vllm.yaml")
    );
    assert!(names.iter().all(|name| !name.ends_with("Chart.yaml")));
    assert!(names.iter().all(|name| !name.contains("/templates/")));
    assert!(names.iter().all(|name| !name.contains("/monitoring/")));
    assert!(yaml_files(&directory).len() > configs.len());
}
