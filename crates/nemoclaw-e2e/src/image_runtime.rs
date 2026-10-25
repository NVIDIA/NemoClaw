// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    compile::{Generations, Target},
    config::Document,
    image_runtime::RuntimeBinding,
};

pub fn binding(adapter_id: &str) -> RuntimeBinding {
    let mut runtime: serde_json::Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    runtime["binaries"] = serde_json::json!({adapter_id:["/usr/local/bin/python3.99"]});
    RuntimeBinding::from_json(
        &serde_json::json!({"runtime":runtime,"adapter_id":adapter_id}).to_string(),
    )
    .unwrap()
}

pub fn policy() -> openshell_core::proto::SandboxPolicy {
    binding("fixture").runtime.policy.to_proto().unwrap()
}

/// Resolve metadata inputs explicitly for protocol tests that bypass OpenTofu discovery.
pub fn targets(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<Target>, nemoclaw_sdk::config::ConfigError> {
    let mut targets = nemoclaw_sdk::compile::targets(document, generations)?;
    for target in &mut targets {
        if target.kind == "provider_profile" || target.kind == "web_search" {
            target.values.insert(
                "binaries_json".into(),
                serde_json::json!(["/usr/local/bin/python3.99"]).to_string(),
            );
        } else if target.kind == "sandbox" {
            let sandbox = document
                .spec
                .sandboxes
                .iter()
                .find(|sandbox| sandbox.name == target.values["name"])
                .unwrap();
            let requirements =
                nemoclaw_sdk::fabric_capabilities::requirements_for_sandbox(document, sandbox)?;
            let adapter = requirements.configuration["harness"]["adapter_id"]
                .as_str()
                .unwrap();
            // The graph carries the agent in the launch, not as a sandbox input.
            target.values.remove("agent_name");
            target.values.insert(
                "launch_json".into(),
                serde_json::to_string(&binding(adapter).launch(&sandbox.agent.name)).unwrap(),
            );
        }
    }
    Ok(targets)
}

use crate::http_fixture as transport;

/// Installed-image metadata for isolated fixtures.
pub fn catalog() -> nemoclaw_sdk::fabric_catalog::FabricCatalog {
    use nemoclaw_sdk::fabric_catalog::FabricCatalog;
    let mut catalog = FabricCatalog::bundled();
    let mut runtime = binding("fixture").runtime;
    runtime.binaries = catalog
        .adapters
        .iter()
        .map(|adapter| {
            (
                adapter.adapter_id().into(),
                vec!["/usr/local/bin/python3.99".into()],
            )
        })
        .collect();
    catalog.runtime = Some(runtime);
    catalog
}

/// Write the metadata bundle of a fixture image labeled with `catalog()` to
/// `directory`, for deployments on Kubernetes or OpenShift, where no engine
/// inspects images. Returns the image's digest reference and the bundle's path.
pub fn metadata_bundle(directory: &std::path::Path) -> (String, std::path::PathBuf) {
    use nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL;
    use sha2::{Digest, Sha256};
    let digest = |raw: &str| {
        let hex: String = Sha256::digest(raw.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        format!("sha256:{hex}")
    };
    let label = serde_json::to_string(&catalog()).unwrap();
    let config = serde_json::json!({"os":"linux", "architecture":"arm64", "config":{"Labels":{IMAGE_CATALOG_LABEL:label}}})
        .to_string();
    let config_digest = digest(&config);
    // Verification checks each descriptor's media type and size against its blob.
    let manifest = serde_json::json!({
        "schemaVersion":2, "mediaType":"application/vnd.oci.image.manifest.v1+json",
        "config":{"mediaType":"application/vnd.oci.image.config.v1+json", "digest":config_digest, "size":config.len()},
        "layers":[]
    })
    .to_string();
    let manifest_digest = digest(&manifest);
    // The reference names the root blob, so the bundle carries only blobs.
    let bundle = serde_json::json!({"schema_version":2,
        "blobs":{&manifest_digest:manifest, &config_digest:config}});
    let path = directory.join("image-metadata.json");
    std::fs::write(&path, serde_json::to_vec(&bundle).unwrap()).unwrap();
    (format!("fixture/agent@{manifest_digest}"), path)
}

/// Installed-image evidence for isolated deployment tests; never queries a live engine.
pub async fn engine(document: &mut Document) -> transport::Fixture {
    use nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL;
    let label = serde_json::to_string(&catalog()).unwrap();
    // Report each image as Docker does: a digest reference without its tag,
    // and the tag separately, so OpenTofu's Docker provider finds it.
    let mut references = Vec::new();
    let mut tags = Vec::new();
    for sandbox in &document.spec.sandboxes {
        let reference = &sandbox.image.ref_;
        let (name, digest) = reference.split_once('@').unwrap_or((reference, ""));
        let slash = name.rfind('/').map_or(0, |index| index + 1);
        let repository = match name[slash..].rfind(':') {
            Some(colon) => {
                tags.push(name.to_owned());
                &name[..slash + colon]
            }
            None => name,
        };
        references.push(if digest.is_empty() {
            repository.to_owned()
        } else {
            format!("{repository}@{digest}")
        });
    }
    let fixture = transport::Fixture::engine(move |request| {
        assert!(request.body.is_empty());
        // OpenTofu's Docker provider, which the plan uses to pull sandbox
        // images, pings and lists through versioned paths; the fixture
        // already holds every sandbox image, so nothing is pulled.
        let path = request.path.split('?').next().unwrap_or_default();
        let path = match path.strip_prefix("/v1.") {
            Some(rest) => &rest[rest.find('/').unwrap_or(rest.len())..],
            None => path,
        };
        if path == "/_ping" {
            return Some((200, b"OK".to_vec()));
        }
        assert_eq!(request.method, "GET", "{}", request.path);
        let inspect = serde_json::json!({"Id":"sha256:fixture", "Architecture":"arm64", "Os":"linux", "RepoDigests":references, "Config":{"Labels":{IMAGE_CATALOG_LABEL:label}}});
        let value = match path {
            "/info" => serde_json::json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"}),
            "/version" => serde_json::json!({"ApiVersion":"1.47", "MinAPIVersion":"1.24", "Version":"28.0", "Os":"linux", "Arch":"arm64"}),
            "/images/json" => serde_json::json!([{"Id":"sha256:fixture", "RepoTags":tags, "RepoDigests":references, "Labels":{}, "Size":1}]),
            _ => {
                assert!(path.starts_with("/images/") && path.ends_with("/json"), "{}", request.path);
                inspect
            }
        };
        Some((200, serde_json::to_vec(&value).unwrap()))
    }).await;
    let nemoclaw_sdk::config::Gateway::External(gateway) = &mut document.spec.gateway else {
        panic!("fixture requires an external gateway")
    };
    gateway.engine = fixture.endpoint.clone();
    fixture
}
