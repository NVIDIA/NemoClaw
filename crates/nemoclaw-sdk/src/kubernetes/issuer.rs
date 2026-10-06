// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The in-cluster development issuer: a static HTTPS server that publishes
//! the discovery document and key set, and nothing else.
//!
//! It runs the pinned `nginx-unprivileged` image with a read-only root
//! filesystem. A NetworkPolicy admits only the gateway's pods and allows no
//! egress. The private signing key never leaves the operator's machine.

use super::auth::Material;
use crate::artifact_pins::DEVELOPMENT_ISSUER_IMAGE;
use serde_json::{Value, json};

const PORT: u16 = 8443;

/// The objects that run one deployment's issuer, in creation order.
/// `name` is the gateway release; objects are named `<name>-oidc`.
pub fn objects(material: &Material, name: &str, namespace: &str) -> Vec<Value> {
    let issuer = format!("{name}-oidc");
    let metadata = json!({"name": issuer, "namespace": namespace});
    let selector = json!({"app.kubernetes.io/name": "nemoclaw-development-issuer", "app.kubernetes.io/instance": issuer});
    let nginx = format!(
        "server {{\n    listen {PORT} ssl;\n    ssl_certificate /tls/tls.crt;\n    ssl_certificate_key /tls/tls.key;\n    \
         default_type application/json;\n    \
         location = /.well-known/openid-configuration {{ alias /documents/openid-configuration; }}\n    \
         location = /jwks {{ alias /documents/jwks; }}\n    location / {{ return 404; }}\n}}\n"
    );
    vec![
        // The gateway mounts this CA to verify the issuer's certificate.
        json!({"apiVersion": "v1", "kind": "ConfigMap",
               "metadata": {"name": format!("{issuer}-ca"), "namespace": namespace},
               "data": {"ca.crt": material.ca_pem()}}),
        json!({"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/tls", "metadata": metadata,
               "stringData": {"tls.crt": material.certificate_pem(), "tls.key": material.key_pem()}}),
        json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata, "data": {
            "default.conf": nginx,
            "openid-configuration": material.discovery().to_string(),
            "jwks": material.jwks().to_string(),
        }}),
        json!({"apiVersion": "v1", "kind": "Service", "metadata": metadata, "spec": {
            "selector": selector, "ports": [{"port": PORT, "targetPort": PORT, "protocol": "TCP"}],
        }}),
        json!({"apiVersion": "networking.k8s.io/v1", "kind": "NetworkPolicy", "metadata": metadata, "spec": {
            "podSelector": {"matchLabels": selector},
            "policyTypes": ["Ingress", "Egress"],
            "ingress": [{
                "from": [{"podSelector": {"matchLabels": {
                    "app.kubernetes.io/name": "openshell", "app.kubernetes.io/instance": name,
                }}}],
                "ports": [{"protocol": "TCP", "port": PORT}],
            }],
            "egress": [],
        }}),
        json!({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": metadata, "spec": {
            "replicas": 1,
            "selector": {"matchLabels": selector},
            "template": {"metadata": {"labels": selector}, "spec": {
                "automountServiceAccountToken": false,
                "securityContext": {"runAsNonRoot": true, "seccompProfile": {"type": "RuntimeDefault"}},
                "containers": [{
                    "name": "issuer",
                    "image": DEVELOPMENT_ISSUER_IMAGE,
                    "imagePullPolicy": "IfNotPresent",
                    // Skip the image's entrypoint scripts, which edit its configuration.
                    "command": ["nginx", "-g", "daemon off;"],
                    "ports": [{"containerPort": PORT}],
                    "readinessProbe": {"tcpSocket": {"port": PORT}, "periodSeconds": 2},
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "16Mi"},
                        "limits": {"cpu": "100m", "memory": "64Mi"},
                    },
                    "securityContext": {
                        "readOnlyRootFilesystem": true,
                        "allowPrivilegeEscalation": false,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "volumeMounts": [
                        {"name": "configuration", "mountPath": "/etc/nginx/conf.d", "readOnly": true},
                        {"name": "documents", "mountPath": "/documents", "readOnly": true},
                        {"name": "tls", "mountPath": "/tls", "readOnly": true},
                        {"name": "scratch", "mountPath": "/tmp"},
                    ],
                }],
                "volumes": [
                    {"name": "configuration", "configMap": {"name": issuer, "items": [{"key": "default.conf", "path": "default.conf"}]}},
                    {"name": "documents", "configMap": {"name": issuer, "items": [
                        {"key": "openid-configuration", "path": "openid-configuration"},
                        {"key": "jwks", "path": "jwks"},
                    ]}},
                    {"name": "tls", "secret": {"secretName": issuer}},
                    {"name": "scratch", "emptyDir": {"sizeLimit": "16Mi"}},
                ],
            }},
        }}),
    ]
}

/// Chart values that make the gateway trust tokens from this issuer.
pub fn oidc_values(name: &str, namespace: &str, audience: &str) -> Value {
    json!({
        "issuer": format!("https://{name}-oidc.{namespace}.svc.cluster.local:{PORT}"),
        "audience": audience,
        "jwksTtl": 60,
        "rolesClaim": "roles",
        "adminRole": super::auth::ADMIN_ROLE,
        "userRole": super::auth::USER_ROLE,
        "scopesClaim": "scope",
        "caConfigMapName": format!("{name}-oidc-ca"),
        "dangerouslyAllowInsecureHttp": false,
    })
}
