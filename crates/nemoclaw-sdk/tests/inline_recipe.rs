// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::Document;

fn example() -> serde_json::Value {
    let mut value: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/config/spark.yaml.json")).unwrap();
    let mut value = value["document"].take();
    let service = &mut value["spec"]["inferenceProviders"][0]["service"];
    service["backend"] = "vllm".into();
    service["recipe"] = serde_json::json!({
        "apiVersion":"nemoclaw.nvidia.com/recipe/v1",
        "compatibility":{"architecture":"arm64","gpu":"NVIDIA GB10","minDriverMajor":580,"minHostMemoryGiB":118,"imageLabels":{"org.nemoclaw.feature.ple":"1","org.nemoclaw.recipe.protocol":"v1"}},
        "preparation":{"executable":"/opt/recipe/prepare","sha256":"a".repeat(64)},
        "verification":{"executable":"/opt/recipe/verify","sha256":"b".repeat(64)},
        "resources":{"preparedBytes":1024,"preparationMemoryGiB":2,"gpuMemoryBytes":85899345920u64,"startupHeadroomGiB":20},
        "serving":{"modelName":"qwen3.8-flash-next","toolParser":"qwen3_coder","reasoningParser":"qwen3","kvCacheDtype":"fp8","mambaCacheDtype":"bfloat16","lazyLoading":true,"chunkedPrefill":true,"environment":{"VLLM_PLE_CPU_OFFLOAD":"1"},"preparedEnvironment":{"VLLM_PLE_PACKED_TABLE_DIR":"."}},
        "licenses":["/opt/recipe/LICENSE"],"sourceNotices":["/opt/recipe/NOTICE"]
    });
    value
}

#[test]
fn inline_recipe_round_trips_without_a_builtin_model_identifier() {
    let value = example();
    let yaml = serde_json::to_vec(&value).unwrap();
    let document = Document::parse(yaml.as_slice()).unwrap();
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    for path in ["../escape", "/opt/recipe/../escape", "sh -c bad"] {
        let mut invalid = value.clone();
        invalid["spec"]["inferenceProviders"][0]["service"]["recipe"]["preparation"]["executable"] =
            path.into();
        assert!(Document::parse(serde_json::to_vec(&invalid).unwrap().as_slice()).is_err());
    }
}

#[tokio::test]
async fn preparation_recovers_staging_reuses_completion_and_rejects_changed_data() {
    use nemoclaw_sdk::{
        CancellationToken, Error,
        recipes::preparation::{self, Action, Request, Runner},
    };
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    struct Fixture {
        fail: AtomicBool,
        calls: AtomicUsize,
    }
    #[async_trait::async_trait]
    impl Runner for Fixture {
        async fn run(
            &self,
            action: Action,
            request: &Request<'_>,
            _: &CancellationToken,
        ) -> Result<Vec<u8>, Error> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            assert_eq!(
                request.api_version,
                "nemoclaw.nvidia.com/recipe-execution/v1"
            );
            match action {
                Action::Prepare => {
                    std::fs::write(request.output_directory.join("packed"),b"packed bytes").unwrap();
                    if self.fail.swap(false,Ordering::SeqCst) {return Err(Error::State("interrupted fixture"));}
                    Ok(Vec::new())
                }
                Action::Verify => Ok(serde_json::to_vec(&serde_json::json!({"files":[{"name":"packed","size":12,"sha256":nemoclaw_sdk::bundle::hash_file(&request.output_directory.join("packed")).unwrap()}]})).unwrap()),
            }
        }
    }
    let d = Document::parse(serde_json::to_vec(&example()).unwrap().as_slice()).unwrap();
    let service = d.spec.inference_providers[0].service.as_ref().unwrap();
    let root = tempfile::tempdir().unwrap();
    let runner = Fixture {
        fail: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
    };
    let cancel = CancellationToken::new();
    assert!(
        preparation::prepare(root.path(), root.path(), service, &runner, &cancel)
            .await
            .is_err()
    );
    let receipt = preparation::prepare(root.path(), root.path(), service, &runner, &cancel)
        .await
        .unwrap();
    assert_eq!(
        preparation::prepare(root.path(), root.path(), service, &runner, &cancel)
            .await
            .unwrap(),
        receipt
    );
    assert_eq!(runner.calls.load(Ordering::SeqCst), 3);
    std::fs::write(root.path().join(receipt.key).join("packed"), b"changed").unwrap();
    assert!(
        preparation::prepare(root.path(), root.path(), service, &runner, &cancel)
            .await
            .is_err()
    );
    assert_eq!(runner.calls.load(Ordering::SeqCst), 3);
}

#[test]
fn qwen_example_preserves_snapshot_identity_and_typed_vllm_behavior() {
    let document =
        Document::parse(include_bytes!("../../../examples/spark-inline.yaml").as_slice()).unwrap();
    let service = document.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap();
    let recipe = service.recipe.as_ref().unwrap();
    assert_eq!(
        recipe.snapshot.as_ref().unwrap().key(),
        nemoclaw_sdk::spark::model_manifest().key()
    );
    assert_eq!(
        recipe.reuse.as_ref().unwrap().preparation_key,
        nemoclaw_sdk::spark::preparation_key()
    );
    let legacy = Document::parse(include_bytes!("fixtures/config/spark.yaml").as_slice()).unwrap();
    let old = legacy.spec.inference_providers[0].service.as_ref().unwrap();
    let before = old
        .arguments("/data/model", 121 * nemoclaw_sdk::hardware::GIB)
        .unwrap();
    let after = service
        .arguments("/data/model", 121 * nemoclaw_sdk::hardware::GIB)
        .unwrap();
    assert_eq!(before.len(), after.len());
    for (a, b) in before.iter().zip(&after) {
        if a.starts_with('{') {
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(a).unwrap(),
                serde_json::from_str::<serde_json::Value>(b).unwrap()
            );
        } else {
            assert_eq!(a, b);
        }
    }
    assert_eq!(service.gpu_bytes().unwrap(), old.gpu_bytes().unwrap());
}

#[tokio::test]
async fn failed_verification_never_publishes_a_completion_receipt() {
    use nemoclaw_sdk::{
        CancellationToken, Error,
        recipes::preparation::{self, Action, Request, Runner},
    };
    struct UntrustedEvidence(Vec<u8>);
    #[async_trait::async_trait]
    impl Runner for UntrustedEvidence {
        async fn run(
            &self,
            action: Action,
            request: &Request<'_>,
            _: &CancellationToken,
        ) -> Result<Vec<u8>, Error> {
            match action {
                Action::Prepare => {
                    std::fs::write(request.output_directory.join("packed"), b"packed bytes")
                        .unwrap();
                    Ok(Vec::new())
                }
                Action::Verify => Ok(self.0.clone()),
            }
        }
    }
    let document = Document::parse(serde_json::to_vec(&example()).unwrap().as_slice()).unwrap();
    let service = document.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap();
    let file = serde_json::json!({"name":"packed","size":12,"sha256":"a".repeat(64)});
    for evidence in [
        b"not JSON".to_vec(),
        vec![b' '; (1 << 20) + 1],
        serde_json::to_vec(&serde_json::json!({"files":[]})).unwrap(),
        serde_json::to_vec(&serde_json::json!({"files":[file.clone()]})).unwrap(),
        serde_json::to_vec(&serde_json::json!({"files":[file.clone(),file]})).unwrap(),
        serde_json::to_vec(
            &serde_json::json!({"files":[{"name":"../packed","size":12,"sha256":"a".repeat(64)}]}),
        )
        .unwrap(),
    ] {
        let root = tempfile::tempdir().unwrap();
        let key = service.recipe.as_ref().unwrap().key(service);
        assert!(
            preparation::prepare(
                root.path(),
                root.path(),
                service,
                &UntrustedEvidence(evidence),
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert!(!root.path().join(&key).exists());
        let staging = root.path().join(format!("{key}.preparing"));
        assert_eq!(
            std::fs::read(staging.join("packed")).unwrap(),
            b"packed bytes"
        );
        assert!(!staging.join("complete.json").exists());
    }
}
