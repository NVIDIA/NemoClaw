// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use std::{
    fs,
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[test]
fn cpu_workpack_cli_emits_verified_results_and_repeated_variant_timings() {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let root =
        std::env::temp_dir().join(format!("gpu-cpu-liveness-{}-{nonce}", std::process::id()));
    fs::create_dir(&root).unwrap();
    let input = root.join("input.bin");
    let output = root.join("output.bin");
    let words: Vec<u32> = vec![
        1, 2, 4, 2, 2, 2, 0, 2, 0, 2, 0, 0, 2, 0, 2, 1, 0, 1, 2, 1, 0, 1, 0, 2, 8, 2, 0, 0, 0, 4,
        16, 0, 0,
    ];
    let mut bytes = b"GLC1".to_vec();
    bytes.extend(words.iter().flat_map(|word| word.to_le_bytes()));
    fs::write(&input, bytes).unwrap();
    let run = Command::new(env!("CARGO_BIN_EXE_gpu-cpu-liveness"))
        .args([input.as_os_str(), output.as_os_str(), "2".as_ref()])
        .output()
        .unwrap();
    assert!(
        run.status.success(),
        "{}",
        String::from_utf8_lossy(&run.stderr)
    );
    let report = String::from_utf8(run.stdout).unwrap();
    for field in [
        "\"backend\":\"cpu-native\"",
        "\"repeat_outputs_equal\":true",
        "\"serial\"",
        "\"function_parallel\"",
        "\"word_parallel\"",
        "\"samples_ms\"",
    ] {
        assert!(report.contains(field), "Missing {field}: {report}");
    }
    let result = fs::read(&output).unwrap();
    let mut expected = b"GLR1".to_vec();
    expected.extend(
        [4u32, 5, 24, 7, 24]
            .iter()
            .flat_map(|word| word.to_le_bytes()),
    );
    assert_eq!(result, expected);
    for repeats in ["0", "10001", "-1", "bad"] {
        let rejected = root.join(format!("rejected-{repeats}.bin"));
        let run = Command::new(env!("CARGO_BIN_EXE_gpu-cpu-liveness"))
            .args([input.as_os_str(), rejected.as_os_str(), repeats.as_ref()])
            .output()
            .unwrap();
        assert!(!run.status.success(), "Accepted invalid repeats {repeats}");
        assert!(!rejected.exists());
    }
    let original = fs::read(&input).unwrap();
    let same_path = Command::new(env!("CARGO_BIN_EXE_gpu-cpu-liveness"))
        .args([input.as_os_str(), input.as_os_str(), "1".as_ref()])
        .output()
        .unwrap();
    assert!(!same_path.status.success(), "Overwrote the input workpack");
    assert_eq!(fs::read(&input).unwrap(), original);
    fs::remove_dir_all(root).unwrap();
}
