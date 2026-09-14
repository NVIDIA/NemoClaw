// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{
    ObservationError,
    backend::Backend,
    config::{Credential, Gateway, TLS},
    openshell::{OpenShell, Secrets},
};
use rcgen::{
    BasicConstraints, CertificateParams, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose,
};
use std::{collections::BTreeMap, sync::Arc};
use tonic::transport::{Certificate, Identity, ServerTlsConfig};
struct Values(BTreeMap<String, String>);
impl Secrets for Values {
    fn resolve(&self, key: &str) -> Result<String, ObservationError> {
        self.0
            .get(key)
            .cloned()
            .ok_or(ObservationError::Authentication)
    }
}
fn authority() -> (String, Issuer<'static, KeyPair>) {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
    let pem = params.self_signed(&key).unwrap().pem();
    (pem, Issuer::new(params, key))
}
fn leaf(issuer: &Issuer<'_, KeyPair>, usage: ExtendedKeyUsagePurpose) -> (String, String) {
    let key = KeyPair::generate().unwrap();
    let mut params = CertificateParams::new(vec!["127.0.0.1".into()]).unwrap();
    params.extended_key_usages = vec![usage];
    (
        params.signed_by(&key, issuer).unwrap().pem(),
        key.serialize_pem(),
    )
}
#[tokio::test]
async fn mutual_tls_and_bearer_references_fail_closed_without_disclosing_credentials() {
    let (ca, issuer) = authority();
    let (server, key) = leaf(&issuer, ExtendedKeyUsagePurpose::ServerAuth);
    let fixture = Fixture::start_with_tls(Some(
        ServerTlsConfig::new()
            .identity(Identity::from_pem(server, key))
            .client_ca_root(Certificate::from_pem(&ca)),
    ))
    .await;
    fixture.state.lock().unwrap().expected_bearer = Some("Bearer secret-sentinel".into());
    let (client, key) = leaf(&issuer, ExtendedKeyUsagePurpose::ClientAuth);
    let directory = tempfile::tempdir().unwrap();
    let mut values = BTreeMap::new();
    for (name, content) in [("CA", ca), ("CERT", client), ("KEY", key)] {
        let path = directory.path().join(name);
        std::fs::write(&path, content).unwrap();
        values.insert(name.into(), path.to_str().unwrap().into());
    }
    values.insert("TOKEN".into(), "secret-sentinel".into());
    let reference = |env: &str| Credential { env: env.into() };
    let gateway = Gateway {
        management: "external".into(),
        endpoint: fixture.endpoint.clone(),
        credential: Some(reference("TOKEN")),
        tls: Some(TLS {
            ca: reference("CA"),
            certificate: reference("CERT"),
            key: reference("KEY"),
        }),
        ..Default::default()
    };
    let desired = [
        ("name".into(), "workspace".into()),
        ("owner".into(), "owner".into()),
        ("generation".into(), "generation".into()),
    ]
    .into();
    let valid = OpenShell::connect(&gateway, Arc::new(Values(values.clone()))).unwrap();
    let established = valid.ensure("workspace", &desired).await;
    assert!(established.error.is_none(), "{:?}", established.error);
    let binding = established.state.unwrap();
    for failure in ["bearer", "server trust", "client trust", "missing key"] {
        let mut altered = values.clone();
        match failure {
            "bearer" => {
                altered.insert("TOKEN".into(), "wrong-secret-sentinel".into());
            }
            "server trust" => {
                let path = directory.path().join("wrong-ca");
                std::fs::write(&path, authority().0).unwrap();
                altered.insert("CA".into(), path.to_str().unwrap().into());
            }
            "client trust" => {
                let (_, issuer) = authority();
                let (cert, key) = leaf(&issuer, ExtendedKeyUsagePurpose::ClientAuth);
                for (name, content) in [("CERT", cert), ("KEY", key)] {
                    let path = directory.path().join(format!("wrong-{name}"));
                    std::fs::write(&path, content).unwrap();
                    altered.insert(name.into(), path.to_str().unwrap().into());
                }
            }
            _ => {
                altered.insert(
                    "KEY".into(),
                    directory.path().join("missing").to_str().unwrap().into(),
                );
            }
        }
        let result = match OpenShell::connect(&gateway, Arc::new(Values(altered))) {
            Ok(client) => client.read("workspace", &binding, false).await.map(|_| ()),
            Err(error) => Err(error),
        };
        let error = result.expect_err(failure);
        assert!(!error.to_string().contains("sentinel"));
    }
    assert_eq!(fixture.state.lock().unwrap().effects, 1);
    assert_eq!(
        valid.read("workspace", &binding, false).await.unwrap(),
        Some(binding)
    );
}
