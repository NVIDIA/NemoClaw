// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Development authentication: a private signing key and issuer certificate
//! kept in the state directory, and the public documents the issuer serves.

use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use nemoclaw_sdk::{ObservationError, kubernetes::auth::Development};
use serde_json::Value;

const OWNER: &str = "00000000-0000-4000-8000-000000000001";

fn development(directory: &std::path::Path) -> Development {
    Development::new(
        directory.join("auth"),
        "nc-0123456789abcdef-gateway",
        "agents",
        OWNER,
    )
}

#[test]
fn material_is_created_once_and_reused() {
    let directory = tempfile::tempdir().unwrap();
    let first = development(directory.path()).ensure().unwrap();
    let second = development(directory.path()).ensure().unwrap();
    assert_eq!(first.jwks(), second.jwks());
    assert_eq!(first.ca_pem(), second.ca_pem());
    #[cfg(unix)]
    for entry in std::fs::read_dir(directory.path().join("auth")).unwrap() {
        use std::os::unix::fs::PermissionsExt;
        let mode = entry.unwrap().metadata().unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0, "material must be private");
    }
}

#[test]
fn a_partial_set_of_material_is_refused() {
    let directory = tempfile::tempdir().unwrap();
    development(directory.path()).ensure().unwrap();
    std::fs::remove_file(directory.path().join("auth/signing.pk8")).unwrap();
    assert!(matches!(
        development(directory.path()).ensure(),
        Err(ObservationError::Authentication)
    ));
}

#[test]
fn the_discovery_document_names_the_issuer_and_its_key_set() {
    let directory = tempfile::tempdir().unwrap();
    let material = development(directory.path()).ensure().unwrap();
    let discovery = material.discovery();
    let issuer = "https://nc-0123456789abcdef-gateway-oidc.agents.svc.cluster.local:8443";
    assert_eq!(discovery["issuer"], issuer);
    assert_eq!(discovery["jwks_uri"], format!("{issuer}/jwks"));
    assert_eq!(material.issuer(), issuer);
    let keys = material.jwks()["keys"].as_array().unwrap().clone();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0]["kty"], "OKP");
    assert_eq!(keys[0]["crv"], "Ed25519");
    assert_eq!(keys[0]["alg"], "EdDSA");
    assert_eq!(keys[0]["use"], "sig");
}

#[test]
fn a_token_verifies_with_the_published_key_and_names_the_deployment() {
    let directory = tempfile::tempdir().unwrap();
    let material = development(directory.path()).ensure().unwrap();
    let token = material.token(1_800_000_000);
    let parts: Vec<&str> = token.split('.').collect();
    assert_eq!(parts.len(), 3);
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0]).unwrap()).unwrap();
    assert_eq!(header["alg"], "EdDSA");
    assert_eq!(header["kid"], material.jwks()["keys"][0]["kid"]);
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1]).unwrap()).unwrap();
    assert_eq!(claims["iss"], material.issuer());
    assert_eq!(claims["aud"], OWNER);
    assert_eq!(claims["exp"], 1_800_003_600);
    assert_eq!(
        claims["roles"],
        serde_json::json!(["nemoclaw-development-admin"])
    );
    let public = URL_SAFE_NO_PAD
        .decode(material.jwks()["keys"][0]["x"].as_str().unwrap())
        .unwrap();
    let signature = URL_SAFE_NO_PAD.decode(parts[2]).unwrap();
    let message = format!("{}.{}", parts[0], parts[1]);
    ring::signature::UnparsedPublicKey::new(&ring::signature::ED25519, &public)
        .verify(message.as_bytes(), &signature)
        .expect("token signature verifies with the published key");
}

#[test]
fn the_issuer_certificate_is_trusted_only_for_the_issuer_host() {
    use rustls::{
        client::danger::ServerCertVerifier,
        pki_types::{CertificateDer, ServerName, UnixTime, pem::PemObject},
    };
    let directory = tempfile::tempdir().unwrap();
    let material = development(directory.path()).ensure().unwrap();
    let mut roots = rustls::RootCertStore::empty();
    roots
        .add(CertificateDer::from_pem_slice(material.ca_pem().as_bytes()).unwrap())
        .unwrap();
    let provider = std::sync::Arc::new(rustls::crypto::ring::default_provider());
    let verifier =
        rustls::client::WebPkiServerVerifier::builder_with_provider(roots.into(), provider)
            .build()
            .unwrap();
    let server = CertificateDer::from_pem_slice(material.certificate_pem().as_bytes()).unwrap();
    let now = UnixTime::now();
    let host = "nc-0123456789abcdef-gateway-oidc.agents.svc.cluster.local";
    verifier
        .verify_server_cert(&server, &[], &ServerName::try_from(host).unwrap(), &[], now)
        .expect("issuer host is trusted");
    assert!(
        verifier
            .verify_server_cert(
                &server,
                &[],
                &ServerName::try_from("elsewhere.example").unwrap(),
                &[],
                now
            )
            .is_err()
    );
}

/// Runs the pinned issuer image with the generated configuration, as the
/// Deployment does, and checks that both documents remain available over HTTPS
/// within the Deployment's memory budget.
#[tokio::test]
#[ignore = "runs the issuer image with Docker; run through cargo ci live-docker"]
async fn the_issuer_image_serves_both_documents_over_https() {
    use nemoclaw_sdk::kubernetes::issuer;
    let directory = tempfile::tempdir().unwrap();
    let material = development(directory.path()).ensure().unwrap();
    let objects = issuer::objects(&material, "nc-0123456789abcdef-gateway", "agents");
    let find = |kind: &str, name: &str| {
        objects
            .iter()
            .find(|object| object["kind"] == kind && object["metadata"]["name"] == name)
            .unwrap()
            .clone()
    };
    let documents = find("ConfigMap", "nc-0123456789abcdef-gateway-oidc");
    let secret = find("Secret", "nc-0123456789abcdef-gateway-oidc");
    let deployment = find("Deployment", "nc-0123456789abcdef-gateway-oidc");
    let container = &deployment["spec"]["template"]["spec"]["containers"][0];
    // Lay out the mounted volumes on disk, readable by the image's user.
    let root = directory.path().join("mounts");
    for (dir, entries) in [
        (
            "conf.d",
            vec![("default.conf", &documents["data"]["default.conf"])],
        ),
        (
            "documents",
            vec![
                (
                    "openid-configuration",
                    &documents["data"]["openid-configuration"],
                ),
                ("jwks", &documents["data"]["jwks"]),
            ],
        ),
        (
            "tls",
            vec![
                ("tls.crt", &secret["stringData"]["tls.crt"]),
                ("tls.key", &secret["stringData"]["tls.key"]),
            ],
        ),
    ] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
        for (file, value) in entries {
            std::fs::write(root.join(dir).join(file), value.as_str().unwrap()).unwrap();
        }
    }
    #[cfg(unix)]
    for entry in walk(&root) {
        use std::os::unix::fs::PermissionsExt;
        let mode = if entry.is_dir() { 0o755 } else { 0o644 };
        std::fs::set_permissions(&entry, std::fs::Permissions::from_mode(mode)).unwrap();
    }
    let name = format!("nemoclaw-issuer-test-{}", std::process::id());
    let mount = |source: &str, target: &str| {
        format!(
            "type=bind,source={},target={target},readonly",
            root.join(source).display()
        )
    };
    let mut command = std::process::Command::new("docker");
    command.args([
        "run",
        "-d",
        "--rm",
        "--name",
        &name,
        "--read-only",
        "--cap-drop",
        "ALL",
    ]);
    command.args([
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/tmp",
        "-p",
        "127.0.0.1::8443",
    ]);
    // Exercise the same memory budget as the Kubernetes Deployment, including
    // on hosts where nginx's automatic worker count would exhaust it.
    let memory = container["resources"]["limits"]["memory"]
        .as_str()
        .unwrap()
        .strip_suffix("Mi")
        .unwrap();
    command.args([
        "--memory",
        &format!("{memory}m"),
        "--memory-swap",
        &format!("{memory}m"),
    ]);
    command.args(["--mount", &mount("conf.d", "/etc/nginx/conf.d")]);
    command.args(["--mount", &mount("documents", "/documents")]);
    command.args(["--mount", &mount("tls", "/tls")]);
    let argv = container["command"].as_array().unwrap();
    command.arg("--entrypoint").arg(argv[0].as_str().unwrap());
    command.arg(container["image"].as_str().unwrap());
    command.args(argv[1..].iter().map(|part| part.as_str().unwrap()));
    let started = command.output().unwrap();
    assert!(
        started.status.success(),
        "{}",
        String::from_utf8_lossy(&started.stderr)
    );
    struct Stop(String);
    impl Drop for Stop {
        fn drop(&mut self) {
            let _ = std::process::Command::new("docker")
                .args(["rm", "-f", &self.0])
                .output();
        }
    }
    let _stop = Stop(name.clone());
    let port = std::process::Command::new("docker")
        .args(["port", &name, "8443/tcp"])
        .output()
        .unwrap();
    let address: std::net::SocketAddr = String::from_utf8(port.stdout)
        .unwrap()
        .lines()
        .next()
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    let host = "nc-0123456789abcdef-gateway-oidc.agents.svc.cluster.local";
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .tls_certs_only([reqwest::Certificate::from_pem(material.ca_pem().as_bytes()).unwrap()])
        .resolve(host, address)
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .unwrap();
    let url = |path: &str| format!("https://{host}:{}{path}", address.port());
    let mut answered = None;
    for _ in 0..50 {
        match client.get(url("/jwks")).send().await {
            Ok(response) => {
                answered = Some(response);
                break;
            }
            Err(_) => tokio::time::sleep(std::time::Duration::from_millis(200)).await,
        }
    }
    let response = answered
        .expect("issuer answered")
        .error_for_status()
        .unwrap();
    let jwks: serde_json::Value = serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
    assert_eq!(jwks, material.jwks());
    let discovery = client
        .get(url("/.well-known/openid-configuration"))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes()
        .await
        .unwrap();
    let discovery: serde_json::Value = serde_json::from_slice(&discovery).unwrap();
    assert_eq!(discovery, material.discovery());
    let missing = client.get(url("/signing.pk8")).send().await.unwrap();
    assert_eq!(missing.status(), 404);

    // The first request can succeed while nginx is still starting workers.
    // Keep serving after startup to catch exhaustion of the memory budget on
    // hosts with more CPUs than this static issuer needs.
    let until = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    while tokio::time::Instant::now() < until {
        for (path, expected) in [
            ("/jwks", material.jwks()),
            ("/.well-known/openid-configuration", material.discovery()),
        ] {
            let response = client
                .get(url(path))
                .send()
                .await
                .expect("issuer remains available within its memory budget")
                .error_for_status()
                .unwrap();
            let document: serde_json::Value =
                serde_json::from_slice(&response.bytes().await.unwrap()).unwrap();
            assert_eq!(document, expected);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

#[cfg(unix)]
fn walk(root: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut found = vec![root.to_path_buf()];
    for entry in std::fs::read_dir(root).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            found.extend(walk(&path));
        } else {
            found.push(path);
        }
    }
    found
}
