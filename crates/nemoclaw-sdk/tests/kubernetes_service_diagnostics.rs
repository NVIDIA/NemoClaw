// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{operations, spec};
use nemoclaw_sdk::ObservationError;
use serde_json::json;
use std::error::Error;

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
        *object.pointer_mut(pointer).unwrap() = replacement;
        objects.insert(object);
        let before = objects.0.lock().unwrap().clone();
        let error = operations.read(&spec, None).await.unwrap_err();
        let message = error.to_string();
        for required in [kind, "agents", spec.name.as_str(), field] {
            assert!(
                message.contains(required),
                "missing {required:?}: {message}"
            );
        }
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
