// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authored runtime image checks through pinned OpenTofu.

use crate::{http_fixture::Fixture, tofu::TofuWorkspace};
use nemoclaw_sdk::managed::{RUNTIME_SPEC_VERSION, RUNTIME_SPEC_VERSION_LABEL};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{Arc, Mutex},
};

/// A Docker engine that answers image inspection with `image`.
async fn image_engine(image: Arc<Mutex<Value>>) -> Fixture {
    Fixture::start(move |request| {
        assert_eq!(request.method, "GET", "an image check must not mutate");
        let body = if request.path.starts_with("/images/") {
            image.lock().unwrap().clone()
        } else {
            json!({"ID":"engine"})
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    })
    .await
}

fn workspace(engine: &str) -> TofuWorkspace {
    let path = |name| PathBuf::from(std::env::var_os(name).expect("explicit qualification path"));
    let (tofu, provider) = (path("NEMOCLAW_TEST_TOFU"), path("NEMOCLAW_TEST_PROVIDER"));
    assert!(tofu.is_absolute() && provider.is_absolute());
    let workspace = TofuWorkspace::new(tofu, provider);
    fs::write(
        workspace.path().join("main.tf"),
        format!(
            r#"terraform {{
  required_providers {{
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw" }}
  }}
}}

provider "nemoclaw" {{}}

data "nemoclaw_runtime_image" "vllm" {{
  engine       = "{engine}"
  image        = "runtime@sha256:{digest}"
  architecture = "arm64"
  labels = {{
    "org.nemoclaw.backend" = "vllm"
  }}
}}

output "observation" {{
  value = jsondecode(data.nemoclaw_runtime_image.vllm.observation_json)
}}
"#,
            digest = "a".repeat(64),
        ),
    )
    .unwrap();
    workspace
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Docker fixture"]
async fn authored_runtime_image_check_reads_labels_and_rejects_an_incompatible_image() {
    let image = Arc::new(Mutex::new(json!({
        "Id": "sha256:runtime", "Os": "linux", "Architecture": "arm64",
        "Config": {"Labels": {
            RUNTIME_SPEC_VERSION_LABEL: RUNTIME_SPEC_VERSION,
            "org.nemoclaw.backend": "vllm"
        }}
    })));
    let engine = image_engine(image.clone()).await;
    let workspace = workspace(&engine.endpoint);
    let run = |args: &[&str]| workspace.command().args(args).output().unwrap();
    let output = run(&["apply", "-input=false", "-auto-approve", "-no-color"]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let outputs: Value = serde_json::from_slice(&run(&["output", "-json"]).stdout).unwrap();
    assert_eq!(outputs["observation"]["value"]["status"], "available");

    // An image without the required backend label fails the read.
    image.lock().unwrap()["Config"]["Labels"]["org.nemoclaw.backend"] = json!("ollama");
    let output = run(&["plan", "-input=false", "-no-color"]);
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("Runtime image compatibility check failed"),
        "{stderr}"
    );
}
