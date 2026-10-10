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
    // The image's default worker count follows the host CPU count and can
    // exceed this static server's memory limit on large Kubernetes nodes.
    let nginx = format!(
        r#"worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {{ worker_connections 1024; }}
http {{
    access_log off;
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;
    server {{
        listen {PORT} ssl;
        ssl_certificate /tls/tls.crt;
        ssl_certificate_key /tls/tls.key;
        default_type application/json;
        location = /.well-known/openid-configuration {{ alias /documents/openid-configuration; }}
        location = /jwks {{ alias /documents/jwks; }}
        location / {{ return 404; }}
    }}
}}
"#
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
                    "command": ["nginx", "-c", "/etc/nginx/conf.d/default.conf", "-g", "daemon off;"],
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
        "jwks_ttl_secs": 60,
        "roles_claim": "roles",
        "admin_role": super::auth::ADMIN_ROLE,
        "user_role": super::auth::USER_ROLE,
        "scopes_claim": "scope",
        "dangerously_allow_insecure_http": false,
    })
}
