// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

use nemoclaw_e2e::http_fixture as transport;
use nemoclaw_e2e::tofu::TofuWorkspace;
use nemoclaw_sdk::fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Docker fixture"]
async fn discovery_plan_reads_target_metadata_without_gateway_or_mutations() {
    let tofu =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu required"));
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider required"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let catalog = FabricCatalog::bundled();
    let catalog_json = serde_json::to_string(&catalog).unwrap();
    let fixture = transport::Fixture::start(move |request| {
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
    let directory = TofuWorkspace::new(tofu, provider);
    let root = directory.path();
    let config = json!({
        "terraform":{"required_version":"= 1.12.6","required_providers":{"nemoclaw":{"source":"nvidia/nemoclaw"}}},
        "provider":{"nemoclaw":{}},
        "data":{
            "nemoclaw_engine_capabilities":{
                "present":{"engine":fixture.endpoint,"compute_driver":"docker"},
                "unknown":{"engine":format!("unix://{}",root.join("missing.sock").display()),"compute_driver":"docker"}
            },
            "nemoclaw_fabric_capabilities":{
                "present":{"engine":fixture.endpoint,"image":"labeled:image"},
                "absent":{"engine":fixture.endpoint,"image":"absent:image"}
            }
        },
        "output":{
            "engine":{"value":"${data.nemoclaw_engine_capabilities.present.observation_json}"},
            "unknown":{"value":"${data.nemoclaw_engine_capabilities.unknown.observation_json}"},
            "fabric":{"value":"${data.nemoclaw_fabric_capabilities.present.observation_json}"},
            "absent":{"value":"${data.nemoclaw_fabric_capabilities.absent.observation_json}"}
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
    assert_eq!(observation("unknown")["status"], "unknown");
    assert_eq!(observation("absent")["status"], "unavailable");
    assert_eq!(
        observation("fabric")["catalog"],
        serde_json::to_value(catalog).unwrap()
    );
    assert_eq!(requests.load(Ordering::SeqCst), 3);
    assert!(!root.join("terraform.tfstate").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Docker fixture"]
async fn sdk_discovery_session_uses_verified_bundle_and_reuses_offline_initialization() {
    use nemoclaw_sdk::{
        CancellationToken,
        bundle::{Manifest, hash_file, required_files},
        config::ComputeDriver,
        discovery::{DiscoveryRequest, ObservationStatus},
        discovery_session::{DiscoveryQuery, DiscoverySession, DiscoverySource},
    };
    let tofu =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu required"));
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider required"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    let bundle = tempfile::tempdir().unwrap();
    let mut manifest = Manifest {
        version: "0.1.0".into(),
        rust: "test fixture".into(),
        opentofu: nemoclaw_sdk::compile::OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    for relative in required_files(&manifest.version).unwrap() {
        let target = bundle.path().join(&relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        if relative.starts_with("providers/") {
            fs::copy(&provider, &target).unwrap();
        } else if relative.starts_with("libexec/") {
            fs::copy(&tofu, &target).unwrap();
        } else {
            fs::write(&target, b"isolated bundle fixture; unused by discovery").unwrap();
        }
        manifest.files.insert(relative, hash_file(&target).unwrap());
    }
    fs::write(
        bundle.path().join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    let catalog = FabricCatalog::bundled();
    let catalog_json = serde_json::to_string(&catalog).unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let fixture=transport::Fixture::start(move |request| {
        assert_eq!(request.method,"GET");
        assert!(request.body.is_empty());
        seen.fetch_add(1,Ordering::SeqCst);
        let body=match request.path.as_str() {
            "/info"=>json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"}),
            "/images/labeled:image/json"=>json!({"Id":"sha256:fixture", "Config":{"Labels":{IMAGE_CATALOG_LABEL:catalog_json}}}),
            other=>panic!("unexpected engine query {other}"),
        };
        Some((200,serde_json::to_vec(&body).unwrap()))
    }).await;
    let mut session = DiscoverySession::new(bundle.path()).unwrap();
    let cancel = CancellationToken::new();
    let engine = DiscoveryRequest {
        engine: fixture.endpoint.clone(),
        compute_driver: ComputeDriver::Docker,
    };
    let start = std::time::Instant::now();
    let observed = session
        .observe(&[DiscoveryQuery::Engine(engine.clone())], &cancel)
        .await
        .unwrap();
    eprintln!(
        "SDK discovery cold initialization + engine plan/show: {:?}",
        start.elapsed()
    );
    assert_eq!(
        observed.engine(&engine).map(|engine| engine.status),
        Some(ObservationStatus::Available)
    );
    // Without a platform the image read adds no engine read, so the request
    // count below stays the reads this test names.
    let image_query = DiscoveryQuery::Fabric {
        engine: fixture.endpoint.clone(),
        image: "labeled:image".into(),
        requirements: nemoclaw_sdk::fabric_capabilities::FabricRequirements {
            configuration: serde_json::json!({"harness": {"adapter_id": "nvidia.fabric.openclaw"}}),
            filesystem_read: None,
        },
        platform: None,
    };
    let start = std::time::Instant::now();
    let observed = session
        .observe(std::slice::from_ref(&image_query), &cancel)
        .await
        .unwrap();
    eprintln!("SDK discovery warm Fabric plan/show: {:?}", start.elapsed());
    use nemoclaw_sdk::discovery_session::DiscoveryObservation;
    let Some(DiscoveryObservation::Fabric(image)) = observed.get(&image_query) else {
        panic!("the image read is observed");
    };
    assert_eq!(image.status, ObservationStatus::Available);
    assert_eq!(image.catalog, Some(catalog));
    let query = DiscoveryQuery::Engine(DiscoveryRequest {
        engine: fixture.endpoint.clone(),
        compute_driver: ComputeDriver::Docker,
    });
    let start = std::time::Instant::now();
    let batched = session
        .batch(
            &[
                query.clone(),
                DiscoveryQuery::Hardware {
                    engine: fixture.endpoint.clone(),
                },
                image_query,
                query,
            ],
            &cancel,
        )
        .await
        .unwrap();
    eprintln!(
        "SDK discovery warm engine/hardware/Fabric batch plan/show: {:?}",
        start.elapsed()
    );
    assert_eq!(batched[0], batched[3]);
    assert!(
        matches!(&batched[1],DiscoveryObservation::Hardware(value) if value.architecture.as_deref()==Some("arm64") && !value.gpu_inventory_complete)
    );
    assert_eq!(requests.load(Ordering::SeqCst), 5);
    assert!(!bundle.path().join("terraform.tfstate").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; isolated Docker fixture"]
async fn compiled_discovery_requires_runtime_metadata_but_allows_unknown_capabilities() {
    use nemoclaw_sdk::{compile::compile, config::Document};
    let tofu =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu required"));
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider required"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
    let document =
        Document::parse(include_bytes!("../../../examples/onboarding/openclaw.yaml").as_slice())
            .unwrap();
    let image = document.spec.sandboxes[0].image.ref_.clone();
    let mode = Arc::new(AtomicUsize::new(0));
    let current = mode.clone();
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    let fixture=transport::Fixture::start(move |request| {
        assert_eq!(request.method,"GET");
        assert!(request.body.is_empty());
        seen.fetch_add(1,Ordering::SeqCst);
        let body=if request.path=="/info" {
            json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"})
        } else {
            assert!(request.path.starts_with("/images/") && request.path.ends_with("/json"));
            let mut catalog=nemoclaw_e2e::image_runtime::catalog();
            match current.load(Ordering::SeqCst) {
                1=>{
                    catalog.adapters.retain(|adapter|adapter.adapter_id()!="nvidia.fabric.openclaw");
                    catalog.runtime.as_mut().unwrap().binaries.remove("nvidia.fabric.openclaw");
                },
                2=>return Some((200,br#"{"Id":"sha256:unlabeled","Config":{"Labels":{}}}"#.to_vec())),
                3=>return Some((404,br#"{"message":"not found"}"#.to_vec())),
                4=>{
                    catalog.adapters.iter_mut().find(|adapter|adapter.adapter_id()=="nvidia.fabric.openclaw")
                        .unwrap().descriptor.as_object_mut().unwrap().remove("extension_schemas");
                },
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
    // and gateway reads so this test touches only its owned engine fixture.
    let mut output = compiled["output"].clone();
    output["discovery"]["value"]
        .as_object_mut()
        .unwrap()
        .retain(|name, _| name != "gateway" && !name.starts_with("endpoint_"));
    let graph = json!({
        "terraform":{"required_version":"= 1.12.6","required_providers":{"nemoclaw":{"source":"nvidia/nemoclaw"}}},
        "provider":{"nemoclaw":{}},
        "data":{
            "nemoclaw_engine_capabilities":compiled["data"]["nemoclaw_engine_capabilities"],
            "nemoclaw_fabric_capabilities":compiled["data"]["nemoclaw_fabric_capabilities"],
            "nemoclaw_target_hardware":compiled["data"]["nemoclaw_target_hardware"]
        },
        "output":output
    });
    let directory = TofuWorkspace::new(tofu, provider);
    let root = directory.path();
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    for selected in 0..5 {
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
            4 => Some("unknown"),
            _ => None,
        };
        assert_eq!(
            result.status.success(),
            compatible.is_some(),
            "{diagnostics}"
        );
        if let Some(expected) = compatible {
            let output = directory
                .command()
                .args(["show", "-json", "plan.bin"])
                .output()
                .unwrap();
            assert!(output.status.success());
            let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
            let observation: Value = serde_json::from_str(
                plan["planned_values"]["outputs"]["discovery"]["value"]["sandbox_0"]
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
                    .any(|check| check["requirement"] == "fabric_plan"
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
    assert_eq!(requests.load(Ordering::SeqCst), 15);
    assert!(!root.join("terraform.tfstate").exists());
}
