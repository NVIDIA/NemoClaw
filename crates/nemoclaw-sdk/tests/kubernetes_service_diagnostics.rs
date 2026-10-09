// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{operations, spec};
use nemoclaw_sdk::ObservationError;
use serde_json::json;
use std::error::Error;

#[tokio::test]
async fn admission_details_preserve_the_requested_pod_name_without_exposing_credentials() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    objects.reject_create("Pod");
    let error = operations.preflight_workload(&spec).await.unwrap_err();
    let ObservationError::Admission { kind, name, detail } = error else {
        panic!("expected admission rejection, got {error:?}");
    };
    assert_eq!(kind, "Pod");
    assert!(name.starts_with(&spec.name), "{name}");
    assert!(
        detail.contains(&format!("Pod {name:?} is forbidden")),
        "{detail}"
    );
    assert_eq!(
        detail.matches(&name).count(),
        1,
        "credential values must stay redacted: {detail}"
    );
    for secret in [
        "secret-sentinel",
        "nc-unverified-0123456789abcdef0123456789abcdef",
    ] {
        assert!(!detail.contains(secret), "{detail}");
    }
    assert!(detail.contains("exceeded quota"), "{detail}");
}

pub(super) fn assert_named_mismatch(
    error: &ObservationError,
    kind: &str,
    namespace: &str,
    name: &str,
    field: &'static str,
) {
    assert_eq!(
        error,
        &ObservationError::KubernetesObjectMismatch {
            kind: kind.into(),
            namespace: namespace.into(),
            name: name.into(),
            field,
        }
    );
    let message = error.to_string();
    for required in [kind, namespace, name, field] {
        assert!(
            message.contains(required),
            "missing {required:?}: {message}"
        );
    }
    assert!(!message.contains("private-"), "value leaked: {message}");
    assert_eq!(
        error
            .source()
            .and_then(|source| source.downcast_ref::<ObservationError>()),
        Some(&ObservationError::BindingMismatch)
    );
}

#[tokio::test]
async fn namespace_drift_names_the_live_or_retained_identity_without_its_value() {
    for change in [
        "live namespace",
        "live cluster",
        "retained namespace",
        "retained cluster",
    ] {
        let spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        operations.ensure(&spec, None).await.unwrap();
        let receipt_path = directory
            .path()
            .join("services")
            .join(&spec.name)
            .join("receipt.json");
        let (name, field) = match change {
            "live namespace" | "live cluster" => {
                let name = if change == "live namespace" {
                    "agents"
                } else {
                    "kube-system"
                };
                let mut namespace = objects.get("v1", "Namespace", "", name).unwrap();
                namespace["metadata"]["uid"] = json!("private-replacement-uid");
                objects.insert(namespace);
                (
                    name,
                    if change == "live namespace" {
                        "metadata.uid"
                    } else {
                        "cluster identity"
                    },
                )
            }
            _ => {
                let mut receipt: serde_json::Value =
                    serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
                let field = if change == "retained namespace" {
                    receipt["namespaceUid"] = json!("private-retained-uid");
                    "metadata.uid"
                } else {
                    receipt["cluster"]["systemUid"] = json!("private-retained-system-uid");
                    "cluster identity"
                };
                std::fs::write(&receipt_path, serde_json::to_vec(&receipt).unwrap()).unwrap();
                ("agents", field)
            }
        };
        let saved = std::fs::read(&receipt_path).unwrap();
        let before = objects.0.lock().unwrap().clone();
        let error = operations.ensure(&spec, None).await.unwrap_err();
        assert_named_mismatch(&error, "Namespace", "", name, field);
        assert_eq!(*objects.0.lock().unwrap(), before);
        assert_eq!(std::fs::read(&receipt_path).unwrap(), saved);
    }
}

#[tokio::test]
async fn api_conflicts_name_the_requested_object_and_preserve_durable_bindings() {
    for operation in [
        "read",
        "create",
        "initial preflight",
        "replacement preflight",
        "delete",
    ] {
        let mut spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        if matches!(operation, "read" | "replacement preflight" | "delete") {
            operations.ensure(&spec, None).await.unwrap();
        }
        let receipt_path = directory
            .path()
            .join("services")
            .join(&spec.name)
            .join("receipt.json");
        let saved = std::fs::read(&receipt_path).unwrap();
        let before = objects.0.lock().unwrap().clone();
        let collection = crate::kube_api::collection("v1", "Pod", "agents");
        let (method, path, dry_run, field) = match operation {
            "read" => (
                "GET",
                format!("{collection}/{}", spec.name),
                false,
                "API read conflict",
            ),
            "create" => ("POST", collection, false, "API create conflict"),
            "delete" => (
                "DELETE",
                format!("{collection}/{}", spec.name),
                false,
                "metadata.uid",
            ),
            _ => ("POST", collection, true, "API dry-run conflict"),
        };
        objects.reject_request(method, &path, dry_run, 409);
        let error = match operation {
            "read" => operations.read(&spec, None).await.unwrap_err(),
            "create" => operations.ensure(&spec, None).await.unwrap_err(),
            "delete" => operations.remove(&spec, None).await.unwrap_err(),
            _ => {
                if operation == "replacement preflight" {
                    spec.image = format!("registry.example/replacement@sha256:{}", "b".repeat(64));
                }
                operations.preflight_workload(&spec).await.unwrap_err()
            }
        };
        let rejected = objects.rejected_requests();
        assert_eq!(rejected.len(), 1, "failure must execute: {operation}");
        let requested_name = rejected[0]["body"]["metadata"]["name"]
            .as_str()
            .unwrap_or(&spec.name);
        assert_named_mismatch(&error, "Pod", "agents", requested_name, field);
        if operation == "create" {
            assert!(objects.get("v1", "Pod", "agents", &spec.name).is_none());
            for (path, object) in before {
                assert_eq!(objects.0.lock().unwrap().get(&path), Some(&object));
            }
            let receipt: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
            assert!(
                receipt["compute"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|owned| owned["kind"] != "Pod")
            );
            assert!(
                receipt.get("pending").is_none(),
                "authoritative absence settles the rejected create"
            );
        } else {
            assert_eq!(*objects.0.lock().unwrap(), before);
            assert_eq!(std::fs::read(&receipt_path).unwrap(), saved);
        }
    }
}

#[tokio::test]
async fn object_read_failures_keep_authentication_permission_and_query_categories() {
    for (code, expected) in [
        (401, ObservationError::Authentication),
        (403, ObservationError::Permission),
        (500, ObservationError::Query),
    ] {
        let spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        operations.ensure(&spec, None).await.unwrap();
        let before = objects.0.lock().unwrap().clone();
        objects.reject_request(
            "GET",
            &format!("/api/v1/namespaces/agents/pods/{}", spec.name),
            false,
            code,
        );
        assert_eq!(operations.read(&spec, None).await, Err(expected));
        assert_eq!(objects.rejected_requests().len(), 1);
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn missing_bound_configuration_names_the_absent_object_without_recreating_it() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    objects.0.lock().unwrap().remove(&format!(
        "/api/v1/namespaces/agents/configmaps/{}",
        spec.name
    ));
    let before = objects.0.lock().unwrap().clone();
    let error = operations.read(&spec, None).await.unwrap_err();
    assert_named_mismatch(&error, "ConfigMap", "agents", &spec.name, "object presence");
    assert_eq!(*objects.0.lock().unwrap(), before);
}

#[tokio::test]
async fn tampered_model_objects_identify_the_object_and_field_without_values() {
    for (api, kind, field, pointer, replacement) in [
        (
            "v1",
            "Pod",
            "metadata.uid",
            "/metadata/uid",
            json!("private-observed-uid"),
        ),
        (
            "v1",
            "Pod",
            "metadata.labels[nemoclaw.nvidia.com/uid]",
            "/metadata/labels/nemoclaw.nvidia.com~1uid",
            json!("private-owner"),
        ),
        (
            "v1",
            "Pod",
            "metadata.labels[nemoclaw.nvidia.com/generation]",
            "/metadata/labels/nemoclaw.nvidia.com~1generation",
            json!("private-generation"),
        ),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].image",
            "/spec/containers/0/image",
            json!("private-registry/image:private-tag"),
        ),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].command",
            "/spec/containers/0/command",
            json!(["private-command"]),
        ),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].envFrom[0].configMapRef.name",
            "/spec/containers/0/envFrom/0/configMapRef/name",
            json!("private-config"),
        ),
        ("v1", "Pod", "spec.volumes", "/spec/volumes", json!([])),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].volumeMounts",
            "/spec/containers/0/volumeMounts",
            json!([]),
        ),
        (
            "v1",
            "Pod",
            "spec.volumes.persistentVolumeClaim.claimName",
            "/spec/volumes/0/persistentVolumeClaim/claimName",
            json!("private-claim"),
        ),
        (
            "v1",
            "Pod",
            "spec.volumes.persistentVolumeClaim.readOnly",
            "/spec/volumes/0/persistentVolumeClaim/readOnly",
            json!(true),
        ),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].volumeMounts.name",
            "/spec/containers/0/volumeMounts/0/name",
            json!("private-mount"),
        ),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].volumeMounts.subPath",
            "/spec/containers/0/volumeMounts/0/subPath",
            json!("private-subpath"),
        ),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].volumeMounts.subPathExpr",
            "/spec/containers/0/volumeMounts/0/subPathExpr",
            json!("private-subpath"),
        ),
        (
            "v1",
            "Pod",
            "spec.containers[runtime].volumeMounts.readOnly",
            "/spec/containers/0/volumeMounts/0/readOnly",
            json!(true),
        ),
        (
            "v1",
            "Service",
            "spec.type",
            "/spec/type",
            json!("NodePort"),
        ),
        ("v1", "Service", "spec.ports", "/spec/ports", json!([])),
        (
            "v1",
            "Service",
            "spec.externalIPs",
            "/spec/externalIPs",
            json!(["private-address"]),
        ),
        (
            "v1",
            "Service",
            "spec.selector",
            "/spec/selector",
            json!({"private-selector": "private-value"}),
        ),
        (
            "networking.k8s.io/v1",
            "NetworkPolicy",
            "spec.ingress",
            "/spec/ingress",
            json!([{"private-rule": "private-value"}]),
        ),
        (
            "networking.k8s.io/v1",
            "NetworkPolicy",
            "spec.podSelector",
            "/spec/podSelector",
            json!({"private-selector": "private-value"}),
        ),
        (
            "networking.k8s.io/v1",
            "NetworkPolicy",
            "spec.policyTypes",
            "/spec/policyTypes",
            json!([]),
        ),
        (
            "networking.k8s.io/v1",
            "NetworkPolicy",
            "spec.egress",
            "/spec/egress",
            json!([{"private-rule": "private-value"}]),
        ),
        ("v1", "ConfigMap", "immutable", "/immutable", json!(false)),
        (
            "v1",
            "ConfigMap",
            "data",
            "/data",
            json!({"private-key": "private-value"}),
        ),
    ] {
        let spec = spec("vllm", true);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        operations.ensure(&spec, None).await.unwrap();
        let mut object = objects.get(api, kind, "agents", &spec.name).unwrap();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        object.pointer_mut(parent).unwrap()[key.replace("~1", "/")] = replacement;
        objects.insert(object);
        let before = objects.0.lock().unwrap().clone();
        let error = operations.read(&spec, None).await.unwrap_err();
        let message = error.to_string();
        assert_named_mismatch(&error, kind, "agents", &spec.name, field);
        assert!(
            !message.contains("private-"),
            "observed value leaked: {message}"
        );
        assert!(
            !message.contains(&spec.image),
            "expected image leaked: {message}"
        );
        assert_eq!(
            error
                .source()
                .and_then(|source| source.downcast_ref::<ObservationError>()),
            Some(&ObservationError::BindingMismatch)
        );
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn replacement_preflight_identifies_a_live_object_without_a_recorded_binding() {
    let mut spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let path = directory
        .path()
        .join("services")
        .join(&spec.name)
        .join("receipt.json");
    let mut receipt: serde_json::Value =
        serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    receipt["compute"]
        .as_array_mut()
        .unwrap()
        .retain(|owned| owned["kind"] != "ConfigMap");
    std::fs::write(&path, serde_json::to_vec(&receipt).unwrap()).unwrap();
    let saved = std::fs::read(&path).unwrap();
    let before = objects.0.lock().unwrap().clone();
    spec.image = format!("registry.example/replacement@sha256:{}", "b".repeat(64));
    let error = operations.preflight_workload(&spec).await.unwrap_err();
    let message = error.to_string();
    for required in ["ConfigMap", "agents", spec.name.as_str(), "receipt binding"] {
        assert!(
            message.contains(required),
            "missing {required:?}: {message}"
        );
    }
    assert_eq!(
        error
            .source()
            .and_then(|source| source.downcast_ref::<ObservationError>()),
        Some(&ObservationError::BindingMismatch)
    );
    assert_eq!(*objects.0.lock().unwrap(), before);
    assert_eq!(std::fs::read(&path).unwrap(), saved);
}
