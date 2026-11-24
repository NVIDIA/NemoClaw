// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Authoring a new deployment for another gateway target takes only the
//! edits the usage guide lists: the target and its settings, each sandbox's
//! image metadata, managed services a target can't run, OpenShell's settings
//! and each sandbox's driver configuration, and who registers APF. A live deployment keeps its target; changing it
//! needs a new deployment.

use nemoclaw_sdk::config::Document;
use serde_json::{Map, Value, json};

const PODMAN: &str = "unix:///run/user/1000/podman/podman.sock";
const ENGINE: &str = "unix:///var/run/docker.sock";
const ENDPOINT: &str = "https://gateway.example.com";
const INFERENCE: &str = "https://inference.example.com/v1";

#[derive(Clone, Copy, Debug)]
enum Management {
    Managed,
    External,
}

/// Each gateway target a document can name.
const TARGETS: [(Management, &str); 8] = [
    (Management::Managed, "docker"),
    (Management::Managed, "podman"),
    (Management::Managed, "kubernetes"),
    (Management::Managed, "openshift"),
    (Management::External, "docker"),
    (Management::External, "podman"),
    (Management::External, "kubernetes"),
    (Management::External, "openshift"),
];

fn cluster(key: &str) -> bool {
    matches!(key, "kubernetes" | "openshift")
}

/// The cluster settings an example names, or the minimum a new managed
/// cluster target takes.
fn cluster_settings(gateway: &Value, key: &str) -> Value {
    let named = gateway["target"]
        .as_object()
        .and_then(|target| {
            target
                .iter()
                .find(|(name, _)| cluster(name))
                .map(|(_, settings)| settings.clone())
        })
        .filter(|_| gateway["management"] == "managed");
    let mut settings = named.unwrap_or_else(|| {
        json!({
            "kubeconfig": {"env": "NEMOCLAW_CLUSTER_KUBECONFIG"},
            "context": "example",
            "namespace": "nemoclaw",
            "authentication": {"profile": "development"}
        })
    });
    // Only OpenShift serves Routes; on Kubernetes, a Service publishes the
    // gateway or nothing does.
    if key == "kubernetes" && settings["expose"].get("route").is_some() {
        settings.as_object_mut().unwrap().remove("expose");
    }
    settings
}

/// The edit to `spec.gateway`: the new target and its settings; for a
/// managed gateway, OpenShell's settings stay in `config`, and only the
/// managed docker target has NemoClaw register APF.
fn gateway(original: &Value, management: Management, key: &str) -> Value {
    let mut gateway = Map::new();
    let target = match (management, key) {
        (Management::Managed, "docker") => json!({}),
        (Management::Managed, "podman") => json!({"engine": PODMAN}),
        (Management::Managed, _) => cluster_settings(original, key),
        (Management::External, "docker" | "podman") => json!({"engine": ENGINE}),
        (Management::External, _) => json!({}),
    };
    let external = original["management"] == "external";
    match management {
        Management::Managed => {
            gateway.insert("management".into(), json!("managed"));
            if let Some(config) = original.get("config") {
                gateway.insert("config".into(), config.clone());
            }
        }
        Management::External => {
            gateway.insert("management".into(), json!("external"));
            // An existing gateway's address and credentials are its own.
            let endpoint = original["endpoint"]
                .as_str()
                .filter(|_| external)
                .unwrap_or(ENDPOINT);
            gateway.insert("endpoint".into(), json!(endpoint));
            for field in ["credential", "tls"] {
                if let Some(value) = original.get(field).filter(|_| external) {
                    gateway.insert(field.into(), value.clone());
                }
            }
        }
    }
    gateway.insert("target".into(), json!({ key: target }));
    if let Some(authority) = original.get("policyAuthority") {
        let mut authority = authority.clone();
        if !matches!((management, key), (Management::Managed, "docker")) {
            authority["apf"] = json!({"registration": "external"});
        }
        gateway.insert("policyAuthority".into(), authority);
    }
    Value::Object(gateway)
}

/// Whether the target runs `service`: the managed docker target runs every
/// kind; a cluster runs none; elsewhere, vLLM and Ollama need an explicit
/// placement, an Ollama proxy its own engine, and a container the managed
/// docker target.
fn runs(service: &Value, management: Management, key: &str) -> bool {
    match (management, key) {
        (Management::Managed, "docker") => true,
        (_, key) if cluster(key) => false,
        _ => match service["kind"].as_str().unwrap() {
            "vllm" | "ollama" => service.get("placement").is_some(),
            "ollamaProxy" => service.get("engine").is_some(),
            _ => false,
        },
    }
}

/// Point every inference provider that used `service` at an endpoint the
/// sandboxes reach instead, wherever a provider is defined.
fn replace_service_providers(value: &mut Value, service: &str) {
    fn visit(value: &mut Value, service: &str) {
        match value {
            Value::Object(object) => {
                if object.get("serviceRef").and_then(Value::as_str) == Some(service) {
                    object.remove("serviceRef");
                    object.insert("endpoint".into(), json!(INFERENCE));
                }
                object.values_mut().for_each(|child| visit(child, service));
            }
            Value::Array(items) => items.iter_mut().for_each(|child| visit(child, service)),
            _ => {}
        }
    }
    visit(value, service);
}

/// The compute driver a target's sandboxes run on.
fn driver(key: &str) -> &'static str {
    match key {
        "docker" => "docker",
        "podman" => "podman",
        _ => "kubernetes",
    }
}

/// Move OpenShell's driver settings, in a managed gateway's `config` and each
/// sandbox's `driverConfig`, to the new driver's table and key.
fn move_driver_settings(value: &mut Value, key: &str) {
    let new = driver(key);
    if let Some(config) = value["spec"]["gateway"]
        .get_mut("config")
        .and_then(Value::as_object_mut)
    {
        *config = std::mem::take(config)
            .into_iter()
            .map(|(table, fields)| {
                let moved = ["docker", "podman", "kubernetes"]
                    .into_iter()
                    .find_map(|old| {
                        let rest = table.strip_prefix(&format!("openshell.drivers.{old}"))?;
                        (rest.is_empty() || rest.starts_with('.'))
                            .then(|| format!("openshell.drivers.{new}{rest}"))
                    })
                    .unwrap_or(table);
                (moved, fields)
            })
            .collect();
    }
    for sandbox in value["spec"]["sandboxes"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        if let Some(settings) = sandbox
            .get_mut("driverConfig")
            .and_then(Value::as_object_mut)
        {
            *settings = std::mem::take(settings)
                .into_values()
                .map(|fields| (new.to_owned(), fields))
                .collect();
        }
    }
}

/// The example as a new deployment on `key`, with only the documented edits.
fn retarget(example: &Value, management: Management, key: &str) -> Value {
    let mut value = example.clone();
    value["spec"]["gateway"] = gateway(&example["spec"]["gateway"], management, key);
    // A cluster has no engine to inspect images on, so each sandbox names
    // its image's metadata bundle; Docker and Podman inspect their engine.
    for sandbox in value["spec"]["sandboxes"]
        .as_object_mut()
        .unwrap()
        .values_mut()
    {
        let image = sandbox["image"].as_object_mut().unwrap();
        if cluster(key) {
            image.insert("metadata".into(), json!({"env": "NEMOCLAW_IMAGE_METADATA"}));
        } else {
            image.remove("metadata");
        }
    }
    move_driver_settings(&mut value, key);
    let replaced: Vec<String> = value["spec"]["services"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, service)| !runs(service, management, key))
        .map(|(name, _)| name.clone())
        .collect();
    for service in replaced {
        value["spec"]["services"]
            .as_object_mut()
            .unwrap()
            .remove(&service);
        replace_service_providers(&mut value["spec"], &service);
    }
    if value["spec"]["services"]
        .as_object()
        .is_some_and(Map::is_empty)
    {
        value["spec"].as_object_mut().unwrap().remove("services");
    }
    value
}

#[test]
fn every_example_is_authored_for_every_target_with_only_the_listed_edits() {
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../examples");
    let mut checked = 0;
    for path in crate::examples::yaml_files(&directory) {
        let text = std::fs::read_to_string(&path).unwrap();
        // Onboarding templates are sparse; onboarding completes them.
        if Document::parse(text.as_bytes()).is_err() {
            assert!(
                path.components()
                    .any(|part| part.as_os_str() == "onboarding")
            );
            continue;
        }
        let example: Value = serde_saphyr::from_str(&text).unwrap();
        for (management, key) in TARGETS {
            let retargeted = retarget(&example, management, key);
            let document =
                Document::parse(retargeted.to_string().as_bytes()).unwrap_or_else(|error| {
                    panic!("{} on {management:?} {key}: {error}", path.display())
                });
            assert_eq!(document.spec.gateway.compute_driver().as_str(), key);
            checked += 1;
        }
    }
    assert!(checked >= 50 * TARGETS.len(), "checked {checked}");
}
