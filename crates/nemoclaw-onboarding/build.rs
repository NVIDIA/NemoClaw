// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Generate one onboarding journey test per NemoClaw configuration example.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn visit(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        // Local recipe state, such as v1/.local, is not a repository example.
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with('.'))
        {
            continue;
        }
        if path.is_dir() {
            // Rebuild when an example directory gains or loses a file.
            println!("cargo:rerun-if-changed={}", path.display());
            visit(&path, files);
        } else if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("yaml" | "yml")
        ) {
            println!("cargo:rerun-if-changed={}", path.display());
            files.push(path);
        }
    }
}

/// A recipe directory can also contain Helm charts and monitoring YAML.
/// Those files are not onboarding configurations.
fn nemoclaw_config(path: &Path) -> bool {
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    String::from_utf8_lossy(&bytes).lines().any(|line| {
        let line = line.trim();
        line.starts_with("apiVersion:") && line.contains("nemoclaw.nvidia.com/")
    })
}

/// Journey names must stay snake_case. `Chart.yaml` would otherwise compile as
/// `Chart`, which `clippy -D warnings` rejects.
fn journey_name(relative: &str) -> String {
    let stem = relative.trim_end_matches(".yaml").trim_end_matches(".yml");
    let mut name = String::new();
    let mut underscore = false;
    for character in stem.chars() {
        if character.is_ascii_alphanumeric() {
            name.push(character.to_ascii_lowercase());
            underscore = false;
        } else if !underscore {
            name.push('_');
            underscore = true;
        }
    }
    let name = name.trim_matches('_');
    if name.is_empty() || name.starts_with(|character: char| character.is_ascii_digit()) {
        format!("example_{name}")
    } else {
        name.to_string()
    }
}

fn main() {
    let root = Path::new(&env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../examples");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    visit(&root, &mut files);
    files.sort();
    let mut tests = String::new();
    for path in files {
        if !nemoclaw_config(&path) {
            continue;
        }
        let relative = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let name = journey_name(&relative);
        tests.push_str(&format!(
            "#[test]\nfn {name}() {{\n    super::example_reaches_review({relative:?});\n}}\n"
        ));
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("example_journeys.rs");
    fs::write(output, tests).unwrap();
}
