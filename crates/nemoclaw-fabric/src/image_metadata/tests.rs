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
fn catalog() -> FabricCatalog {
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
    catalog
}
/// Add one platform's manifest and config, returning the manifest's descriptor.
fn platform(blobs: &mut BTreeMap<String, String>, architecture: &str, label: &str) -> Value {
    let config = add(
        blobs,
        &json!({"os":"linux", "architecture":architecture, "config":{"Labels":{IMAGE_CATALOG_LABEL:label}}}),
    );
    let config_size = blobs[&config].len();
    let manifest = add(
        blobs,
        &json!({"schemaVersion":2,"mediaType":OCI_MANIFEST,"config":{"mediaType":OCI_CONFIG,"digest":config,"size":config_size},"layers":[]}),
    );
    json!({"mediaType":OCI_MANIFEST,"digest":manifest,"size":blobs[&manifest].len(),"platform":{"os":"linux","architecture":architecture}})
}
/// A bundle for one manifest when `architectures` has no index, otherwise for an
/// index of those Linux platforms plus an attestation the check ignores.
fn fixture(indexed: bool, architectures: &[&str]) -> (String, Value) {
    let label = serde_json::to_string(&catalog()).unwrap();
    let mut blobs = BTreeMap::new();
    let mut manifests: Vec<Value> = architectures
        .iter()
        .map(|architecture| platform(&mut blobs, architecture, &label))
        .collect();
    let root = if indexed {
        manifests.push(json!({"mediaType":OCI_MANIFEST,"digest":format!("sha256:{}", "b".repeat(64)),"size":1,"platform":{"os":"unknown","architecture":"unknown"}}));
        add(
            &mut blobs,
            &json!({"schemaVersion":2,"mediaType":OCI_INDEX,"manifests":manifests}),
        )
    } else {
        manifests[0]["digest"].as_str().unwrap().to_owned()
    };
    (
        format!("registry.example.com/agent@{root}"),
        json!({"schema_version":2,"blobs":blobs}),
    )
}
fn check(image: &str, bundle: &Value) -> Result<FabricObservation, ObservationError> {
    verify(&serde_json::to_vec(bundle).unwrap(), image)
}

#[test]
fn immutable_indexes_and_manifests_prove_the_image_contract() {
    for (indexed, architectures, reported) in [
        (false, &["arm64"][..], Some("arm64")),
        (true, &["arm64"][..], Some("arm64")),
        // Kubernetes chooses the node's platform; the platforms agree, so no
        // single architecture describes the image.
        (true, &["arm64", "amd64"][..], None),
    ] {
        let (image, bundle) = fixture(indexed, architectures);
        let observed = check(&image, &bundle).unwrap();
        assert_eq!(observed.status, ObservationStatus::Available);
        assert_eq!(observed.image.architecture.as_deref(), reported);
        assert_eq!(observed.image.repo_digests, [image]);
        assert!(observed.catalog.unwrap().runtime.is_some());
    }
}

#[test]
fn platforms_with_different_catalogs_are_rejected() {
    let mut blobs = BTreeMap::new();
    let mut other = catalog();
    other.adapters.pop();
    let manifests = [
        platform(
            &mut blobs,
            "arm64",
            &serde_json::to_string(&catalog()).unwrap(),
        ),
        platform(&mut blobs, "amd64", &serde_json::to_string(&other).unwrap()),
    ];
    let root = add(
        &mut blobs,
        &json!({"schemaVersion":2,"mediaType":OCI_INDEX,"manifests":manifests}),
    );
    let bundle = json!({"schema_version":2,"blobs":blobs});
    assert!(check(&format!("registry/agent@{root}"), &bundle).is_err());
}

#[test]
fn changed_blobs_missing_links_and_mutable_references_are_rejected() {
    let (image, bundle) = fixture(true, &["arm64", "amd64"]);
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
    let mut older = bundle.clone();
    older["schema_version"] = json!(1);
    assert!(check(&image, &older).is_err());
    assert!(verify(&vec![b' '; MAX_BUNDLE_BYTES + 1], &image).is_err());
}

#[test]
fn descriptor_size_platform_and_ambiguity_are_verified_against_the_root_digest() {
    let (image, bundle) = fixture(true, &["arm64"]);
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
                // A Linux platform the bundle doesn't carry.
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
        assert!(
            check(&format!("registry/agent@{digest}"), &changed).is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn verified_config_must_advertise_a_linux_runtime_contract() {
    let (image, bundle) = fixture(false, &["arm64"]);
    let manifest_digest = image.rsplit_once('@').unwrap().1;
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
        let changed = json!({"schema_version":2,"blobs":blobs});
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
    let (image, bundle) = fixture(true, &["arm64"]);
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
