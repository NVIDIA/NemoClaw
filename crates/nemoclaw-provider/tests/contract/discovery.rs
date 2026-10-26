// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::http_fixture as transport;
use nemoclaw_sdk::fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
use serde_json::{Value, json};
use std::{
    fs,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn discovery_plan_reads_target_metadata_without_gateway_or_mutations() {
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let catalog = FabricCatalog::bundled();
    let catalog_json = serde_json::to_string(&catalog).unwrap();
    let fixture = transport::Fixture::engine(move |request| {
        assert_eq!(request.method, "GET");
        assert!(request.body.is_empty());
        seen.fetch_add(1, Ordering::SeqCst);
        let body = match request.path.as_str() {
            "/info" => json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"}),
            "/images/labeled:image/json" => json!({"Id":"sha256:fixture", "Config":{"Labels":{IMAGE_CATALOG_LABEL:catalog_json}}}),
            "/images/absent:image/json" => return Some((404, br#"{"message":"not found"}"#.to_vec())),
            other => panic!("unexpected engine query {other}"),
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    }).await;
    let directory = crate::workspace();
    let root = directory.path();
    // One engine read answers both the engine facts and the advertised hardware.
    // An engine nothing serves: a missing socket, or a closed loopback port.
    let unreachable = if cfg!(unix) {
        format!("unix://{}", root.join("missing.sock").display())
    } else {
        "ssh://127.0.0.1:1".to_owned()
    };
    let config = json!({
        "terraform":{"required_providers":{"host":{"source":"nvidia/host"},"fabric":{"source":"nvidia/fabric"}}},
        "provider":{"host":{},"fabric":{}},
        "data":{
            "host_engine":{
                "present":{"engine":fixture.endpoint},
                "unknown":{"engine":unreachable}
            },
            "fabric_harnesses":{
                "present":{"engine":fixture.endpoint,"image":"labeled:image"},
                "absent":{"engine":fixture.endpoint,"image":"absent:image"}
            }
        },
        "output":{
            "engine":{"value":"${data.host_engine.present.engine_json}"},
            "hardware":{"value":"${data.host_engine.present.hardware_json}"},
            "status":{"value":"${data.host_engine.present.status}"},
            "unknown":{"value":"${data.host_engine.unknown.engine_json}"},
            "unknown_hardware":{"value":"${data.host_engine.unknown.hardware_json}"},
            "fabric":{"value":"${data.fabric_harnesses.present.observation_json}"},
            "absent":{"value":"${data.fabric_harnesses.absent.observation_json}"}
        }
    });
    fs::write(root.join("main.tf.json"), config.to_string()).unwrap();
    let run = |args: &[&str]| {
        let result = directory.command().args(args).output().unwrap();
        assert!(
            result.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        result
    };
    run(&["plan", "-input=false", "-no-color", "-out=plan.bin"]);
    let plan: Value = serde_json::from_slice(&run(&["show", "-json", "plan.bin"]).stdout).unwrap();
    let observation = |name: &str| {
        serde_json::from_str::<Value>(
            plan["planned_values"]["outputs"][name]["value"]
                .as_str()
                .unwrap(),
        )
        .unwrap()
    };
    assert_eq!(observation("engine")["status"], "available");
    assert_eq!(observation("engine")["architecture"], "arm64");
    assert_eq!(
        plan["planned_values"]["outputs"]["status"]["value"],
        "available"
    );
    assert!(observation("hardware")["status"].is_string());
    assert_eq!(observation("unknown")["status"], "unknown");
    assert_eq!(observation("unknown_hardware")["status"], "unknown");
    assert_eq!(observation("absent")["status"], "unavailable");
    assert_eq!(
        observation("fabric")["catalog"],
        serde_json::to_value(catalog).unwrap()
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    assert!(!root.join("terraform.tfstate").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn authored_fabric_requirements_take_the_configuration_and_policy_reads_separately() {
    let catalog_json = serde_json::to_string(&FabricCatalog::bundled()).unwrap();
    let fixture = transport::Fixture::engine(move |request| {
        let body = match request.path.as_str() {
            "/images/labeled:image/json" => json!({"Id":"sha256:fixture", "Config":{"Labels":{IMAGE_CATALOG_LABEL:catalog_json}}}),
            other => panic!("unexpected engine query {other}"),
        };
        Some((200, serde_json::to_vec(&body).unwrap()))
    })
    .await;
    let directory = crate::workspace();
    let write = |configuration: &str, reads: &str| {
        fs::write(
            directory.path().join("main.tf"),
            format!(
                r#"terraform {{
  required_providers {{
    fabric = {{ source = "nvidia/fabric" }}
  }}
}}

provider "fabric" {{}}

data "fabric_harnesses" "agent" {{
  engine          = "{engine}"
  image           = "labeled:image"
  config_json     = jsonencode({configuration})
  filesystem_read = {reads}
}}

output "status" {{
  value = data.fabric_harnesses.agent.compatibility_status
}}
"#,
                engine = fixture.endpoint
            ),
        )
        .unwrap();
    };
    let plan = || {
        let result = directory
            .command()
            .args(["plan", "-input=false", "-no-color"])
            .output()
            .unwrap();
        (
            result.status.success(),
            format!(
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            ),
        )
    };

    write(
        r#"{ harness = { adapter_id = "fixture.adapter" } }"#,
        r#"["/srv", "/opt/app"]"#,
    );
    let (planned, output) = plan();
    assert!(planned, "{output}");

    write(r#"{ harness = {} }"#, "null");
    let (planned, output) = plan();
    assert!(
        !planned,
        "a configuration without an adapter must be rejected"
    );
    assert!(
        output.contains("Invalid discovery target or selection"),
        "{output}"
    );

    write(
        r#"{ harness = { adapter_id = "fixture.adapter" } }"#,
        r#""/srv""#,
    );
    let (planned, output) = plan();
    assert!(!planned, "filesystem_read must be a list");
    assert!(output.contains("filesystem_read"), "{output}");
}

// Its managed gateway needs a local engine, which only Unix clients reach.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated Docker fixture"]
async fn compiled_discovery_requires_the_image_runtime_metadata() {
    use nemoclaw_sdk::{compile::compile, config::Document};
    let document =
        Document::parse(include_bytes!("../../../../examples/onboarding/openclaw.yaml").as_slice())
            .unwrap();
    let image = document.spec.sandboxes["assistant"].image.ref_.clone();
    let mode = Arc::new(AtomicUsize::new(0));
    let current = mode.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let fixture=transport::Fixture::engine(move |request| {
        assert_eq!(request.method,"GET");
        assert!(request.body.is_empty());
        seen.fetch_add(1,Ordering::SeqCst);
        let body=if request.path=="/info" {
            json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"})
        } else {
            assert!(request.path.starts_with("/images/") && request.path.ends_with("/json"));
            let mut catalog=crate::image_runtime::catalog();
            match current.load(Ordering::SeqCst) {
                1=>{
                    catalog.adapters.retain(|adapter|adapter.adapter_id()!="nvidia.fabric.openclaw");
                    catalog.runtime.as_mut().unwrap().binaries.remove("nvidia.fabric.openclaw");
                },
                2=>return Some((200,br#"{"Id":"sha256:unlabeled","Config":{"Labels":{}}}"#.to_vec())),
                3=>return Some((404,br#"{"message":"not found"}"#.to_vec())),
                _=>{}
            }
            json!({"Id":"sha256:fixture", "Architecture":"arm64", "Os":"linux", "RepoDigests":[image], "Config":{"Labels":{IMAGE_CATALOG_LABEL:serde_json::to_string(&catalog).unwrap()}}})
        };
        Some((200,serde_json::to_vec(&body).unwrap()))
    }).await;
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["gateway"]["engine"] = json!(fixture.endpoint);
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
    let compiled = compile(&document, &generations, "0.1.0").unwrap();
    // Keep the compiler's target inputs and conditions; isolate remote endpoint
    // and gateway reads, and the openshell provider's gateway prerequisites,
    // so this test touches only its owned engine fixture.
    let mut output = compiled["output"].clone();
    output["discovery"]["value"]
        .as_object_mut()
        .unwrap()
        .retain(|name, _| {
            !["gateway", "gateway_prerequisites"].contains(&name.as_str())
                && !name.starts_with("endpoint_")
        });
    // Only the discovery reads; the reads after an image pull belong to apply.
    let mut reads = compiled["data"]["fabric_harnesses"].clone();
    reads
        .as_object_mut()
        .unwrap()
        .retain(|name, _| !name.ends_with("_acquired"));
    let graph = json!({
        "terraform":{"required_providers":{"host":{"source":"nvidia/host"},"fabric":{"source":"nvidia/fabric"}}},
        "provider":{"host":{},"fabric":{}},
        "data":{
            "host_engine":compiled["data"]["host_engine"],
            "fabric_harnesses":reads
        },
        "output":output
    });
    let directory = crate::workspace();
    let root = directory.path();
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    for selected in 0..4 {
        mode.store(selected, Ordering::SeqCst);
        let result = directory
            .command()
            .args(["plan", "-input=false", "-no-color", "-out=plan.bin"])
            .output()
            .unwrap();
        let diagnostics = format!(
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        let compatible = match selected {
            0 => Some("supported"),
            _ => None,
        };
        // An absent image passes, reported unavailable, because the plan pulls
        // it before the reads that need its label.
        let deferred = selected == 3;
        assert_eq!(
            result.status.success(),
            compatible.is_some() || deferred,
            "{diagnostics}"
        );
        if deferred {
            let output = directory
                .command()
                .args(["show", "-json", "plan.bin"])
                .output()
                .unwrap();
            assert!(output.status.success());
            let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
            let observation: Value = serde_json::from_str(
                plan["planned_values"]["outputs"]["discovery"]["value"]["sandbox_assistant"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(observation["status"], "unavailable", "{observation}");
            continue;
        }
        if let Some(expected) = compatible {
            let output = directory
                .command()
                .args(["show", "-json", "plan.bin"])
                .output()
                .unwrap();
            assert!(output.status.success());
            let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
            let observation: Value = serde_json::from_str(
                plan["planned_values"]["outputs"]["discovery"]["value"]["sandbox_assistant"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap();
            assert!(observation["catalog"]["runtime"].is_object());
            assert!(
                observation["compatibility"]["checks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|check| check["requirement"] == "fabric_adapter"
                        && check["status"] == expected)
            );
        } else if selected == 1 {
            assert!(
                diagnostics.contains("Resource postcondition failed"),
                "{diagnostics}"
            );
            assert!(
                diagnostics.contains("sandbox/assistant: adapter/nvidia.fabric.openclaw"),
                "{diagnostics}"
            );
        } else {
            assert!(
                diagnostics.contains("image runtime metadata is unavailable"),
                "{diagnostics}"
            );
        }
    }
    // Three engine requests per case.
    assert_eq!(requests.load(Ordering::SeqCst), 12);
    assert!(!root.join("terraform.tfstate").exists());
}
