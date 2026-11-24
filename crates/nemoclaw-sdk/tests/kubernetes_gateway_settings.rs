// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed Kubernetes or OpenShift gateway's data volume StorageClass and
//! container resources, which reach the chart as written.

use nemoclaw_sdk::{
    compile::{Generations, compile_runtime},
    config::{Document, schema},
};
use serde_json::{Value, json};

/// A managed Kubernetes gateway whose target also holds `settings`.
fn input(settings: Value) -> Value {
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(document).unwrap();
    let mut target = json!({
        "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
        "context": "explicit-context",
        "namespace": "owned-gateway",
        "authentication": {"profile": "development"}
    });
    target
        .as_object_mut()
        .unwrap()
        .extend(settings.as_object().unwrap().clone());
    input["spec"]["gateway"] = json!({"management": "managed", "target": {"kubernetes": target}});
    input["spec"]["sandboxes"]["assistant"]["image"]["metadata"] =
        json!({"env": "TEST_IMAGE_METADATA"});
    input
}

/// The same input with a managed OpenShift gateway.
fn openshift(mut input: Value) -> Value {
    let target = input["spec"]["gateway"]["target"]["kubernetes"].take();
    input["spec"]["gateway"]["target"] = json!({"openshift": target});
    input
}

/// The input's target, Kubernetes or OpenShift.
fn target(input: &Value) -> &Value {
    let target = &input["spec"]["gateway"]["target"];
    target.get("kubernetes").unwrap_or(&target["openshift"])
}

fn parse(input: &Value) -> Result<Document, String> {
    Document::parse(input.to_string().as_bytes()).map_err(|error| error.to_string())
}

fn chart_values(document: &Value) -> Value {
    let generations: Generations = ["kubernetes_gateway", "kubernetes_storage"]
        .map(|kind| (kind.to_owned(), "a".repeat(32)))
        .into();
    let graph = compile_runtime(&parse(document).unwrap(), &generations, "0.1.0").unwrap();
    serde_json::from_str(
        graph["resource"]["helm_release"]["gateway"]["values"][0]
            .as_str()
            .unwrap(),
    )
    .unwrap()
}

#[test]
fn gateway_settings_survive_parsing_and_export_unchanged() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let sized = json!({
        "dataStorageClass": "fast-local",
        "resources": {
            "requests": {"cpu": "500m", "memory": "1Gi"},
            "limits": {"cpu": "2", "memory": "4096Mi"}
        }
    });
    for accepted in [
        input(sized.clone()),
        openshift(input(sized)),
        input(json!({"dataStorageClass": "ocs-storagecluster-ceph-rbd"})),
        // A request may equal its limit, in other units.
        input(json!({"resources": {
            "requests": {"cpu": "0.5", "memory": "1Gi"},
            "limits": {"cpu": "500m", "memory": "1024Mi"}
        }})),
        // Only what is written: no limit, or only a limit.
        input(json!({"resources": {"requests": {"memory": "512Mi"}}})),
        input(json!({"resources": {"limits": {"cpu": "1.5"}}})),
    ] {
        assert!(validator.is_valid(&accepted), "schema refused {accepted}");
        let document = parse(&accepted).unwrap();
        let exported = serde_json::to_value(&document).unwrap();
        for field in ["dataStorageClass", "resources"] {
            assert_eq!(
                target(&exported).get(field),
                target(&accepted).get(field),
                "{field} survives parsing and export unchanged"
            );
        }
    }
}

/// Each refusal comes from both the schema and the parser, with its rule.
#[test]
fn gateway_settings_rules_refuse_documents_with_the_rule_they_break() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let resources = |resources: Value| input(json!({"resources": resources}));
    for (refused, rule) in [
        (
            input(json!({"dataStorageClass": "Fast_SSD"})),
            "StorageClass name",
        ),
        (input(json!({"dataStorageClass": ""})), "StorageClass name"),
        // Kubernetes reads 256m as 0.256 bytes.
        (
            resources(json!({"requests": {"memory": "256m"}})),
            "Mi or Gi",
        ),
        (resources(json!({"limits": {"memory": "2G"}})), "Mi or Gi"),
        (resources(json!({"limits": {"cpu": "1G"}})), "millicores"),
        (resources(json!({"limits": {"cpu": 1}})), "millicores"),
        (
            resources(json!({"requests": {"ephemeral-storage": "1Gi"}})),
            "cpu and memory",
        ),
    ] {
        assert!(!validator.is_valid(&refused), "schema accepted {refused}");
        let error = parse(&refused).expect_err("parser accepted an input the schema refuses");
        assert!(error.contains(rule), "{error}");
    }
    // Kubernetes refuses a request above its limit only when Helm installs
    // the gateway; the parser refuses it first.
    for (refused, rule) in [
        (
            openshift(resources(
                json!({"requests": {"cpu": "2"}, "limits": {"cpu": "1500m"}}),
            )),
            "spec.gateway.target.openshift.resources.requests.cpu must not exceed resources.limits.cpu",
        ),
        (
            resources(json!({"requests": {"memory": "2Gi"}, "limits": {"memory": "1024Mi"}})),
            "spec.gateway.target.kubernetes.resources.requests.memory must not exceed resources.limits.memory",
        ),
    ] {
        let error = parse(&refused).unwrap_err();
        assert!(error.contains(rule), "{error}");
    }
}

/// What is written reaches the chart, and nothing is added: here, no CPU
/// limit.
#[test]
fn the_chart_receives_the_volume_class_and_resources_as_written() {
    let resources = json!({
        "requests": {"cpu": "500m", "memory": "1Gi"},
        "limits": {"memory": "4Gi"}
    });
    let settings = json!({"dataStorageClass": "fast-local", "resources": resources});
    for document in [input(settings.clone()), openshift(input(settings))] {
        let values = chart_values(&document);
        assert_eq!(values["server"]["dataStorageClass"], "fast-local");
        assert_eq!(values["resources"], resources);
    }
}

/// Without the settings, the volume uses the cluster's default StorageClass,
/// and the gateway keeps the resources sized for 256 sandboxes.
#[test]
fn without_settings_the_chart_keeps_the_default_class_and_resources() {
    let values = chart_values(&input(json!({})));
    assert!(
        values["server"].get("dataStorageClass").is_none(),
        "{values}"
    );
    assert_eq!(
        values["resources"],
        json!({
            "requests": {"cpu": "250m", "memory": "256Mi"},
            "limits": {"cpu": "1", "memory": "2Gi"}
        })
    );
}
