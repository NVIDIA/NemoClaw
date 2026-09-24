// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    fabric_capabilities::{
        FabricRequirements, ImageMetadata, Support, assess_fabric, assess_image_platform,
        project_adapter,
    },
    fabric_catalog::FabricCatalog,
};

#[test]
fn canonical_api_and_streaming_rejections_are_distinct_from_missing_metadata() {
    let catalog = FabricCatalog::bundled();
    let request = FabricRequirements {
        harness: "openclaw".into(),
        api: Some("unsupported-protocol".into()),
        ..Default::default()
    };
    assert_eq!(
        assess_fabric(&catalog, &request).status,
        Support::Unsupported
    );
    let request = FabricRequirements {
        harness: "deepagents".into(),
        api: Some("openai-completions".into()),
        ..Default::default()
    };
    assert_eq!(assess_fabric(&catalog, &request).status, Support::Unknown);
    let request = FabricRequirements {
        harness: "pi".into(),
        streaming: true,
        ..Default::default()
    };
    assert_eq!(
        assess_fabric(&catalog, &request).status,
        Support::Unsupported
    );
    let request = FabricRequirements {
        harness: "remote-agent".into(),
        streaming: true,
        ..Default::default()
    };
    assert_eq!(assess_fabric(&catalog, &request).status, Support::Supported);
}

#[test]
fn descriptor_projection_preserves_tools_interfaces_fields_and_runtime_requirements() {
    let catalog = FabricCatalog::bundled();
    let pi = project_adapter(catalog.adapters.iter().find(|a| a.harness == "pi").unwrap());
    assert_eq!(pi.tools, Support::Supported);
    assert_eq!(pi.required_binaries, Some(vec!["node".into()]));
    assert!(
        pi.config_fields
            .unwrap()
            .contains(&"tools.definitions".into())
    );
    let openclaw = project_adapter(
        catalog
            .adapters
            .iter()
            .find(|a| a.harness == "openclaw")
            .unwrap(),
    );
    assert_eq!(openclaw.interfaces, Some(vec!["dashboard".into()]));
    assert_eq!(openclaw.streaming, Support::Unknown);
}

#[test]
fn engine_platform_comparison_normalizes_aliases_and_preserves_unknowns() {
    let image = ImageMetadata {
        architecture: Some("arm64".into()),
        operating_system: Some("linux".into()),
        ..Default::default()
    };
    assert_eq!(
        assess_image_platform(&image, Some("aarch64"), Some("linux")).status,
        Support::Supported
    );
    assert_eq!(
        assess_image_platform(&image, Some("x86_64"), Some("linux")).status,
        Support::Unsupported
    );
    assert_eq!(
        assess_image_platform(&image, None, Some("linux")).status,
        Support::Unknown
    );
}

#[test]
fn unused_schema_definitions_and_open_interface_objects_do_not_imply_closed_capabilities() {
    let mut catalog = FabricCatalog::bundled();
    catalog
        .adapters
        .retain(|adapter| adapter.harness == "openclaw");
    let descriptor = &mut catalog.adapters[0].descriptor;
    descriptor["settings_schema"]["properties"]["inference"]["properties"]
        .as_object_mut()
        .unwrap()
        .remove("api");
    descriptor["settings_schema"]["properties"]["inference"]["properties"]["interfaces"]["additionalProperties"] =
        serde_json::json!(true);
    let request = FabricRequirements {
        harness: "openclaw".into(),
        api: Some("new-api".into()),
        interfaces: vec!["new-interface".into()],
        ..Default::default()
    };
    assert_eq!(assess_fabric(&catalog, &request).status, Support::Unknown);
}

#[test]
fn compatibility_cannot_combine_different_adapters_to_satisfy_one_request() {
    let mut catalog = FabricCatalog::bundled();
    catalog
        .adapters
        .retain(|adapter| adapter.harness == "remote-agent");
    let mut other = catalog.adapters[0].clone();
    other.adapter_id = "example.second".into();
    other.descriptor["capabilities"]["streaming"] = serde_json::json!(false);
    catalog.adapters[0].descriptor["settings_schema"]["properties"]["api_type"]["enum"] =
        serde_json::json!(["openai-responses"]);
    catalog.adapters.push(other);
    let request = FabricRequirements {
        harness: "remote-agent".into(),
        api: Some("openai-completions".into()),
        streaming: true,
        ..Default::default()
    };
    assert_eq!(
        assess_fabric(&catalog, &request).status,
        Support::Unsupported
    );
}

#[test]
fn document_requirements_follow_native_api_tool_and_interface_configuration() {
    let document = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/fabric-openclaw.yaml").as_slice(),
    )
    .unwrap();
    let request = FabricRequirements::for_sandbox(&document, &document.spec.sandboxes[0]).unwrap();
    assert_eq!(request.harness, "openclaw");
    assert_eq!(request.api.as_deref(), Some("openai-completions"));
    assert_eq!(
        assess_fabric(&FabricCatalog::bundled(), &request).status,
        Support::Supported
    );
}

#[test]
fn image_digest_evidence_distinguishes_matching_substituted_and_unrecorded_images() {
    use nemoclaw_sdk::fabric_capabilities::assess_image_digest;
    let image = ImageMetadata {
        repo_digests: vec![format!("registry/agent@sha256:{}", "a".repeat(64))],
        ..Default::default()
    };
    assert_eq!(
        assess_image_digest(&image, &format!("mirror/agent@sha256:{}", "a".repeat(64))).status,
        Support::Supported
    );
    assert_eq!(
        assess_image_digest(&image, &format!("registry/agent@sha256:{}", "b".repeat(64))).status,
        Support::Unsupported
    );
    assert_eq!(
        assess_image_digest(
            &ImageMetadata::default(),
            &format!("agent@sha256:{}", "a".repeat(64))
        )
        .status,
        Support::Unknown
    );
}
