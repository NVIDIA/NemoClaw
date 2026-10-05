// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[test]
fn openshell_telemetry_stays_disabled_even_when_environment_requests_it() {
    const CHILD: &str = "NEMOCLAW_TELEMETRY_TEST_CHILD";
    if std::env::var_os(CHILD).is_some() {
        assert!(!openshell_core::telemetry::enabled());
        assert_eq!(openshell_core::telemetry::enabled_env_value(), "false");
        return;
    }
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "openshell_telemetry_stays_disabled_even_when_environment_requests_it",
            "--nocapture",
        ])
        .env(CHILD, "1")
        .env("OPENSHELL_TELEMETRY_ENABLED", "true")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
