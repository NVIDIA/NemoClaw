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
        "compatibility":{"architecture":"arm64","gpu":"NVIDIA GB10","minDriverMajor":580,"minHostMemoryGiB":118,"imageLabels":{"org.nemoclaw.feature.example":"1","org.nemoclaw.recipe.protocol":"v1"}},
        "preparation":{"executable":"/opt/recipe/prepare","sha256":"a".repeat(64)},
        "verification":{"executable":"/opt/recipe/verify","sha256":"b".repeat(64)},
        "resources":{"preparedBytes":1024,"preparationMemoryGiB":2,"gpuMemoryBytes":85899345920u64,"startupHeadroomGiB":20},
        "serving":{"modelName":"fixture-model","toolParser":"hermes","reasoningParser":"qwen3","kvCacheDtype":"fp8","mambaCacheDtype":"bfloat16","lazyLoading":true,"chunkedPrefill":true,"environment":{"VLLM_EXAMPLE_FEATURE":"1"},"preparedEnvironment":{"VLLM_EXAMPLE_PREPARED_DIR":"."}},
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
async fn preparation_recovers_staging_reuses_output_and_rejects_changed_data() {
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
    let output = preparation::prepare(root.path(), root.path(), service, &runner, &cancel)
        .await
        .unwrap();
    assert_eq!(
        preparation::prepare(root.path(), root.path(), service, &runner, &cancel)
            .await
            .unwrap(),
        output
    );
    assert_eq!(runner.calls.load(Ordering::SeqCst), 3);
    let published = root.path().join(&output.key);
    let mut names: Vec<_> = std::fs::read_dir(&published)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["manifest.json", "packed"]);
    let saved: serde_json::Value =
        serde_json::from_slice(&std::fs::read(published.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(saved["key"], output.key);
    assert_eq!(saved["files"][0]["name"], "packed");
    std::fs::write(published.join("packed"), b"changed").unwrap();
    assert!(
        preparation::prepare(root.path(), root.path(), service, &runner, &cancel)
            .await
            .is_err()
    );
    assert_eq!(runner.calls.load(Ordering::SeqCst), 3);
}

#[test]
fn preparation_keys_track_model_and_tool_identity() {
    let document = Document::parse(serde_json::to_vec(&example()).unwrap().as_slice()).unwrap();
    let mut service = document.spec.inference_providers[0]
        .service
        .clone()
        .unwrap();
    let original = service.clone();
    let key = service.recipe.as_ref().unwrap().key(&service);
    service.model.repository = "another/model".into();
    assert_ne!(service.recipe.as_ref().unwrap().key(&service), key);
    service = original;
    service.recipe.as_mut().unwrap().preparation.sha256 = "c".repeat(64);
    assert_ne!(service.recipe.as_ref().unwrap().key(&service), key);
}

#[tokio::test]
async fn failed_verification_never_publishes_an_output_manifest() {
    use nemoclaw_sdk::{
        CancellationToken, Error,
        recipes::preparation::{self, Action, Request, Runner},
    };
    struct InvalidVerification(Vec<u8>);
    #[async_trait::async_trait]
    impl Runner for InvalidVerification {
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
    for verification in [
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
        let error = preparation::prepare(
            root.path(),
            root.path(),
            service,
            &InvalidVerification(verification),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(
                error,
                Error::State("recipe preparation is incomplete or changed")
            ),
            "{error}"
        );
        assert!(!root.path().join(&key).exists());
        let staging = root.path().join(format!("{key}.preparing"));
        assert_eq!(
            std::fs::read(staging.join("packed")).unwrap(),
            b"packed bytes"
        );
        assert!(!staging.join("manifest.json").exists());
    }
}

#[test]
fn model_specific_backend_names_are_rejected() {
    let mut document = serde_json::to_value(
        Document::parse(include_bytes!("../../../examples/spark/spark-inline.yaml").as_slice())
            .unwrap(),
    )
    .unwrap();
    let service = &mut document["spec"]["inferenceProviders"][0]["service"];
    service.as_object_mut().unwrap().remove("recipe");
    service["backend"] = "vllm-qwen38-spark-v1".into();
    assert!(Document::parse(serde_json::to_vec(&document).unwrap().as_slice()).is_err());
}

#[tokio::test]
async fn published_directory_without_an_output_manifest_is_not_rebuilt() {
    use nemoclaw_sdk::{
        CancellationToken, Error,
        recipes::preparation::{self, Action, Request, Runner},
    };
    struct NoTools;
    #[async_trait::async_trait]
    impl Runner for NoTools {
        async fn run(
            &self,
            _: Action,
            _: &Request<'_>,
            _: &CancellationToken,
        ) -> Result<Vec<u8>, Error> {
            panic!("failed observation must not run preparation");
        }
    }
    let document = Document::parse(serde_json::to_vec(&example()).unwrap().as_slice()).unwrap();
    let service = document.spec.inference_providers[0]
        .service
        .as_ref()
        .unwrap();
    let root = tempfile::tempdir().unwrap();
    let published = root
        .path()
        .join(service.recipe.as_ref().unwrap().key(service));
    std::fs::create_dir(&published).unwrap();
    std::fs::write(published.join("retained"), b"keep").unwrap();
    assert!(
        preparation::prepare(
            root.path(),
            root.path(),
            service,
            &NoTools,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert_eq!(std::fs::read(published.join("retained")).unwrap(), b"keep");
    assert!(!published.join("manifest.json").exists());
    // A legacy completion file cannot silently become a new output manifest.
    std::fs::write(published.join("complete.json"), b"legacy").unwrap();
    assert!(
        preparation::prepare(
            root.path(),
            root.path(),
            service,
            &NoTools,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert_eq!(
        std::fs::read(published.join("complete.json")).unwrap(),
        b"legacy"
    );
    assert!(!published.join("manifest.json").exists());
}
