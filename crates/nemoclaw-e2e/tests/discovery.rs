// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(unix)]

#[path = "../../test-support/docker.rs"]
mod transport;
use nemoclaw_sdk::fabric_catalog::{FabricCatalog, IMAGE_CATALOG_LABEL};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    process::Command,
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
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"), format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}", serde_json::to_string(root).unwrap())).unwrap();
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
        let result = Command::new(&tofu)
            .args(args)
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap();
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
        discovery_session::DiscoverySession,
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
    let start = std::time::Instant::now();
    let observed = session
        .engine(
            &DiscoveryRequest {
                engine: fixture.endpoint.clone(),
                compute_driver: ComputeDriver::Docker,
            },
            &cancel,
        )
        .await
        .unwrap();
    eprintln!(
        "SDK discovery cold initialization + engine plan/show: {:?}",
        start.elapsed()
    );
    assert_eq!(observed.status, ObservationStatus::Available);
    let start = std::time::Instant::now();
    let observed = session
        .fabric(&fixture.endpoint, "labeled:image", &cancel)
        .await
        .unwrap();
    eprintln!("SDK discovery warm Fabric plan/show: {:?}", start.elapsed());
    assert_eq!(observed.status, ObservationStatus::Available);
    assert_eq!(observed.catalog, Some(catalog));
    use nemoclaw_sdk::discovery_session::{DiscoveryObservation, DiscoveryQuery};
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
                DiscoveryQuery::Fabric {
                    engine: fixture.endpoint.clone(),
                    image: "labeled:image".into(),
                },
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
async fn compiled_discovery_conditions_reject_known_mismatch_and_allow_unknown_metadata() {
    use nemoclaw_sdk::{compile::compile, config::Document};
    let tofu =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("explicit OpenTofu required"));
    let provider = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("explicit provider required"),
    );
    assert!(tofu.is_absolute() && provider.is_absolute());
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
            let mut catalog=FabricCatalog::bundled();
            match current.load(Ordering::SeqCst) {
                1=>catalog.adapters.retain(|adapter|adapter.adapter_id()!="nvidia.fabric.openclaw"),
                2=>return Some((200,br#"{"Id":"sha256:unlabeled","Config":{"Labels":{}}}"#.to_vec())),
                3=>return Some((404,br#"{"message":"not found"}"#.to_vec())),
                _=>{}
            }
            json!({"Id":"sha256:fixture", "Config":{"Labels":{IMAGE_CATALOG_LABEL:serde_json::to_string(&catalog).unwrap()}}})
        };
        Some((200,serde_json::to_vec(&body).unwrap()))
    }).await;
    let document =
        Document::parse(include_bytes!("../../../examples/onboarding/openclaw.yaml").as_slice())
            .unwrap();
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
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"),format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}",serde_json::to_string(root).unwrap())).unwrap();
    fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
    for selected in 0..4 {
        mode.store(selected, Ordering::SeqCst);
        let result = Command::new(&tofu)
            .args(["plan", "-input=false", "-no-color", "-out=plan.bin"])
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap();
        let diagnostics = format!(
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.status.success(), selected != 1, "{diagnostics}");
        if selected == 1 {
            assert!(
                diagnostics.contains("Resource postcondition failed"),
                "{diagnostics}"
            );
            assert!(
                diagnostics.contains("contradicts the configured platform"),
                "{diagnostics}"
            );
        }
    }
    assert_eq!(requests.load(Ordering::SeqCst), 12);
    assert!(!root.join("terraform.tfstate").exists());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit Fabric descriptor, OpenTofu and provider paths; isolated engine fixture"]
async fn fabric_owned_adapter_settings_reach_real_planning_without_consumer_manifests() {
    use nemoclaw_sdk::{compile::compile, config::Document};
    let tofu = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_TOFU").expect("OpenTofu path"));
    let provider =
        PathBuf::from(std::env::var_os("NEMOCLAW_TEST_PROVIDER").expect("provider path"));
    let descriptor_path = PathBuf::from(
        std::env::var_os("NEMOCLAW_TEST_FABRIC_DESCRIPTOR").expect("Fabric-owned descriptor path"),
    );
    let descriptor: Value = serde_json::from_slice(&fs::read(&descriptor_path).unwrap()).unwrap();
    let adapter_id = descriptor["adapter_id"].as_str().unwrap().to_owned();
    let python = std::env::var_os("NEMOCLAW_TEST_FABRIC_PYTHON")
        .expect("Fabric interpreter with installed fixture");
    let bundled = FabricCatalog::bundled();
    let packaged = Command::new(&python)
        .arg(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../image/fabric/catalog.py"
        ))
        .args([
            "--installed",
            "--revision",
            &bundled.fabric_revision,
            "--source-sha256",
            &bundled.source_sha256,
        ])
        .output()
        .unwrap();
    assert!(
        packaged.status.success(),
        "{}",
        String::from_utf8_lossy(&packaged.stderr)
    );
    let label = String::from_utf8(packaged.stdout).unwrap();
    let catalog = FabricCatalog::from_json(&label).unwrap();
    let record = catalog
        .adapters
        .iter()
        .find(|record| record.adapter_id() == adapter_id)
        .expect("installed Fabric fixture discovered by packaging");
    for (field, value) in descriptor.as_object().unwrap() {
        assert_eq!(
            &record.descriptor[field], value,
            "owner-authored field {field}"
        );
    }
    assert!(
        record
            .provenance
            .as_array()
            .unwrap()
            .iter()
            .any(|source| source["source"] == "installed_package")
    );
    let fixture = transport::Fixture::start(move |request| {
        assert_eq!(request.method,"GET");
        assert!(request.body.is_empty());
        let response = if request.path == "/info" {
            json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"})
        } else {
            assert!(request.path.starts_with("/images/") && request.path.ends_with("/json"));
            json!({"Id":"sha256:fixture","Architecture":"arm64","Os":"linux","RepoDigests":[format!("fixture-fabric@sha256:{}", "a".repeat(64))],"Config":{"Labels":{IMAGE_CATALOG_LABEL:label}}})
        };
        Some((200,serde_json::to_vec(&response).unwrap()))
    }).await;
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    fs::copy(provider, root.join("terraform-provider-nemoclaw")).unwrap();
    fs::write(root.join("tofu.rc"),format!("provider_installation {{ dev_overrides {{ \"registry.opentofu.org/nvidia/nemoclaw\" = {} }} direct {{}} }}",serde_json::to_string(root).unwrap())).unwrap();
    let from_wizard = std::env::var_os("NEMOCLAW_TEST_AUTHORED_YAML").is_some();
    let authored = std::env::var_os("NEMOCLAW_TEST_AUTHORED_YAML")
        .map(|path| fs::read_to_string(path).unwrap())
        .unwrap_or_else(|| include_str!("../../../examples/onboarding/openclaw.yaml").into());
    let mut input: Value = serde_saphyr::from_str(&authored).unwrap();
    input["spec"]["gateway"]["engine"] = fixture.endpoint.clone().into();
    let expected_harness = json!({"kind":adapter_id,"settings":{"mode":"advanced","budget":4}});
    if from_wizard {
        assert_eq!(input["spec"]["sandboxes"][0]["harness"], expected_harness);
    } else {
        input["spec"]["sandboxes"][0]["harness"] = expected_harness;
    }
    input["spec"]["sandboxes"][0]["image"] =
        json!({"ref":format!("fixture-fabric@sha256:{}", "a".repeat(64))});
    let model =
        &mut input["spec"]["sandboxes"][0]["agent"]["inference"]["routes"][0]["overrides"]["model"];
    if from_wizard {
        assert_eq!(*model, "fixture-model");
    } else {
        *model = "fixture-model".into();
    }
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
    ]
    .map(|name| (name.into(), "a".repeat(32)))
    .into();
    for valid in [true, false] {
        if !valid {
            input["spec"]["sandboxes"][0]["harness"]["settings"]
                .as_object_mut()
                .unwrap()
                .remove("budget");
        }
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        let compiled = compile(&document, &generations, "0.1.0").unwrap();
        let graph = json!({
            "terraform":{"required_version":"= 1.12.6","required_providers":{"nemoclaw":{"source":"nvidia/nemoclaw"}}},
            "provider":{"nemoclaw":{}},
            "output":{"compatibility":{"value":"${data.nemoclaw_fabric_capabilities.sandbox_0.compatibility_status}"}},
            "data":{
                "nemoclaw_engine_capabilities":compiled["data"]["nemoclaw_engine_capabilities"],
                "nemoclaw_fabric_capabilities":compiled["data"]["nemoclaw_fabric_capabilities"]
            }
        });
        fs::write(root.join("main.tf.json"), graph.to_string()).unwrap();
        let result = Command::new(&tofu)
            .args(["plan", "-input=false", "-no-color", "-out=checked.plan"])
            .current_dir(root)
            .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .output()
            .unwrap();
        let diagnostics = format!(
            "{}\n{}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(result.status.success(), valid, "{diagnostics}");
        if valid {
            let output = Command::new(&tofu)
                .args(["show", "-json", "checked.plan"])
                .current_dir(root)
                .env("TF_CLI_CONFIG_FILE", root.join("tofu.rc"))
                .output()
                .unwrap();
            assert!(output.status.success());
            let plan: Value = serde_json::from_slice(&output.stdout).unwrap();
            assert_eq!(
                plan["planned_values"]["outputs"]["compatibility"]["value"],
                "supported"
            );
            let resource = compiled["resource"]["nemoclaw_agent_configuration"]
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap();
            let config_path = root.join("fabric-config.json");
            fs::write(&config_path, resource["config_json"].as_str().unwrap()).unwrap();
            let result = Command::new(&python)
                .args([
                    "-c",
                    r#"
import asyncio, json, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from fabric import RuntimeHost
async def run():
    config = json.loads(Path(sys.argv[2]).read_text())
    with tempfile.TemporaryDirectory() as directory:
        # Owned test locations replace only deployment paths; native authored
        # settings and the compiled model/adapter configuration stay unchanged.
        config['environment']['workspace'] = directory
        config['runtime']['artifacts'] = directory
        host = RuntimeHost(config['metadata']['name'], Path(directory))
        try:
            await host.configure(config)
            result = await host.handle({'operation':'invoke', 'agent':config['metadata']['name'], 'input':{'proof':'authored'}})
            assert result['status'] == 'succeeded', result
            assert result['output']['settings'] == config['harness']['settings'], result
            assert result['output']['input'] == {'proof':'authored'}, result
        finally:
            await host.stop()
asyncio.run(run())
"#,
                ])
                .arg(concat!(env!("CARGO_MANIFEST_DIR"), "/../../image/fabric"))
                .arg(&config_path)
                .env("ADAPTER_PYTHON", &python)
                .output()
                .unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
        } else {
            assert!(
                diagnostics.contains("Resource postcondition failed"),
                "{diagnostics}"
            );
        }
    }
    assert!(!root.join("terraform.tfstate").exists());
}
