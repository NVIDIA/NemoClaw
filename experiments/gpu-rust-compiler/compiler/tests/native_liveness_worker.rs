// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn persistent_native_worker_replaces_facts_and_recovers_from_errors_without_cuda_fallback() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root = std::env::temp_dir().join(format!("native-worker-{}-{nonce}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let input = root.join("input.bin");
    let output = root.join("output.bin");
    let broken = root.join("broken.bin");
    let words = [
        1u32, 2, 4, 2, 2, 2, 0, 2, 0, 2, 0, 0, 2, 0, 2, 1, 0, 1, 2, 1, 0, 1, 0, 2, 8, 2, 0, 0, 0,
        4, 16, 0, 0,
    ];
    let mut bytes = b"GLC1".to_vec();
    bytes.extend(words.iter().flat_map(|word| word.to_le_bytes()));
    fs::write(&input, &bytes).unwrap();
    fs::write(&broken, b"GLC1").unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_gpu-native-benchmark"))
        .args(["--serve", "--threads", "2"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let mut request = |id: &str, backend: &str, source: &std::path::Path, residency: &str| {
        writeln!(
            stdin,
            "{id}\t{backend}\tdense\t{}\t{}\t{residency}\tserial",
            source.display(),
            output.display()
        )
        .unwrap();
        stdin.flush().unwrap();
        let mut response = String::new();
        stdout.read_line(&mut response).unwrap();
        response
    };
    let first = request("1", "cpu", &input, "update");
    assert!(first.contains("\"status\":\"ok\""), "{first}");
    assert!(first.contains("\"cuda_context_creations\":0"), "{first}");
    let mut expected = b"GLR1".to_vec();
    expected.extend(
        [4u32, 5, 24, 7, 24]
            .iter()
            .flat_map(|word| word.to_le_bytes()),
    );
    assert_eq!(fs::read(&output).unwrap(), expected);
    let malformed = request("2", "cpu", &broken, "update");
    assert!(malformed.contains("\"status\":\"error\""), "{malformed}");
    let unavailable = request("3", "cuda", &input, "update");
    assert!(
        unavailable.contains("\"status\":\"error\""),
        "{unavailable}"
    );
    assert!(
        unavailable.contains("CUDA library was not specified"),
        "{unavailable}"
    );
    let recovered = request("4", "cpu", &input, "resident");
    assert!(recovered.contains("\"status\":\"ok\""), "{recovered}");
    // All twelve bitset words (USE/DEF/PHIOUT) become zero. The prior live-in
    // facts must disappear rather than becoming an incorrect cached solution.
    let mut cleared = bytes.clone();
    let facts_begin = cleared.len() - 12 * 4;
    cleared[facts_begin..].fill(0);
    fs::write(&input, cleared).unwrap();
    let stale = request("5", "cpu", &input, "resident");
    assert!(stale.contains("\"status\":\"error\""), "{stale}");
    let changed = request("6", "cpu", &input, "update");
    assert!(changed.contains("\"status\":\"ok\""), "{changed}");
    let result = fs::read(&output).unwrap();
    assert_eq!(&result[8..], &[0; 16]);
    writeln!(stdin, "quit").unwrap();
    drop(stdin);
    assert!(child.wait().unwrap().success());
    fs::remove_dir_all(root).unwrap();
}
