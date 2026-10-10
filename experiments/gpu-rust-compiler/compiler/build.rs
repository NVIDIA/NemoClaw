// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{env, path::PathBuf, process::Command};

fn main() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .unwrap()
        .to_owned();
    let source = root.join("native/metal_bridge.mm");
    let header = root.join("native/metal_bridge.h");
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed={}", header.display());
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    let library = out.join("libgpulab_metal.dylib");
    let status = Command::new("xcrun")
        .args(["clang++", "-std=c++17", "-O3", "-fobjc-arc", "-dynamiclib"])
        .arg(&source)
        .args([
            "-framework",
            "Metal",
            "-framework",
            "Foundation",
            "-Wl,-install_name,@rpath/libgpulab_metal.dylib",
            "-o",
        ])
        .arg(&library)
        .status()
        .expect("Could not launch the Xcode C++ compiler");
    assert!(status.success(), "Native Metal adapter compilation failed");
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=dylib=gpulab_metal");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", out.display());
    let codegen_source = root.join("native/codegen_metal.mm");
    for file in [
        &codegen_source,
        &root.join("native/codegen_bridge.h"),
        &root.join("native/codegen.metal"),
    ] {
        println!("cargo:rerun-if-changed={}", file.display());
    }
    let codegen_library = out.join("libgpuemit_metal.dylib");
    let status = Command::new("xcrun")
        .args([
            "clang++",
            "-std=c++17",
            "-O3",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-fobjc-arc",
            "-dynamiclib",
        ])
        .arg(codegen_source)
        .args(["-framework", "Metal", "-framework", "Foundation", "-o"])
        .arg(&codegen_library)
        .status()
        .expect("Could not build Metal machine-code adapter");
    assert!(
        status.success(),
        "Metal machine-code adapter compilation failed"
    );
    println!(
        "cargo:rustc-env=GPUEMIT_METAL_LIBRARY={}",
        codegen_library.display()
    );
}
