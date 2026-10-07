// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use serde_json::json;

fn add(blobs: &mut BTreeMap<String, String>, value: &Value) -> String {
    let raw = value.to_string();
    let digest = sha256(raw.as_bytes());
    blobs.insert(digest.clone(), raw);
    digest
}
fn fixture(indexed: bool) -> (String, Value) {
    let mut catalog = FabricCatalog::bundled();
    let mut runtime: Value =
        serde_json::from_str(include_str!("../../../../image/fabric/runtime.json")).unwrap();
    runtime["binaries"] = Value::Object(
        catalog
            .adapters
            .iter()
            .map(|adapter| {
                (
                    adapter.adapter_id().into(),
                    json!(["/usr/local/bin/python3.14"]),
                )
            })
            .collect(),
    );
    catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
    let mut blobs = BTreeMap::new();
    let config = add(
        &mut blobs,
        &json!({"os":"linux", "architecture":"arm64", "config":{"Labels":{IMAGE_CATALOG_LABEL:serde_json::to_string(&catalog).unwrap()}}}),
    );
    let config_size = blobs[&config].len();
    let manifest = add(
        &mut blobs,
        &json!({"schemaVersion":2,"mediaType":OCI_MANIFEST,"config":{"mediaType":OCI_CONFIG,"digest":config,"size":config_size},"layers":[]}),
    );
    let root = if indexed {
        let manifest_size = blobs[&manifest].len();
        add(
            &mut blobs,
            &json!({"schemaVersion":2,"mediaType":OCI_INDEX,"manifests":[{"mediaType":OCI_MANIFEST,"digest":manifest,"size":manifest_size,"platform":{"os":"linux","architecture":"arm64"}}]}),
        )
    } else {
        manifest.clone()
    };
    (
        format!("registry.example.com/agent@{root}"),
        json!({"schema_version":1,"manifest_digest":manifest,"blobs":blobs}),
    )
}
fn check(image: &str, bundle: &Value) -> Result<FabricObservation, ObservationError> {
    verify(&serde_json::to_vec(bundle).unwrap(), image)
}

fn runtime_fixture(
    kind: &str,
    architecture: &str,
    labels: Value,
) -> (String, Value, nemoclaw_runtime::RuntimeSpec) {
    let source = if kind == "vllm" {
        include_str!("../../../../examples/spark/vllm.yaml")
    } else {
        include_str!("../../../../examples/managed-ollama-gpu.yaml")
    };
    let document = crate::config::Document::parse(source.as_bytes()).unwrap();
    let runtime = match &document.spec.services["qwen"] {
        crate::services::ServiceDefinition::Vllm(service) => {
            nemoclaw_runtime::RuntimeSpec::Vllm(Box::new(service.runtime.clone()))
        }
        crate::services::ServiceDefinition::Ollama(service) => {
            nemoclaw_runtime::RuntimeSpec::Ollama(Box::new(service.runtime.clone()))
        }
        _ => unreachable!(),
    };
    let (image, bundle) = runtime_bundle("linux", architecture, labels);
    (image, bundle, runtime)
}

fn runtime_bundle(os: &str, architecture: &str, labels: Value) -> (String, Value) {
    let mut blobs = BTreeMap::new();
    let config = add(
        &mut blobs,
        &json!({"os":os, "architecture":architecture, "config":{"Labels":labels}}),
    );
    let config_size = blobs[&config].len();
    let manifest = add(
        &mut blobs,
        &json!({"schemaVersion":2,"mediaType":OCI_MANIFEST,"config":{"mediaType":OCI_CONFIG,"digest":config,"size":config_size},"layers":[]}),
    );
    (
        format!("registry.example.com/runtime@{manifest}"),
        json!({"schema_version":1,"manifest_digest":manifest,"blobs":blobs}),
    )
}

#[test]
fn runtime_metadata_verifies_backend_images_without_a_fabric_catalog() {
    for kind in ["vllm", "ollama"] {
        let (image, bundle, runtime) = runtime_fixture(
            kind,
            "arm64",
            json!({
                "org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":kind
            }),
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("runtime-metadata.json");
        std::fs::write(&path, serde_json::to_vec(&bundle).unwrap()).unwrap();
        struct Source(String);
        impl Secrets for Source {
            fn resolve(&self, _: &str) -> Result<String, ObservationError> {
                Ok(self.0.clone())
            }
        }
        let source = Source(path.to_string_lossy().into_owned());
        assert!(
            observe_runtime(&source, "RUNTIME_METADATA", &image, "arm64", &runtime).is_ok(),
            "{kind}"
        );
    }
}

fn check_runtime(
    image: &str,
    bundle: &Value,
    runtime: &nemoclaw_runtime::RuntimeSpec,
    architecture: &str,
) -> Result<(), ObservationError> {
    struct Source(String);
    impl Secrets for Source {
        fn resolve(&self, _: &str) -> Result<String, ObservationError> {
            Ok(self.0.clone())
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("runtime-metadata.json");
    std::fs::write(&path, serde_json::to_vec(bundle).unwrap()).unwrap();
    observe_runtime(
        &Source(path.to_string_lossy().into_owned()),
        "RUNTIME_METADATA",
        image,
        architecture,
        runtime,
    )
}

#[test]
fn authenticated_runtime_requires_the_image_bearer_contract() {
    let labels = json!({"org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":"vllm"});
    let (image, bundle, mut runtime) = runtime_fixture("vllm", "arm64", labels.clone());
    let nemoclaw_runtime::RuntimeSpec::Vllm(service) = &mut runtime else {
        unreachable!()
    };
    service.authentication = Some(nemoclaw_runtime::vllm::ServiceAuthentication::Bearer);
    assert!(check_runtime(&image, &bundle, &runtime, "arm64").is_err());
    let mut authenticated = labels;
    authenticated["org.nemoclaw.inference.authentication"] = json!("bearer-v1");
    let (image, bundle, _) = runtime_fixture("vllm", "arm64", authenticated);
    assert!(check_runtime(&image, &bundle, &runtime, "arm64").is_ok());
}

#[test]
fn recipe_runtime_requires_every_declared_image_capability() {
    let document = crate::config::Document::parse(
        include_bytes!("../../../../examples/spark/spark-inline.yaml").as_slice(),
    )
    .unwrap();
    let crate::services::ServiceDefinition::Vllm(service) = &document.spec.services["qwen"] else {
        unreachable!()
    };
    let runtime = nemoclaw_runtime::RuntimeSpec::Vllm(Box::new(service.runtime.clone()));
    let mut labels =
        serde_json::to_value(&service.recipe.as_ref().unwrap().compatibility.image_labels).unwrap();
    labels["org.nemoclaw.runtime.spec"] = json!("v1");
    labels["org.nemoclaw.backend"] = json!("vllm");
    let (image, bundle) = runtime_bundle("linux", "arm64", labels.clone());
    assert!(check_runtime(&image, &bundle, &runtime, "arm64").is_ok());
    for key in service
        .recipe
        .as_ref()
        .unwrap()
        .compatibility
        .image_labels
        .keys()
    {
        let mut missing = labels.clone();
        missing.as_object_mut().unwrap().remove(key);
        let (image, bundle) = runtime_bundle("linux", "arm64", missing);
        assert!(
            check_runtime(&image, &bundle, &runtime, "arm64").is_err(),
            "missing {key}"
        );
    }
}

#[test]
fn runtime_index_selects_the_explicit_cluster_architecture() {
    let (_, bundle, runtime) = runtime_fixture(
        "vllm",
        "arm64",
        json!({
            "org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":"vllm"
        }),
    );
    let manifest = bundle["manifest_digest"].as_str().unwrap();
    let mut blobs: BTreeMap<String, String> =
        serde_json::from_value(bundle["blobs"].clone()).unwrap();
    let mut index = json!({"schemaVersion":2,"mediaType":OCI_INDEX,"manifests":[
        {"mediaType":OCI_MANIFEST,"digest":manifest,"size":blobs[manifest].len(),"platform":{"os":"linux","architecture":"arm64"}},
        {"mediaType":OCI_MANIFEST,"digest":format!("sha256:{}", "a".repeat(64)),"size":100,"platform":{"os":"linux","architecture":"amd64"}}
    ]});
    let root = add(&mut blobs, &index);
    let indexed = json!({"schema_version":1,"manifest_digest":manifest,"blobs":blobs});
    let image = format!("registry.example.com/runtime@{root}");
    assert!(check_runtime(&image, &indexed, &runtime, "arm64").is_ok());
    assert!(check_runtime(&image, &indexed, &runtime, "amd64").is_err());

    blobs.remove(&root);
    index["manifests"][1]["platform"]["architecture"] = json!("arm64");
    let root = add(&mut blobs, &index);
    let ambiguous = json!({"schema_version":1,"manifest_digest":manifest,"blobs":blobs});
    assert!(
        check_runtime(
            &format!("registry.example.com/runtime@{root}"),
            &ambiguous,
            &runtime,
            "arm64"
        )
        .is_err()
    );
}

#[test]
fn runtime_metadata_rejects_wrong_platform_contract_and_changed_bytes() {
    for kind in ["vllm", "ollama"] {
        let labels = json!({"org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":kind});
        let (image, bundle, runtime) = runtime_fixture(kind, "arm64", labels.clone());
        assert!(check_runtime(&image, &bundle, &runtime, "amd64").is_err());
        for (os, labels) in [
            ("windows", labels.clone()),
            ("linux", json!({"org.nemoclaw.backend":kind})),
            (
                "linux",
                json!({"org.nemoclaw.runtime.spec":"v0", "org.nemoclaw.backend":kind}),
            ),
            (
                "linux",
                json!({"org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":"unknown"}),
            ),
        ] {
            let (image, bundle) = runtime_bundle(os, "arm64", labels);
            assert!(check_runtime(&image, &bundle, &runtime, "arm64").is_err());
        }
        let mut changed = bundle;
        let manifest = changed["manifest_digest"].as_str().unwrap().to_owned();
        changed["blobs"][manifest] = json!("PRIVATE_SENTINEL");
        let error = check_runtime(&image, &changed, &runtime, "arm64").unwrap_err();
        assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
    }
}

#[test]
fn runtime_bundle_reads_are_bounded_and_errors_do_not_expose_local_paths() {
    struct Source(String);
    impl Secrets for Source {
        fn resolve(&self, _: &str) -> Result<String, ObservationError> {
            Ok(self.0.clone())
        }
    }
    let (image, bundle, runtime) = runtime_fixture(
        "ollama",
        "arm64",
        json!({
            "org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":"ollama"
        }),
    );
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("PRIVATE_SENTINEL");
    let source = Source(path.to_string_lossy().into_owned());
    std::fs::write(&path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    assert!(observe_runtime(&source, "RUNTIME_METADATA", &image, "arm64", &runtime).is_ok());
    std::fs::write(&path, vec![b' '; MAX_BUNDLE_BYTES + 1]).unwrap();
    let error =
        observe_runtime(&source, "RUNTIME_METADATA", &image, "arm64", &runtime).unwrap_err();
    assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
    std::fs::remove_file(&path).unwrap();
    assert!(observe_runtime(&source, "RUNTIME_METADATA", &image, "arm64", &runtime).is_err());
    assert!(
        observe_runtime(
            &Source("relative.json".into()),
            "RUNTIME_METADATA",
            &image,
            "arm64",
            &runtime
        )
        .is_err()
    );
}

#[test]
fn deployment_preflight_requires_metadata_for_every_declared_cluster_service() {
    struct Source(String);
    impl Secrets for Source {
        fn resolve(&self, name: &str) -> Result<String, ObservationError> {
            if name == "NEMOCLAW_MODEL_IMAGE_METADATA" {
                Ok(self.0.clone())
            } else {
                Err(ObservationError::Authentication)
            }
        }
    }
    for (kind, source) in [
        (
            "vllm",
            include_bytes!("../../../../examples/kubernetes/local-vllm.yaml").as_slice(),
        ),
        (
            "ollama",
            include_bytes!("../../../../examples/kubernetes/local-ollama.yaml").as_slice(),
        ),
    ] {
        let (image, bundle) = runtime_bundle(
            "linux",
            "amd64",
            json!({
                "org.nemoclaw.runtime.spec":"v1", "org.nemoclaw.backend":kind,
                "org.nemoclaw.inference.authentication":"bearer-v1"
            }),
        );
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("metadata.json");
        std::fs::write(&path, serde_json::to_vec(&bundle).unwrap()).unwrap();
        let secrets = Source(path.to_string_lossy().into_owned());
        let mut input =
            serde_json::to_value(crate::config::Document::parse(source).unwrap()).unwrap();
        input["spec"]["services"]["qwen"]["image"] = json!(image);
        let document = crate::config::Document::parse(input.to_string().as_bytes()).unwrap();
        assert!(verify_cluster_runtime_images(&document, &secrets).is_ok());
        let mut unused = input["spec"]["services"]["qwen"].clone();
        unused["kubernetes"]["imageMetadata"]["env"] = json!("UNRESOLVED_RUNTIME_METADATA");
        input["spec"]["services"]["unused"] = unused;
        let document = crate::config::Document::parse(input.to_string().as_bytes()).unwrap();
        assert!(verify_cluster_runtime_images(&document, &secrets).is_err());
    }
}

#[test]
fn immutable_index_and_manifest_prove_the_selected_image_contract() {
    for indexed in [false, true] {
        let (image, bundle) = fixture(indexed);
        let observed = check(&image, &bundle).unwrap();
        assert_eq!(observed.status, ObservationStatus::Available);
        assert_eq!(observed.image.architecture.as_deref(), Some("arm64"));
        assert_eq!(observed.image.repo_digests, [image]);
        assert!(observed.catalog.unwrap().runtime.is_some());
    }
}

#[test]
fn changed_blobs_missing_links_and_mutable_references_are_rejected() {
    let (image, bundle) = fixture(true);
    for digest in bundle["blobs"].as_object().unwrap().keys() {
        let mut changed = bundle.clone();
        changed["blobs"][digest] = json!("PRIVATE_SENTINEL");
        assert!(check(&image, &changed).is_err());
        changed["blobs"].as_object_mut().unwrap().remove(digest);
        assert!(check(&image, &changed).is_err());
    }
    assert!(check("registry.example.com/agent:latest", &bundle).is_err());
    assert!(
        check(
            &format!("registry/agent@sha256:{}", "a".repeat(64)),
            &bundle
        )
        .is_err()
    );
    let mut extra = bundle.clone();
    extra["blobs"]["../../PRIVATE_SENTINEL"] = json!("file:///PRIVATE_SENTINEL");
    assert!(check(&image, &extra).is_err());
    assert!(verify(&vec![b' '; MAX_BUNDLE_BYTES + 1], &image).is_err());
}

#[test]
fn descriptor_size_platform_and_ambiguity_are_verified_against_the_root_digest() {
    let (image, bundle) = fixture(true);
    let old_root = image.rsplit_once('@').unwrap().1;
    let root: Value = serde_json::from_str(bundle["blobs"][old_root].as_str().unwrap()).unwrap();
    for mutation in 0..5 {
        let mut changed_root = root.clone();
        match mutation {
            0 => changed_root["manifests"][0]["size"] = json!(0),
            1 => changed_root["manifests"][0]["platform"]["architecture"] = json!("amd64"),
            2 => changed_root["manifests"]
                .as_array_mut()
                .unwrap()
                .push(root["manifests"][0].clone()),
            3 => changed_root["manifests"][0]["mediaType"] = json!(OCI_INDEX),
            _ => {
                let mut other_platform = root["manifests"][0].clone();
                other_platform["platform"]["architecture"] = json!("amd64");
                other_platform["digest"] = json!(format!("sha256:{}", "a".repeat(64)));
                changed_root["manifests"]
                    .as_array_mut()
                    .unwrap()
                    .push(other_platform);
            }
        }
        let mut blobs: BTreeMap<String, String> =
            serde_json::from_value(bundle["blobs"].clone()).unwrap();
        blobs.remove(old_root);
        let digest = add(&mut blobs, &changed_root);
        let mut changed = bundle.clone();
        changed["blobs"] = json!(blobs);
        assert!(check(&format!("registry/agent@{digest}"), &changed).is_err());
    }
}

#[test]
fn verified_config_must_advertise_a_linux_runtime_contract() {
    let (_, bundle) = fixture(false);
    let manifest_digest = bundle["manifest_digest"].as_str().unwrap();
    let original_manifest: Value =
        serde_json::from_str(bundle["blobs"][manifest_digest].as_str().unwrap()).unwrap();
    let config_digest = original_manifest["config"]["digest"].as_str().unwrap();
    let original_config: Value =
        serde_json::from_str(bundle["blobs"][config_digest].as_str().unwrap()).unwrap();
    for mutation in 0..5 {
        let mut config = original_config.clone();
        match mutation {
            0 => config["os"] = json!("windows"),
            1 => config["architecture"] = json!("unrecognized"),
            2 => config["config"]["Labels"] = json!({}),
            3 => config["config"]["Labels"][IMAGE_CATALOG_LABEL] = json!("PRIVATE_SENTINEL"),
            _ => {
                let mut catalog: Value = serde_json::from_str(
                    config["config"]["Labels"][IMAGE_CATALOG_LABEL]
                        .as_str()
                        .unwrap(),
                )
                .unwrap();
                catalog.as_object_mut().unwrap().remove("runtime");
                config["config"]["Labels"][IMAGE_CATALOG_LABEL] = json!(catalog.to_string());
            }
        }
        let mut blobs = BTreeMap::new();
        let digest = add(&mut blobs, &config);
        let mut manifest = original_manifest.clone();
        manifest["config"]["digest"] = json!(digest);
        manifest["config"]["size"] = json!(blobs[&digest].len());
        let root = add(&mut blobs, &manifest);
        let changed = json!({"schema_version":1,"manifest_digest":root,"blobs":blobs});
        assert!(check(&format!("registry/agent@{root}"), &changed).is_err());
    }
}

#[test]
fn local_file_errors_do_not_expose_paths_or_contents() {
    struct Source(String);
    impl Secrets for Source {
        fn resolve(&self, _: &str) -> Result<String, ObservationError> {
            Ok(self.0.clone())
        }
    }
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("PRIVATE_SENTINEL");
    let (image, bundle) = fixture(true);
    std::fs::write(&path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    let source = Source(path.to_string_lossy().into_owned());
    assert_eq!(
        observe(&source, "IMAGE_METADATA", &image).status,
        ObservationStatus::Available
    );
    std::fs::write(&path, b"PRIVATE_SENTINEL").unwrap();
    let invalid = observe(&source, "IMAGE_METADATA", &image);
    assert_eq!(invalid.status, ObservationStatus::Unknown);
    assert!(
        !serde_json::to_string(&invalid)
            .unwrap()
            .contains("PRIVATE_SENTINEL")
    );
    assert_eq!(
        observe(&Source("relative.json".into()), "IMAGE_METADATA", &image).status,
        ObservationStatus::Unknown
    );
}
