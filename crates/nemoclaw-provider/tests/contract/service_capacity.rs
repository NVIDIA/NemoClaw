// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::tofu::TofuWorkspace;
use nemoclaw_sdk::{compile, config::Document};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

#[test]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated SSH fixture"]
fn production_capacity_data_blocks_overcommit_defers_unknowns_and_preserves_state() {
    let tofu =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu required"));
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider required"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    let directory = TofuWorkspace::new(tofu, provider);
    let root = directory.path();
    // Beside the providers, where Windows finds it before the relay on PATH.
    nemoclaw_test_fixtures::ssh::install_simulator(root, root);
    for (file, value) in [
        ("engine.json", json!({"effects":0})),
        ("fixture.json", json!({})),
        ("control.json", json!({})),
    ] {
        fs::write(root.join(file), value.to_string()).unwrap();
    }
    let document =
        Document::parse(include_bytes!("../../../../examples/spark/two-models.yaml").as_slice())
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
    assert!(compiled["data"]["nemoclaw_service_capacity"].is_null());
    // Capacity is opt-in. Exercise the production data source with an explicit
    // consumer without creating model processes or contacting a live gateway.
    // Capacity takes each service's runtime contract.
    let contracts: Vec<_> = compile::runtime_targets(&document, &generations)
        .unwrap()
        .into_iter()
        .filter(|target| target.kind == "inference_service")
        .map(|target| {
            serde_json::from_str::<nemoclaw_sdk::managed::Spec>(&target.values["spec"])
                .unwrap()
                .runtime_configuration()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(contracts.len(), 2);
    let capacity = "data.nemoclaw_service_capacity.selected";
    let condition = json!({"precondition":[{
        "condition":format!("${{{capacity}.compatible}}"),
        "error_message":format!("Combined service memory requires ${{{capacity}.required_bytes}} bytes; observed ${{{capacity}.observed_bytes}} bytes.")
    }]});
    let mut graph = json!({"terraform":{"required_version":"= 1.12.6", "required_providers":{"nemoclaw":{"source":"registry.opentofu.org/nvidia/nemoclaw"}}}, "provider":{"nemoclaw":{}}, "data":{"nemoclaw_service_capacity":{"selected":{"engine":"ssh://operator@gpu-box","contracts":contracts}}}, "resource":{"terraform_data":{"consumer":{"input":"capacity checked", "lifecycle":condition}}}});
    let write_graph =
        |graph: &Value| fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    let control = |value: Value| fs::write(root.join("control.json"), value.to_string()).unwrap();
    let run = |args: &[&str], success: bool| {
        let output = directory
            .command()
            .args(args)
            .env("NEMOCLAW_TEST_REMOTE", root)
            .env("PATH", nemoclaw_test_fixtures::path_with(root))
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
    // This optional observation checks total capacity, not transient free
    // memory. The hosted runtime checks headroom when it starts.
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
    let contracts = source["contracts"].clone();
    source["contracts"] = json!("${terraform_data.requirements.output}");
    graph["resource"]["terraform_data"]["requirements"] = json!({"input":contracts});
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
