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
