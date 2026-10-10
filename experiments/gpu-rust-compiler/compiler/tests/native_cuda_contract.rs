// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn requested_cuda_reports_unavailable_hardware_without_cpu_output() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let directory = std::env::temp_dir().join(format!(
        "native-cuda-contract-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&directory).unwrap();
    let source = directory.join("source.rs");
    let output = directory.join("program");
    fs::write(&source, "fn main()->i64 { return 19; }").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_gpu-rust-compiler"))
        .arg(&source)
        .args([
            "--backend",
            "cuda",
            "--cuda-algorithm",
            "sparse",
            "--cuda-library",
        ])
        .arg(directory.join("unavailable-cuda-library.so"))
        .arg("--output")
        .arg(&output)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        !output.exists(),
        "Unavailable CUDA must not emit a CPU fallback executable"
    );
    let error = String::from_utf8_lossy(&result.stderr);
    assert!(
        error.contains("CUDA"),
        "Missing CUDA availability diagnostic: {error}"
    );
    assert!(
        !error.contains("Unsupported native backend"),
        "The native compiler has no CUDA adapter: {error}"
    );
    fs::remove_dir_all(directory).unwrap();
}
