// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live HCL scenarios. `case` applies `hcl/cases/<case>.yaml` with the bundled
//! CLI, then runs `hcl/tests/<case>.tftest.hcl`, whose verifier runs `probe`
//! from this binary once per target. The caller destroys the deployment, so
//! cleanup also runs after a cancelled or timed-out job:
//! `nemoclaw destroy --state-dir "$NEMOCLAW_HCL_RUN/deployment"`.

use fabric_provider::AgentBridge as _;
use nemoclaw_e2e::state::{runtime_id, sandbox_binding, successful_invocation};
use nemoclaw_sdk::{EnvironmentSecrets, config::Document};
use nemoclaw_test_fixtures::Bundle;
use openshell_provider::OpenShell;
use serde_json::{Value, json};
use std::{env::var, fs, path::PathBuf, process::Command, sync::Arc};

#[test]
#[ignore = "live: needs NEMOCLAW_TEST_BUNDLE, NEMOCLAW_HCL_CASE, NEMOCLAW_HCL_RUN, Docker, and the case's images and credentials"]
fn case() {
    let bundle = Bundle::from_env();
    let case = var("NEMOCLAW_HCL_CASE").unwrap();
    let run = PathBuf::from(var("NEMOCLAW_HCL_RUN").unwrap());
    let (state, reports) = (run.join("deployment"), run.join("reports"));
    fs::create_dir_all(&reports).unwrap();
    let config = fs::canonicalize(format!("hcl/cases/{case}.yaml")).unwrap();
    let cli = bundle
        .root()
        .join("bin")
        .join(nemoclaw_sdk::bundle::executable("nemoclaw"));
    let applied = Command::new(cli)
        .args([
            "apply",
            "--progress",
            "plain",
            "--non-interactive",
            "--state-dir",
        ])
        .arg(&state)
        .arg(&config)
        .status()
        .unwrap();
    assert!(applied.success(), "apply failed");
    let context = json!({
        "config": config, "state_dir": state, "evidence_dir": reports,
        "probe_executable": std::env::current_exe().unwrap(),
    });
    let filter = format!("-filter=tests/{case}.tftest.hcl");
    for args in [&["get", "-no-color"][..], &["test", "-no-color", &filter]] {
        let status = Command::new(bundle.tofu())
            .args(args)
            .current_dir("hcl")
            .env("TF_DATA_DIR", run.join("tofu"))
            .env("TF_VAR_context", context.to_string())
            .status()
            .unwrap();
        assert!(status.success(), "tofu {} failed", args[0]);
    }
}

/// Invoke one target's agent and record the outcome, never the request or reply.
#[tokio::test]
#[ignore = "run by hcl/verifier for one target"]
async fn probe() {
    let input = |name: &str| var(format!("NEMOCLAW_HCL_{name}")).unwrap();
    let (state, agent) = (PathBuf::from(input("STATE")), input("AGENT"));
    let document = Document::parse(fs::File::open(input("CONFIG")).unwrap()).unwrap();
    let sandbox = document
        .sandboxes()
        .find(|s| s.agent.name == agent)
        .unwrap();
    let binding = fabric_provider::fabric_binding(sandbox_binding(&state, sandbox.name)).unwrap();
    let runtime = runtime_id(&state, sandbox.name);
    let connection = document.spec.gateway.connection();
    let client = OpenShell::connect(&connection, Arc::new(EnvironmentSecrets)).unwrap();
    let request: Value = serde_json::from_str(&input("REQUEST")).unwrap();
    let response = client.invoke_agent(&binding, &runtime, &request).await.ok();
    let field = |name: &str| response.as_ref().and_then(|r| r.pointer(name)?.as_str());
    let report = json!({
        "agent": {"expected": agent, "observed": field("/agent_name")},
        "runtime": {"expected": runtime, "observed": field("/runtime_id")},
        "succeeded": response.as_ref().is_some_and(|r| successful_invocation(r.to_string().as_bytes())),
        "reply": field(&input("RESPONSE_POINTER")).is_some_and(|text| !text.trim().is_empty()),
    });
    fs::write(input("REPORT"), report.to_string()).unwrap();
}
