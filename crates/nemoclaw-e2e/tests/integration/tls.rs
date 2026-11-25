// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{
    ObservationError,
    backend::Backend,
    config::{FileRef, Gateway, SecretRef, TLS},
};
use openshell_provider::{OpenShell, Secrets};
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

#[cfg(any(target_os = "linux", all(target_os = "macos", target_arch = "aarch64")))]
async fn bundled_cli_reads_the_deployment_workspace(mtls: bool) {
    use nemoclaw_sdk::{CancellationToken, Deployment, bundle::Bundle, config::Document};
    use std::{fs, path::PathBuf};
    let directory = tempfile::tempdir().unwrap();
    let mut values = BTreeMap::new();
    let tls = if mtls {
        let (ca, issuer) = authority();
        let (server, server_key) = leaf(&issuer, ExtendedKeyUsagePurpose::ServerAuth);
        let (client, client_key) = leaf(&issuer, ExtendedKeyUsagePurpose::ClientAuth);
        for (name, pem) in [
            ("CLI_CA", ca.clone()),
            ("CLI_CERT", client),
            ("CLI_KEY", client_key),
        ] {
            let path = directory.path().join(name);
            fs::write(&path, pem).unwrap();
            values.insert(name.into(), path.to_str().unwrap().to_owned());
        }
        Some(
            ServerTlsConfig::new()
                .identity(Identity::from_pem(server, server_key))
                .client_ca_root(Certificate::from_pem(ca)),
        )
    } else {
        None
    };
    let fixture = Fixture::start_with_tls(tls).await;
    let bundle = PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap());
    Bundle::open(&bundle).unwrap();
    let mut document = Document::parse(
        include_bytes!("../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_slice(),
    )
    .unwrap();
    nemoclaw_e2e::point_gateway_at(&mut document, &fixture.endpoint);
    if mtls {
        let Gateway::External(gateway) = &mut document.spec.gateway else {
            unreachable!()
        };
        gateway.tls = Some(TLS {
            ca: FileRef {
                env: "CLI_CA".into(),
            },
            certificate: Some(FileRef {
                env: "CLI_CERT".into(),
            }),
            key: Some(FileRef {
                env: "CLI_KEY".into(),
            }),
        });
    }
    let _engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let state = directory.path().join("state");
    let deployment =
        Deployment::new(&state, &bundle).with_secrets(Arc::new(Values(values.clone())));
    deployment
        .apply(&document, &CancellationToken::new())
        .await
        .unwrap();
    let user_config = directory.path().join("user-config");
    fs::create_dir_all(user_config.join("openshell")).unwrap();
    let active_gateway = user_config.join("openshell/active_gateway");
    fs::write(&active_gateway, "unrelated-user-gateway\n").unwrap();
    let command = || {
        let mut command = tokio::process::Command::new(
            bundle
                .join("bin")
                .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        );
        command
            .arg("osh")
            .arg("--state-dir")
            .arg(&state)
            .arg("--bundle")
            .arg(&bundle)
            .args([
                "--",
                "workspace",
                "get",
                &document.workspace(),
                "-o",
                "json",
            ])
            .envs(&values)
            .env("NEMOCLAW_DISABLE_TELEMETRY", "1")
            .env("XDG_CONFIG_HOME", &user_config)
            .env("OPENSHELL_GATEWAY", "unrelated-user-gateway")
            .env("OPENSHELL_GATEWAY_ENDPOINT", "http://127.0.0.1:1")
            .env("OPENSHELL_WORKSPACE", "unrelated-workspace");
        command
    };
    let output = command().output().await.unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let workspace: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(workspace["name"], document.workspace(), "{workspace}");
    assert_eq!(
        fs::read_to_string(&active_gateway).unwrap(),
        "unrelated-user-gateway\n"
    );
    if mtls {
        let wrong_ca = directory.path().join("wrong-ca");
        fs::write(&wrong_ca, authority().0).unwrap();
        let before = fixture.state.lock().unwrap().rpcs.len();
        let refused = command()
            .env("CLI_CA", &wrong_ca)
            .env("OPENSHELL_GATEWAY_INSECURE", "true")
            .output()
            .await
            .unwrap();
        assert!(
            !refused.status.success(),
            "an inherited insecure setting must not bypass the deployment's CA"
        );
        assert_eq!(
            fixture.state.lock().unwrap().rpcs.len(),
            before,
            "untrusted TLS must fail before an RPC"
        );
    }
    assert_eq!(
        fs::read_dir(directory.path().join("state/openshell"))
            .unwrap()
            .count(),
        0
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE with the pinned OpenShell CLI"]
#[cfg(any(target_os = "linux", all(target_os = "macos", target_arch = "aarch64")))]
async fn bundled_cli_reaches_a_plaintext_gateway_without_a_user_profile() {
    bundled_cli_reads_the_deployment_workspace(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE with the pinned OpenShell CLI"]
#[cfg(any(target_os = "linux", all(target_os = "macos", target_arch = "aarch64")))]
async fn bundled_cli_reaches_an_mtls_gateway_without_a_user_profile() {
    bundled_cli_reads_the_deployment_workspace(true).await;
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
    let file = |env: &str| FileRef { env: env.into() };
    let gateway = Gateway::External(nemoclaw_sdk::config::ExternalGateway {
        endpoint: fixture.endpoint.clone(),
        credential: Some(SecretRef {
            env: "TOKEN".into(),
        }),
        tls: Some(TLS {
            ca: file("CA"),
            certificate: Some(file("CERT")),
            key: Some(file("KEY")),
        }),
        ..Default::default()
    });
    let desired = [
        ("name".into(), "workspace".into()),
        ("owner".into(), "owner".into()),
        ("generation".into(), "generation".into()),
    ]
    .into();
    let valid =
        OpenShell::connect(&gateway.connection(), Arc::new(Values(values.clone()))).unwrap();
    let established = valid.ensure("workspace", &desired).await;
    assert!(established.error().is_none(), "{:?}", established.error());
    let binding = established.into_parts().0.unwrap();
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
        let result = match OpenShell::connect(&gateway.connection(), Arc::new(Values(altered))) {
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

/// With only a CA, the client verifies the gateway's certificate and
/// presents none of its own, for a gateway that authenticates clients by
/// token alone.
#[tokio::test]
async fn a_ca_alone_verifies_the_gateway_without_a_client_certificate() {
    let (ca, issuer) = authority();
    let (server, key) = leaf(&issuer, ExtendedKeyUsagePurpose::ServerAuth);
    let fixture = Fixture::start_with_tls(Some(
        ServerTlsConfig::new().identity(Identity::from_pem(server, key)),
    ))
    .await;
    fixture.state.lock().unwrap().expected_bearer = Some("Bearer secret-sentinel".into());
    let directory = tempfile::tempdir().unwrap();
    let [trusted, unrelated] = [("ca", ca), ("other-ca", authority().0)].map(|(name, pem)| {
        let path = directory.path().join(name);
        std::fs::write(&path, pem).unwrap();
        path.to_str().unwrap().to_owned()
    });
    let gateway = Gateway::External(nemoclaw_sdk::config::ExternalGateway {
        endpoint: fixture.endpoint.clone(),
        credential: Some(SecretRef {
            env: "TOKEN".into(),
        }),
        tls: Some(TLS {
            ca: FileRef { env: "CA".into() },
            certificate: None,
            key: None,
        }),
        ..Default::default()
    });
    let desired = [
        ("name".into(), "workspace".into()),
        ("owner".into(), "owner".into()),
        ("generation".into(), "generation".into()),
    ]
    .into();
    let client = |ca: &str| {
        let values = [("CA", ca), ("TOKEN", "secret-sentinel")]
            .map(|(name, value)| (name.to_owned(), value.to_owned()));
        OpenShell::connect(&gateway.connection(), Arc::new(Values(values.into()))).unwrap()
    };
    let established = client(&trusted).ensure("workspace", &desired).await;
    assert!(established.error().is_none(), "{:?}", established.error());
    let refused = client(&unrelated)
        .ensure("workspace", &desired)
        .await
        .error();
    assert_eq!(
        refused.map(|error| error.to_string()).as_deref(),
        Some(
            "the gateway's TLS server certificate is not signed by the configured certificate authority"
        )
    );
    assert_eq!(fixture.state.lock().unwrap().effects, 1);
}
