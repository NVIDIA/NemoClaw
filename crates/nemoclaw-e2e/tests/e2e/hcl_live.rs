// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Live HCL scenarios. `case` runs `tests/e2e/hcl/tests/<case>.tftest.hcl`
//! against `cases/<case>.yaml`, or the bound copy that `NEMOCLAW_HCL_DOCUMENT`
//! names. Its run blocks drive the bundled CLI through `tests/e2e/hcl/cli` and
//! run `probe` from this binary once per target through `tests/e2e/hcl/verifier`.
//! OpenTofu installs providers that a case's own modules use, such as Helm for
//! a kind case's fixtures, from the bundle. The caller
//! destroys the deployment, so cleanup also runs after a failed, cancelled, or
//! timed-out job: `nemoclaw destroy --state-dir "$NEMOCLAW_HCL_RUN/deployment"`.

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
    // Reports are published; command output and replies stay in `work`.
    let (reports, work) = (run.join("reports"), run.join("work"));
    for directory in [&reports, &work] {
        fs::create_dir_all(directory).unwrap();
    }
    let config = var("NEMOCLAW_HCL_DOCUMENT").unwrap_or_else(|_| format!("cases/{case}.yaml"));
    let context = json!({
        "config": fs::canonicalize(config).unwrap(),
        "state_dir": run.join("deployment"),
        "cli": bundle.root().join("bin").join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        "probe_executable": std::env::current_exe().unwrap(),
        "work_dir": work,
        "evidence_dir": reports,
    });
    let providers = run.join("providers.tfrc");
    fs::write(
        &providers,
        format!(
            "provider_installation {{ filesystem_mirror {{ path = {} }} }}\n",
            json!(bundle.root().join("providers"))
        ),
    )
    .unwrap();
    let filter = format!("-filter=tests/{case}.tftest.hcl");
    for args in [
        &["init", "-input=false", "-no-color"][..],
        &["test", "-no-color", &filter],
    ] {
        let status = Command::new(bundle.tofu())
            .args(args)
            .current_dir("tests/e2e/hcl")
            .env("TF_DATA_DIR", run.join("tofu"))
            .env("TF_CLI_CONFIG_FILE", &providers)
            .env("TF_VAR_context", context.to_string())
            .status()
            .unwrap();
        assert!(status.success(), "tofu {} failed", args[0]);
    }
}

/// Invoke one target's agent. The published report records the outcome; the
/// reply text stays in the private work directory for `hcl/verifier`.
#[tokio::test]
#[ignore = "run by tests/e2e/hcl/verifier for one target"]
async fn probe() {
    let input = |name: &str| var(format!("NEMOCLAW_HCL_{name}")).unwrap();
    let (state, agent) = (PathBuf::from(input("STATE")), input("AGENT"));
    let document = Document::parse(fs::File::open(input("CONFIG")).unwrap()).unwrap();
    let sandbox = document
        .sandboxes()
        .find(|s| s.agent.name == agent)
        .unwrap();
    let recorded = sandbox_binding(&state, sandbox.name);
    let runtime = runtime_id(&state, sandbox.name);
    let request: Value = serde_json::from_str(&input("REQUEST")).unwrap();
    // A managed Kubernetes gateway is reached through a port-forward that the
    // connection holds, as the SDK's providers reach it.
    let (_forward, client) = match document
        .spec
        .gateway
        .as_managed()
        .and_then(|gateway| gateway.kubernetes.as_deref())
    {
        Some(kubernetes) => {
            let target = nemoclaw_sdk::kubernetes::ClusterTarget {
                kubeconfig: var(&kubernetes.kubeconfig.as_ref().unwrap().env)
                    .unwrap()
                    .into(),
                context: kubernetes.context.clone().unwrap(),
            };
            let operations = nemoclaw_sdk::kubernetes::operations::Operations {
                client: nemoclaw_sdk::kubernetes::connect(&target).await.unwrap(),
                state: state.join("kubernetes"),
                openshift_wait: nemoclaw_sdk::kubernetes::operations::OPENSHIFT_WAIT,
            };
            let (forward, client) =
                crate::kubernetes_live::requests::gateway(&operations, &recorded)
                    .await
                    .unwrap();
            (Some(forward), client)
        }
        None => {
            let connection = document.spec.gateway.connection();
            (
                None,
                OpenShell::connect(&connection, Arc::new(EnvironmentSecrets)).unwrap(),
            )
        }
    };
    let binding = fabric_provider::fabric_binding(recorded).unwrap();
    let response = client.invoke_agent(&binding, &runtime, &request).await.ok();
    let field = |name: &str| response.as_ref().and_then(|r| r.pointer(name)?.as_str());
    let reply = field(&input("RESPONSE_POINTER")).unwrap_or_default();
    let report = json!({
        "agent": {"expected": agent, "observed": field("/agent_name")},
        "runtime": {"expected": runtime, "observed": field("/runtime_id")},
        "succeeded": response.as_ref().is_some_and(|r| successful_invocation(r.to_string().as_bytes())),
        "reply": !reply.trim().is_empty(),
    });
    fs::write(input("REPLY"), reply).unwrap();
    fs::write(input("REPORT"), report.to_string()).unwrap();
}
