// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Agent readiness through OpenTofu.

use super::*;

fn output(tofu: &Standalone, name: &str) -> Value {
    let output = tofu.run(&["output", "-json", name], true);
    serde_json::from_slice(&output.stdout).unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; fake OpenShell gateway"]
async fn readiness_reports_the_configured_agent_and_its_failed_health() {
    let fixture = Fixture::start().await;
    let tofu = Standalone::new(&fixture.endpoint, &["readiness.tf"]);
    tofu.apply();
    assert_eq!(output(&tofu, "ready"), json!(true));
    // Failed health is an observation, not an apply failure, and reading it
    // writes nothing to the sandbox.
    let effects = fixture.state.lock().unwrap().effects;
    fixture.state.lock().unwrap().health_report = Some(
        json!({"supported": true, "report": {"fixture": false}, "reason_code": "fixture_unhealthy"}),
    );
    tofu.apply();
    assert_eq!(output(&tofu, "ready"), json!(false));
    fixture.state.lock().unwrap().health_report = None;
    tofu.apply();
    assert_eq!(output(&tofu, "ready"), json!(true));
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
}
