// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Development authentication for a managed Kubernetes gateway.
//!
//! OpenShell authenticates users with OIDC tokens. For development, the SDK
//! is its own issuer: it keeps an Ed25519 signing key and an issuer TLS
//! certificate in the private state directory, signs short tokens for each
//! operation, and publishes only the public discovery document and key set.
//! A static HTTPS server in the cluster serves those two documents. This is
//! not a login service and holds no user accounts.

use crate::ObservationError;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, PKCS_ECDSA_P256_SHA256,
};
use ring::signature::{Ed25519KeyPair, KeyPair as _};
use serde_json::{Value, json};
use std::path::PathBuf;

/// The key ID OpenShell matches tokens against.
const KEY_ID: &str = "nemoclaw-development";
pub const ADMIN_ROLE: &str = "nemoclaw-development-admin";
pub const USER_ROLE: &str = "nemoclaw-development-user";
/// Every OpenShell scope, so the development user may do anything.
const SCOPES: &str = "config:read config:write provider:read provider:write \
    sandbox:read sandbox:write workspace:read workspace:write";
/// Files that make up one deployment's material; all or none must exist.
const FILES: [&str; 5] = [
    "ca.key",
    "ca.crt",
    "server.key",
    "server.crt",
    "signing.pk8",
];

/// One deployment's issuer, before its material is loaded.
pub struct Development {
    directory: PathBuf,
    name: String,
    namespace: String,
    owner: String,
}

/// Loaded material for signing tokens and configuring the issuer.
pub struct Material {
    issuer: String,
    owner: String,
    ca: String,
    certificate: String,
    key: String,
    signing: Ed25519KeyPair,
}

impl Development {
    /// `name` is the gateway release name; the issuer service is `<name>-oidc`.
    pub fn new(directory: PathBuf, name: &str, namespace: &str, owner: &str) -> Self {
        Self {
            directory,
            name: name.into(),
            namespace: namespace.into(),
            owner: owner.into(),
        }
    }

    /// The issuer service's DNS name inside the cluster.
    pub fn host(&self) -> String {
        format!("{}-oidc.{}.svc.cluster.local", self.name, self.namespace)
    }

    /// Load the material, creating it on first use. A partial set, as after
    /// an interrupted write, is refused rather than silently replaced.
    pub fn ensure(&self) -> Result<Material, ObservationError> {
        let present = FILES
            .iter()
            .filter(|file| self.directory.join(file).exists())
            .count();
        match present {
            0 => self.create()?,
            count if count == FILES.len() => {}
            _ => return Err(ObservationError::Authentication),
        }
        self.load()
    }

    fn create(&self) -> Result<(), ObservationError> {
        let failed = |_| ObservationError::Authentication;
        super::receipt::private_directory(&self.directory)?;
        let now = time::OffsetDateTime::now_utc();
        let ca_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(failed)?;
        let mut ca = CertificateParams::new(Vec::<String>::new()).map_err(failed)?;
        ca.distinguished_name
            .push(DnType::CommonName, "NemoClaw development issuer CA");
        ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        ca.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        ca.not_before = now - time::Duration::hours(1);
        ca.not_after = now + time::Duration::days(365);
        let ca_certificate = ca.self_signed(&ca_key).map_err(failed)?;
        let server_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).map_err(failed)?;
        let mut server = CertificateParams::new(vec![self.host()]).map_err(failed)?;
        server
            .distinguished_name
            .push(DnType::CommonName, self.host());
        server.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        server.not_before = ca.not_before;
        server.not_after = ca.not_after;
        let issuer = Issuer::new(ca, &ca_key);
        let server_certificate = server.signed_by(&server_key, &issuer).map_err(failed)?;
        let signing = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new())
            .map_err(|_| ObservationError::Authentication)?;
        // The signing key is written last, so its presence marks a complete set.
        for (file, bytes) in [
            ("ca.key", ca_key.serialize_pem().into_bytes()),
            ("ca.crt", ca_certificate.pem().into_bytes()),
            ("server.key", server_key.serialize_pem().into_bytes()),
            ("server.crt", server_certificate.pem().into_bytes()),
            ("signing.pk8", signing.as_ref().to_vec()),
        ] {
            crate::state::atomic_write(&self.directory.join(file), &bytes)
                .map_err(|_| ObservationError::Authentication)?;
        }
        Ok(())
    }

    /// Read existing material without creating files. Once an issuer is bound,
    /// missing or inconsistent material requires recovery from the original set.
    pub(super) fn load(&self) -> Result<Material, ObservationError> {
        use rustls::{
            client::danger::ServerCertVerifier,
            pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime, pem::PemObject},
        };

        let read = |file: &str| {
            std::fs::read(self.directory.join(file)).map_err(|_| ObservationError::Authentication)
        };
        let text = |file: &str| {
            read(file).and_then(|bytes| {
                String::from_utf8(bytes).map_err(|_| ObservationError::Authentication)
            })
        };
        let signing = Ed25519KeyPair::from_pkcs8(&read("signing.pk8")?)
            .map_err(|_| ObservationError::Authentication)?;
        let ca = text("ca.crt")?;
        let certificate = text("server.crt")?;
        let key = text("server.key")?;
        let ca_key = text("ca.key")?;
        let provider = rustls::crypto::ring::default_provider();
        for (certificate, key) in [(&ca, &ca_key), (&certificate, &key)] {
            let certificate = CertificateDer::from_pem_slice(certificate.as_bytes())
                .map_err(|_| ObservationError::Authentication)?;
            let key = PrivateKeyDer::from_pem_slice(key.as_bytes())
                .map_err(|_| ObservationError::Authentication)?;
            rustls::sign::CertifiedKey::from_der(vec![certificate], key, &provider)
                .and_then(|pair| pair.keys_match())
                .map_err(|_| ObservationError::Authentication)?;
        }
        let mut roots = rustls::RootCertStore::empty();
        roots
            .add(
                CertificateDer::from_pem_slice(ca.as_bytes())
                    .map_err(|_| ObservationError::Authentication)?,
            )
            .map_err(|_| ObservationError::Authentication)?;
        let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(
            roots.into(),
            std::sync::Arc::new(provider),
        )
        .build()
        .map_err(|_| ObservationError::Authentication)?;
        verifier
            .verify_server_cert(
                &CertificateDer::from_pem_slice(certificate.as_bytes())
                    .map_err(|_| ObservationError::Authentication)?,
                &[],
                &ServerName::try_from(self.host()).map_err(|_| ObservationError::Authentication)?,
                &[],
                UnixTime::now(),
            )
            .map_err(|_| ObservationError::Authentication)?;
        Ok(Material {
            issuer: format!("https://{}:8443", self.host()),
            owner: self.owner.clone(),
            ca,
            certificate,
            key,
            signing,
        })
    }
}

impl Material {
    pub fn issuer(&self) -> &str {
        &self.issuer
    }
    /// The CA the gateway trusts for the issuer's HTTPS endpoint.
    pub fn ca_pem(&self) -> &str {
        &self.ca
    }
    pub fn certificate_pem(&self) -> &str {
        &self.certificate
    }
    pub fn key_pem(&self) -> &str {
        &self.key
    }

    /// The public key set, served at `/jwks`.
    pub fn jwks(&self) -> Value {
        json!({"keys": [{
            "kid": KEY_ID, "kty": "OKP", "crv": "Ed25519", "alg": "EdDSA", "use": "sig",
            "x": URL_SAFE_NO_PAD.encode(self.signing.public_key().as_ref()),
        }]})
    }

    /// The OIDC discovery document, served at `/.well-known/openid-configuration`.
    pub fn discovery(&self) -> Value {
        json!({
            "issuer": self.issuer,
            "jwks_uri": format!("{}/jwks", self.issuer),
            "id_token_signing_alg_values_supported": ["EdDSA"],
        })
    }

    /// A token valid for one hour from `now` (seconds since the epoch),
    /// for this deployment's audience, with every scope.
    pub fn token(&self, now: i64) -> String {
        let encode = |value: &Value| URL_SAFE_NO_PAD.encode(value.to_string());
        let header = encode(&json!({"alg": "EdDSA", "typ": "JWT", "kid": KEY_ID}));
        let claims = encode(&json!({
            "iss": self.issuer, "aud": self.owner, "sub": format!("nemoclaw-development-{}", self.owner),
            "iat": now, "nbf": now, "exp": now + 3600,
            "roles": [ADMIN_ROLE], "scope": SCOPES,
        }));
        let message = format!("{header}.{claims}");
        let signature = URL_SAFE_NO_PAD.encode(self.signing.sign(message.as_bytes()));
        format!("{message}.{signature}")
    }
}
