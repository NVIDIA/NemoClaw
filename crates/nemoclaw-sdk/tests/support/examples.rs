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
        } else if path.extension().is_some_and(|ext| ext == "yaml") {
            files.push(path);
        }
    }
    files.sort();
    files
}
