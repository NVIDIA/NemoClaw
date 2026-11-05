// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Historical intent parity: each live hosted case in `cases` preserves the
//! portable intent of a reviewed raw v0 export. The live lifecycle of those
//! cases is `tests/e2e/hcl/tests/docker-{openclaw,hermes}-v0-parity.tftest.hcl`.

use nemoclaw_sdk::config::{ComputeDriver, Document, Gateway, HarnessKind, InferenceProviderKind};
use serde_json::json;

/// A v0 list of named entries as a v1 map keyed by name.
fn keyed_by_name(list: serde_json::Value, collection: &str) -> serde_json::Value {
    list.as_array()
        .unwrap_or_else(|| panic!("raw v0 export requires its historical {collection} list"))
        .iter()
        .map(|entry| {
            let mut entry = entry.clone();
            let name = entry.as_object_mut().unwrap().remove("name").unwrap();
            (name.as_str().unwrap().to_owned(), entry)
        })
        .collect::<serde_json::Map<_, _>>()
        .into()
}

// This scenario compares separately authored current intent with a test-only
// projection. The raw export remains unchanged and never reaches deployment.
fn authored_document(raw: &[u8], current: &[u8]) -> Document {
    let document =
        Document::parse(current).expect("authored v1 input must use current agent syntax");
    let mut projected: serde_json::Value =
        serde_saphyr::from_str(std::str::from_utf8(raw).unwrap()).unwrap();
    // v0 listed providers and sandboxes with their names; v1 keys them by name.
    for collection in ["inferenceProviders", "sandboxes"] {
        projected["spec"][collection] =
            keyed_by_name(projected["spec"][collection].take(), collection);
    }
    let sandboxes = projected["spec"]["sandboxes"].as_object_mut().unwrap();
    assert_eq!(sandboxes.len(), 1, "hosted parity requires one sandbox");
    let sandbox = sandboxes
        .values_mut()
        .next()
        .unwrap()
        .as_object_mut()
        .unwrap();
    let agents = sandbox
        .remove("agents")
        .expect("raw v0 export requires its historical agents list");
    assert_eq!(agents.as_array().unwrap().len(), 1);
    assert!(!sandbox.contains_key("agent"));
    sandbox.insert("agent".into(), agents[0].clone());
    // Migration is explicit test-only authoring, never production alias dispatch.
    let harness = sandbox["harness"].as_object_mut().unwrap();
    harness["kind"] = match harness["kind"].as_str().unwrap() {
        "openclaw" => json!("nvidia.fabric.openclaw"),
        "hermes" => json!("nvidia.fabric.hermes"),
        other => panic!("unexpected historical fixture adapter {other}"),
    };
    // v0 declared Hermes's native API under the harness; v1 passes it to
    // Fabric's Hermes adapter as an adapter setting.
    let interfaces = harness.remove("interfaces");
    assert_eq!(
        interfaces.is_some(),
        harness["kind"] == "nvidia.fabric.hermes",
        "only the Hermes export declares native interfaces"
    );
    if let Some(interfaces) = interfaces {
        harness.insert("settings".into(), json!({ "interfaces": interfaces }));
    }
    // v0 images ran agents as 1000:1000; v1 images use 10001:10001.
    if let Some(process) = sandbox
        .get_mut("network")
        .and_then(|network| network.pointer_mut("/policy/explicit/process"))
    {
        for field in ["run_as_user", "run_as_group"] {
            if process[field] == "1000" {
                process[field] = json!("10001");
            }
        }
    }
    // The v1 Hermes image's adapter reads Fabric's relay plugins, so an
    // explicit filesystem policy must also grant that directory read access.
    if sandbox["harness"]["kind"] == "nvidia.fabric.hermes"
        && let Some(read_only) = sandbox
            .get_mut("network")
            .and_then(|network| network.pointer_mut("/policy/explicit/filesystem_policy/read_only"))
            .and_then(|paths| paths.as_array_mut())
    {
        read_only.push(json!("/opt/nemo-relay/plugins/switchyard"));
    }
    // The export records no image; the live case names the image template CI binds.
    if !sandbox.contains_key("image") {
        let image = match sandbox["harness"]["kind"].as_str().unwrap() {
            "nvidia.fabric.hermes" => {
                "nc-fabric-hermes@sha256:0000000000000000000000000000000000000000000000000000000000000000"
            }
            "nvidia.fabric.openclaw" => {
                "nc-fabric@sha256:0000000000000000000000000000000000000000000000000000000000000000"
            }
            other => panic!("unexpected fixture image {other}"),
        };
        sandbox.insert("image".into(), json!({"ref":image}));
    }

    assert_eq!(
        Document::parse(projected.to_string().as_bytes()).unwrap(),
        document,
        "authored v1 configuration must preserve the raw export's portable intent"
    );
    document
}

#[test]
fn live_inputs_preserve_raw_export_and_require_matching_authored_intent() {
    for (raw, current) in [
        (
            include_bytes!("../../fixtures/openclaw-nvidia-hosted/v0-export.yaml").as_slice(),
            include_bytes!("../../cases/docker-openclaw-v0-parity.yaml").as_slice(),
        ),
        (
            include_bytes!("../../fixtures/hermes-nvidia-hosted/v0-export.yaml").as_slice(),
            include_bytes!("../../cases/docker-hermes-v0-parity.yaml").as_slice(),
        ),
    ] {
        let document = authored_document(raw, current);
        assert_eq!(document, Document::parse(current).unwrap());
        let mut changed = document.clone();
        changed
            .spec
            .sandboxes
            .get_mut("assistant")
            .unwrap()
            .agent
            .name = "different-agent".into();
        assert!(
            std::panic::catch_unwind(|| authored_document(raw, changed.yaml().unwrap().as_bytes()))
                .is_err()
        );
    }
}

fn assert_hosted_document(document: &Document, harness: HarnessKind, runtime_root: &str) {
    let gateway = &document.spec.gateway;
    assert!(matches!(gateway, Gateway::Managed(_)));
    let gateway = gateway.as_managed().unwrap();
    assert_eq!(gateway.engine, "unix:///var/run/docker.sock");

    let provider = &document.spec.inference_providers["hosted-nvidia-prod"];
    assert_eq!(provider.provider, InferenceProviderKind::Openai);
    assert_eq!(provider.endpoint, "https://integrate.api.nvidia.com/v1");
    assert_eq!(
        provider.credential.as_ref().unwrap().env,
        "NVIDIA_INFERENCE_API_KEY"
    );
    assert!(provider.service_ref.is_none());

    let sandbox = document.sandbox("assistant").unwrap();
    assert!(sandbox.image.ref_.contains("@sha256:"));
    assert_eq!(sandbox.image.ref_.rsplit(':').next().unwrap().len(), 64);
    assert_eq!(
        document.spec.gateway.runtime().provider,
        ComputeDriver::Docker
    );
    let nemoclaw_sdk::config::NetworkPolicy::Explicit(explicit) = &sandbox.network.policy else {
        panic!("expected explicit policy");
    };
    let process = explicit.process.as_ref().unwrap();
    assert_eq!(process.run_as_user.as_deref(), Some("10001"));
    assert_eq!(process.run_as_group.as_deref(), Some("10001"));
    let read_only = explicit
        .filesystem_policy
        .as_ref()
        .unwrap()
        .read_only
        .as_ref()
        .unwrap();
    for root in [runtime_root, "/opt/fabric", "/opt/nemoclaw"] {
        assert!(
            read_only.iter().any(|path| path == root),
            "raw export policy must grant the v1 runtime root {root}"
        );
    }
    assert_eq!(document.sandbox_harness(sandbox).unwrap().kind, harness);
    let inference = document.sandbox_inference(sandbox).unwrap();
    assert_eq!(
        inference.routes[0].provider_ref.as_deref(),
        Some("hosted-nvidia-prod")
    );
    assert_eq!(
        inference.routes[0].overrides.model,
        "nvidia/nemotron-3.5-super-vl-120b-a12b"
    );
}

#[test]
fn hosted_openclaw_scenario_preserves_authored_intent() {
    let raw = include_bytes!("../../fixtures/openclaw-nvidia-hosted/v0-export.yaml");
    let v1 = authored_document(
        raw,
        include_bytes!("../../cases/docker-openclaw-v0-parity.yaml"),
    );
    assert_hosted_document(&v1, "nvidia.fabric.openclaw".parse().unwrap(), "/app");
}

#[test]
fn hosted_hermes_scenario_preserves_authored_intent() {
    let export = include_bytes!("../../fixtures/hermes-nvidia-hosted/v0-export.yaml");
    let v1 = authored_document(
        export,
        include_bytes!("../../cases/docker-hermes-v0-parity.yaml"),
    );
    assert_hosted_document(&v1, "nvidia.fabric.hermes".parse().unwrap(), "/opt/hermes");
    let harness = v1
        .sandbox_harness(v1.sandbox("assistant").unwrap())
        .unwrap();
    assert_eq!(
        harness.settings,
        serde_json::json!({"interfaces": {"api": {"port": 8643}}})
            .as_object()
            .cloned(),
        "the v0 export's API interface becomes a Hermes adapter setting"
    );
}
