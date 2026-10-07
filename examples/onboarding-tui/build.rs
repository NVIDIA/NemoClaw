// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Generate one onboarding journey test per repository example.

use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn visit(directory: &Path, files: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            // Rebuild when an example directory gains or loses a file.
            println!("cargo:rerun-if-changed={}", path.display());
            visit(&path, files);
        } else if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("yaml" | "yml")
        ) {
            files.push(path);
        }
    }
}

fn main() {
    let root = Path::new(&env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("..");
    println!("cargo:rerun-if-changed={}", root.display());
    let mut files = Vec::new();
    visit(&root, &mut files);
    files.sort();
    let mut tests = String::new();
    for path in files {
        let relative = path
            .strip_prefix(&root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        let name: String = relative
            .trim_end_matches(".yaml")
            .trim_end_matches(".yml")
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();
        tests.push_str(&format!(
            "#[test]\nfn {name}() {{\n    super::example_reaches_review({relative:?});\n}}\n"
        ));
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("example_journeys.rs");
    fs::write(output, tests).unwrap();
}
