// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Readiness by endpoint: a server placed on any platform, checked over HTTP
//! without an engine, and the ref inference registrations take.
use crate::http_fixture::Fixture;
use serde_json::{Value, json};
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

const REVISION: &str = "1cfa9a7208912126459214e8b04321603b3df60c";

/// A model server listing `qwen` while `serving` holds.
async fn server(serving: Arc<AtomicBool>) -> Fixture {
    Fixture::start_tcp(move |request| {
        if request.method != "GET" || request.path != "/v1/models" {
            return Some((404, Vec::new()));
        }
        let models = if serving.load(Ordering::SeqCst) {
            json!([{"id": "qwen", "object": "model"}])
        } else {
            json!([])
        };
        Some((
            200,
            json!({"object": "list", "data": models})
                .to_string()
                .into_bytes(),
        ))
    })
    .await
}

/// A configuration reading `qwen`'s readiness with `inputs`.
fn config(runtime: &str, inputs: &str) -> String {
    format!(
        r#"terraform {{
  required_providers {{
    vllm = {{ source = "registry.opentofu.org/nvidia/vllm" }}
  }}
}}

provider "vllm" {{}}

data "vllm_runtime" "qwen" {{
  hardware {{
    profile = "dgx-spark"
  }}
  model {{
    repository = "Qwen/Qwen3-4B"
    revision   = "{REVISION}"
  }}
  serving {{
    port       = 18898
    model_name = "qwen"
  }}
{runtime}}}

data "vllm_readiness" "qwen" {{
  contract             = data.vllm_runtime.qwen.spec
  wait_timeout_seconds = 2
{inputs}}}

output "server" {{
  value = data.vllm_readiness.qwen.ref
}}
"#
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated model server fixture"]
async fn endpoint_readiness_waits_for_the_served_model_and_exports_the_server_ref() {
    let serving = Arc::new(AtomicBool::new(true));
    let fixture = server(serving.clone()).await;
    let workspace = crate::workspace();
    let write = |runtime: &str, inputs: &str| {
        fs::write(workspace.path().join("main.tf"), config(runtime, inputs)).unwrap()
    };
    let run = |args: &[&str]| workspace.command().args(args).output().unwrap();
    let endpoint = format!(
        "  endpoint         = \"{}/v1\"\n  sandbox_endpoint = \"http://10.0.0.8:18898/v1\"\n",
        fixture.endpoint
    );

    // A serving model is ready; the ref names the address sandboxes use.
    write("", &endpoint);
    let applied = run(&["apply", "-auto-approve", "-input=false", "-no-color"]);
    assert!(
        applied.status.success(),
        "{}",
        String::from_utf8_lossy(&applied.stderr)
    );
    let shown = run(&["output", "-json", "server"]);
    let server: Value = serde_json::from_slice(&shown.stdout).unwrap();
    assert_eq!(
        server,
        json!({
            "type": "inference_server",
            "endpoint": "http://10.0.0.8:18898/v1",
            "model": "qwen",
            "credential_env": "",
            "credential_source": ""
        })
    );

    // A server that stops listing the model is not ready.
    serving.store(false, Ordering::SeqCst);
    let planned = run(&["plan", "-input=false", "-no-color"]);
    assert!(!planned.status.success());
    let stderr = String::from_utf8_lossy(&planned.stderr);
    assert!(stderr.contains("qwen"), "{stderr}");

    // Readiness leaves destination checks to OpenShell, which owns them: the
    // gateway-host alias is a valid address for sandboxes.
    write(
        "",
        &format!(
            "  endpoint         = \"{}/v1\"\n  sandbox_endpoint = \"http://host.openshell.internal:18898/v1\"\n",
            fixture.endpoint
        ),
    );
    let named = run(&["validate", "-no-color"]);
    assert!(
        named.status.success(),
        "{}",
        String::from_utf8_lossy(&named.stderr)
    );

    // Endpoint and container inputs are separate modes.
    write(
        "",
        &format!(
            "{endpoint}  engine = \"unix:///var/run/docker.sock\"\n  name = \"qwen\"\n  container_id = \"abc\"\n"
        ),
    );
    let mixed = run(&["validate", "-no-color"]);
    assert!(!mixed.status.success());
    assert!(String::from_utf8_lossy(&mixed.stderr).contains("endpoint"));

    // Endpoint readiness serves unauthenticated servers only.
    write("  authentication = \"bearer\"\n", &endpoint);
    let authenticated = run(&["plan", "-input=false", "-no-color"]);
    assert!(!authenticated.status.success());
    assert!(
        String::from_utf8_lossy(&authenticated.stderr).contains("unauthenticated"),
        "{}",
        String::from_utf8_lossy(&authenticated.stderr)
    );
}
