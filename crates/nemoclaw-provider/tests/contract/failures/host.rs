// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Host checks in `hcl/host/main.tf` that must fail the plan, which `tofu
//! test` cannot expect.

use std::{fs, sync::atomic::Ordering};

/// An incompatible image, an unhealthy container, and a server that stops
/// listing its model each fail the plan that reads them; invalid readiness
/// inputs fail before any read.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated host fixtures"]
async fn failed_host_checks_stop_the_plan() {
    let host = crate::fakes::Host::start().await;
    let workspace = crate::workspace();
    let main = workspace.path().join("main.tf");
    fs::copy(std::path::Path::new(crate::HCL).join("host/main.tf"), &main).unwrap();
    let plan = |variables: &[&str]| {
        let output = workspace
            .command()
            .args(["plan", "-input=false", "-no-color"])
            .args(variables)
            .envs(host.variables.clone())
            .output()
            .unwrap();
        assert!(!output.status.success(), "{variables:?} passed");
        // OpenTofu wraps diagnostic text.
        String::from_utf8_lossy(&output.stderr)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    host.healthy.store(false, Ordering::SeqCst);
    let stderr = plan(&[]);
    let expected = [
        "Image compatibility check failed",
        "Container health observation failed",
        r#"data.host_container_health.application["engine"]"#,
        r#"data.host_container_health.application["http"]"#,
        r#"data.host_container_health.application["status"]"#,
        "qwen",
    ];
    for expected in expected {
        assert!(stderr.contains(expected), "{expected}: {stderr}");
    }
    host.healthy.store(true, Ordering::SeqCst);
    // Endpoint readiness serves unauthenticated servers only.
    let stderr = plan(&["-var=authentication=bearer"]);
    assert!(stderr.contains("unauthenticated"), "{stderr}");
    // Endpoint and container inputs are separate modes.
    let source = fs::read_to_string(&main).unwrap();
    let endpoint = "  sandbox_endpoint     = var.sandbox_endpoint\n";
    assert!(source.contains(endpoint));
    let mixed = source.replace(endpoint, &format!("{endpoint}  name = \"qwen\"\n"));
    fs::write(&main, mixed).unwrap();
    let stderr = plan(&[]);
    assert!(
        stderr.contains("either endpoint or the container inputs"),
        "{stderr}"
    );
}
