// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::kubernetes::services::{Spec, compute_objects, storage_objects};
use serde_json::{Value, json};

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
    objects.0.lock().unwrap().remove(&pod_path);
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
    assert!(objects.get("v1", "Pod", "agents", &spec.name).is_some());
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
    use nemoclaw_sdk::ObservationError;
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
        assert_eq!(
            operations.ensure(&spec, compute.id.as_deref()).await,
            Err(ObservationError::BindingMismatch)
        );
        assert_eq!(
            operations.remove(&spec, compute.id.as_deref()).await,
            Err(ObservationError::BindingMismatch)
        );
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
    assert_eq!(
        operations.ensure(&spec, None).await,
        Err(nemoclaw_sdk::ObservationError::BindingMismatch)
    );
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
    assert_eq!(
        operations.ensure(&spec, None).await,
        Err(nemoclaw_sdk::ObservationError::BindingMismatch)
    );
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
    assert!(
        operations
            .endpoint_addresses(&spec.storage(), "http://elsewhere.agents.svc:11434/v1")
            .await
            .is_err()
    );
    service["metadata"]["uid"] = json!("replacement");
    objects.insert(service);
    assert_eq!(
        operations
            .endpoint_addresses(&spec.storage(), &spec.endpoint())
            .await,
        Err(nemoclaw_sdk::ObservationError::BindingMismatch)
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
    assert_eq!(
        operations.ensure(&spec, compute.id.as_deref()).await,
        Err(nemoclaw_sdk::ObservationError::BindingMismatch)
    );
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
    assert_eq!(
        operations.read(&spec, compute.id.as_deref()).await,
        Err(nemoclaw_sdk::ObservationError::BindingMismatch)
    );
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
