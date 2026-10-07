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
