// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Cluster connections use only the kubeconfig and context named in the YAML.
#![cfg(unix)]

use crate::transport::Fixture;
use nemoclaw_sdk::kubernetes::{ClusterTarget, connect};
use std::sync::{Arc, Mutex};

/// A kubeconfig with two contexts whose user runs an exec credential plugin.
fn kubeconfig(directory: &std::path::Path, server: &str) -> std::path::PathBuf {
    let plugin = directory.join("credential-plugin");
    std::fs::write(
        &plugin,
        "#!/bin/sh\nprintf '%s' '{\"apiVersion\":\"client.authentication.k8s.io/v1\",\"kind\":\"ExecCredential\",\"status\":{\"token\":\"from-plugin\"}}'\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&plugin, std::fs::Permissions::from_mode(0o700)).unwrap();
    let path = directory.join("kubeconfig");
    std::fs::write(
        &path,
        format!(
            "apiVersion: v1\nkind: Config\ncurrent-context: other\n\
             clusters:\n- name: selected\n  cluster:\n    server: {server}\n- name: other\n  cluster:\n    server: http://127.0.0.1:9\n\
             users:\n- name: plugin\n  user:\n    exec:\n      apiVersion: client.authentication.k8s.io/v1\n      command: {}\n      interactiveMode: Never\n\
             contexts:\n- name: selected\n  context:\n    cluster: selected\n    user: plugin\n- name: other\n  context:\n    cluster: other\n    user: plugin\n",
            plugin.display()
        ),
    )
    .unwrap();
    path
}

#[tokio::test]
async fn the_authored_context_is_used_with_its_exec_plugin_credentials() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let record = seen.clone();
    let server = Fixture::start_tcp(move |request| {
        record.lock().unwrap().push((
            request.path.clone(),
            request.header("authorization").map(str::to_owned),
        ));
        Some((
            200,
            br#"{"kind":"Namespace","apiVersion":"v1","metadata":{"name":"agents","uid":"uid-1"}}"#
                .to_vec(),
        ))
    })
    .await;
    let directory = tempfile::tempdir().unwrap();
    let path = kubeconfig(directory.path(), &server.endpoint);
    let target = ClusterTarget {
        kubeconfig: path,
        context: "selected".into(),
    };
    let client = connect(&target).await.unwrap();
    let namespaces: kube::Api<k8s_openapi::api::core::v1::Namespace> = kube::Api::all(client);
    let namespace = namespaces.get("agents").await.unwrap();
    assert_eq!(namespace.metadata.uid.as_deref(), Some("uid-1"));
    let seen = seen.lock().unwrap();
    assert_eq!(seen[0].0, "/api/v1/namespaces/agents");
    assert_eq!(seen[0].1.as_deref(), Some("Bearer from-plugin"));
}

#[tokio::test]
async fn an_inherited_kubeconfig_is_ignored() {
    // Rerun this test in a child process whose environment selects another
    // kubeconfig that has the requested context; the authored file lacks it.
    const CHILD: &str = "NEMOCLAW_KUBECONFIG_TEST_AUTHORED";
    if let Some(authored) = std::env::var_os(CHILD) {
        let target = ClusterTarget {
            kubeconfig: authored.into(),
            context: "selected".into(),
        };
        assert!(connect(&target).await.is_err());
        return;
    }
    let directory = tempfile::tempdir().unwrap();
    let inherited = kubeconfig(directory.path(), "http://127.0.0.1:9");
    let authored = directory.path().join("authored");
    std::fs::write(
        &authored,
        "apiVersion: v1\nkind: Config\nclusters: []\nusers: []\ncontexts: []\n",
    )
    .unwrap();
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "kubernetes_connection::an_inherited_kubeconfig_is_ignored",
        ])
        .env(CHILD, &authored)
        .env("KUBECONFIG", &inherited)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[tokio::test]
async fn an_unknown_context_fails_without_falling_back() {
    let directory = tempfile::tempdir().unwrap();
    let path = kubeconfig(directory.path(), "http://127.0.0.1:9");
    let target = ClusterTarget {
        kubeconfig: path,
        context: "missing".into(),
    };
    assert!(connect(&target).await.is_err());
}
