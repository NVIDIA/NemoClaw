// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{Spec, StorageSpec};
use crate::kubernetes::{cluster::OWNER_LABEL, gateway::Identity};
use serde_json::{Value, json};

/// Retained volumes are independent of the image, model revision and Pod identity.
pub fn storage_objects(spec: &StorageSpec) -> Vec<Value> {
    let claim = |suffix: &str, gib: u64| {
        let mut object = json!({"apiVersion": "v1", "kind": "PersistentVolumeClaim",
            "metadata": {"name": format!("{}-{suffix}", spec.name), "namespace": spec.namespace()},
            "spec": {"accessModes": ["ReadWriteOnce"], "volumeMode": "Filesystem", "resources": {"requests": {"storage": format!("{gib}Gi")}}}});
        if let Some(class) = &spec.storage_class {
            object["spec"]["storageClassName"] = json!(class);
        }
        object
    };
    let mut objects = vec![claim("data", spec.storage_gib)];
    if spec.authenticated {
        objects.push(claim("auth", 1));
    }
    objects
}

/// The Pod has no restart controller: a protective runtime stop requires apply or recover.
pub fn compute_objects(spec: &Spec, identity: Option<Identity>) -> Vec<Value> {
    let namespace = spec.namespace();
    let metadata = json!({"name": spec.name, "namespace": namespace});
    let selector = json!({OWNER_LABEL: spec.owner, "nemoclaw.nvidia.com/service": spec.name});
    let configuration =
        serde_json::to_string(&spec.runtime).expect("serializable runtime specification");
    let config = json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata,
        "immutable": true, "data": {"NEMOCLAW_RUNTIME_SPEC": configuration}});
    let service = json!({"apiVersion": "v1", "kind": "Service", "metadata": metadata,
        "spec": {"type": "ClusterIP", "selector": selector,
            "ports": [{"name": "inference", "port": spec.port(), "targetPort": spec.port(), "protocol": "TCP"}]}});
    let policy = json!({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": metadata,
        "spec": {"podSelector": {"matchLabels": selector}, "policyTypes": ["Ingress"],
            "ingress": [{"from": [{"podSelector": {}}], "ports": [{"protocol": "TCP", "port": spec.port()}]}]}});
    let mut volumes = vec![
        json!({"name": "models", "persistentVolumeClaim": {"claimName": format!("{}-data", spec.name)}}),
        json!({"name": "shm", "emptyDir": {"medium": "Memory", "sizeLimit": format!("{}Gi", spec.shared_memory_gib)}}),
        json!({"name": "tmp", "emptyDir": {}}),
    ];
    let mut mounts = vec![
        json!({"name": "models", "mountPath": "/data"}),
        json!({"name": "shm", "mountPath": "/dev/shm"}),
        json!({"name": "tmp", "mountPath": "/tmp"}),
    ];
    if spec.authenticated() {
        volumes.push(json!({"name": "credentials", "persistentVolumeClaim": {"claimName": format!("{}-auth", spec.name)}}));
        mounts.push(json!({"name": "credentials", "mountPath": "/credentials"}));
    }
    let mut node_selector = spec.settings.node_selector.clone();
    node_selector.insert("kubernetes.io/os".into(), "linux".into());
    node_selector.insert("kubernetes.io/arch".into(), spec.architecture.clone());
    let identity = identity.unwrap_or(Identity {
        user: 1000,
        group: 1000,
    });
    let mut pod = json!({"apiVersion": "v1", "kind": "Pod",
        "metadata": {"name": spec.name, "namespace": namespace, "labels": selector},
        "spec": {"restartPolicy": "Never", "automountServiceAccountToken": false,
            "nodeSelector": node_selector, "tolerations": spec.settings.tolerations,
            "securityContext": {"runAsNonRoot": true, "runAsUser": identity.user, "runAsGroup": identity.group,
                "fsGroup": identity.group, "fsGroupChangePolicy": "OnRootMismatch", "seccompProfile": {"type": "RuntimeDefault"}},
            "containers": [{"name": "runtime", "image": spec.image, "imagePullPolicy": spec.image_pull_policy.unwrap_or_default().as_str(),
                "command": ["/usr/local/bin/nemoclaw-runtime"],
                "envFrom": [{"configMapRef": {"name": spec.name}}],
                "env": [{"name": "HOME", "value": "/data"}, {"name": "XDG_CACHE_HOME", "value": "/data/.cache"}],
                "ports": [{"name": "inference", "containerPort": spec.port()}],
                "securityContext": {"allowPrivilegeEscalation": false, "capabilities": {"drop": ["ALL"]}},
                "resources": {"requests": {"cpu": format!("{}m", spec.settings.cpu_request_millis), "memory": format!("{}Gi", spec.settings.memory_request_gib), "nvidia.com/gpu": "1"},
                    "limits": {"cpu": format!("{}m", spec.settings.cpu_limit_millis), "memory": format!("{}Gi", spec.settings.memory_limit_gib), "nvidia.com/gpu": "1"}},
                "volumeMounts": mounts}], "volumes": volumes}});
    if let Some(class) = &spec.settings.runtime_class_name {
        pod["spec"]["runtimeClassName"] = json!(class);
    }
    vec![config, service, policy, pod]
}
