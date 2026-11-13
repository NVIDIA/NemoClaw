// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The oldest glibc that Linux bundles must run on.

use nemoclaw_build::glibc;

/// The loader refuses an executable whose required glibc symbol version is
/// missing, unless the reference is weak; versions compare by number, so 2.4 is
/// older than 2.38, and other libraries' versions do not count.
#[test]
fn the_newest_strong_glibc_reference_sets_the_requirement() {
    assert_eq!(
        glibc::newest_required([
            ("GLIBC_2.4", false),
            ("GLIBC_2.38", false),
            ("GLIBC_2.39", true),
            ("GCC_7.0.0", false),
            ("GLIBC_PRIVATE", false),
        ]),
        Some((2, 38))
    );
    assert_eq!(glibc::newest_required([("GLIBC_2.39", true)]), None);
    assert_eq!(glibc::parse_minimum("2.35"), Ok((2, 35)));
    assert!(glibc::parse_minimum("2.x").is_err());
}

/// A dynamically linked executable needing a newer glibc than the minimum is
/// named with both versions; scripts, data, and executables within the minimum
/// pass.
#[cfg(target_os = "linux")]
#[test]
fn executables_newer_than_the_minimum_are_named_and_others_pass() {
    let directory = tempfile::tempdir().unwrap();
    let bin = directory.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    // This test executable links glibc dynamically, so it needs some version.
    std::fs::copy(std::env::current_exe().unwrap(), bin.join("tool")).unwrap();
    std::fs::write(bin.join("script"), "#!/bin/sh\n").unwrap();
    std::fs::write(directory.path().join("manifest.json"), "{}").unwrap();

    let needed = glibc::required(&bin.join("tool")).unwrap().unwrap();
    assert!(needed >= (2, 2), "{needed:?}");
    assert_eq!(glibc::required(&bin.join("script")).unwrap(), None);

    let error = glibc::check(directory.path(), (2, 0)).unwrap_err();
    let tool = bin.join("tool");
    assert!(
        error.contains(&format!(
            "{} needs glibc {}.{}, newer than the minimum 2.0",
            tool.display(),
            needed.0,
            needed.1
        )),
        "{error}"
    );
    assert!(!error.contains("script"), "{error}");
    glibc::check(directory.path(), needed).unwrap();
}

/// The command CI runs after building a Linux bundle.
#[cfg(target_os = "linux")]
#[test]
fn the_check_command_fails_on_an_executable_newer_than_the_minimum() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::copy(
        std::env::current_exe().unwrap(),
        directory.path().join("tool"),
    )
    .unwrap();
    let run = |minimum: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_nemoclaw-build"))
            .args(["check-glibc", "--minimum", minimum])
            .arg(directory.path())
            .output()
            .unwrap()
    };
    let refused = run("2.0");
    assert!(!refused.status.success());
    assert!(
        String::from_utf8_lossy(&refused.stderr).contains("newer than the minimum 2.0"),
        "{}",
        String::from_utf8_lossy(&refused.stderr)
    );
    assert!(run("99.0").status.success());
}
