// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The command-scoped connection to a managed Kubernetes gateway: a loopback
//! port forward and the client credentials OpenShell requires.
#![cfg(unix)]

use crate::kube_api::{Objects, client};
use base64::{Engine, engine::general_purpose::STANDARD};
use nemoclaw_sdk::{
    Error,
    kubernetes::{
        AUTH_KIND, CA_ENV, CERT_ENV, GATEWAY_KIND, KEY_ENV, STORAGE_KIND, Spec, TOKEN_ENV,
        connection::forward, operations::Operations,
    },
};
use serde_json::json;
use std::path::Path;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const OWNER: &str = "00000000-0000-4000-8000-000000000001";
const NAME: &str = "nc-0123456789abcdef-gateway";

#[tokio::test]
async fn the_forwarder_carries_bytes_both_ways_for_each_connection() {
    let upstream = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let target = upstream.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut stream, _) = upstream.accept().await.unwrap();
            tokio::spawn(async move {
                let mut buffer = [0; 64];
                let read = stream.read(&mut buffer).await.unwrap();
                stream.write_all(&buffer[..read]).await.unwrap();
            });
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let local = listener.local_addr().unwrap();
    let _forward = forward(listener, move || async move {
        tokio::net::TcpStream::connect(target).await
    });
    for message in [b"first".as_slice(), b"second".as_slice()] {
        let mut stream = tokio::net::TcpStream::connect(local).await.unwrap();
        stream.write_all(message).await.unwrap();
        let mut echoed = vec![0; message.len()];
        stream.read_exact(&mut echoed).await.unwrap();
        assert_eq!(echoed, message);
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn spec(kind: &str, port: u16) -> Spec {
    serde_json::from_value(json!({
        "layout": 1, "kind": kind, "name": NAME, "owner": OWNER,
        "generation": "0123456789abcdef0123456789abcdef",
        "settings": {
            "runtime": {"provider": "kubernetes"},
            "endpoint": format!("https://127.0.0.1:{port}"),
            "kubernetes": {
                "kubeconfig": {"env": "TEST_CLUSTER_CONFIG"}, "context": "selected", "namespace": "agents",
                "authentication": {"profile": "development"}
            }
        }
    }))
    .unwrap()
}

/// A cluster with a running gateway and the chart's client TLS Secret.
async fn running(objects: &Objects, directory: &Path) -> (crate::transport::Fixture, Operations) {
    for object in [
        json!({"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "kube-system", "uid": "system-1"}}),
        json!({"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
               "metadata": {"name": "standard", "annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}),
        json!({"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
               "metadata": {"name": "sandboxes.agents.x-k8s.io"}}),
        json!({"apiVersion": "apps/v1", "kind": "Deployment",
               "metadata": {"name": "agent-sandbox-controller", "namespace": "agent-sandbox-system"},
               "status": {"availableReplicas": 1}}),
    ] {
        objects.insert(object);
    }
    let fixture = objects.serve().await;
    let operations = Operations {
        client: client(&fixture),
        server: fixture.endpoint.clone(),
        state: directory.join("state"),
    };
    operations
        .ensure(&spec(STORAGE_KIND, 1), None)
        .await
        .unwrap();
    operations.ensure(&spec(AUTH_KIND, 1), None).await.unwrap();
    objects.insert(json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": NAME, "namespace": "agents", "uid": "gateway-uid", "generation": 1,
            "labels": {"app.kubernetes.io/instance": NAME},
            "annotations": {"meta.helm.sh/release-name": NAME, "meta.helm.sh/release-namespace": "agents"}},
        "status": {"readyReplicas": 1, "observedGeneration": 1}}));
    operations
        .ensure(&spec(GATEWAY_KIND, 1), None)
        .await
        .unwrap();
    objects.insert(
        json!({"apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/tls",
        "metadata": {"name": format!("{NAME}-client-tls"), "namespace": "agents"},
        "data": {
            "ca.crt": STANDARD.encode("gateway CA"),
            "tls.crt": STANDARD.encode("client certificate"),
            "tls.key": STANDARD.encode("client key"),
        }}),
    );
    (fixture, operations)
}

#[tokio::test]
async fn a_connection_supplies_private_client_credentials_and_a_token() {
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = running(&objects, directory.path()).await;
    let port = free_port();
    let connection = operations.connect(&spec(GATEWAY_KIND, port)).await.unwrap();
    assert_eq!(connection.endpoint(), format!("https://127.0.0.1:{port}"));
    let environment = connection.environment();
    assert_eq!(environment.len(), 4);
    for (name, expected) in [
        (CA_ENV, "gateway CA"),
        (CERT_ENV, "client certificate"),
        (KEY_ENV, "client key"),
    ] {
        let path = Path::new(&environment[name]);
        assert_eq!(std::fs::read_to_string(path).unwrap(), expected, "{name}");
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            path.metadata().unwrap().permissions().mode() & 0o077,
            0,
            "{name} must be private"
        );
        assert!(
            path.starts_with(directory.path().join("state")),
            "{name} stays in the state directory"
        );
    }
    let claims = environment[TOKEN_ENV].split('.').nth(1).unwrap();
    let claims: serde_json::Value = serde_json::from_slice(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(claims)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(claims["aud"], OWNER);
}

#[tokio::test]
async fn an_occupied_loopback_port_is_refused() {
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = running(&objects, directory.path()).await;
    let held = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = held.local_addr().unwrap().port();
    assert!(matches!(
        operations.connect(&spec(GATEWAY_KIND, port)).await,
        Err(Error::Conflict(_))
    ));
}

#[tokio::test]
async fn a_gateway_that_is_not_running_cannot_be_connected() {
    let objects = Objects::default();
    let directory = tempfile::tempdir().unwrap();
    let (_fixture, operations) = running(&objects, directory.path()).await;
    objects.insert(json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": NAME, "namespace": "agents", "uid": "gateway-uid", "generation": 2},
        "status": {"readyReplicas": 0, "observedGeneration": 2}}));
    assert!(
        operations
            .connect(&spec(GATEWAY_KIND, free_port()))
            .await
            .is_err()
    );
}
