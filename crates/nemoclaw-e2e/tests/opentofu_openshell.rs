// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::{Command, Output},
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER"]
async fn production_provider_applies_refreshes_and_destroys_the_reference_graph() {
    let fixture = Fixture::start().await;
    let directory = tempfile::tempdir().unwrap();
    let tofu = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit pinned OpenTofu path"),
    );
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER")
            .expect("explicit built production provider path"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    fs::copy(
        provider,
        directory.path().join(nemoclaw_sdk::bundle::executable(
            "terraform-provider-nemoclaw",
        )),
    )
    .unwrap();
    fs::write(directory.path().join("tofu.rc"),format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}",serde_json::to_string(directory.path().to_str().unwrap()).unwrap())).unwrap();
    let mut document = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    document.spec.gateway.endpoint = fixture.endpoint.clone();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect();
    let mut graph = compile(&document, &generations, "0.1.0").unwrap();
    fs::write(directory.path().join("main.tf.json"), graph.to_string()).unwrap();
    let run = |args: &[&str]| -> Output {
        Command::new(&tofu)
            .args(args)
            .current_dir(directory.path())
            .env("TF_CLI_CONFIG_FILE", directory.path().join("tofu.rc"))
            .env("CHECKPOINT_DISABLE", "1")
            .env("TF_IN_AUTOMATION", "1")
            .output()
            .unwrap()
    };
    let success = |args: &[&str]| -> Output {
        let output = run(args);
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    success(&["apply", "-auto-approve", "-input=false", "-no-color"]);
    let before = fs::read(directory.path().join("terraform.tfstate")).unwrap();
    let effects = fixture.state.lock().unwrap().effects;
    success(&["plan", "-input=false", "-out=plan", "-no-color"]);
    let plan: Value = serde_json::from_slice(&success(&["show", "-json", "plan"]).stdout).unwrap();
    for change in plan["resource_changes"].as_array().unwrap() {
        assert_eq!(change["change"]["actions"], json!(["no-op"]));
    }
    assert_eq!(fixture.state.lock().unwrap().effects, effects);
    fixture.state.lock().unwrap().fail_read = Some(("provider", tonic::Code::Unavailable));
    assert!(!run(&["plan", "-input=false", "-no-color"]).status.success());
    assert_eq!(
        fs::read(directory.path().join("terraform.tfstate")).unwrap(),
        before
    );
    fixture.state.lock().unwrap().fail_read = None;
    graph["provider"]["nemoclaw"]["destroy"] = json!(true);
    for kind in [
        "nemoclaw_sandbox",
        "nemoclaw_provider_profile",
        "nemoclaw_provider",
    ] {
        graph["resource"].as_object_mut().unwrap().remove(kind);
    }
    fs::write(directory.path().join("main.tf.json"), graph.to_string()).unwrap();
    success(&["apply", "-auto-approve", "-input=false", "-no-color"]);
    let state = fixture.state.lock().unwrap();
    assert!(state.sandboxes.is_empty() && state.providers.is_empty() && state.profiles.is_empty());
    assert_eq!(state.workspaces.len(), 1);
}
