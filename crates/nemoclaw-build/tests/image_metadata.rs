// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The metadata bundle a cluster sandbox names in `image.metadata`.

use nemoclaw_build::images::metadata_bundle;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

fn digest(bytes: &[u8]) -> String {
    format!("sha256:{}", nemoclaw_build::hex(&Sha256::digest(bytes)))
}

/// An OCI layout as `docker image save` writes it: an outer index naming
/// the image's own index, which lists one manifest and an attestation.
fn layout(catalog: &str) -> (Vec<u8>, String) {
    let config = json!({"os": "linux", "architecture": "arm64",
        "config": {"Labels": {"io.nemoclaw.fabric.catalog": catalog}}})
    .to_string();
    let manifest = json!({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": digest(config.as_bytes()), "size": config.len()},
        "layers": [{"mediaType": "application/vnd.oci.image.layer.v1.tar+gzip", "digest": digest(b"layer"), "size": 5}]}).to_string();
    let attestation = json!({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": digest(b"{}"), "size": 2}, "layers": []}).to_string();
    let index = json!({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [
        {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": digest(manifest.as_bytes()), "size": manifest.len(),
         "platform": {"architecture": "arm64", "os": "linux"}},
        {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": digest(attestation.as_bytes()), "size": attestation.len(),
         "platform": {"architecture": "unknown", "os": "unknown"},
         "annotations": {"vnd.docker.reference.type": "attestation-manifest"}},
    ]}).to_string();
    let outer = json!({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json", "manifests": [
        {"mediaType": "application/vnd.oci.image.index.v1+json", "digest": digest(index.as_bytes()), "size": index.len()}]}).to_string();
    let mut archive = tar::Builder::new(Vec::new());
    let mut add = |path: &str, bytes: &[u8]| {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        archive.append_data(&mut header, path, bytes).unwrap();
    };
    for blob in [&config, &manifest, &attestation, &index] {
        add(
            &format!("blobs/sha256/{}", &digest(blob.as_bytes())[7..]),
            blob.as_bytes(),
        );
    }
    add("blobs/sha256/layerlayerlayer", b"layer");
    add("index.json", outer.as_bytes());
    (archive.into_inner().unwrap(), digest(index.as_bytes()))
}

#[test]
fn the_bundle_holds_the_index_manifest_and_config_only() {
    let (archive, root) = layout("{}");
    let bundle: Value =
        serde_json::from_slice(&metadata_bundle(&archive, "linux/arm64").unwrap()).unwrap();
    assert_eq!(bundle["schema_version"], 1);
    let blobs = bundle["blobs"].as_object().unwrap();
    assert_eq!(
        blobs.len(),
        3,
        "index, one manifest and its config; no attestation or layers"
    );
    assert!(blobs.contains_key(&root));
    let manifest = bundle["manifest_digest"].as_str().unwrap();
    let manifest: Value = serde_json::from_str(blobs[manifest].as_str().unwrap()).unwrap();
    assert_eq!(manifest["layers"][0]["size"], 5);
    for (digest_text, raw) in blobs {
        assert_eq!(
            &digest(raw.as_str().unwrap().as_bytes()),
            digest_text,
            "blobs keep their exact bytes"
        );
    }
}

#[test]
fn an_image_without_the_requested_platform_is_refused() {
    let (archive, _) = layout("{}");
    assert!(metadata_bundle(&archive, "linux/amd64").is_err());
}

#[test]
fn the_sdk_verifies_an_exported_bundle_for_the_image_reference() {
    let catalog = serde_json::to_string(&{
        let mut catalog = nemoclaw_sdk::fabric_catalog::FabricCatalog::bundled();
        let mut runtime: Value =
            serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
        runtime["binaries"] = Value::Object(
            catalog
                .adapters
                .iter()
                .map(|adapter| {
                    (
                        adapter.adapter_id().into(),
                        json!(["/opt/fabric/bin/python"]),
                    )
                })
                .collect(),
        );
        catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
        catalog
    })
    .unwrap();
    let (archive, root) = layout(&catalog);
    let bundle = metadata_bundle(&archive, "linux/arm64").unwrap();
    let observation = nemoclaw_sdk::image_metadata::verify(
        &bundle,
        &format!("registry.example.com/agent@{root}"),
    )
    .unwrap();
    assert!(observation.catalog.is_some());
}
