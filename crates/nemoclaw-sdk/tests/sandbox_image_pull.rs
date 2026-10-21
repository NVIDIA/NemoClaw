// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! On Docker and Podman, the plan pulls each sandbox image through the Docker
//! provider, with the logins `spec.registries` selects, before the reads that
//! need its catalog label: an image the engine doesn't hold yet defers them.

use nemoclaw_sdk::{
    compile::{Generations, compile},
    config::Document,
};
use serde_json::Value;

fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "ollama",
        "managed_gateway",
        "inference_service",
        "kubernetes_gateway",
        "kubernetes_storage",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

fn graph(value: &Value) -> (Document, Value) {
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let graph = compile(&document, &generations(), "0.1.0").unwrap();
    (document, graph)
}

fn example(text: &str) -> Value {
    serde_saphyr::from_str(text).unwrap()
}

/// Docker and Podman gateways whose engine holds the sandbox images.
fn local_gateways() -> Vec<Value> {
    let mut external = example(include_str!("../../../examples/fabric-openclaw.yaml"));
    external["spec"]["gateway"]["engine"] = "unix:///var/run/docker.sock".into();
    let mut managed = example(include_str!("../../../examples/fabric-openclaw.yaml"));
    managed["spec"]["gateway"] = serde_json::json!({
        "management": "managed",
        "runtime": {"provider": "docker"},
        "endpoint": "http://127.0.0.1:17681",
        "engine": "unix:///var/run/docker.sock",
        "networkCIDR": "172.30.250.0/24",
    });
    let podman = example(include_str!("../../../examples/managed-podman.yaml"));
    vec![external, managed, podman]
}

#[test]
fn a_docker_sandbox_image_is_pulled_before_the_reads_that_need_it() {
    for value in local_gateways() {
        let (document, graph) = graph(&value);
        let example = document.metadata.name.clone();
        let sandbox = &document.spec.sandboxes[0];
        let reference = &sandbox.image.ref_;
        let pulls: Vec<(&String, &Value)> = graph["resource"]["docker_image"]
            .as_object()
            .unwrap()
            .iter()
            .filter(|(_, image)| image["name"] == reference.as_str())
            .collect();
        let [(pull, image)] = pulls.as_slice() else {
            panic!("expected one pull of {reference}: {pulls:?}");
        };
        assert_eq!(image["keep_locally"], true);
        assert!(image["provider"].as_str().unwrap().starts_with("docker."));
        let image_id = format!("${{docker_image.{pull}.image_id}}");

        // Discovery still reads at plan time, and accepts an image the
        // engine doesn't hold yet.
        let reads = &graph["data"]["fabric_harnesses"];
        let accepts = |read: &Value| read["lifecycle"]["postcondition"][1]["condition"].clone();
        assert_eq!(
            accepts(&reads["sandbox_0"]),
            "${self.runtime_json != \"\" || self.status == \"unavailable\"}"
        );
        assert!(reads["sandbox_0"].get("image_id").is_none());
        // The reads the sandbox and its agent use wait for the pull, and
        // require the runtime the pulled image declares.
        let acquired = &reads["sandbox_0_acquired"];
        assert_eq!(acquired["image_id"], image_id.as_str());
        assert_eq!(acquired["image"], reads["sandbox_0"]["image"]);
        assert_eq!(accepts(acquired), "${self.runtime_json != \"\"}");
        let harnesses = &graph["data"]["fabric_harness"];
        let harness = &harnesses[format!("{}_acquired", sandbox.name)];
        assert_eq!(harness["image_id"], image_id.as_str());
        assert_eq!(harness["image"], reads["sandbox_0"]["image"]);
        assert!(harnesses.get(&sandbox.name).is_none());
        let resources = graph["resource"].to_string();
        assert!(
            resources.contains("data.fabric_harnesses.sandbox_0_acquired."),
            "{example}"
        );
        assert!(
            !resources.contains("data.fabric_harnesses.sandbox_0."),
            "{example}"
        );
    }
}

#[test]
fn a_kubernetes_sandbox_reads_its_metadata_bundle_without_a_pull() {
    let (_, graph) = graph(&example(include_str!(
        "../../../examples/kubernetes/managed-development.yaml"
    )));
    assert!(graph["resource"].get("docker_image").is_none());
    let reads = &graph["data"]["fabric_harnesses"];
    assert_eq!(
        reads["sandbox_0"]["lifecycle"]["postcondition"][1]["condition"],
        "${self.runtime_json != \"\"}"
    );
    assert!(reads.get("sandbox_0_acquired").is_none());
}
