// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The gateway client a provider configuration establishes, and the backend
//! that reconciles OpenShell objects through it.

use crate::{EnvironmentSecrets, OpenShell};
use async_trait::async_trait;
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use std::sync::{Arc, RwLock};
use tf_provider::value::Value;

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
