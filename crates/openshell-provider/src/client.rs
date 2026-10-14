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
    sync::{Arc, RwLock},
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
}

impl GatewaySettings<'_> {
    fn references(&self) -> [&Value<String>; 4] {
        [
            self.credential_env,
            self.tls_ca_env,
            self.tls_certificate_env,
            self.tls_key_env,
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
    /// The connection these known inputs describe; `None` without an endpoint.
    pub fn connection(&self) -> Result<Option<nemoclaw_openshell::Connection>, &'static str> {
        let text = |value: &Value<String>| match value {
            Value::Value(value) => value.clone(),
            _ => String::new(),
        };
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
            if ca.is_empty() || certificate.is_empty() || key.is_empty() {
                return Err("Incomplete TLS credential references");
            }
            connection.tls = Some(nemoclaw_openshell::TlsFiles {
                ca_env: ca,
                certificate_env: certificate,
                key_env: key,
            });
        }
        Ok(Some(connection))
    }
}

/// The connection a row's `gateway` ref carries.
pub fn row_connection(row: &Row) -> Result<nemoclaw_openshell::Connection, &'static str> {
    let [
        endpoint,
        credential_env,
        tls_ca_env,
        tls_certificate_env,
        tls_key_env,
    ] = nemoclaw_openshell::GATEWAY_FIELDS
        .map(|(_, field)| Value::Value(row.get(field).cloned().unwrap_or_default()));
    GatewaySettings {
        endpoint: &endpoint,
        credential_env: &credential_env,
        tls_ca_env: &tls_ca_env,
        tls_certificate_env: &tls_certificate_env,
        tls_key_env: &tls_key_env,
    }
    .connection()?
    .ok_or("The gateway ref has no endpoint")
}

/// Gateway clients by connection, created on first use.
pub struct GatewayClient {
    clients: RwLock<BTreeMap<String, OpenShell>>,
    services: Arc<dyn Services>,
}

impl Default for GatewayClient {
    fn default() -> Self {
        Self::with_services(Arc::new(DockerServices))
    }
}

impl GatewayClient {
    /// Use the deployment's managed service checks for each client.
    pub fn with_services(services: Arc<dyn Services>) -> Self {
        Self {
            clients: RwLock::default(),
            services,
        }
    }

    /// Whether `config` permits teardown.
    pub fn configure(&self, _: &mut Diagnostics, config: &GatewayConfig) -> Option<bool> {
        Some(matches!(config.destroy, Value::Value(true)))
    }

    /// The client for `connection`, connecting lazily on first use.
    pub fn connect(
        &self,
        connection: &nemoclaw_openshell::Connection,
    ) -> Result<OpenShell, String> {
        let key = serde_json::to_string(&(
            &connection.endpoint,
            &connection.credential_env,
            connection
                .tls
                .as_ref()
                .map(|tls| (&tls.ca_env, &tls.certificate_env, &tls.key_env)),
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
    pub fn client_for(&self, row: &Row) -> Result<OpenShell, ObservationError> {
        let connection = row_connection(row).map_err(|_| ObservationError::Incomplete)?;
        self.connect(&connection)
            .map_err(|_| ObservationError::Incomplete)
    }

    /// The client for a row about to be planned, explaining a connection the
    /// gateway ref cannot describe.
    pub fn planning_client(&self, row: &Row) -> Result<OpenShell, Error> {
        let connection = row_connection(row).map_err(Error::State)?;
        self.connect(&connection)
            .map_err(|_| Error::State("The gateway ref's endpoint is not a valid gateway origin"))
    }
}

/// Reconciles OpenShell objects through the gateway each row names.
pub struct OpenShellBackend(pub Arc<GatewayClient>);

#[async_trait]
impl Backend for OpenShellBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        self.0
            .planning_client(desired)?
            .plan(kind, desired, prior)
            .await
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.0.client_for(prior)?.read(kind, prior, removing).await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.0.client_for(desired) {
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
        self.0
            .client_for(prior)?
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
        let first = client.client_for(&row("http://127.0.0.1:1")).unwrap();
        let again = client.client_for(&row("http://127.0.0.1:1")).unwrap();
        client.client_for(&row("http://127.0.0.1:2")).unwrap();
        assert_eq!(client.clients.read().unwrap().len(), 2);
        drop((first, again));
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
            assert!(client.client_for(&row).is_err());
            assert!(client.planning_client(&row).is_err());
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
