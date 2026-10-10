// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[cfg(target_os = "macos")]
#[test]
fn a_failed_receipt_write_does_not_publish_a_gpu_object() {
    use std::{
        fs,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };
    let root = std::env::temp_dir().join(format!(
        "gpu-object-publication-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&root).unwrap();
    let mut packet = b"GEM1".to_vec();
    let triple = b"aarch64-apple-darwin";
    packet.extend_from_slice(&(triple.len() as u32).to_le_bytes());
    packet.extend_from_slice(triple);
    packet.extend_from_slice(&1u32.to_le_bytes());
    let name = b"gpu_publication_probe";
    packet.extend_from_slice(&(name.len() as u32).to_le_bytes());
    packet.extend_from_slice(name);
    for field in [0u32, 0, 1, 2] {
        packet.extend_from_slice(&field.to_le_bytes());
    }
    for (op, result, a, imm) in [(1u32, 0u32, 0u32, 42i64), (6, u32::MAX, 0, 0)] {
        for field in [op, result, a, 0] {
            packet.extend_from_slice(&field.to_le_bytes());
        }
        packet.extend_from_slice(&imm.to_le_bytes());
    }
    let input = root.join("input.gem");
    let output = root.join("leaf.o");
    let report = root.join("missing/report.json");
    fs::write(&input, packet).unwrap();
    let shader = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join("native/codegen.metal");
    let result = Command::new(env!("CARGO_BIN_EXE_gpu-emit-module"))
        .arg("--input")
        .arg(input)
        .arg("--output")
        .arg(&output)
        .args([
            "--backend",
            "metal",
            "--library",
            env!("GPUEMIT_METAL_LIBRARY"),
        ])
        .arg("--shader")
        .arg(shader)
        .arg("--report")
        .arg(&report)
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(
        !output.exists(),
        "failed GPU emission published an unqualified native object: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!report.exists());
    fs::remove_dir_all(root).unwrap();
}
