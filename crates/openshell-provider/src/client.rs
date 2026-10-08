// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The gateway client a provider configuration establishes, and the backend
//! that reconciles OpenShell objects through it.

use crate::{EnvironmentSecrets, OpenShell};
use async_trait::async_trait;
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, RwLock};
use tf_provider::{
    Diagnostics,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Description, Schema},
    value::Value,
};

/// Configuration of a provider that reaches objects through one gateway.
#[derive(Default, Serialize, Deserialize)]
pub struct GatewayConfig {
    pub endpoint: Value<String>,
    pub credential_env: Value<String>,
    pub tls_ca_env: Value<String>,
    pub tls_certificate_env: Value<String>,
    pub tls_key_env: Value<String>,
    pub destroy: Value<bool>,
}

impl GatewayConfig {
    /// The provider configuration schema: the gateway connection and teardown permission.
    pub fn schema() -> Schema {
        let attribute = |attr_type, description: &str| Attribute {
            attr_type,
            constraint: AttributeConstraint::Optional,
            description: Description::plain(description.to_owned()),
            ..Default::default()
        };
        Schema {
            version: 0,
            block: Block {
                attributes: [
                    (
                        "endpoint",
                        attribute(AttributeType::String, "Gateway HTTP(S) origin."),
                    ),
                    (
                        "credential_env",
                        attribute(
                            AttributeType::String,
                            "Environment variable holding the bearer credential.",
                        ),
                    ),
                    (
                        "tls_ca_env",
                        attribute(
                            AttributeType::String,
                            "Environment variable naming the CA certificate file.",
                        ),
                    ),
                    (
                        "tls_certificate_env",
                        attribute(
                            AttributeType::String,
                            "Environment variable naming the client certificate file.",
                        ),
                    ),
                    (
                        "tls_key_env",
                        attribute(
                            AttributeType::String,
                            "Environment variable naming the client key file.",
                        ),
                    ),
                    (
                        "destroy",
                        attribute(
                            AttributeType::Bool,
                            "Permit deleting sandboxes during explicit teardown.",
                        ),
                    ),
                ]
                .into_iter()
                .map(|(name, attribute)| (name.into(), attribute))
                .collect(),
                ..Default::default()
            },
        }
    }
}

#[derive(Default)]
enum State {
    #[default]
    Unconfigured,
    /// Connection inputs are unknown until an upstream resource applies.
    Deferred,
    Ready(OpenShell),
}

/// The gateway client of the current provider configuration.
#[derive(Default)]
pub struct GatewayClient(RwLock<State>);

/// Gateway connection inputs of a provider configuration.
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
    /// Whether any input is set.
    pub fn any(&self) -> bool {
        matches!(self.endpoint, Value::Value(_))
            || self
                .references()
                .into_iter()
                .any(|value| matches!(value, Value::Value(_)))
    }
    /// Whether a credential or TLS reference is set.
    pub fn credentials(&self) -> bool {
        self.references()
            .into_iter()
            .any(|value| matches!(value, Value::Value(value) if !value.is_empty()))
    }
    /// The connection these known inputs describe; `None` without an endpoint.
    pub fn connection(&self) -> Result<Option<nemoclaw_openshell::Connection>, &'static str> {
        let text = |value: &Value<String>| match value {
            Value::Value(value) => value.clone(),
            _ => String::new(),
        };
        if matches!(self.endpoint, Value::Null) {
            return Ok(None);
        }
        let mut connection = nemoclaw_openshell::Connection {
            endpoint: text(self.endpoint),
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

impl GatewayClient {
    pub fn client(&self) -> Result<OpenShell, ObservationError> {
        match &*self.0.read().map_err(|_| ObservationError::Query)? {
            State::Ready(client) => Ok(client.clone()),
            State::Unconfigured | State::Deferred => Err(ObservationError::Query),
        }
    }
    /// Whether the configuration's connection inputs are not yet known.
    pub fn deferred(&self) -> Result<bool, ObservationError> {
        Ok(matches!(
            *self.0.read().map_err(|_| ObservationError::Query)?,
            State::Deferred
        ))
    }
    fn set(&self, state: State) -> Result<(), &'static str> {
        *self
            .0
            .write()
            .map_err(|_| "Provider configuration lock failed")? = state;
        Ok(())
    }
    /// Forget any earlier client; unknown inputs defer connecting.
    pub fn reset(&self, deferred: bool) -> Result<(), &'static str> {
        self.set(if deferred {
            State::Deferred
        } else {
            State::Unconfigured
        })
    }
    /// Connect lazily to `connection`.
    pub fn connect(&self, connection: &nemoclaw_openshell::Connection) -> Result<(), String> {
        let client = OpenShell::connect(connection, Arc::new(EnvironmentSecrets))
            .map_err(|error| error.to_string())?;
        self.set(State::Ready(client)).map_err(str::to_owned)
    }
}

impl GatewayClient {
    /// Connect for `config`, forgetting any earlier client first. Returns
    /// whether teardown may delete objects, or `None` after reporting an error.
    pub fn configure(&self, diags: &mut Diagnostics, config: &GatewayConfig) -> Option<bool> {
        // Reconfiguration must not retain a client or teardown permission from
        // an earlier configuration when inputs become unknown or invalid.
        let settings = GatewaySettings {
            endpoint: &config.endpoint,
            credential_env: &config.credential_env,
            tls_ca_env: &config.tls_ca_env,
            tls_certificate_env: &config.tls_certificate_env,
            tls_key_env: &config.tls_key_env,
        };
        let deferred = settings.unknown() || matches!(config.destroy, Value::Unknown);
        if let Err(error) = self.reset(deferred) {
            diags.root_error_short(error);
            return None;
        }
        if deferred {
            return Some(false);
        }
        let connection = match settings.connection() {
            Ok(Some(connection)) => connection,
            Ok(None) => {
                if settings.credentials() || matches!(config.destroy, Value::Value(true)) {
                    diags.root_error_short("Gateway credentials and teardown require an endpoint");
                    return None;
                }
                return Some(false);
            }
            Err(error) => {
                diags.root_error_short(error);
                return None;
            }
        };
        if let Err(error) = self.connect(&connection) {
            diags.root_error("Gateway connection", error);
            return None;
        }
        Some(matches!(config.destroy, Value::Value(true)))
    }
}

/// Reconciles OpenShell objects through the configured gateway client.
pub struct OpenShellBackend(pub Arc<GatewayClient>);

#[async_trait]
impl Backend for OpenShellBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        // Unknown provider inputs may be produced by an upstream resource.
        // Only fresh-resource planning can defer its read; bound resources
        // must still be observed, and mutations always require a ready client.
        if prior.is_none() && self.0.deferred()? {
            return Ok(());
        }
        self.0.client()?.plan(kind, desired, prior).await
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.0.client()?.read(kind, prior, removing).await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.0.client() {
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
        self.0.client()?.remove(kind, prior, destroying).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> GatewayConfig {
        GatewayConfig {
            endpoint: Value::Value("http://127.0.0.1:1".into()),
            destroy: Value::Value(true),
            ..Default::default()
        }
    }

    #[tokio::test]
    async fn unknown_connection_inputs_clear_old_clients_and_only_defer_fresh_planning() {
        for field in 0..6 {
            let client = Arc::new(GatewayClient::default());
            let mut diagnostics = Diagnostics::default();
            assert_eq!(client.configure(&mut diagnostics, &known()), Some(true));
            assert!(client.client().is_ok());
            let mut config = known();
            match field {
                0 => config.endpoint = Value::Unknown,
                1 => config.credential_env = Value::Unknown,
                2 => config.tls_ca_env = Value::Unknown,
                3 => config.tls_certificate_env = Value::Unknown,
                4 => config.tls_key_env = Value::Unknown,
                _ => config.destroy = Value::Unknown,
            }
            assert_eq!(client.configure(&mut diagnostics, &config), Some(false));
            assert!(diagnostics.errors.is_empty());
            assert!(client.client().is_err());
            let backend = OpenShellBackend(client);
            let row = Row::new();
            assert!(backend.plan("workspace", &row, None).await.is_ok());
            assert!(backend.plan("workspace", &row, Some(&row)).await.is_err());
            assert!(backend.read("workspace", &row, false).await.is_err());
            assert!(backend.ensure("workspace", &row).await.error().is_some());
            assert!(backend.remove("workspace", &row, true).await.is_err());
        }
    }

    // Connecting starts a lazy channel, which needs a runtime.
    #[tokio::test]
    async fn missing_or_invalid_endpoints_clear_the_previous_client() {
        for endpoint in [Value::Null, Value::Value("invalid".into())] {
            let client = GatewayClient::default();
            let mut diagnostics = Diagnostics::default();
            client.configure(&mut diagnostics, &known()).unwrap();
            let config = GatewayConfig {
                endpoint,
                ..known()
            };
            // Teardown without an endpoint, or an invalid endpoint, is refused.
            assert!(client.configure(&mut diagnostics, &config).is_none());
            assert!(!diagnostics.errors.is_empty());
            assert!(client.client().is_err());
            assert!(!client.deferred().unwrap());
        }
    }

    #[tokio::test]
    async fn an_empty_configuration_has_no_client_and_no_teardown_permission() {
        let client = GatewayClient::default();
        let mut diagnostics = Diagnostics::default();
        client.configure(&mut diagnostics, &known()).unwrap();
        assert_eq!(
            client.configure(&mut diagnostics, &GatewayConfig::default()),
            Some(false)
        );
        assert!(diagnostics.errors.is_empty());
        assert!(client.client().is_err());
        assert!(!client.deferred().unwrap());
    }
}
