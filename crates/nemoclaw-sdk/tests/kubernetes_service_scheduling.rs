// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{Deployed, operations, spec};
use nemoclaw_sdk::kubernetes::services::{Operations, Spec};
use serde_json::{Value, json};

async fn running(
    backend: &str,
) -> (
    Spec,
    crate::kube_api::Objects,
    tempfile::TempDir,
    crate::transport::Fixture,
    Operations,
    String,
) {
    let mut spec = spec(backend, backend == "vllm");
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let bound = operations.ensure(&spec, None).await.unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    pod["spec"]["nodeName"] = json!("gpu-node");
    pod["status"] = json!({"phase":"Running"});
    objects.insert(pod);
    objects.insert(json!({"apiVersion":"v1", "kind":"Node", "metadata":{
        "name":"gpu-node", "labels":{"kubernetes.io/os":"linux", "kubernetes.io/arch":spec.architecture, "gpu-pool":"inference"}},
        "status":{"conditions":[{"type":"Ready", "status":"True"}], "allocatable":{"cpu":"8", "memory":"64Gi", "nvidia.com/gpu":"1"}}}));
    // These scenarios exercise scheduling checks after explicit downtime opt-in;
    // the existing workload was created with the default Preserve policy.
    spec.settings.update_policy = nemoclaw_sdk::services::ServiceUpdatePolicy::Recreate;
    (
        spec,
        objects,
        directory,
        fixture,
        operations,
        bound.id.unwrap(),
    )
}

async fn refuses_before_stopping(
    operations: &Operations,
    objects: &crate::kube_api::Objects,
    directory: &std::path::Path,
    desired: &Spec,
    id: &str,
    reason: &str,
) {
    let before = objects.0.lock().unwrap().clone();
    let receipt = directory
        .join("services")
        .join(&desired.name)
        .join("receipt.json");
    let saved = std::fs::read(&receipt).unwrap();
    for apply in [false, true] {
        let error = if apply {
            operations.ensure(desired, Some(id)).await.map(|_| ())
        } else {
            operations.preflight_workload(desired).await
        }
        .expect_err("replacement must be refused before the running Pod is stopped");
        let message = error.to_string();
        assert!(message.contains(reason), "{message}");
        assert!(message.contains(&desired.name), "{message}");
        assert_eq!(*objects.0.lock().unwrap(), before);
        assert_eq!(std::fs::read(&receipt).unwrap(), saved);
    }
}

#[tokio::test]
async fn excessive_memory_requests_preserve_the_running_pod_and_saved_receipt() {
    for backend in ["vllm", "ollama"] {
        let (mut desired, objects, directory, _fixture, operations, id) = running(backend).await;
        desired.settings.memory_request_gib = 128;
        desired.settings.memory_limit_gib = 128;
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "memory",
        )
        .await;
    }
}

#[tokio::test]
async fn an_untolerated_node_taint_preserves_the_running_pod_and_saved_receipt() {
    for backend in ["vllm", "ollama"] {
        let (mut desired, objects, directory, _fixture, operations, id) = running(backend).await;
        desired.settings.cpu_request_millis = 2000;
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["spec"] =
            json!({"taints":[{"key":"dedicated", "value":"inference", "effect":"NoSchedule"}]});
        objects.insert(node);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "taint",
        )
        .await;
    }
}

#[tokio::test]
async fn a_cordoned_node_preserves_the_running_pod_and_saved_receipt() {
    let (mut desired, objects, directory, _fixture, operations, id) = running("vllm").await;
    desired.settings.cpu_request_millis = 2000;
    let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
    node["spec"] = json!({"unschedulable":true});
    objects.insert(node);
    refuses_before_stopping(
        &operations,
        &objects,
        directory.path(),
        &desired,
        &id,
        "cordoned",
    )
    .await;
}

#[tokio::test]
async fn runtime_class_overhead_from_admission_must_fit_before_the_running_pod_is_stopped() {
    let (mut desired, objects, directory, _fixture, operations, id) = running("vllm").await;
    desired.settings.cpu_request_millis = 2000;
    objects.admit_pod_dry_run_with(json!({"overhead":{"memory":"64Gi"}}));
    refuses_before_stopping(
        &operations,
        &objects,
        directory.path(),
        &desired,
        &id,
        "memory",
    )
    .await;
}

#[tokio::test]
async fn equivalent_kubernetes_quantities_allow_a_sequential_update_on_one_gpu() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.cpu_request_millis = 2000;
    for (resource, quantity) in [
        ("cpu", "2.0"),
        ("cpu", "+2."),
        ("cpu", "2000000000n"),
        ("cpu", "2000000u"),
        ("cpu", "2e0"),
        ("cpu", "2000e-3"),
        ("memory", "16384Mi"),
        ("memory", "16Gi"),
        ("memory", "17179869184"),
        ("memory", "17179869.184k"),
        ("memory", "17.179869184G"),
        ("memory", "1.7179869184e10"),
        ("nvidia.com/gpu", "1e0"),
    ] {
        let (objects, _directory, operations) = deployed.restore();
        let old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
        let storage = objects
            .get(
                "v1",
                "PersistentVolumeClaim",
                "agents",
                &format!("{}-data", desired.name),
            )
            .unwrap();
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["status"]["allocatable"][resource] = json!(quantity);
        objects.insert(node);
        operations
            .ensure(&desired, Some(&id))
            .await
            .unwrap_or_else(|error| panic!("{resource}={quantity}: {error}"));
        assert_ne!(
            objects.get("v1", "Pod", "agents", &desired.name).unwrap()["metadata"]["uid"],
            old_pod["metadata"]["uid"]
        );
        assert_eq!(
            objects.get(
                "v1",
                "PersistentVolumeClaim",
                "agents",
                &format!("{}-data", desired.name)
            ),
            Some(storage)
        );
    }
}

#[tokio::test]
async fn unsupported_admission_resource_shapes_preserve_the_running_pod() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.cpu_request_millis = 2000;
    for overlay in [
        json!({"initContainers":[{"name":"init", "image":"example/init", "resources":{"requests":{"memory":"128Gi"}}}]}),
        json!({"resources":{"requests":{"memory":"128Gi"}}}),
    ] {
        let (objects, directory, operations) = deployed.restore();
        objects.admit_pod_dry_run_with(overlay);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "cannot assess admitted Pod resource requests",
        )
        .await;
    }
}

#[tokio::test]
async fn requests_above_allocatable_capacity_and_unreadable_quantities_preserve_the_running_pod() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.cpu_request_millis = 2000;
    for (resource, available, reason) in [
        ("cpu", "1999m", "cpu"),
        ("memory", "16383Mi", "memory"),
        ("nvidia.com/gpu", "0", "nvidia.com/gpu"),
        ("memory", "-1Gi", "cannot assess Node allocatable quantity"),
        (
            "memory",
            "1e1000",
            "cannot assess Node allocatable quantity",
        ),
        ("memory", "0.1n", "cannot assess Node allocatable quantity"),
        (
            "memory",
            "invalid",
            "cannot assess Node allocatable quantity",
        ),
    ] {
        let (objects, directory, operations) = deployed.restore();
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["status"]["allocatable"][resource] = json!(available);
        objects.insert(node);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            reason,
        )
        .await;
    }
}

async fn refuses_without_node_list(
    operations: &Operations,
    objects: &crate::kube_api::Objects,
    directory: &std::path::Path,
    desired: &Spec,
    id: &str,
) {
    let before = objects.0.lock().unwrap().clone();
    let receipt = directory
        .join("services")
        .join(&desired.name)
        .join("receipt.json");
    let saved = std::fs::read(&receipt).unwrap();
    for apply in [false, true] {
        objects.reject_request("GET", "/api/v1/nodes", false, 403);
        let error = if apply {
            operations.ensure(desired, Some(id)).await.map(|_| ())
        } else {
            operations.preflight_workload(desired).await
        }
        .unwrap_err();
        let message = error.to_string();
        for expected in ["list nodes (cluster scope)", "not replaced"] {
            assert!(message.contains(expected), "{message}");
        }
        assert_eq!(*objects.0.lock().unwrap(), before);
        assert_eq!(std::fs::read(&receipt).unwrap(), saved);
    }
}

#[tokio::test]
async fn losing_node_read_permission_preserves_the_running_pod_and_receipt() {
    for backend in ["vllm", "ollama"] {
        let (mut desired, objects, directory, _fixture, operations, id) = running(backend).await;
        desired.settings.cpu_request_millis = 2000;
        refuses_without_node_list(&operations, &objects, directory.path(), &desired, &id).await;
    }
}

#[tokio::test]
async fn image_and_runtime_only_updates_do_not_require_node_read_permission() {
    for backend in ["vllm", "ollama"] {
        let (original, objects, directory, fixture, operations, id) = running(backend).await;
        let deployed = Deployed::new(&objects, directory, fixture, operations);
        for change_image in [false, true] {
            let (objects, _directory, operations) = deployed.restore();
            let mut desired = original.clone();
            if change_image {
                desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            } else {
                let mut runtime = serde_json::to_value(&desired.runtime).unwrap();
                let timeout = runtime["serving"]["startupTimeoutSeconds"]
                    .as_u64()
                    .unwrap();
                runtime["serving"]["startupTimeoutSeconds"] = json!(timeout + 1);
                desired.runtime = serde_json::from_value(runtime).unwrap();
            }
            let old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
            for apply in [false, true] {
                objects.reject_request("GET", "/api/v1/nodes", false, 403);
                if apply {
                    operations.ensure(&desired, Some(&id)).await.map(|_| ())
                } else {
                    operations.preflight_workload(&desired).await
                }
                .unwrap();
            }
            assert_ne!(
                objects.get("v1", "Pod", "agents", &desired.name).unwrap()["metadata"]["uid"],
                old_pod["metadata"]["uid"]
            );
        }
    }
}

#[tokio::test]
async fn admitted_runtime_class_node_constraints_and_sidecar_requests_are_checked() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.runtime_class_name = Some("other-nvidia".into());
    for (overlay, reason) in [
        (
            json!({"nodeSelector":{"kubernetes.io/os":"linux", "gpu-pool":"missing-pool"}}),
            "nodeSelector",
        ),
        (
            json!({"containers":[{"name":"runtime", "resources":{"requests":{"memory":"16Gi"}}},
            {"name":"admitted-sidecar", "resources":{"requests":{"memory":"49Gi"}}}]}),
            "memory",
        ),
    ] {
        let (objects, directory, operations) = deployed.restore();
        objects.insert(json!({"apiVersion":"node.k8s.io/v1", "kind":"RuntimeClass", "metadata":{"name":"other-nvidia"}, "handler":"nvidia"}));
        objects.admit_pod_dry_run_with(overlay);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            reason,
        )
        .await;
    }
}

#[tokio::test]
async fn matching_tolerations_and_preferred_taints_allow_sequential_updates() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.cpu_request_millis = 2000;
    for (effect, toleration, cordoned) in [
        (
            "NoSchedule",
            json!({"key":"dedicated", "operator":"Equal", "value":"inference", "effect":"NoSchedule"}),
            false,
        ),
        (
            "NoExecute",
            json!({"key":"dedicated", "operator":"Exists"}),
            false,
        ),
        ("NoSchedule", json!({"operator":"Exists"}), false),
        ("PreferNoSchedule", Value::Null, false),
        (
            "PreferNoSchedule",
            json!({"key":"node.kubernetes.io/unschedulable", "operator":"Exists", "effect":"NoSchedule"}),
            true,
        ),
    ] {
        let (objects, _directory, operations) = deployed.restore();
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["spec"] = json!({"unschedulable":cordoned, "taints":[{"key":"dedicated", "value":"inference", "effect":effect}]});
        objects.insert(node);
        objects.admit_pod_dry_run_with(
            json!({"tolerations": if toleration.is_null() { vec![] } else { vec![toleration] }}),
        );
        operations.ensure(&desired, Some(&id)).await.unwrap();
    }
}

#[tokio::test]
async fn an_unassessable_node_does_not_hide_another_node_that_fits_the_replacement() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.cpu_request_millis = 2000;
    for unknown_capacity in [
        Value::Null,
        json!({"allocatable":{"cpu":"8", "memory":"invalid", "nvidia.com/gpu":"1"}}),
    ] {
        let (objects, _directory, operations) = deployed.restore();
        let old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
        let mut joining = objects.get("v1", "Node", "", "gpu-node").unwrap();
        joining["metadata"]["name"] = json!("0-joining-node");
        joining["status"] = unknown_capacity;
        objects.insert(joining);
        operations.ensure(&desired, Some(&id)).await.expect("the existing GPU Node has sufficient capacity even when an earlier Node cannot be assessed");
        assert_ne!(
            objects.get("v1", "Pod", "agents", &desired.name).unwrap()["metadata"]["uid"],
            old_pod["metadata"]["uid"]
        );
    }
}

fn node(
    objects: &crate::kube_api::Objects,
    name: &str,
    desired: &Spec,
    spec: Value,
    allocatable: Value,
) {
    objects.insert(json!({"apiVersion":"v1", "kind":"Node", "metadata":{
        "name":name, "labels":{"kubernetes.io/os":"linux", "kubernetes.io/arch":desired.architecture, "gpu-pool":"inference"}},
        "spec":spec, "status":{"conditions":[{"type":"Ready", "status":"True"}], "allocatable":allocatable}}));
}

#[tokio::test]
async fn tolerations_must_match_the_taint_key_value_and_effect() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.cpu_request_millis = 2000;
    for (taint, toleration) in [
        (
            json!({"key":"dedicated", "value":"inference", "effect":"NoExecute"}),
            Value::Null,
        ),
        (
            json!({"key":"dedicated", "value":"inference", "effect":"NoSchedule"}),
            json!({"key":"dedicated", "operator":"Equal", "value":"other", "effect":"NoSchedule"}),
        ),
        (
            json!({"key":"dedicated", "value":"inference", "effect":"NoExecute"}),
            json!({"key":"dedicated", "operator":"Equal", "value":"inference", "effect":"NoSchedule"}),
        ),
        (
            json!({"key":"dedicated", "value":"inference", "effect":"NoExecute"}),
            json!({"operator":"Exists", "effect":"NoSchedule"}),
        ),
        (
            json!({"key":"node.kubernetes.io/not-ready", "effect":"NoSchedule"}),
            json!({"key":"node.kubernetes.io/not-ready", "operator":"Exists", "effect":"NoExecute", "tolerationSeconds":300}),
        ),
        (
            json!({"key":"dedicated", "value":"inference", "effect":"NoSchedule"}),
            json!({"key":"other", "operator":"Exists"}),
        ),
    ] {
        let (objects, directory, operations) = deployed.restore();
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["spec"] = json!({"taints":[taint]});
        objects.insert(node);
        objects.admit_pod_dry_run_with(
            json!({"tolerations": if toleration.is_null() { vec![] } else { vec![toleration] }}),
        );
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "taint",
        )
        .await;
    }
}

#[tokio::test]
async fn every_requested_resource_must_fit_on_one_schedulable_node() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.cpu_request_millis = 2000;
    for (gpu_node, other_node) in [
        // A Node missing an extended resource offers none of it.
        (
            (
                json!({"unschedulable":true}),
                json!({"cpu":"8", "memory":"64Gi", "nvidia.com/gpu":"1"}),
            ),
            (json!({}), json!({"cpu":"8", "memory":"64Gi"})),
        ),
        // Capacity split across Nodes does not fit one Pod.
        (
            (
                json!({}),
                json!({"cpu":"1", "memory":"64Gi", "nvidia.com/gpu":"1"}),
            ),
            (json!({}), json!({"cpu":"8", "memory":"64Gi"})),
        ),
    ] {
        let (objects, directory, operations) = deployed.restore();
        node(&objects, "gpu-node", &desired, gpu_node.0, gpu_node.1);
        node(&objects, "cpu-node", &desired, other_node.0, other_node.1);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            "no matching Node has enough allocatable",
        )
        .await;
    }
}

#[tokio::test]
async fn tolerations_and_architecture_alone_are_scheduling_changes() {
    // The vLLM fixture's recipe fixes its architecture.
    for (backend, change) in [
        ("vllm", "tolerations"),
        ("ollama", "tolerations"),
        ("ollama", "architecture"),
    ] {
        {
            let (mut desired, objects, directory, _fixture, operations, id) =
                running(backend).await;
            if change == "tolerations" {
                desired.settings.tolerations = vec![
                    serde_json::from_value(json!({"key":"dedicated", "operator":"Exists"}))
                        .unwrap(),
                ];
            } else {
                let architecture = if desired.architecture == "amd64" {
                    "arm64"
                } else {
                    "amd64"
                };
                desired.architecture = architecture.into();
                let mut runtime = serde_json::to_value(&desired.runtime).unwrap();
                runtime["hardware"]["architecture"] = json!(architecture);
                desired.runtime = serde_json::from_value(runtime).unwrap();
                desired.validate().unwrap();
            }
            // A changed scheduling input needs the Node list; unchanged inputs
            // are checked only when Nodes are readable.
            refuses_without_node_list(&operations, &objects, directory.path(), &desired, &id).await;
            if change == "architecture" {
                refuses_before_stopping(
                    &operations,
                    &objects,
                    directory.path(),
                    &desired,
                    &id,
                    "no Node matches nodeSelector",
                )
                .await;
            }
        }
    }
}

#[tokio::test]
async fn image_and_runtime_only_updates_refuse_when_no_node_can_run_the_unchanged_pod() {
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
    for (node_spec, reason) in [
        (json!({"unschedulable":true}), "cordoned"),
        (
            json!({"taints":[{"key":"maintenance", "effect":"NoSchedule"}]}),
            "taint",
        ),
    ] {
        let (objects, directory, operations) = deployed.restore();
        let mut node = objects.get("v1", "Node", "", "gpu-node").unwrap();
        node["spec"] = node_spec;
        objects.insert(node);
        refuses_before_stopping(
            &operations,
            &objects,
            directory.path(),
            &desired,
            &id,
            reason,
        )
        .await;
    }
}

#[tokio::test]
async fn image_only_updates_do_not_require_assessable_admitted_requests() {
    // Unchanged scheduling inputs already fit the current Pod's node; an
    // injected init container leaves only Node state to check.
    let (mut desired, objects, _directory, _fixture, operations, id) = running("vllm").await;
    desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
    objects.admit_pod_dry_run_with(
        json!({"initContainers":[{"name":"istio-init", "image":"example/init",
        "resources":{"requests":{"cpu":"10m", "memory":"40Mi"}}}]}),
    );
    let old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
    operations.ensure(&desired, Some(&id)).await.unwrap();
    assert_ne!(
        objects.get("v1", "Pod", "agents", &desired.name).unwrap()["metadata"]["uid"],
        old_pod["metadata"]["uid"]
    );
}

#[tokio::test]
async fn replacing_a_pod_that_is_not_serving_skips_the_node_check() {
    let unschedulable = json!({"phase":"Pending", "conditions":[{"type":"PodScheduled", "status":"False",
        "reason":"Unschedulable", "message":"0/1 nodes are available: 1 node(s) didn't match Pod's node affinity/selector."}]});
    let oom = json!({"phase":"Failed", "containerStatuses":[{"name":"runtime",
        "state":{"terminated":{"reason":"OOMKilled", "exitCode":137}}}]});
    let (mut desired, objects, directory, fixture, operations, id) = running("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    desired.settings.memory_request_gib = 24;
    // Each case would otherwise fail the check: the Node list is denied, or
    // admission injects an init container whose requests it cannot assess.
    for (status, scheduled, deny_nodes) in [
        (json!({"phase":"Failed"}), true, true),
        (oom.clone(), true, false),
        (unschedulable.clone(), false, true),
        (unschedulable, false, false),
    ] {
        let (objects, _directory, operations) = deployed.restore();
        let mut pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
        if !scheduled {
            pod["spec"].as_object_mut().unwrap().remove("nodeName");
        }
        pod["status"] = status;
        objects.insert(pod.clone());
        if deny_nodes {
            objects.reject_request("GET", "/api/v1/nodes", false, 403);
        } else {
            objects.admit_pod_dry_run_with(
                json!({"initContainers":[{"name":"istio-init", "image":"example/init"}]}),
            );
        }
        operations.ensure(&desired, Some(&id)).await.unwrap();
        let replacement = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
        assert_ne!(replacement["metadata"]["uid"], pod["metadata"]["uid"]);
        assert_eq!(
            replacement["spec"]["containers"][0]["resources"]["requests"]["memory"],
            "24Gi"
        );
    }
}
