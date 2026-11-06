// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Compile-time source-compatibility fixture for the v0.1.5 public status shape.

use openshell_sdk::raw::proto::SandboxStatus;

#[test]
fn baseline_exhaustive_sandbox_status_literal_still_compiles() {
    // Intentionally no `..Default::default()`: adding even an optional public
    // field breaks existing downstream Rust exhaustive struct literals.
    let status = SandboxStatus {
        agent_pod: String::new(),
        agent_fd: String::new(),
        sandbox_fd: String::new(),
        conditions: Vec::new(),
        phase: 0,
        current_policy_version: 0,
        main_process_instance_id: String::new(),
        exit_code: None,
        endpoint_statuses: Vec::new(),
        configuration_admission: None,
        configuration_activated: None,
        provisioning: None,
        restart_count: 0,
        next_restart_time: None,
        main_process_started_time: None,
        last_token_grant_failure: None,
    };
    assert_eq!(status, SandboxStatus::default());
}
