// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::kubernetes::services::{Spec, compute_objects, storage_objects};
use serde_json::{Value, json};
#[path = "kubernetes_service_diagnostics.rs"]
mod diagnostics;
#[path = "kubernetes_service_exec.rs"]
mod exec_boundary;
#[path = "kubernetes_service_idempotence.rs"]
mod idempotence;
#[path = "kubernetes_service_readiness.rs"]
mod readiness;

fn assert_binding_mismatch<T>(result: Result<T, nemoclaw_sdk::ObservationError>) {
    use nemoclaw_sdk::ObservationError;
    use std::error::Error;
    let error = result.err().expect("identity change must be refused");
    assert!(
        error == ObservationError::BindingMismatch
            || error
                .source()
                .and_then(|source| source.downcast_ref::<ObservationError>())
                == Some(&ObservationError::BindingMismatch),
        "{error:?}"
    );
}

fn spec(backend: &str, authenticated: bool) -> Spec {
    let runtime: Value = if backend == "vllm" {
        let mut value: Value = serde_saphyr::from_str(include_str!(
            "../../nemoclaw-runtime/tests/fixtures/vllm.yaml"
        ))
        .unwrap();
        if authenticated {
            value["authentication"] = json!("bearer");
        }
        value
    } else {
        json!({"kind": "ollama", "hardware": {"profile": "rtx-4090", "architecture": "amd64"}, "model": {"name": "qwen3:4b", "digest": "a".repeat(64)}, "serving": {"port": 11434, "contextTokens": 8192, "maxSequences": 1, "startupTimeoutSeconds": 1800}, "memory": {"hostReserveGiB": 32, "gpuMemoryGiB": 16, "minAvailableGiB": 8, "minFreeGiB": 3, "freeGateGiB": 12, "consecutiveSamples": 5}})
    };
    serde_json::from_value(json!({
        "layout": 1, "kind": "kubernetes_service", "name": "nc-0123456789abcdef-model-0123456789abcdef",
        "owner": "00000000-0000-4000-8000-000000000001", "generation": "0123456789abcdef0123456789abcdef",
        "gateway": {"layout": 1, "kind": "kubernetes_gateway", "name": "nc-0123456789abcdef-gateway",
            "owner": "00000000-0000-4000-8000-000000000001", "generation": "abcdef0123456789abcdef0123456789",
            "settings": {"runtime": {"provider": "kubernetes"}, "endpoint": "https://127.0.0.1:17671",
                "kubernetes": {"kubeconfig": {"env": "TEST_CLUSTER_CONFIG"}, "context": "selected", "namespace": "agents", "authentication": {"profile": "development"}}}},
        "image": format!("registry.example/runtime@sha256:{}", "a".repeat(64)), "imagePullPolicy": "Never",
        "runtime": runtime, "settings": {"imageMetadata": {"env": "TEST_MODEL_IMAGE_METADATA"},"cpuRequestMillis": 1000, "cpuLimitMillis": 4000, "memoryRequestGiB": 16, "memoryLimitGiB": 32, "storageGiB": 80, "storageClass": "model-cache", "runtimeClassName": "nvidia", "nodeSelector": {"gpu-pool": "inference"}}, "sharedMemoryGib": 8, "architecture": if backend == "vllm" { "arm64" } else { "amd64" }
    })).unwrap()
}

#[test]
fn authenticated_vllm_uses_distinct_retained_writable_model_and_credential_claims() {
    let spec = spec("vllm", true);
    let storage = storage_objects(&spec.storage());
    assert_eq!(
        storage.len(),
        2,
        "model and credentials must be separate retained claims"
    );
    let objects = compute_objects(&spec, None);
    let pod = objects
        .iter()
        .find(|object| object["kind"] == "Pod")
        .unwrap();
    assert_eq!(pod["spec"]["restartPolicy"], "Never");
    assert_eq!(
        pod["spec"]["containers"][0]["resources"]["limits"]["nvidia.com/gpu"],
        "1"
    );
    let mounts = pod["spec"]["containers"][0]["volumeMounts"]
        .as_array()
        .unwrap();
    for path in ["/data", "/credentials"] {
        assert!(
            mounts
                .iter()
                .any(|mount| mount["mountPath"] == path && mount["readOnly"] != true)
        );
    }
}

async fn operations(
    objects: &crate::kube_api::Objects,
    directory: &std::path::Path,
    spec: &Spec,
) -> (
    crate::transport::Fixture,
    nemoclaw_sdk::kubernetes::services::Operations,
) {
    use nemoclaw_sdk::kubernetes::{
        cluster::{Cluster, Owned},
        receipt::{ClusterIdentity, Receipt},
    };
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kube-system", "uid": "system-uid"}}));
    objects.insert(json!({"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass", "metadata": {"name": "model-cache"}}));
    objects.insert(json!({"apiVersion": "node.k8s.io/v1", "kind": "RuntimeClass", "metadata": {"name": "nvidia"}, "handler": "nvidia"}));
    let fixture = objects.serve().await;
    let client = crate::kube_api::client(&fixture);
    let cluster = Cluster::new(client.clone(), &spec.owner, &spec.gateway.generation);
    let namespace = cluster
        .create(json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "agents"}}))
        .await
        .unwrap();
    let mut receipt = Receipt::new(&spec.owner, &spec.gateway.name);
    receipt.cluster = Some(ClusterIdentity {
        server: fixture.endpoint.clone(),
        system_uid: "system-uid".into(),
    });
    receipt.objects.push(Owned { ..namespace });
    receipt.storage_ready = true;
    receipt.save(directory).unwrap();
    (
        fixture,
        nemoclaw_sdk::kubernetes::services::Operations {
            client,
            server: receipt.cluster.unwrap().server,
            state: directory.into(),
        },
    )
}

#[tokio::test]
async fn apply_creates_both_backends_without_mutating_existing_retained_storage() {
    for backend in ["vllm", "ollama"] {
        let spec = spec(backend, backend == "vllm");
        spec.validate().unwrap();
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        let storage = operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        assert!(storage.id.is_some());
        let claims: Vec<_> = objects
            .0
            .lock()
            .unwrap()
            .values()
            .filter(|object| object["kind"] == "PersistentVolumeClaim")
            .cloned()
            .collect();
        let compute = operations.ensure(&spec, None).await.unwrap();
        assert!(compute.id.is_some());
        assert!(objects.get("v1", "Pod", "agents", &spec.name).is_some());
        operations
            .ensure_storage(&spec.storage(), storage.id.as_deref())
            .await
            .unwrap();
        let observed: Vec<_> = objects
            .0
            .lock()
            .unwrap()
            .values()
            .filter(|object| object["kind"] == "PersistentVolumeClaim")
            .cloned()
            .collect();
        assert_eq!(observed, claims);
    }
}

#[tokio::test]
async fn refresh_keeps_missing_pod_binding_and_apply_recovers_only_compute() {
    let spec = spec("vllm", true);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    let storage = operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let compute = operations.ensure(&spec, None).await.unwrap();
    let pod_path = format!("/api/v1/namespaces/agents/pods/{}", spec.name);
    let old_pod = objects.0.lock().unwrap().remove(&pod_path).unwrap();
    let before = objects.0.lock().unwrap().clone();
    let read = operations.read(&spec, compute.id.as_deref()).await.unwrap();
    assert_eq!(read.id, compute.id);
    assert_eq!(read.running, Some(false));
    assert_eq!(
        *objects.0.lock().unwrap(),
        before,
        "refresh must be read-only"
    );
    let recovered = operations
        .ensure(&spec, compute.id.as_deref())
        .await
        .unwrap();
    assert_eq!(recovered.id, compute.id);
    let new_pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    assert_ne!(old_pod["metadata"]["uid"], new_pod["metadata"]["uid"]);
    let receipt: Value = serde_json::from_slice(
        &std::fs::read(
            directory
                .path()
                .join("services")
                .join(&spec.name)
                .join("receipt.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(
        receipt["compute"]
            .as_array()
            .unwrap()
            .iter()
            .any(|owned| owned["kind"] == "Pod" && owned["uid"] == new_pod["metadata"]["uid"])
    );
    assert_eq!(
        operations
            .read_storage(&spec.storage(), storage.id.as_deref())
            .await
            .unwrap(),
        storage
    );
}

#[tokio::test]
async fn running_pod_without_runtime_evidence_is_not_ready() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let compute = operations.ensure(&spec, None).await.unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    pod["status"] =
        json!({"phase": "Running", "conditions": [{"type": "Ready", "status": "True"}]});
    objects.insert(pod);
    assert_eq!(
        operations.read(&spec, compute.id.as_deref()).await,
        Err(nemoclaw_sdk::ObservationError::Incomplete)
    );
}

#[tokio::test]
async fn retained_claim_loss_and_substitution_block_compute_mutation() {
    for corrupt in ["missing", "uid", "generation"] {
        let spec = spec("vllm", true);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        let compute = operations.ensure(&spec, None).await.unwrap();
        let claim = format!(
            "/api/v1/namespaces/agents/persistentvolumeclaims/{}-auth",
            spec.name
        );
        match corrupt {
            "missing" => {
                objects.0.lock().unwrap().remove(&claim);
            }
            "uid" => {
                objects.0.lock().unwrap().get_mut(&claim).unwrap()["metadata"]["uid"] =
                    json!("substitute")
            }
            "generation" => {
                objects.0.lock().unwrap().get_mut(&claim).unwrap()["metadata"]["labels"]["nemoclaw.nvidia.com/generation"] =
                    json!("other")
            }
            _ => unreachable!(),
        }
        let before = objects.0.lock().unwrap().clone();
        assert_binding_mismatch(operations.ensure(&spec, compute.id.as_deref()).await);
        assert_binding_mismatch(operations.remove(&spec, compute.id.as_deref()).await);
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn failed_compute_creation_retains_a_binding_and_destroy_preserves_foreign_objects_and_claims()
 {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    let storage = operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    objects.insert(json!({"apiVersion": "v1", "kind": "Pod", "metadata": {"name": spec.name, "namespace": "agents", "uid": "foreign"}}));
    let error = operations.ensure(&spec, None).await.unwrap_err();
    diagnostics::assert_named_mismatch(&error, "Pod", "agents", &spec.name, "receipt binding");
    let partial = operations.read_for_removal(&spec, None).await.unwrap();
    assert!(partial.id.is_some());
    operations
        .remove(&spec, partial.id.as_deref())
        .await
        .unwrap();
    assert_eq!(
        objects.get("v1", "Pod", "agents", &spec.name).unwrap()["metadata"]["uid"],
        "foreign"
    );
    assert!(
        objects
            .get("v1", "ConfigMap", "agents", &spec.name)
            .is_none()
    );
    assert!(objects.get("v1", "Service", "agents", &spec.name).is_none());
    assert_eq!(
        operations
            .read_storage(&spec.storage(), storage.id.as_deref())
            .await
            .unwrap(),
        storage
    );
}

#[tokio::test]
async fn image_updates_and_destroy_reapply_retain_the_same_claims() {
    let mut spec = spec("vllm", true);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    let storage = operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&spec, None).await.unwrap();
    let mut service = objects.get("v1", "Service", "agents", &spec.name).unwrap();
    service["spec"]["clusterIP"] = json!("10.96.0.42");
    service["spec"]["clusterIPs"] = json!(["10.96.0.42"]);
    objects.insert(service.clone());
    objects.insert(json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "unrelated", "namespace": "agents"}}));
    spec.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
    let second = operations.ensure(&spec, first.id.as_deref()).await.unwrap();
    assert_eq!(
        second.id, first.id,
        "provider updates must preserve the bound compute identity"
    );
    assert_eq!(
        objects.get("v1", "Service", "agents", &spec.name),
        Some(service),
        "image updates retain the published address"
    );
    assert_eq!(
        objects.get("v1", "Pod", "agents", &spec.name).unwrap()["spec"]["containers"][0]["image"],
        spec.image
    );
    operations
        .remove(&spec, second.id.as_deref())
        .await
        .unwrap();
    assert_eq!(
        operations
            .read_storage(&spec.storage(), storage.id.as_deref())
            .await
            .unwrap(),
        storage
    );
    operations.ensure(&spec, None).await.unwrap();
    assert_eq!(
        operations
            .read_storage(&spec.storage(), storage.id.as_deref())
            .await
            .unwrap(),
        storage
    );
}

#[tokio::test]
async fn cluster_identity_changes_block_model_mutations() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kube-system", "uid": "rebuilt-cluster"}}));
    let before = objects.0.lock().unwrap().clone();
    assert_binding_mismatch(operations.ensure(&spec, None).await);
    assert_eq!(*objects.0.lock().unwrap(), before);
}

#[tokio::test]
async fn endpoint_grants_follow_only_the_owned_service_cluster_addresses() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let mut service = objects.get("v1", "Service", "agents", &spec.name).unwrap();
    service["spec"]["clusterIP"] = json!("10.96.0.42");
    service["spec"]["clusterIPs"] = json!(["10.96.0.42", "fd00::42"]);
    objects.insert(service.clone());
    assert_eq!(
        operations
            .endpoint_addresses(&spec.storage(), &spec.endpoint())
            .await
            .unwrap(),
        vec![
            "10.96.0.42".parse::<std::net::IpAddr>().unwrap(),
            "fd00::42".parse().unwrap()
        ]
    );
    let error = operations
        .endpoint_addresses(&spec.storage(), "http://elsewhere.agents.svc:11434/v1")
        .await
        .unwrap_err();
    diagnostics::assert_named_mismatch(&error, "Service", "agents", &spec.name, "endpoint");
    assert!(!error.to_string().contains("elsewhere"));
    service["metadata"]["uid"] = json!("replacement");
    objects.insert(service);
    assert_binding_mismatch(
        operations
            .endpoint_addresses(&spec.storage(), &spec.endpoint())
            .await,
    );
}

#[tokio::test]
async fn retained_claims_remain_observable_after_their_storage_class_is_removed() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    let storage = operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    objects
        .0
        .lock()
        .unwrap()
        .remove("/apis/storage.k8s.io/v1/storageclasses/model-cache");
    let before = objects.0.lock().unwrap().clone();
    operations.preflight(&spec.storage(), None).await.unwrap();
    assert_eq!(
        operations
            .read_storage(&spec.storage(), storage.id.as_deref())
            .await
            .unwrap(),
        storage
    );
    assert_eq!(*objects.0.lock().unwrap(), before);
}

#[test]
fn workload_architecture_must_match_the_runtime_contract() {
    let mut spec = spec("ollama", false);
    spec.architecture = "arm64".into();
    assert!(spec.validate().is_err());
}

#[tokio::test]
async fn openshift_workloads_use_only_the_recorded_namespace_identity() {
    use nemoclaw_sdk::kubernetes::{gateway::Identity, receipt::Receipt};
    let mut spec = spec("ollama", false);
    spec.gateway.settings.runtime.provider = nemoclaw_sdk::config::ComputeDriver::OpenShift;
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    let mut namespace = objects.get("v1", "Namespace", "", "agents").unwrap();
    namespace["metadata"]["annotations"] = json!({"openshift.io/sa.scc.uid-range": "1000720000/10000", "openshift.io/sa.scc.supplemental-groups": "1000720000/10000"});
    objects.insert(namespace.clone());
    let mut gateway = Receipt::load(directory.path(), &spec.owner, &spec.gateway.name)
        .unwrap()
        .unwrap();
    gateway.namespace_identity = Some(Identity {
        user: 1000720000,
        group: 1000720000,
    });
    gateway.save(directory.path()).unwrap();
    objects.require_pod_identity(1000720000);
    let before = objects.0.lock().unwrap().clone();
    operations.preflight_workload(&spec).await.unwrap();
    assert_eq!(
        *objects.0.lock().unwrap(),
        before,
        "initial admission preflight must use the gateway identity before model storage exists"
    );
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let compute = operations.ensure(&spec, None).await.unwrap();
    let pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    assert_eq!(pod["spec"]["securityContext"]["runAsUser"], 1000720000);
    assert_eq!(pod["spec"]["securityContext"]["fsGroup"], 1000720000);
    namespace["metadata"]["annotations"]["openshift.io/sa.scc.uid-range"] =
        json!("1000730000/10000");
    objects.insert(namespace);
    let before = objects.0.lock().unwrap().clone();
    let error = operations
        .ensure(&spec, compute.id.as_deref())
        .await
        .unwrap_err();
    diagnostics::assert_named_mismatch(
        &error,
        "Namespace",
        "",
        "agents",
        "metadata.annotations[openshift.io identity]",
    );
    assert!(!error.to_string().contains("1000720000"));
    assert!(!error.to_string().contains("1000730000"));
    assert_eq!(*objects.0.lock().unwrap(), before);
}

#[tokio::test]
async fn a_bound_pod_cannot_redirect_the_runtime_to_another_credentials_claim() {
    let spec = spec("vllm", true);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let compute = operations.ensure(&spec, None).await.unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    let volumes = pod["spec"]["volumes"].as_array_mut().unwrap();
    volumes
        .iter_mut()
        .find(|volume| volume["name"] == "credentials")
        .unwrap()["persistentVolumeClaim"]["claimName"] = json!("foreign-credentials");
    objects.insert(pod);
    assert_binding_mismatch(operations.read(&spec, compute.id.as_deref()).await);
}

#[tokio::test]
async fn an_interrupted_update_keeps_the_binding_and_requires_intent_reconciliation() {
    let original = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &original).await;
    operations
        .ensure_storage(&original.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&original, None).await.unwrap();
    let mut updated = original.clone();
    updated.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
    operations
        .ensure(&updated, first.id.as_deref())
        .await
        .unwrap();
    let mut pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
    pod["status"] = json!({"phase": "Running"});
    objects.insert(pod);
    let before = objects.0.lock().unwrap().clone();
    let read = operations
        .read(&original, first.id.as_deref())
        .await
        .unwrap();
    assert_eq!(read.id, first.id);
    assert_eq!(
        read.running,
        Some(false),
        "the old specification must not describe the replacement as applied"
    );
    assert_eq!(*objects.0.lock().unwrap(), before);
}

#[test]
fn model_ingress_admits_only_openshell_supervisors_in_its_namespace() {
    for backend in ["vllm", "ollama"] {
        let spec = spec(backend, backend == "vllm");
        let objects = compute_objects(&spec, None);
        let service = objects.iter().find(|o| o["kind"] == "Service").unwrap();
        let policy = objects
            .iter()
            .find(|o| o["kind"] == "NetworkPolicy")
            .unwrap();
        assert_eq!(
            policy["spec"],
            json!({
                "podSelector": {"matchLabels": service["spec"]["selector"]},
                "policyTypes": ["Ingress"],
                "ingress": [{"from": [{"podSelector": {"matchLabels": {
                    "openshell.ai/managed-by": "openshell",
                    "openshell.ai/boundary-role": "supervisor"
                }}}], "ports": [{"protocol": "TCP", "port": spec.port()}]}]
            })
        );
    }
}

#[tokio::test]
async fn metadata_reference_changes_preserve_the_running_workload() {
    let mut spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&spec, None).await.unwrap();
    let before = objects.0.lock().unwrap().clone();
    operations.ensure(&spec, first.id.as_deref()).await.unwrap();
    assert_eq!(*objects.0.lock().unwrap(), before);
    spec.settings.image_metadata.env = "RENAMED_METADATA".into();
    operations.ensure(&spec, first.id.as_deref()).await.unwrap();
    assert_eq!(*objects.0.lock().unwrap(), before);
}

#[tokio::test]
async fn missing_classes_name_the_configuration_before_creating_objects() {
    for (path, field) in [
        (
            "/apis/storage.k8s.io/v1/storageclasses/model-cache",
            "kubernetes.storageClass",
        ),
        (
            "/apis/node.k8s.io/v1/runtimeclasses/nvidia",
            "kubernetes.runtimeClassName",
        ),
    ] {
        let spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        objects.0.lock().unwrap().remove(path);
        let before = objects.0.lock().unwrap().clone();
        let error = operations
            .preflight(&spec.storage(), spec.settings.runtime_class_name.as_deref())
            .await
            .unwrap_err();
        assert!(error.to_string().contains(field), "{error}");
        assert!(!error.to_string().contains("retained"));
        if field.ends_with("storageClass") {
            assert!(
                operations
                    .ensure_storage(&spec.storage(), None)
                    .await
                    .is_err()
            );
        } else {
            assert!(operations.ensure(&spec, None).await.is_err());
        }
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn a_failed_first_create_does_not_bind_the_serving_port() {
    let mut spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    objects.fail_create("ConfigMap", false);
    assert!(operations.ensure(&spec, None).await.is_err());
    if let nemoclaw_runtime::RuntimeSpec::Ollama(runtime) = &mut spec.runtime {
        runtime.serving.port += 1;
    }
    operations.ensure(&spec, None).await.unwrap();
    assert_eq!(
        objects.get("v1", "Service", "agents", &spec.name).unwrap()["spec"]["ports"][0]["port"],
        spec.port()
    );
}

#[tokio::test]
async fn missing_network_objects_refuse_updates_before_stopping_the_pod() {
    for (api, kind) in [("v1", "Service"), ("networking.k8s.io/v1", "NetworkPolicy")] {
        let mut spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        let first = operations.ensure(&spec, None).await.unwrap();
        let path = format!(
            "{}/{}",
            crate::kube_api::collection(api, kind, "agents"),
            spec.name
        );
        objects.0.lock().unwrap().remove(&path);
        let before = objects.0.lock().unwrap().clone();
        spec.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
        assert_binding_mismatch(operations.ensure(&spec, first.id.as_deref()).await);
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn changed_network_specs_refuse_refresh_and_update_but_allow_explicit_removal() {
    for (api, kind, field, replacement) in [
        ("v1", "Service", "externalIPs", json!(["203.0.113.7"])),
        ("v1", "Service", "selector", json!({"foreign": "true"})),
        (
            "networking.k8s.io/v1",
            "NetworkPolicy",
            "ingress",
            json!([{}]),
        ),
    ] {
        let mut spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        let first = operations.ensure(&spec, None).await.unwrap();
        let mut object = objects.get(api, kind, "agents", &spec.name).unwrap();
        object["spec"][field] = replacement;
        objects.insert(object);
        let before = objects.0.lock().unwrap().clone();
        assert_binding_mismatch(operations.read(&spec, first.id.as_deref()).await);
        spec.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
        assert_binding_mismatch(operations.ensure(&spec, first.id.as_deref()).await);
        assert_eq!(*objects.0.lock().unwrap(), before);
        operations.remove(&spec, first.id.as_deref()).await.unwrap();
    }
}

#[tokio::test]
async fn a_lost_create_response_blocks_cleanup_of_the_orphans_network_policy() {
    let spec = spec("vllm", true);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    objects.fail_create("Pod", true);
    assert!(operations.ensure(&spec, None).await.is_err());
    let before = objects.0.lock().unwrap().clone();
    let error = operations.ensure(&spec, None).await.unwrap_err();
    assert!(error.to_string().contains(&spec.name), "{error}");
    assert!(operations.remove(&spec, None).await.is_err());
    assert_eq!(*objects.0.lock().unwrap(), before);
    // An operator verifies and removes the unrecorded Pod. Retry can then finish.
    let path = format!("/api/v1/namespaces/agents/pods/{}", spec.name);
    objects.0.lock().unwrap().remove(&path);
    operations.ensure(&spec, None).await.unwrap();
    operations.remove(&spec, None).await.unwrap();
    assert!(
        objects
            .get(
                "networking.k8s.io/v1",
                "NetworkPolicy",
                "agents",
                &spec.name
            )
            .is_none()
    );
}

#[tokio::test]
async fn model_preflight_checks_admission_and_permissions_without_creating_resources() {
    for kind in [
        "Pod",
        "PersistentVolumeClaim",
        "permission",
        "endpointslices",
    ] {
        let spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        let before = objects.0.lock().unwrap().clone();
        if kind == "permission" {
            objects.deny_access("pods");
        } else if kind == "endpointslices" {
            objects.deny_access("endpointslices");
        } else {
            objects.reject_create(kind);
        }
        let error = operations.preflight_workload(&spec).await.unwrap_err();
        if !matches!(kind, "permission" | "endpointslices") {
            assert!(error.to_string().contains("exceeded quota"), "{error}");
            assert!(!error.to_string().contains("secret-sentinel"));
        }
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn replacement_admission_rejection_preserves_the_running_model_and_its_receipt() {
    for backend in ["vllm", "ollama"] {
        for rejected_kind in ["Pod", "ConfigMap"] {
            let original = spec(backend, backend == "vllm");
            let objects = crate::kube_api::Objects::default();
            let directory = tempfile::tempdir().unwrap();
            let (_fixture, operations) = operations(&objects, directory.path(), &original).await;
            operations
                .ensure_storage(&original.storage(), None)
                .await
                .unwrap();
            let first = operations.ensure(&original, None).await.unwrap();
            let mut pod = objects.get("v1", "Pod", "agents", &original.name).unwrap();
            pod["status"] = json!({"phase":"Running"});
            objects.insert(pod);
            let before = objects.0.lock().unwrap().clone();
            let receipt = directory
                .path()
                .join("services")
                .join(&original.name)
                .join("receipt.json");
            let recorded = std::fs::read(&receipt).unwrap();
            let mut desired = original.clone();
            desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
            objects.reject_create(rejected_kind);

            let error = operations
                .ensure(&desired, first.id.as_deref())
                .await
                .unwrap_err();
            assert!(error.to_string().contains("exceeded quota"), "{error}");
            assert_eq!(
                *objects.0.lock().unwrap(),
                before,
                "{backend} {rejected_kind}"
            );
            assert_eq!(
                std::fs::read(&receipt).unwrap(),
                recorded,
                "{backend} {rejected_kind}"
            );
        }
    }
}

#[tokio::test]
async fn replacement_admission_uses_temporary_names_without_changing_the_workload() {
    use nemoclaw_sdk::kubernetes::cluster::{GENERATION_LABEL, OWNER_LABEL};
    for backend in ["vllm", "ollama"] {
        let original = spec(backend, backend == "vllm");
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &original).await;
        operations
            .ensure_storage(&original.storage(), None)
            .await
            .unwrap();
        operations.ensure(&original, None).await.unwrap();
        let before = objects.0.lock().unwrap().clone();
        let receipt = directory
            .path()
            .join("services")
            .join(&original.name)
            .join("receipt.json");
        let recorded = std::fs::read(&receipt).unwrap();
        let initial_checks = objects.dry_runs().len();
        let mut desired = original.clone();
        desired.image = format!("registry.example/runtime@sha256:{}", "b".repeat(64));
        operations.preflight_workload(&desired).await.unwrap();
        let checks = objects.dry_runs();
        let replacements = &checks[initial_checks..];
        assert_eq!(replacements.len(), 2);
        for check in replacements {
            let name = check["metadata"]["name"].as_str().unwrap();
            assert!(name.len() <= 63);
            assert_ne!(name, original.name);
            assert!(
                name.bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            );
            let mut expected = compute_objects(&desired, None)
                .into_iter()
                .find(|object| object["kind"] == check["kind"])
                .unwrap();
            expected["metadata"]["labels"][OWNER_LABEL] = json!(original.owner);
            expected["metadata"]["labels"][GENERATION_LABEL] = json!(original.generation);
            expected["metadata"]["name"] = json!(name);
            assert_eq!(&expected, check);
        }
        assert_eq!(*objects.0.lock().unwrap(), before);
        assert_eq!(std::fs::read(&receipt).unwrap(), recorded);

        // An unchanged apply needs no replacement admission or spare quota.
        objects.reject_create("Pod");
        operations.preflight_workload(&original).await.unwrap();
        assert_eq!(objects.dry_runs().len(), checks.len());
    }
}

#[tokio::test]
async fn foreign_service_backends_cannot_receive_the_managed_credential() {
    let spec = spec("vllm", true);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let mut service = objects.get("v1", "Service", "agents", &spec.name).unwrap();
    service["spec"]["clusterIP"] = json!("10.96.0.42");
    objects.insert(service);
    objects.insert(json!({"apiVersion":"discovery.k8s.io/v1","kind":"EndpointSlice", "metadata":{"name":"injected-backend", "namespace":"agents", "labels":{"kubernetes.io/service-name":spec.name}}, "addressType":"IPv4", "endpoints":[{"addresses":["10.244.0.15"],"conditions":{"ready":true},"targetRef":{"kind":"Pod","namespace":"agents","name":"foreign","uid":"foreign"}}]}));
    let error = operations
        .endpoint_addresses(&spec.storage(), &spec.endpoint())
        .await
        .unwrap_err();
    diagnostics::assert_named_mismatch(
        &error,
        "EndpointSlice",
        "agents",
        "injected-backend",
        "endpoints.targetRef",
    );
    assert!(!error.to_string().contains("foreign"));
    assert!(!error.to_string().contains("10.244.0.15"));
}

#[tokio::test]
async fn terminal_pods_are_replaced_only_by_explicit_apply_and_only_when_owned() {
    for foreign in [false, true] {
        let spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        operations
            .ensure_storage(&spec.storage(), None)
            .await
            .unwrap();
        let first = operations.ensure(&spec, None).await.unwrap();
        let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
        let old_uid = pod["metadata"]["uid"].clone();
        pod["status"] = json!({"phase":"Failed"});
        if foreign {
            pod["metadata"]["uid"] = json!("foreign");
        }
        objects.insert(pod);
        let before = objects.0.lock().unwrap().clone();
        let receipt = directory
            .path()
            .join("services")
            .join(&spec.name)
            .join("receipt.json");
        let recorded = std::fs::read(&receipt).unwrap();
        let read = operations.read(&spec, first.id.as_deref()).await;
        assert_eq!(*objects.0.lock().unwrap(), before);
        assert_eq!(std::fs::read(&receipt).unwrap(), recorded);
        if foreign {
            diagnostics::assert_named_mismatch(
                &read.unwrap_err(),
                "Pod",
                "agents",
                &spec.name,
                "metadata.uid",
            );
            let error = operations
                .ensure(&spec, first.id.as_deref())
                .await
                .unwrap_err();
            diagnostics::assert_named_mismatch(&error, "Pod", "agents", &spec.name, "metadata.uid");
            assert_eq!(*objects.0.lock().unwrap(), before);
            assert_eq!(std::fs::read(&receipt).unwrap(), recorded);
        } else {
            assert_eq!(read.unwrap().running, Some(false));
            operations.ensure(&spec, first.id.as_deref()).await.unwrap();
            let after = objects.0.lock().unwrap().clone();
            for (path, object) in before {
                if object["kind"] == "Pod" {
                    assert_ne!(after[&path]["metadata"]["uid"], old_uid);
                } else {
                    assert_eq!(after[&path], object);
                }
            }
        }
    }
}

#[tokio::test]
async fn runtime_updates_replace_configuration_and_retry_after_interrupted_create() {
    let mut spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&spec, None).await.unwrap();
    let receipt_path = directory
        .path()
        .join("services")
        .join(&spec.name)
        .join("receipt.json");
    let original_receipt: Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    objects.insert(json!({"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"unrelated","namespace":"agents"},"data":{"keep":"me"}}));
    let foreign = objects.get("v1", "ConfigMap", "agents", "unrelated");
    let config = objects
        .get("v1", "ConfigMap", "agents", &spec.name)
        .unwrap();
    let service = objects.get("v1", "Service", "agents", &spec.name);
    if let nemoclaw_runtime::RuntimeSpec::Ollama(runtime) = &mut spec.runtime {
        runtime.model.digest = "b".repeat(64);
    }
    objects.fail_create("ConfigMap", false);
    assert!(operations.ensure(&spec, first.id.as_deref()).await.is_err());
    assert!(objects.get("v1", "Pod", "agents", &spec.name).is_none());
    let interrupted: Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    assert_eq!(
        interrupted["specification"],
        serde_json::to_value(&spec).unwrap()
    );
    for field in [
        "storage",
        "cluster",
        "namespaceUid",
        "volumes",
        "storageReady",
        "computeBound",
    ] {
        assert_eq!(interrupted[field], original_receipt[field], "{field}");
    }
    assert!(
        interrupted.get("pending").is_none(),
        "the failed create was confirmed absent"
    );
    let retained_network: Vec<_> = original_receipt["compute"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|owned| matches!(owned["kind"].as_str(), Some("Service" | "NetworkPolicy")))
        .cloned()
        .collect();
    assert_eq!(interrupted["compute"], json!(retained_network));
    let before = objects.0.lock().unwrap().clone();
    let read = operations
        .read_for_removal(&spec, first.id.as_deref())
        .await
        .unwrap();
    assert_eq!(read.id, first.id);
    assert_eq!(*objects.0.lock().unwrap(), before);
    let recovered = operations.ensure(&spec, first.id.as_deref()).await.unwrap();
    assert_eq!(recovered.id, first.id);
    let recovered_receipt: Value =
        serde_json::from_slice(&std::fs::read(&receipt_path).unwrap()).unwrap();
    for field in [
        "storage",
        "cluster",
        "namespaceUid",
        "volumes",
        "storageReady",
        "computeBound",
    ] {
        assert_eq!(recovered_receipt[field], original_receipt[field], "{field}");
    }
    assert!(recovered_receipt.get("pending").is_none());
    let replaced = objects
        .get("v1", "ConfigMap", "agents", &spec.name)
        .unwrap();
    assert_ne!(replaced["metadata"]["uid"], config["metadata"]["uid"]);
    assert_ne!(replaced["data"], config["data"]);
    assert_eq!(objects.get("v1", "Service", "agents", &spec.name), service);
    assert_eq!(
        objects.get("v1", "ConfigMap", "agents", "unrelated"),
        foreign
    );
    operations.remove(&spec, first.id.as_deref()).await.unwrap();
    assert_eq!(
        objects.get("v1", "ConfigMap", "agents", "unrelated"),
        foreign
    );
    assert!(
        objects
            .get(
                "networking.k8s.io/v1",
                "NetworkPolicy",
                "agents",
                &spec.name
            )
            .is_none()
    );
}

#[tokio::test]
async fn a_bound_serving_port_change_preserves_all_live_objects() {
    let mut spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&spec, None).await.unwrap();
    let before = objects.0.lock().unwrap().clone();
    if let nemoclaw_runtime::RuntimeSpec::Ollama(runtime) = &mut spec.runtime {
        runtime.serving.port += 1;
    }
    let error = operations
        .ensure(&spec, first.id.as_deref())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("conversation history"));
    assert_eq!(*objects.0.lock().unwrap(), before);
}

#[test]
fn model_pods_allow_runtime_shutdown_and_preserve_failure_diagnostics() {
    for backend in ["vllm", "ollama"] {
        let objects = compute_objects(&spec(backend, backend == "vllm"), None);
        let pod = objects
            .iter()
            .find(|object| object["kind"] == "Pod")
            .unwrap();
        assert_eq!(pod["spec"]["terminationGracePeriodSeconds"], 60);
        assert_eq!(
            pod["spec"]["containers"][0]["terminationMessagePolicy"],
            "FallbackToLogsOnError"
        );
    }
}

#[tokio::test]
async fn destroy_waits_for_pod_deletion_before_removing_its_network_boundary() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&spec, None).await.unwrap();
    objects.delay_deletion("Pod", 4);
    let removal = operations.remove(&spec, first.id.as_deref());
    tokio::pin!(removal);
    tokio::select! {
        result = &mut removal => panic!("delete must wait: {result:?}"),
        _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
            assert!(objects.get("networking.k8s.io/v1", "NetworkPolicy", "agents", &spec.name).is_some());
        }
    }
    removal.await.unwrap();
    assert!(objects.get("v1", "Pod", "agents", &spec.name).is_none());
    assert!(
        objects
            .get(
                "networking.k8s.io/v1",
                "NetworkPolicy",
                "agents",
                &spec.name
            )
            .is_none()
    );
}

#[tokio::test]
async fn endpoint_grants_reject_service_drift_and_unroutable_addresses() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    operations.ensure(&spec, None).await.unwrap();
    let mut service = objects.get("v1", "Service", "agents", &spec.name).unwrap();
    service["spec"]["clusterIP"] = json!("10.96.0.42");
    service["spec"]["clusterIPs"] = json!(["10.96.0.42"]);
    for addresses in [
        json!(["None"]),
        json!(["127.0.0.1"]),
        json!(["169.254.1.1"]),
        json!(["255.255.255.255"]),
        json!(["::ffff:10.0.0.1"]),
        json!(["fe80::1"]),
        json!(["::"]),
        json!(["10.96.0.42", "fd00::42", "10.96.0.43"]),
    ] {
        let malformed = addresses[0] == "None" || addresses.as_array().unwrap().len() > 2;
        let mut invalid = service.clone();
        invalid["spec"]["clusterIP"] = addresses[0].clone();
        invalid["spec"]["clusterIPs"] = addresses;
        objects.insert(invalid);
        let error = operations
            .endpoint_addresses(&spec.storage(), &spec.endpoint())
            .await
            .unwrap_err();
        if malformed {
            assert_eq!(error, nemoclaw_sdk::ObservationError::Incomplete);
        } else {
            diagnostics::assert_named_mismatch(
                &error,
                "Service",
                "agents",
                &spec.name,
                "spec.clusterIPs",
            );
        }
    }
    for (field, value) in [
        ("selector", json!({"foreign":"pod"})),
        ("ports", json!([])),
        ("type", json!("NodePort")),
    ] {
        let mut invalid = service.clone();
        invalid["spec"][field] = value;
        objects.insert(invalid);
        assert_binding_mismatch(
            operations
                .endpoint_addresses(&spec.storage(), &spec.endpoint())
                .await,
        );
    }
}

#[tokio::test]
async fn lost_first_creation_records_an_address_until_an_operator_resolves_it() {
    for kind in ["PersistentVolumeClaim", "ConfigMap"] {
        let spec = spec("ollama", false);
        let objects = crate::kube_api::Objects::default();
        let directory = tempfile::tempdir().unwrap();
        let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
        if kind == "ConfigMap" {
            operations
                .ensure_storage(&spec.storage(), None)
                .await
                .unwrap();
        }
        objects.fail_create(kind, true);
        if kind == "ConfigMap" {
            assert!(operations.ensure(&spec, None).await.is_err());
            let partial = operations.read_for_removal(&spec, None).await.unwrap();
            assert!(partial.id.is_some());
            assert!(
                operations
                    .remove(&spec, partial.id.as_deref())
                    .await
                    .is_err()
            );
        } else {
            assert!(
                operations
                    .ensure_storage(&spec.storage(), None)
                    .await
                    .is_err()
            );
        }
        let before = objects.0.lock().unwrap().clone();
        let error = if kind == "ConfigMap" {
            operations.ensure(&spec, None).await.unwrap_err()
        } else {
            operations
                .ensure_storage(&spec.storage(), None)
                .await
                .unwrap_err()
        };
        assert!(error.to_string().contains(kind), "{error}");
        assert!(error.to_string().contains(&spec.name), "{error}");
        assert_eq!(*objects.0.lock().unwrap(), before);
    }
}

#[tokio::test]
async fn delete_timeout_keeps_the_network_boundary_and_can_be_retried() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&spec, None).await.unwrap();
    objects.delay_deletion("Pod", u32::MAX);
    tokio::time::pause();
    let mut removal = Box::pin(operations.remove(&spec, first.id.as_deref()));
    let wall_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while objects
        .deletion_reads(&spec.name)
        .is_none_or(|reads| reads == u32::MAX)
    {
        tokio::select! {
            biased;
            result = &mut removal => panic!("delete returned before its first poll: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(
            std::time::Instant::now() < wall_deadline,
            "fixture did not receive delete/poll"
        );
    }
    tokio::time::advance(std::time::Duration::from_secs(31)).await;
    tokio::select! {
        biased;
        result = &mut removal => panic!("delete must allow the 60-second Pod grace period: {result:?}"),
        _ = tokio::task::yield_now() => {}
    }
    tokio::time::advance(std::time::Duration::from_secs(60)).await;
    assert_eq!(
        removal.await,
        Err(nemoclaw_sdk::ObservationError::Incomplete)
    );
    tokio::time::resume();
    assert!(
        objects
            .get(
                "networking.k8s.io/v1",
                "NetworkPolicy",
                "agents",
                &spec.name
            )
            .is_some()
    );
    objects
        .0
        .lock()
        .unwrap()
        .remove(&format!("/api/v1/namespaces/agents/pods/{}", spec.name));
    operations.remove(&spec, first.id.as_deref()).await.unwrap();
    assert!(
        objects
            .get(
                "networking.k8s.io/v1",
                "NetworkPolicy",
                "agents",
                &spec.name
            )
            .is_none()
    );
}

#[tokio::test]
async fn a_replacement_during_delete_preserves_the_network_boundary() {
    let spec = spec("ollama", false);
    let objects = crate::kube_api::Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = operations(&objects, directory.path(), &spec).await;
    operations
        .ensure_storage(&spec.storage(), None)
        .await
        .unwrap();
    let first = operations.ensure(&spec, None).await.unwrap();
    objects.delay_deletion("Pod", u32::MAX);
    let mut removal = Box::pin(operations.remove(&spec, first.id.as_deref()));
    let wall_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while objects.deletion_reads(&spec.name).is_none() {
        tokio::select! {
            biased;
            result = &mut removal => panic!("delete returned before its first poll: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        assert!(std::time::Instant::now() < wall_deadline);
    }
    let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
    pod["metadata"]["uid"] = json!("replacement");
    objects.insert(pod.clone());
    let error = removal.await.unwrap_err();
    diagnostics::assert_named_mismatch(&error, "Pod", "agents", &spec.name, "metadata.uid");
    assert_eq!(objects.get("v1", "Pod", "agents", &spec.name), Some(pod));
    assert!(
        objects
            .get(
                "networking.k8s.io/v1",
                "NetworkPolicy",
                "agents",
                &spec.name
            )
            .is_some()
    );
}
