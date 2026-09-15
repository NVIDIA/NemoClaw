// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde_json::{Value, json};
use std::{fs, path::PathBuf, process::Command};

#[test]
#[ignore = "requires explicit retained runtime state, OpenTofu and production provider paths; reads owned storage only"]
fn provider_refreshes_retained_storage_without_changes() {
    let path = |name| PathBuf::from(std::env::var_os(name).expect("explicit qualification path"));
    let tofu = path("NEMOCLAW_TEST_TOFU");
    let provider = path("NEMOCLAW_TEST_PROVIDER");
    let retained = path("NEMOCLAW_TEST_RUNTIME_STATE");
    assert!(tofu.is_absolute() && provider.is_absolute() && retained.is_absolute());
    let original = fs::read(&retained).unwrap();
    let mut state: Value = serde_json::from_slice(&original).unwrap();
    state["resources"].as_array_mut().unwrap().retain(|r| {
        matches!(
            r["type"].as_str(),
            Some("nemoclaw_gateway_storage" | "nemoclaw_inference_storage")
        )
    });
    let resources = state["resources"].as_array().unwrap();
    assert_eq!(
        resources.len(),
        2,
        "requires the two retained storage resources"
    );
    let directory = tempfile::tempdir().unwrap();
    fs::copy(
        provider,
        directory.path().join(nemoclaw_sdk::bundle::executable(
            "terraform-provider-nemoclaw",
        )),
    )
    .unwrap();
    fs::write(directory.path().join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}",serde_json::to_string(directory.path().to_str().unwrap()).unwrap())).unwrap();
    let mut graph = json!({"terraform":{"required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw","version":"0.1.0"}}},"provider":{"nemoclaw":{"endpoint":"http://127.0.0.1:17681"}},"resource":{}});
    for resource in resources {
        assert_eq!(resource["instances"].as_array().unwrap().len(), 1);
        let attrs = &resource["instances"][0]["attributes"];
        assert!(!attrs["id"].as_str().unwrap().is_empty());
        graph["resource"][resource["type"].as_str().unwrap()][resource["name"].as_str().unwrap()] =
            json!({"spec":attrs["spec"],"lifecycle":{"prevent_destroy":true}});
    }
    fs::write(
        directory.path().join("terraform.tfstate"),
        state.to_string(),
    )
    .unwrap();
    fs::write(directory.path().join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str]| {
        let output = Command::new(&tofu)
            .args(args)
            .current_dir(directory.path())
            .env("TF_CLI_CONFIG_FILE", directory.path().join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    run(&["plan", "-input=false", "-no-color", "-out=plan"]);
    let plan: Value = serde_json::from_slice(&run(&["show", "-json", "plan"]).stdout).unwrap();
    let changes = plan["resource_changes"].as_array().unwrap();
    assert_eq!(changes.len(), 2);
    for change in changes {
        assert_eq!(change["change"]["actions"], json!(["no-op"]));
        assert_eq!(
            change["change"]["before"]["id"],
            change["change"]["after"]["id"]
        );
    }
    assert_eq!(
        fs::read(&retained).unwrap(),
        original,
        "qualification altered the original state"
    );
}
