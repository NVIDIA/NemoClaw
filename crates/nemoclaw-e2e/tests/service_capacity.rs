// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, process::Command};

#[test]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated SSH fixture"]
fn production_capacity_data_blocks_overcommit_defers_unknowns_and_preserves_state() {
    let tofu =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu required"));
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider required"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::create_dir(root.join("bin")).unwrap();
    fs::write(
        root.join("bin/ssh"),
        include_bytes!("fixtures/remote_ssh.py"),
    )
    .unwrap();
    fs::set_permissions(root.join("bin/ssh"), fs::Permissions::from_mode(0o700)).unwrap();
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(root.to_str().unwrap()).unwrap())).unwrap();
    for (file, value) in [
        ("engine.json", json!({"effects":0})),
        ("fixture.json", json!({})),
        ("control.json", json!({})),
    ] {
        fs::write(root.join(file), value.to_string()).unwrap();
    }
    let document =
        Document::parse(include_bytes!("../../../examples/spark/two-models.yaml").as_slice())
            .unwrap();
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["gateway"] = json!({"management":"external", "endpoint":"http://127.0.0.1:1"});
    for service in value["spec"]["services"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        service["placement"] =
            json!({"engine":"ssh://operator@gpu-box", "networkCidr":"172.30.180.0/24"});
        service["publication"] = json!({"endpoint":format!("http://10.0.0.8:{}/v1",service["serving"]["port"]),"bindAddress":"10.0.0.8"});
        service["memory"]["gpuMemoryGiB"] = json!(64);
    }
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let compiled = compile::compile_runtime(&document, &generations, "0.1.0").unwrap();
    // Exercise the generated condition with a built-in consumer: capacity reads
    // never create model processes, pull artifacts, or contact a live gateway.
    let condition = compiled["resource"]["nemoclaw_inference_service"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()["lifecycle"]
        .clone();
    let mut graph = json!({"terraform":{"required_version":"= 1.12.6", "required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}}, "provider":{"nemoclaw":{"endpoint":"http://127.0.0.1:1"}}, "data":compiled["data"], "resource":{"terraform_data":{"consumer":{"input":"capacity checked", "lifecycle":condition}}}});
    let write_graph =
        |graph: &Value| fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let control = |value: Value| fs::write(root.join("control.json"), value.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = Command::new(&tofu)
            .args(args)
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .env("NEMOCLAW_TEST_REMOTE", root)
            .env(
                "PATH",
                format!(
                    "{}:{}",
                    root.join("bin").display(),
                    std::env::var("PATH").unwrap()
                ),
            )
            .output()
            .unwrap();
        assert_eq!(
            output.status.success(),
            success,
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };
    write_graph(&graph);
    run(&["validate"], true);
    assert!(
        !root.join("capacity_reads").exists(),
        "validation contacted the engine"
    );
    let output = run(&["plan", "-input=false"], false);
    let diagnostic = String::from_utf8_lossy(&output.stderr);
    assert!(
        diagnostic.contains("171798691840") && diagnostic.contains("137438953472"),
        "{diagnostic}"
    );
    assert!(!root.join("terraform.tfstate").exists());
    control(json!({"total_capacity_gib":192, "low_capacity":true}));
    // Low free memory must not block replacement planning. The SDK checks
    // transient startup demand separately immediately around actual startup.
    run(&["apply", "-auto-approve", "-input=false"], true);
    let prior = fs::read(root.join("terraform.tfstate")).unwrap();
    for failure in [
        json!({}),
        json!({"capacity_failure":true}),
        json!({"transport_failure":true}),
    ] {
        control(failure);
        run(&["plan", "-input=false"], false);
        assert_eq!(fs::read(root.join("terraform.tfstate")).unwrap(), prior);
    }
    let source = graph["data"]["nemoclaw_service_capacity"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .next()
        .unwrap();
    let specs = source["specs"].clone();
    source["specs"] = json!("${terraform_data.requirements.output}");
    graph["resource"]["terraform_data"]["requirements"] = json!({"input":specs});
    write_graph(&graph);
    let reads = fs::read(root.join("capacity_reads")).unwrap();
    run(&["plan", "-input=false", "-out=deferred.plan"], true);
    assert_eq!(fs::read(root.join("capacity_reads")).unwrap(), reads);
    let plan: Value =
        serde_json::from_slice(&run(&["show", "-json", "deferred.plan"], true).stdout).unwrap();
    assert!(
        plan["resource_changes"].as_array().unwrap().iter().any(
            |change| change["mode"] == "data" && change["change"]["actions"] == json!(["read"])
        )
    );
    control(json!({"total_capacity_gib":192}));
    run(&["apply", "-input=false", "deferred.plan"], true);
    assert!(fs::read(root.join("capacity_reads")).unwrap().len() > reads.len());
    control(json!({"capacity_failure":true}));
    graph.as_object_mut().unwrap().remove("data");
    graph.as_object_mut().unwrap().remove("resource");
    write_graph(&graph);
    run(&["apply", "-auto-approve", "-input=false"], true);
    let state: Value =
        serde_json::from_slice(&fs::read(root.join("engine.json")).unwrap()).unwrap();
    assert_eq!(state["effects"], 0);
}
