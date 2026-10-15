// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! `data.openshell_external_inference_server`: an inference server NemoClaw
//! doesn't run, such as an IT-run LiteLLM proxy, checked through pinned
//! OpenTofu against a fake model server.
use crate::http_fixture::Fixture;
use serde_json::{Value, json};
use std::{
    fs,
    process::Output,
    sync::{Arc, Mutex},
};

const KEY: &str = "external-inference-fixture-key";
const UPSTREAM_SECRET: &str = "PRIVATE_UPSTREAM_DETAIL";

/// A model server listing `nemotron-super`, to requests with `KEY` unless `open`.
async fn server(open: bool, requests: Arc<Mutex<usize>>) -> Fixture {
    Fixture::start_tcp(move |request| {
        *requests.lock().unwrap() += 1;
        if request.method != "GET" || request.path != "/v1/models" {
            return Some((404, Vec::new()));
        }
        let authorized = request.headers.iter().any(|(name, value)| {
            name.eq_ignore_ascii_case("authorization") && *value == format!("Bearer {KEY}")
        });
        if !open && !authorized {
            return Some((
                401,
                json!({"error": UPSTREAM_SECRET}).to_string().into_bytes(),
            ));
        }
        Some((
            200,
            json!({"object":"list", "data":[{"id":"nemotron-super", "object":"model"}]})
                .to_string()
                .into_bytes(),
        ))
    })
    .await
}

fn config(inputs: &str) -> String {
    format!(
        r#"terraform {{
  required_providers {{
    openshell = {{ source = "registry.opentofu.org/nvidia/openshell" }}
  }}
}}

provider "openshell" {{}}

data "openshell_external_inference_server" "litellm" {{
  api = "openai-completions"
{inputs}}}

output "server" {{
  value = data.openshell_external_inference_server.litellm.ref
}}
"#
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated model server fixture"]
async fn external_inference_server_checks_the_model_list_and_exports_the_server_ref() {
    let requests = Arc::new(Mutex::new(0));
    let protected = server(false, requests.clone()).await;
    let open = server(true, requests.clone()).await;
    let workspace = crate::workspace();
    let run = |inputs: &str, args: &[&str], key: Option<&str>| -> Output {
        fs::write(workspace.path().join("main.tf"), config(inputs)).unwrap();
        let mut command = workspace.command();
        command
            .args(args)
            .arg("-no-color")
            .env_remove("LITELLM_KEY");
        if let Some(key) = key {
            command.env("LITELLM_KEY", key);
        }
        command.output().unwrap()
    };
    let stderr = |output: &Output| String::from_utf8_lossy(&output.stderr).into_owned();
    let protected_inputs = |model: &str| {
        format!(
            "  endpoint         = \"{}/v1\"\n  sandbox_endpoint = \"https://litellm.corp.example.com/v1\"\n  model            = \"{model}\"\n  credential_env   = \"LITELLM_KEY\"\n",
            protected.endpoint
        )
    };
    let apply = ["apply", "-auto-approve", "-input=false"];

    // With the key, the server lists the model; the ref names the address
    // sandboxes use and the key's variable, never the key.
    let ready = run(&protected_inputs("nemotron-super"), &apply, Some(KEY));
    assert!(ready.status.success(), "{}", stderr(&ready));
    let shown = workspace
        .command()
        .args(["output", "-json", "server"])
        .output()
        .unwrap();
    let server: Value = serde_json::from_slice(&shown.stdout).unwrap();
    assert_eq!(
        server,
        json!({
            "type": "inference_server",
            "endpoint": "https://litellm.corp.example.com/v1",
            "model": "nemotron-super",
            "credential_env": "LITELLM_KEY",
            "credential_source": ""
        })
    );
    assert!(!String::from_utf8_lossy(&shown.stdout).contains(KEY));

    // The check blocks, and never echoes keys or the server's own error text.
    for (key, model, expected) in [
        (None, "nemotron-super", "requires a key"),
        (Some("wrong-fixture-key"), "nemotron-super", "refused"),
        (Some(KEY), "other-model", "does not list model other-model"),
    ] {
        let failed = run(&protected_inputs(model), &["plan", "-input=false"], key);
        assert!(!failed.status.success(), "{expected}");
        let text = stderr(&failed);
        assert!(text.contains(expected), "{expected}: {text}");
        for secret in [KEY, "wrong-fixture-key", UPSTREAM_SECRET] {
            assert!(!text.contains(secret), "{secret}: {text}");
        }
    }

    // A server that needs no key needs no credential_env.
    let unauthenticated = run(
        &format!("  endpoint = \"{}/v1\"\n", open.endpoint),
        &apply,
        None,
    );
    assert!(
        unauthenticated.status.success(),
        "{}",
        stderr(&unauthenticated)
    );

    // An unreachable server blocks.
    let unreachable = run(
        "  endpoint = \"http://127.0.0.1:9/v1\"\n",
        &["plan", "-input=false"],
        None,
    );
    assert!(!unreachable.status.success());

    // A URL with credentials, a query, or a fragment fails validation.
    let invalid = run(
        "  endpoint = \"https://litellm.corp.example.com/v1?debug=1\"\n",
        &["validate"],
        None,
    );
    assert!(!invalid.status.success());
    assert!(
        stderr(&invalid).contains("endpoint"),
        "{}",
        stderr(&invalid)
    );

    // A read_trigger known only at apply keeps planning off the network, as
    // generated graphs use it.
    let before = *requests.lock().unwrap();
    let deferred = run(
        &format!(
            "{}  read_trigger = timestamp() != \"\"\n",
            protected_inputs("nemotron-super")
        ),
        &["plan", "-input=false", "-out=deferred.plan"],
        None,
    );
    assert!(deferred.status.success(), "{}", stderr(&deferred));
    assert_eq!(*requests.lock().unwrap(), before);
}
