// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Gateway clients for the connections resources name, and the backend that
//! reconciles OpenShell objects through them.

use crate::{DockerServices, EnvironmentSecrets, OpenShell, Services};
use async_trait::async_trait;
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex, RwLock},
};
use tf_provider::{
    Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Description, Schema},
    value::Value,
};

/// Configuration of a provider whose resources each name their gateway.
#[derive(Default, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub destroy: Value<bool>,
}

impl GatewayConfig {
    /// The provider configuration schema: teardown permission only. Each
    /// resource names its gateway with a `gateway` ref.
    pub fn schema() -> Schema {
        Schema {
            version: 0,
            block: Block {
                attributes: [(
                    "destroy".into(),
                    Attribute {
                        attr_type: AttributeType::Bool,
                        constraint: AttributeConstraint::Optional,
                        description: Description::plain(
                            "Permit removing this provider's objects during explicit teardown."
                                .to_owned(),
                        ),
                        ..Default::default()
                    },
                )]
                .into(),
                ..Default::default()
            },
        }
    }
}

/// Gateway connection inputs.
pub struct GatewaySettings<'a> {
    pub endpoint: &'a Value<String>,
    pub credential_env: &'a Value<String>,
    pub tls_ca_env: &'a Value<String>,
    pub tls_certificate_env: &'a Value<String>,
    pub tls_key_env: &'a Value<String>,
    /// A managed Kubernetes gateway's specification. Providers connect to
    /// such a gateway themselves, through a port-forward.
    pub kubernetes: &'a Value<String>,
}

/// How to reach a gateway.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GatewayConnection {
    /// An endpoint, with variables naming its credentials.
    Direct(nemoclaw_openshell::Connection),
    /// A managed Kubernetes gateway's specification, as JSON.
    Kubernetes(String),
}

impl GatewaySettings<'_> {
    fn references(&self) -> [&Value<String>; 5] {
        [
            self.credential_env,
            self.tls_ca_env,
            self.tls_certificate_env,
            self.tls_key_env,
            self.kubernetes,
        ]
    }
    /// Whether any input is unknown, so connecting must wait until apply.
    pub fn unknown(&self) -> bool {
        matches!(self.endpoint, Value::Unknown)
            || self
                .references()
                .into_iter()
                .any(|value| matches!(value, Value::Unknown))
    }
    /// The connection these known inputs describe; `None` without an
    /// endpoint or a Kubernetes specification.
    pub fn connection(&self) -> Result<Option<GatewayConnection>, &'static str> {
        let text = |value: &Value<String>| match value {
            Value::Value(value) => value.clone(),
            _ => String::new(),
        };
        let kubernetes = text(self.kubernetes);
        if !kubernetes.is_empty() {
            return Ok(Some(GatewayConnection::Kubernetes(kubernetes)));
        }
        let endpoint = text(self.endpoint);
        if endpoint.is_empty() {
            return Ok(None);
        }
        let mut connection = nemoclaw_openshell::Connection {
            endpoint,
            ..Default::default()
        };
        let credential = text(self.credential_env);
        if !credential.is_empty() {
            connection.credential_env = Some(credential);
        }
        let (ca, certificate, key) = (
            text(self.tls_ca_env),
            text(self.tls_certificate_env),
            text(self.tls_key_env),
        );
        if !ca.is_empty() || !certificate.is_empty() || !key.is_empty() {
            // A CA alone, or with a client certificate and its key.
            if ca.is_empty() || certificate.is_empty() != key.is_empty() {
                return Err("Incomplete TLS credential references");
            }
            connection.tls = Some(nemoclaw_openshell::TlsFiles {
                ca_env: ca,
                identity: (!certificate.is_empty()).then_some(nemoclaw_openshell::IdentityFiles {
                    certificate_env: certificate,
                    key_env: key,
                }),
            });
        }
        Ok(Some(GatewayConnection::Direct(connection)))
    }
}

/// The connection a row's `gateway` ref carries.
pub fn row_connection(row: &Row) -> Result<GatewayConnection, &'static str> {
    let [
        endpoint,
        credential_env,
        tls_ca_env,
        tls_certificate_env,
        tls_key_env,
        kubernetes,
    ] = nemoclaw_openshell::GATEWAY_FIELDS
        .map(|(_, field)| Value::Value(row.get(field).cloned().unwrap_or_default()));
    GatewaySettings {
        endpoint: &endpoint,
        credential_env: &credential_env,
        tls_ca_env: &tls_ca_env,
        tls_certificate_env: &tls_certificate_env,
        tls_key_env: &tls_key_env,
        kubernetes: &kubernetes,
    }
    .connection()?
    .ok_or("The gateway ref has no endpoint")
}

/// A port-forward to a managed Kubernetes gateway, and what reaching it needs.
pub struct KubernetesConnection {
    /// The forward's loopback endpoint.
    pub endpoint: String,
    /// The bearer token.
    pub token: Option<String>,
    /// Paths of the CA, client certificate, and client key files.
    pub tls: Option<[String; 3]>,
    /// Keeps the forward open; dropping it closes the forward.
    pub forward: Box<dyn std::any::Any + Send + Sync>,
}

/// Opens port-forwards to managed Kubernetes gateways.
#[async_trait]
pub trait KubernetesConnector: Send + Sync {
    async fn open(&self, spec: &str) -> Result<KubernetesConnection, ObservationError>;
}

/// Connects with the SDK, from the kubeconfig the specification names or the
/// pod's service account, and the state directory the SDK passes to providers.
#[cfg(feature = "kubernetes")]
struct SdkKubernetes;

#[cfg(feature = "kubernetes")]
#[async_trait]
impl KubernetesConnector for SdkKubernetes {
    async fn open(&self, spec: &str) -> Result<KubernetesConnection, ObservationError> {
        use nemoclaw_sdk::kubernetes::{
            CA_ENV, CERT_ENV, KEY_ENV, TOKEN_ENV, operations::Operations,
        };
        let spec: nemoclaw_sdk::kubernetes::Spec =
            serde_json::from_str(spec).map_err(|_| ObservationError::Query)?;
        let connection = Operations::from_environment(&spec)
            .await?
            .connect(&spec)
            .await
            .map_err(|error| match error {
                nemoclaw_sdk::Error::Observation(error) => error,
                _ => ObservationError::Incomplete,
            })?;
        let mut environment = connection.environment();
        let mut take = |name: &str| environment.remove(name).ok_or(ObservationError::Incomplete);
        let (token, ca, certificate, key) = (
            take(TOKEN_ENV)?,
            take(CA_ENV)?,
            take(CERT_ENV)?,
            take(KEY_ENV)?,
        );
        Ok(KubernetesConnection {
            endpoint: connection.endpoint().to_owned(),
            token: Some(token),
            tls: Some([ca, certificate, key]),
            forward: Box::new(connection),
        })
    }
}

/// Without the SDK, a provider cannot reach managed Kubernetes gateways.
#[cfg(not(feature = "kubernetes"))]
struct NoKubernetes;

#[cfg(not(feature = "kubernetes"))]
#[async_trait]
impl KubernetesConnector for NoKubernetes {
    async fn open(&self, _: &str) -> Result<KubernetesConnection, ObservationError> {
        Err(ObservationError::Backend(
            "this provider was built without managed Kubernetes gateway support",
        ))
    }
}

/// Secrets a forward supplies, resolved from memory rather than the
/// environment. Names are local to one client, and only its connection
/// resolves them: objects resolve their references from the environment.
struct ForwardSecrets(BTreeMap<&'static str, String>);

impl nemoclaw_backend::Secrets for ForwardSecrets {
    fn resolve(&self, reference: &str) -> Result<String, ObservationError> {
        self.0
            .get(reference)
            .cloned()
            .ok_or(ObservationError::Authentication)
    }
}

/// The direct connection through a forward, and the secrets it resolves.
fn forwarded(opened: &KubernetesConnection) -> (nemoclaw_openshell::Connection, ForwardSecrets) {
    let mut connection = nemoclaw_openshell::Connection {
        endpoint: opened.endpoint.clone(),
        ..Default::default()
    };
    let mut secrets = BTreeMap::new();
    if let Some(token) = &opened.token {
        connection.credential_env = Some("token".into());
        secrets.insert("token", token.clone());
    }
    if let Some([ca, certificate, key]) = &opened.tls {
        connection.tls = Some(nemoclaw_openshell::TlsFiles {
            ca_env: "ca".into(),
            identity: Some(nemoclaw_openshell::IdentityFiles {
                certificate_env: "certificate".into(),
                key_env: "key".into(),
            }),
        });
        secrets.insert("ca", ca.clone());
        secrets.insert("certificate", certificate.clone());
        secrets.insert("key", key.clone());
    }
    (connection, ForwardSecrets(secrets))
}

/// Gateway clients by connection, created on first use.
pub struct GatewayClient {
    clients: RwLock<BTreeMap<String, OpenShell>>,
    services: Arc<dyn Services>,
    kubernetes: Arc<dyn KubernetesConnector>,
    /// Open forwards, kept for this provider process's lifetime.
    forwards: Mutex<Vec<Box<dyn std::any::Any + Send + Sync>>>,
    /// Serializes opening forwards, so each gateway gets one.
    opening: tokio::sync::Mutex<()>,
}

impl Default for GatewayClient {
    fn default() -> Self {
        Self::with_services(Arc::new(DockerServices))
    }
}

impl GatewayClient {
    /// Use the deployment's managed service checks for each client.
    pub fn with_services(services: Arc<dyn Services>) -> Self {
        #[cfg(feature = "kubernetes")]
        let kubernetes: Arc<dyn KubernetesConnector> = Arc::new(SdkKubernetes);
        #[cfg(not(feature = "kubernetes"))]
        let kubernetes: Arc<dyn KubernetesConnector> = Arc::new(NoKubernetes);
        Self {
            clients: RwLock::default(),
            services,
            kubernetes,
            forwards: Mutex::default(),
            opening: tokio::sync::Mutex::const_new(()),
        }
    }

    /// Open managed Kubernetes gateway forwards with `connector`.
    pub fn with_kubernetes(mut self, connector: Arc<dyn KubernetesConnector>) -> Self {
        self.kubernetes = connector;
        self
    }

    /// Whether `config` permits teardown.
    pub fn configure(&self, _: &mut Diagnostics, config: &GatewayConfig) -> Option<bool> {
        Some(matches!(config.destroy, Value::Value(true)))
    }

    /// The client for `connection`, connecting lazily on first use. A
    /// managed Kubernetes gateway is reached through one port-forward per
    /// gateway, opened on first use and kept for this process's lifetime.
    pub async fn connect(&self, connection: &GatewayConnection) -> Result<OpenShell, String> {
        match connection {
            GatewayConnection::Direct(connection) => self.connect_direct(connection),
            GatewayConnection::Kubernetes(spec) => self.connect_kubernetes(spec).await,
        }
    }

    fn cached(&self, key: &str) -> Result<Option<OpenShell>, String> {
        Ok(self
            .clients
            .read()
            .map_err(|_| "Gateway client lock failed".to_owned())?
            .get(key)
            .cloned())
    }

    async fn connect_kubernetes(&self, spec: &str) -> Result<OpenShell, String> {
        let key = format!("kubernetes:{spec}");
        if let Some(client) = self.cached(&key)? {
            return Ok(client);
        }
        let _opening = self.opening.lock().await;
        if let Some(client) = self.cached(&key)? {
            return Ok(client);
        }
        let opened = self
            .kubernetes
            .open(spec)
            .await
            .map_err(|error| error.to_string())?;
        let (connection, credentials) = forwarded(&opened);
        // The forward's secrets authenticate only the connection. Objects
        // name their credentials in the environment, as on a direct
        // connection, so no reference resolves to the forward's values.
        let client = OpenShell::connect_with_credentials(
            &connection,
            &credentials,
            Arc::new(EnvironmentSecrets),
            self.services.clone(),
        )
        .map_err(|error| error.to_string())?;
        self.forwards
            .lock()
            .map_err(|_| "Gateway forward lock failed".to_owned())?
            .push(opened.forward);
        self.clients
            .write()
            .map_err(|_| "Gateway client lock failed".to_owned())?
            .insert(key, client.clone());
        Ok(client)
    }

    fn connect_direct(
        &self,
        connection: &nemoclaw_openshell::Connection,
    ) -> Result<OpenShell, String> {
        let key = serde_json::to_string(&(
            &connection.endpoint,
            &connection.credential_env,
            connection.tls.as_ref().map(|tls| {
                let identity = tls.identity.as_ref();
                (
                    &tls.ca_env,
                    identity.map(|identity| (&identity.certificate_env, &identity.key_env)),
                )
            }),
        ))
        .map_err(|error| error.to_string())?;
        if let Some(client) = self
            .clients
            .read()
            .map_err(|_| "Gateway client lock failed".to_owned())?
            .get(&key)
        {
            return Ok(client.clone());
        }
        let client = OpenShell::connect_with_services(
            connection,
            Arc::new(EnvironmentSecrets),
            self.services.clone(),
        )
        .map_err(|error| error.to_string())?;
        self.clients
            .write()
            .map_err(|_| "Gateway client lock failed".to_owned())?
            .insert(key, client.clone());
        Ok(client)
    }

    /// The client for the gateway a row's `gateway` ref names.
    pub async fn client_for(&self, row: &Row) -> Result<OpenShell, ObservationError> {
        let connection = row_connection(row).map_err(|_| ObservationError::Incomplete)?;
        self.connect(&connection)
            .await
            .map_err(|_| ObservationError::Incomplete)
    }

    /// The client for a row about to be planned, explaining a connection the
    /// gateway ref cannot describe.
    pub async fn planning_client(&self, row: &Row) -> Result<OpenShell, Error> {
        let connection = row_connection(row).map_err(Error::State)?;
        self.connect(&connection)
            .await
            .map_err(|_| Error::State("The gateway ref's endpoint is not a valid gateway origin"))
    }
}

/// Reconciles OpenShell objects through the gateway each row names.
pub struct OpenShellBackend(pub Arc<GatewayClient>);

#[async_trait]
impl Backend for OpenShellBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        if crate::composite::KINDS.contains(&kind) {
            return crate::composite::plan(self, kind, desired, prior).await;
        }
        // Planning reaches no gateway: a new object's gateway may not exist
        // until this apply installs it. Applying checks who owns an existing
        // name before it changes anything.
        let _ = prior;
        row_connection(desired).map_err(Error::State)?;
        Ok(())
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        if crate::composite::KINDS.contains(&kind) {
            return crate::composite::read(self, kind, prior, removing).await;
        }
        self.0
            .client_for(prior)
            .await?
            .read(kind, prior, removing)
            .await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        if crate::composite::KINDS.contains(&kind) {
            return crate::composite::ensure(self, kind, desired).await;
        }
        match self.0.client_for(desired).await {
            Ok(client) => client.ensure(kind, desired).await,
            Err(error) => Mutation::failed(error),
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if crate::composite::KINDS.contains(&kind) {
            return crate::composite::remove(self, kind, prior, destroying).await;
        }
        self.0
            .client_for(prior)
            .await?
            .remove(kind, prior, destroying)
            .await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(endpoint: &str) -> Row {
        [("gateway_endpoint".to_owned(), endpoint.to_owned())].into()
    }

    // Connecting starts a lazy channel, which needs a runtime.
    #[tokio::test]
    async fn each_connection_has_one_client_reused_across_rows() {
        let client = GatewayClient::default();
        let first = client.client_for(&row("http://127.0.0.1:1")).await.unwrap();
        let again = client.client_for(&row("http://127.0.0.1:1")).await.unwrap();
        client.client_for(&row("http://127.0.0.1:2")).await.unwrap();
        assert_eq!(client.clients.read().unwrap().len(), 2);
        drop((first, again));
    }

    /// Opens a forward for each specification, recording each open.
    #[derive(Default)]
    struct Forwards(Mutex<Vec<String>>);

    #[async_trait]
    impl KubernetesConnector for Forwards {
        async fn open(&self, spec: &str) -> Result<KubernetesConnection, ObservationError> {
            let mut opened = self.0.lock().unwrap();
            opened.push(spec.to_owned());
            Ok(KubernetesConnection {
                endpoint: format!("http://127.0.0.1:{}", 10 + opened.len()),
                token: None,
                tls: None,
                forward: Box::new(()),
            })
        }
    }

    fn kubernetes(spec: &str) -> Row {
        [
            (
                "gateway_endpoint".to_owned(),
                "https://127.0.0.1:17670".to_owned(),
            ),
            ("gateway_kubernetes".to_owned(), spec.to_owned()),
        ]
        .into()
    }

    #[tokio::test]
    async fn a_kubernetes_gateway_is_reached_through_one_forward() {
        let forwards = Arc::new(Forwards::default());
        let client = GatewayClient::default().with_kubernetes(forwards.clone());
        client.client_for(&kubernetes("first")).await.unwrap();
        client.client_for(&kubernetes("first")).await.unwrap();
        client.planning_client(&kubernetes("first")).await.unwrap();
        client.client_for(&kubernetes("second")).await.unwrap();
        assert_eq!(*forwards.0.lock().unwrap(), ["first", "second"]);
        assert_eq!(client.forwards.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_forward_supplies_its_credentials_from_memory() {
        let opened = KubernetesConnection {
            endpoint: "https://127.0.0.1:40001".into(),
            token: Some("signed token".into()),
            tls: Some([
                "/state/ca.crt".into(),
                "/state/tls.crt".into(),
                "/state/tls.key".into(),
            ]),
            forward: Box::new(()),
        };
        let (connection, secrets) = forwarded(&opened);
        assert_eq!(connection.endpoint, "https://127.0.0.1:40001");
        use nemoclaw_backend::Secrets as _;
        let resolve = |name: &Option<String>| secrets.resolve(name.as_deref().unwrap()).unwrap();
        assert_eq!(resolve(&connection.credential_env), "signed token");
        let tls = connection.tls.unwrap();
        let identity = tls.identity.unwrap();
        for (name, path) in [
            (tls.ca_env, "/state/ca.crt"),
            (identity.certificate_env, "/state/tls.crt"),
            (identity.key_env, "/state/tls.key"),
        ] {
            assert_eq!(secrets.resolve(&name).unwrap(), path);
            // The names are local to this client, never inherited variables.
            assert!(std::env::var_os(&name).is_none(), "{name}");
        }
    }

    #[test]
    fn tls_references_name_a_ca_alone_or_with_a_certificate_and_key() {
        let value = |text: &str| Value::Value(text.to_owned());
        let (endpoint, empty) = (value("https://gateway.example.com"), value(""));
        let (ca, certificate, key) = (value("CA"), value("CERT"), value("KEY"));
        let connect = |[ca, certificate, key]: [&Value<String>; 3]| {
            GatewaySettings {
                endpoint: &endpoint,
                credential_env: &empty,
                tls_ca_env: ca,
                tls_certificate_env: certificate,
                tls_key_env: key,
                kubernetes: &empty,
            }
            .connection()
        };
        let tls = |references| match connect(references) {
            Ok(Some(GatewayConnection::Direct(connection))) => connection.tls,
            other => panic!("{other:?}"),
        };
        assert_eq!(
            tls([&ca, &empty, &empty]),
            Some(nemoclaw_openshell::TlsFiles {
                ca_env: "CA".into(),
                identity: None,
            })
        );
        assert_eq!(
            tls([&ca, &certificate, &key]),
            Some(nemoclaw_openshell::TlsFiles {
                ca_env: "CA".into(),
                identity: Some(nemoclaw_openshell::IdentityFiles {
                    certificate_env: "CERT".into(),
                    key_env: "KEY".into(),
                }),
            })
        );
        for partial in [
            [&ca, &certificate, &empty],
            [&ca, &empty, &key],
            [&empty, &certificate, &key],
        ] {
            assert!(connect(partial).is_err());
        }
    }

    #[test]
    fn an_unknown_kubernetes_gateway_waits_for_apply() {
        let known = Value::Value("https://127.0.0.1:17670".to_owned());
        let empty = Value::Value(String::new());
        let settings = GatewaySettings {
            endpoint: &known,
            credential_env: &empty,
            tls_ca_env: &empty,
            tls_certificate_env: &empty,
            tls_key_env: &empty,
            kubernetes: &Value::Unknown,
        };
        assert!(settings.unknown());
    }

    #[tokio::test]
    async fn rows_without_a_usable_gateway_ref_have_no_client() {
        let client = GatewayClient::default();
        for row in [
            Row::new(),
            row("invalid"),
            [
                (
                    "gateway_endpoint".to_owned(),
                    "http://127.0.0.1:1".to_owned(),
                ),
                ("gateway_tls_ca_env".to_owned(), "CA".to_owned()),
            ]
            .into(),
        ] {
            assert!(client.client_for(&row).await.is_err());
            assert!(client.planning_client(&row).await.is_err());
        }
    }

    #[test]
    fn teardown_permission_needs_no_gateway() {
        let client = GatewayClient::default();
        let mut diagnostics = Diagnostics::default();
        let permit = |destroy| GatewayConfig { destroy };
        assert_eq!(
            client.configure(&mut diagnostics, &permit(Value::Value(true))),
            Some(true)
        );
        assert_eq!(
            client.configure(&mut diagnostics, &permit(Value::Unknown)),
            Some(false)
        );
        assert_eq!(
            client.configure(&mut diagnostics, &GatewayConfig::default()),
            Some(false)
        );
    }
}
