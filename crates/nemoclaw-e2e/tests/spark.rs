// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#![cfg(target_os = "linux")]
use nemoclaw_sdk::{
    CancellationToken, Deployment,
    config::Document,
    docker::Engine,
    managed::{RuntimeObservation, Spec},
    recipes::huggingface,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

struct Evidence {
    path: PathBuf,
    data: Value,
}
impl Evidence {
    fn record(&mut self, name: &str, value: impl serde::Serialize) {
        self.data[name] = serde_json::to_value(value).unwrap();
        self.save();
    }
    fn save(&self) {
        fs::write(&self.path, serde_json::to_vec_pretty(&self.data).unwrap()).unwrap();
    }
}
impl Drop for Evidence {
    fn drop(&mut self) {
        self.data["finishedEpoch"] = json!(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs()
        );
        self.save();
    }
}
fn state(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn service(directory: &Path) -> (Spec, String) {
    let value = state(&directory.join("runtime/terraform.tfstate"));
    let rows: Vec<_> = value["resources"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["type"] == "nemoclaw_inference_service")
        .collect();
    assert_eq!(rows.len(), 1);
    let row = &rows[0]["instances"][0]["attributes"];
    (
        serde_json::from_str(row["spec"].as_str().unwrap()).unwrap(),
        row["id"].as_str().unwrap().into(),
    )
}
async fn capture(directory: &Path) -> Value {
    let mut ids = BTreeMap::new();
    for file in ["terraform.tfstate", "runtime/terraform.tfstate"] {
        let value = state(&directory.join(file));
        let resources = value["resources"].as_array().unwrap();
        assert_eq!(resources.len(), 4);
        for resource in resources {
            let instances = resource["instances"].as_array().unwrap();
            assert_eq!(instances.len(), 1);
            let address = format!(
                "{}.{}",
                resource["type"].as_str().unwrap(),
                resource["name"].as_str().unwrap()
            );
            assert!(
                ids.insert(
                    address,
                    instances[0]["attributes"]["id"]
                        .as_str()
                        .unwrap()
                        .to_string()
                )
                .is_none()
            );
        }
    }
    let (spec, id) = service(directory);
    let engine = Engine::connect(&spec.gateway.engine).unwrap();
    let observed = engine.observe_runtime(&spec, &id).await.unwrap().unwrap();
    engine.verify_artifacts(&observed).await.unwrap();
    let mut receipts = BTreeMap::new();
    let service = spec.service.as_ref().unwrap();
    for path in [
        format!(
            "/data/{}/.nemoclaw-complete.json",
            huggingface::directory(service)
        ),
        format!(
            "/data/prepared/{}/complete.json",
            service.recipe.as_ref().unwrap().key(service)
        ),
    ] {
        let bytes = engine
            .read_file(&observed.container_id, &path, 1 << 20)
            .await
            .unwrap()
            .unwrap();
        let stat = engine
            .stat_file(&observed.container_id, &path)
            .await
            .unwrap()
            .unwrap();
        let hash = Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        receipts.insert(path, json!({"sha256":hash,"mtime":stat.modification_time}));
    }
    json!({"ids":ids,"receipts":receipts})
}
async fn observe(engine: &Engine, spec: &Spec, id: &str) -> RuntimeObservation {
    engine
        .observe_runtime(spec, id)
        .await
        .unwrap()
        .expect("owned inference must remain present")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit NEMOCLAW_LIVE_SPARK_CONFIG, NEMOCLAW_LIVE_SPARK_STATE, NEMOCLAW_TEST_BUNDLE; mutates only that owned experiment"]
async fn spark_apply_export_capacity_and_watchdog_recovery_preserve_identity_and_data() {
    let explicit = |name: &str| {
        let path = PathBuf::from(std::env::var_os(name).expect(name));
        assert!(path.is_absolute());
        path
    };
    let input = explicit("NEMOCLAW_LIVE_SPARK_CONFIG");
    let directory = explicit("NEMOCLAW_LIVE_SPARK_STATE");
    let bundle = explicit("NEMOCLAW_TEST_BUNDLE");
    let document = Document::parse(fs::File::open(input).unwrap()).unwrap();
    assert_eq!(document.spec.gateway.management, "managed");
    assert!(document.spec.inference_providers[0].service.is_some());
    fs::create_dir_all(&directory).unwrap();
    let mut evidence = Evidence {
        path: directory.join("spark-validation.json"),
        data: json!({"passed":false,"deployment":document.metadata.uid,"startedEpoch":SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs()}),
    };
    evidence.record("bundle", state(&bundle.join("manifest.json")));
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    let initial = deployment.apply(&document, &cancel).await.unwrap();
    evidence.record(
        "initialAgentReply",
        nemoclaw_e2e::verify_agent(&document, &directory).await,
    );
    evidence.record("initialApply", initial);
    let before = capture(&directory).await;
    evidence.record("before", &before);
    let unchanged = deployment.apply(&document, &cancel).await.unwrap();
    assert!(unchanged.changes.is_empty());
    evidence.record(
        "unchangedAgentReply",
        nemoclaw_e2e::verify_agent(&document, &directory).await,
    );
    assert_eq!(before, capture(&directory).await);
    evidence.record("unchangedApply", unchanged);
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported.digest(), document.digest());
    fs::write(
        directory.join("spark-export.yaml"),
        exported.yaml().unwrap(),
    )
    .unwrap();
    let reapplied = deployment.apply(&exported, &cancel).await.unwrap();
    assert!(reapplied.changes.is_empty());
    assert_eq!(before, capture(&directory).await);
    evidence.record("exportReapply", reapplied);
    let mut oversized = document.clone();
    oversized.spec.inference_providers[0]
        .service
        .as_mut()
        .unwrap()
        .memory
        .host_reserve_gib = 64;
    oversized.validate().unwrap();
    let rejection = deployment
        .plan(&oversized, &cancel)
        .await
        .expect_err("capacity must reject without allocating memory");
    assert!(rejection.to_string().contains("reserve"), "{rejection}");
    assert_eq!(before, capture(&directory).await);
    evidence.record("capacityRejection", rejection.to_string());
    let (spec, id) = service(&directory);
    let engine = Engine::connect(&spec.gateway.engine).unwrap();
    let observed = observe(&engine, &spec, &id).await;
    assert!(observed.running);
    let signal = std::process::Command::new("docker")
        .args([
            "--host",
            &spec.gateway.engine,
            "kill",
            "--signal",
            "USR1",
            &observed.container_id,
        ])
        .output()
        .unwrap();
    assert!(signal.status.success());
    let stopped = tokio::time::timeout(Duration::from_secs(60), async {
        loop {
            let observed = observe(&engine, &spec, &id).await;
            if !observed.running {
                break observed;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .expect("watchdog must stop owned inference");
    let status = engine.runtime_status(&stopped).await.unwrap();
    assert_eq!(status.phase, "stopped");
    evidence.record("watchdogStop", status);
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        assert!(
            !observe(&engine, &spec, &id).await.running,
            "watchdog must not enter a restart loop"
        );
    }
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(plan.changes.len(), 1);
    assert_eq!(
        plan.changes[0].resource,
        "nemoclaw_inference_service.runtime"
    );
    assert_eq!(plan.changes[0].actions, ["update"]);
    assert!(
        !observe(&engine, &spec, &id).await.running,
        "plan must not restart inference"
    );
    evidence.record("stoppedPlan", plan);
    let recovered = deployment.apply(&document, &cancel).await.unwrap();
    assert_eq!(recovered.changes.len(), 1);
    evidence.record(
        "recoveredAgentReply",
        nemoclaw_e2e::verify_agent(&document, &directory).await,
    );
    assert_eq!(before, capture(&directory).await);
    evidence.record("recoveryApply", recovered);
    evidence.record("after", capture(&directory).await);
    evidence.record("passed", true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires explicit Spark YAML with a changed runtime image pin, established state and verified bundle; replaces only the owned inference process"]
async fn spark_image_change_preserves_independent_bindings_and_prepared_data() {
    let explicit = |name| {
        let path = PathBuf::from(std::env::var_os(name).expect(name));
        assert!(path.is_absolute());
        path
    };
    let input = explicit("NEMOCLAW_LIVE_SPARK_CONFIG");
    let directory = explicit("NEMOCLAW_LIVE_SPARK_STATE");
    let bundle = explicit("NEMOCLAW_TEST_BUNDLE");
    let document = Document::parse(fs::File::open(input).unwrap()).unwrap();
    let old: Document =
        serde_json::from_value(state(&directory.join("intent.json"))["document"].clone()).unwrap();
    let mut comparison = document.clone();
    let new_image = document.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap()
        .image
        .clone();
    let old_image = old.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap()
        .image
        .clone();
    assert_ne!(old_image, new_image);
    comparison.spec.inference_providers[0]
        .service
        .as_mut()
        .unwrap()
        .image = old_image.clone();
    assert_eq!(comparison, old, "only the artifact pin may change");
    let before = capture(&directory).await;
    let mut evidence = Evidence {
        path: directory.join("spark-artifact-validation.json"),
        data: json!({"passed":false,"deployment":document.metadata.uid,"oldImage":old_image,"newImage":new_image,"before":before}),
    };
    let deployment = Deployment::new(&directory, &bundle);
    let cancel = CancellationToken::new();
    let plan = deployment.plan(&document, &cancel).await.unwrap();
    assert_eq!(plan.changes.len(), 1);
    assert_eq!(
        plan.changes[0].resource,
        "nemoclaw_inference_service.runtime"
    );
    assert_eq!(plan.changes[0].actions, ["delete", "create"]);
    assert_eq!(
        capture(&directory).await,
        before,
        "plan changed runtime or storage"
    );
    evidence.record("plan", plan);
    let applied = deployment.apply(&document, &cancel).await.unwrap();
    assert!(
        !nemoclaw_e2e::verify_agent(&document, &directory)
            .await
            .is_empty()
    );
    let after = capture(&directory).await;
    assert_eq!(before["receipts"], after["receipts"]);
    for (address, id) in before["ids"].as_object().unwrap() {
        if address == "nemoclaw_inference_service.runtime" {
            assert_ne!(id, &after["ids"][address]);
        } else {
            assert_eq!(
                id, &after["ids"][address],
                "independent identity changed: {address}"
            );
        }
    }
    evidence.record("apply", applied);
    evidence.record("after", after.clone());
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    let exported = deployment.export(&cancel).await.unwrap();
    assert_eq!(exported, document);
    assert!(
        deployment
            .apply(&exported, &cancel)
            .await
            .unwrap()
            .changes
            .is_empty()
    );
    assert_eq!(capture(&directory).await, after);
    evidence.record("exportReapply", true);
    evidence.record("passed", true);
}
