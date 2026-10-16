// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{Deployed, deploy, operations, spec};
use nemoclaw_sdk::services::ServiceUpdatePolicy;
use serde_json::{Value, json};

#[tokio::test]
async fn default_update_policy_preserves_nonterminal_pods_configuration_and_saved_receipts() {
    for backend in ["vllm", "ollama"] {
        let original = spec(backend, backend == "vllm");
        let (deployed, bound) = deploy(&original).await;
        for phase in [json!("Running"), json!("Pending"), Value::Null] {
            let (objects, directory, operations) = deployed.restore();
            let mut pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
            // A scheduled Pod may be starting or serving, whatever its reported phase.
            pod["spec"]["nodeName"] = json!("gpu-node");
            pod["status"] = json!({"phase":phase});
            objects.insert(pod);
            let mut desired = original.clone();
            desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            let before = objects.0.lock().unwrap().clone();
            let receipt = directory
                .path()
                .join("services")
                .join(&original.name)
                .join("receipt.json");
            let saved = std::fs::read(&receipt).unwrap();
            for apply in [false, true] {
                let error = if apply {
                    operations
                        .ensure(&desired, bound.id.as_deref())
                        .await
                        .map(|_| ())
                } else {
                    operations.preflight_workload(&desired).await
                }
                .expect_err("changing a nonterminal Pod requires an explicit downtime policy");
                let message = error.to_string();
                for expected in ["updatePolicy", "Recreate", &original.name] {
                    assert!(message.contains(expected), "{message}");
                }
                assert_eq!(*objects.0.lock().unwrap(), before);
                assert_eq!(std::fs::read(&receipt).unwrap(), saved);
            }
        }
    }
}

#[tokio::test]
async fn explicit_recreate_replaces_a_running_pod_and_keeps_retained_storage() {
    for backend in ["vllm", "ollama"] {
        let original = spec(backend, backend == "vllm");
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &original).await;
        operations
            .ensure_storage(&original.storage(), None)
            .await
            .unwrap();
        let bound = operations.ensure(&original, None).await.unwrap();
        let mut pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
        pod["spec"]["nodeName"] = json!("gpu-node");
        pod["status"] = json!({"phase":"Running"});
        objects.insert(pod.clone());
        gpu_node(&objects, &original);
        let storage = objects.get(
            "v1",
            "PersistentVolumeClaim",
            "agents",
            &format!("{}-data", original.name),
        );
        let mut desired = original.clone();
        desired.settings.update_policy = ServiceUpdatePolicy::Recreate;
        desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
        operations.preflight_workload(&desired).await.unwrap();
        assert_eq!(
            objects.get("v1", "Pod", "agents", &original.name),
            Some(pod.clone())
        );
        operations
            .ensure(&desired, bound.id.as_deref())
            .await
            .unwrap();
        let replacement = objects.get("v1", "Pod", "agents", &original.name).unwrap();
        assert_ne!(replacement["metadata"]["uid"], pod["metadata"]["uid"]);
        assert_eq!(replacement["spec"]["containers"][0]["image"], desired.image);
        assert_eq!(
            objects.get(
                "v1",
                "PersistentVolumeClaim",
                "agents",
                &format!("{}-data", original.name)
            ),
            storage
        );
    }
}

#[tokio::test]
async fn changing_only_update_policy_keeps_compute_and_removing_it_restores_protection() {
    for backend in ["vllm", "ollama"] {
        let mut desired = spec(backend, backend == "vllm");
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &desired).await;
        operations
            .ensure_storage(&desired.storage(), None)
            .await
            .unwrap();
        let bound = operations.ensure(&desired, None).await.unwrap();
        let mut pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
        pod["spec"]["nodeName"] = json!("gpu-node");
        objects.insert(pod);
        let before = objects.0.lock().unwrap().clone();
        let receipt = directory
            .path()
            .join("services")
            .join(&desired.name)
            .join("receipt.json");
        // Older receipts omit updatePolicy; decoding and unchanged apply must keep that shape.
        let legacy: Value = serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
        assert!(
            legacy["specification"]["settings"]
                .get("updatePolicy")
                .is_none()
        );
        operations
            .ensure(&desired, bound.id.as_deref())
            .await
            .unwrap();
        for policy in [ServiceUpdatePolicy::Recreate, ServiceUpdatePolicy::Preserve] {
            desired.settings.update_policy = policy;
            operations
                .ensure(&desired, bound.id.as_deref())
                .await
                .unwrap();
            assert_eq!(*objects.0.lock().unwrap(), before);
            let saved: Value = serde_json::from_slice(&std::fs::read(&receipt).unwrap()).unwrap();
            assert_eq!(
                saved["specification"],
                serde_json::to_value(&desired).unwrap()
            );
        }
        desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
        assert!(matches!(
            operations.ensure(&desired, bound.id.as_deref()).await,
            Err(nemoclaw_sdk::ObservationError::ModelUpdateRefused { .. })
        ));
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn default_policy_allows_changed_workload_recovery_after_pod_absence_or_termination() {
    for backend in ["vllm", "ollama"] {
        let original = spec(backend, backend == "vllm");
        let (deployed, bound) = deploy(&original).await;
        for phase in [None, Some("Failed"), Some("Succeeded")] {
            let (objects, _directory, operations) = deployed.restore();
            let mut desired = original.clone();
            let mut old_pod = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
            if let Some(phase) = phase {
                old_pod["status"] = json!({"phase":phase});
                objects.insert(old_pod.clone());
            } else {
                objects
                    .0
                    .lock()
                    .unwrap()
                    .remove(&format!("/api/v1/namespaces/agents/pods/{}", desired.name));
            }
            desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            operations
                .ensure(&desired, bound.id.as_deref())
                .await
                .unwrap();
            let replacement = objects.get("v1", "Pod", "agents", &desired.name).unwrap();
            assert_ne!(replacement["metadata"]["uid"], old_pod["metadata"]["uid"]);
            assert_eq!(replacement["spec"]["containers"][0]["image"], desired.image);
        }
    }
}

#[tokio::test]
async fn update_policy_does_not_mask_or_authorize_owned_object_tampering() {
    let original = spec("vllm", true);
    let (deployed, bound) = deploy(&original).await;
    for policy in [ServiceUpdatePolicy::Preserve, ServiceUpdatePolicy::Recreate] {
        for kind in ["Pod", "ConfigMap"] {
            let (objects, _directory, operations) = deployed.restore();
            let mut desired = original.clone();
            let mut object = objects.get("v1", kind, "agents", &desired.name).unwrap();
            if kind == "Pod" {
                object["metadata"]["uid"] = json!("foreign-pod");
            } else {
                object["data"]["NEMOCLAW_RUNTIME_SPEC"] = json!("foreign-configuration");
            }
            objects.insert(object);
            let before = objects.0.lock().unwrap().clone();
            desired.settings.update_policy = policy;
            desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            super::assert_binding_mismatch(operations.ensure(&desired, bound.id.as_deref()).await);
            assert_eq!(*objects.0.lock().unwrap(), before);
        }
    }
}

async fn created(
    backend: &str,
) -> (
    nemoclaw_sdk::kubernetes::services::Spec,
    crate::kube_api::Objects,
    tempfile::TempDir,
    crate::transport::Fixture,
    nemoclaw_sdk::kubernetes::services::Operations,
    String,
) {
    let spec = spec(backend, backend == "vllm");
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let bound = operations.ensure(&spec, None).await.unwrap();
    (
        spec,
        objects,
        directory,
        fixture,
        operations,
        bound.id.unwrap(),
    )
}

fn gpu_node(objects: &crate::kube_api::Objects, spec: &nemoclaw_sdk::kubernetes::services::Spec) {
    objects.insert(json!({"apiVersion":"v1", "kind":"Node", "metadata":{"name":"gpu-node",
        "labels":{"kubernetes.io/os":"linux", "kubernetes.io/arch":spec.architecture, "gpu-pool":"inference"}},
        "status":{"allocatable":{"cpu":"8", "memory":"64Gi", "nvidia.com/gpu":"1"}}}));
}

fn set_pod(objects: &crate::kube_api::Objects, name: &str, node: Option<&str>, status: Value) {
    let mut pod = objects.get("v1", "Pod", "agents", name).unwrap();
    match node {
        Some(node) => pod["spec"]["nodeName"] = json!(node),
        None => {
            pod["spec"].as_object_mut().unwrap().remove("nodeName");
        }
    }
    pod["status"] = status;
    objects.insert(pod);
}

fn unschedulable() -> Value {
    json!({"phase":"Pending", "conditions":[{"type":"PodScheduled", "status":"False", "reason":"Unschedulable",
        "message":"0/3 nodes are available: 3 node(s) didn't match Pod's node affinity/selector."}]})
}

fn waiting(reason: &str) -> Value {
    json!({"phase":"Pending", "conditions":[{"type":"PodScheduled", "status":"True"}],
        "containerStatuses":[{"name":"runtime", "state":{"waiting":{"reason":reason}}}]})
}

#[tokio::test]
async fn default_policy_replaces_pods_that_never_served() {
    let mut cases = vec![
        ("unschedulable", None, unschedulable()),
        ("unbound", None, json!({"phase":"Pending"})),
    ];
    for reason in [
        "ErrImagePull",
        "ImagePullBackOff",
        "ErrImageNeverPull",
        "InvalidImageName",
        "CreateContainerConfigError",
    ] {
        cases.push((reason, Some("gpu-node"), waiting(reason)));
    }
    for backend in ["vllm", "ollama"] {
        let (original, objects, directory, fixture, operations, id) = created(backend).await;
        let deployed = Deployed::new(&objects, directory, fixture, operations);
        for (case, node, status) in &cases {
            let (objects, _directory, operations) = deployed.restore();
            set_pod(&objects, &original.name, *node, status.clone());
            let old_pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
            let claims: Vec<_> = objects
                .0
                .lock()
                .unwrap()
                .values()
                .filter(|object| object["kind"] == "PersistentVolumeClaim")
                .cloned()
                .collect();
            let mut corrected = original.clone();
            if node.is_none() {
                corrected
                    .settings
                    .node_selector
                    .insert("gpu-pool".into(), "corrected".into());
            } else {
                corrected.image = format!("registry.example/runtime@sha256:{}", "c".repeat(64));
            }
            operations
                .preflight_workload(&corrected)
                .await
                .unwrap_or_else(|error| panic!("{backend} {case}: {error}"));
            operations
                .ensure(&corrected, Some(&id))
                .await
                .unwrap_or_else(|error| panic!("{backend} {case}: {error}"));
            let replacement = objects.get("v1", "Pod", "agents", &original.name).unwrap();
            assert_ne!(
                replacement["metadata"]["uid"], old_pod["metadata"]["uid"],
                "{backend} {case}"
            );
            assert_eq!(
                replacement["spec"]["containers"][0]["image"],
                corrected.image
            );
            let retained: Vec<_> = objects
                .0
                .lock()
                .unwrap()
                .values()
                .filter(|object| object["kind"] == "PersistentVolumeClaim")
                .cloned()
                .collect();
            assert_eq!(retained, claims);
        }
    }
}

#[tokio::test]
async fn default_policy_keeps_pods_that_started_or_may_be_serving() {
    let restarted = json!({"phase":"Pending", "containerStatuses":[{"name":"runtime",
        "state":{"waiting":{"reason":"ImagePullBackOff"}},
        "lastState":{"terminated":{"reason":"Error", "exitCode":1}}}]});
    let (original, objects, directory, fixture, operations, id) = created("vllm").await;
    let deployed = Deployed::new(&objects, directory, fixture, operations);
    for (case, node, status, terminating) in [
        (
            "running",
            Some("gpu-node"),
            json!({"phase":"Running"}),
            false,
        ),
        (
            "starting",
            Some("gpu-node"),
            json!({"phase":"Pending"}),
            false,
        ),
        (
            "creating",
            Some("gpu-node"),
            waiting("ContainerCreating"),
            false,
        ),
        ("restarted", Some("gpu-node"), restarted, false),
        ("unknown", None, json!({"phase":"Unknown"}), false),
        (
            "terminating",
            Some("gpu-node"),
            json!({"phase":"Running"}),
            true,
        ),
        ("terminating unscheduled", None, unschedulable(), true),
    ] {
        let (objects, directory, operations) = deployed.restore();
        set_pod(&objects, &original.name, node, status);
        if terminating {
            let mut pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
            pod["metadata"]["deletionTimestamp"] = json!("2026-01-01T00:00:00Z");
            objects.insert(pod);
        }
        let before = objects.0.lock().unwrap().clone();
        let receipt = directory
            .path()
            .join("services")
            .join(&original.name)
            .join("receipt.json");
        let saved = std::fs::read(&receipt).unwrap();
        let mut desired = original.clone();
        desired.image = format!("registry.example/runtime@sha256:{}", "c".repeat(64));
        for apply in [false, true] {
            let result = if apply {
                operations.ensure(&desired, Some(&id)).await.map(|_| ())
            } else {
                operations.preflight_workload(&desired).await
            };
            assert!(
                matches!(
                    result,
                    Err(nemoclaw_sdk::ObservationError::ModelUpdateRefused { .. })
                ),
                "{case}: {result:?}"
            );
            assert_eq!(*objects.0.lock().unwrap(), before, "{case}");
            assert_eq!(std::fs::read(&receipt).unwrap(), saved, "{case}");
        }
    }
}

#[tokio::test]
async fn reverting_a_recreated_pod_that_never_scheduled_needs_no_recreate() {
    let (original, objects, _directory, _fixture, operations, id) = created("vllm").await;
    set_pod(
        &objects,
        &original.name,
        Some("gpu-node"),
        json!({"phase":"Running"}),
    );
    gpu_node(&objects, &original);
    let mut desired = original.clone();
    desired.settings.update_policy = ServiceUpdatePolicy::Recreate;
    desired.image = format!("registry.example/runtime@sha256:{}", "c".repeat(64));
    operations.ensure(&desired, Some(&id)).await.unwrap();
    set_pod(&objects, &original.name, None, unschedulable());
    let unscheduled = objects.get("v1", "Pod", "agents", &original.name).unwrap();
    operations.ensure(&original, Some(&id)).await.unwrap();
    let restored = objects.get("v1", "Pod", "agents", &original.name).unwrap();
    assert_ne!(restored["metadata"]["uid"], unscheduled["metadata"]["uid"]);
    assert_eq!(restored["spec"]["containers"][0]["image"], original.image);
}
