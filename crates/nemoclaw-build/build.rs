// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(feature = "sdk")]
#[path = "src/source.rs"]
mod source;

#[cfg(feature = "sdk")]
fn main() {
    let root =
        std::path::PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    for name in source::SOURCE_ROOTS {
        println!("cargo:rerun-if-changed={}", root.join(name).display());
    }
    let files = source::source_inputs(&root).expect("build tool source inputs");
    println!(
        "cargo:rustc-env=NEMOCLAW_BUILD_SOURCE_VERSION={}",
        source::source_version(&files)
    );
}

#[cfg(not(feature = "sdk"))]
fn main() {}
