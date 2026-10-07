// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The container `cargo images qualify` runs the command contract in.

use nemoclaw_build::images::{Lifecycle, qualify_arguments};
use std::path::Path;

fn arguments(lifecycle: Option<Lifecycle>, require_ready: bool) -> Vec<String> {
    qualify_arguments(
        Path::new("/repo"),
        "name",
        "sha256:image",
        "{}",
        "",
        lifecycle,
        require_ready,
    )
}

fn environment(arguments: &[String]) -> Vec<&str> {
    arguments
        .windows(2)
        .filter(|pair| pair[0] == "-e")
        .map(|pair| pair[1].as_str())
        .collect()
}

#[test]
fn without_a_lifecycle_the_contract_runs_offline_and_read_only() {
    let arguments = arguments(None, false);
    for required in ["--network=none", "--read-only", "--runtime=runc"] {
        assert!(
            arguments.iter().any(|argument| argument == required),
            "{required}"
        );
    }
    let environment = environment(&arguments);
    assert!(environment.contains(&"NEMOCLAW_TEST_LIFECYCLE="));
    assert!(environment.contains(&"NEMOCLAW_TEST_REQUIRE_READY=0"));
    assert_eq!(arguments.last().map(String::as_str), Some("/test.py"));
}

/// A lifecycle profile runs a native adapter against local inference in the
/// sandbox, so it needs the native helper, a home directory and a test key.
#[test]
fn a_lifecycle_profile_gets_the_native_helper_home_and_key() {
    let arguments = arguments(Some(Lifecycle::Hermes), true);
    let environment = environment(&arguments);
    assert!(environment.contains(&"NEMOCLAW_TEST_LIFECYCLE=hermes"));
    assert!(environment.contains(&"NEMOCLAW_TEST_REQUIRE_READY=1"));
    assert!(environment.contains(&"HOME=/sandbox"));
    assert!(environment.contains(&"FABRIC_NATIVE_TEST_KEY=fabric-native-key"));
    assert!(
        arguments
            .windows(2)
            .any(|pair| pair[0] == "--workdir" && pair[1] == "/sandbox")
    );
    // The source is the host path, joined with the host's separator.
    let helper = Path::new("/repo").join("image").join("qualify_native.py");
    let mount = format!(
        "type=bind,src={},dst=/qualify_native.py,readonly",
        helper.display()
    );
    assert!(arguments.contains(&mount), "{arguments:?}");
}
