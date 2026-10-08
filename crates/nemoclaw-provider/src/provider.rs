// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::openshell::{EnvironmentSecrets, OpenShell};
use crate::{Backend, Definition, Mutation, ResourceAdapter, Row};
use crate::{docker::Connections, services::BackendRegistry};
use async_trait::async_trait;
use nemoclaw_sdk::ObservationError;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tf_provider::{
    Diagnostics, DynamicDataSource, DynamicResource, Provider,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

#[derive(Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    endpoint: Value<String>,
    credential_env: Value<String>,
    tls_ca_env: Value<String>,
    tls_certificate_env: Value<String>,
    tls_key_env: Value<String>,
    destroy: Value<bool>,
    platform_only: Value<bool>,
}
fn text(value: Value<String>) -> String {
    match value {
        Value::Value(v) => v,
        _ => String::new(),
    }
}
#[derive(Default)]
enum Connection {
    #[default]
    Unconfigured,
    Deferred,
    Ready(OpenShell),
}
#[derive(Default)]
pub(crate) struct ConfiguredBackend(RwLock<Connection>, Connections);
impl ConfiguredBackend {
    pub(crate) fn connections(&self) -> &Connections {
        &self.1
    }
    pub(crate) fn client(&self) -> Result<OpenShell, ObservationError> {
        match &*self.0.read().map_err(|_| ObservationError::Query)? {
            Connection::Ready(client) => Ok(client.clone()),
            Connection::Unconfigured | Connection::Deferred => Err(ObservationError::Query),
        }
    }
}
#[async_trait]
impl Backend for ConfiguredBackend {
    async fn plan(
        &self,
        kind: &str,
        desired: &Row,
        prior: Option<&Row>,
    ) -> Result<(), nemoclaw_sdk::Error> {
        if let Some(backend) = BackendRegistry::new(&self.1).resolve(kind, desired)? {
            return backend.plan(kind, desired, prior).await;
        }
        // Unknown provider inputs may be produced by an upstream resource.
        // Only fresh-resource planning can defer its read; bound resources
        // must still be observed, and mutations always require a ready client.
        if prior.is_none()
            && matches!(
                *self.0.read().map_err(|_| ObservationError::Query)?,
                Connection::Deferred
            )
        {
            return Ok(());
        }
        self.client()?.plan(kind, desired, prior).await
    }

    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        if let Some(backend) = BackendRegistry::new(&self.1).resolve(kind, prior)? {
            return backend.read(kind, prior, removing).await;
        }
        self.client()?.read(kind, prior, removing).await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        // Image and model downloads during a mutation report progress to the SDK.
        crate::download::with_provider_download_progress(
            crate::download::resource_label(kind, desired),
            async {
                match BackendRegistry::new(&self.1).resolve(kind, desired) {
                    Ok(Some(backend)) => return backend.ensure(kind, desired).await,
                    Err(error) => return Mutation::failed(error),
                    Ok(None) => {}
                }
                match self.client() {
                    Ok(client) => client.ensure(kind, desired).await,
                    Err(error) => Mutation::failed(error),
                }
            },
        )
        .await
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        if let Some(backend) = BackendRegistry::new(&self.1).resolve(kind, prior)? {
            return backend.remove(kind, prior, destroying).await;
        }
        self.client()?.remove(kind, prior, destroying).await
    }
}
#[derive(Default)]
pub struct NemoClawProvider {
    backend: Arc<ConfiguredBackend>,
    destroying: Arc<AtomicBool>,
}
#[async_trait]
impl Provider for NemoClawProvider {
    type Config<'a> = ProviderConfig;
    type MetaState<'a> = ValueEmpty;
    fn get_data_sources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        let vllm_runtime = match crate::vllm_runtime::VllmRuntimeDataSource::new() {
            Ok(source) => source,
            Err(error) => {
                diags.root_error(
                    "The vLLM runtime contract has no OpenTofu schema",
                    error.to_string(),
                );
                return None;
            }
        };
        Some(HashMap::from([
            (
                nemoclaw_sdk::services::installers::vllm::RUNTIME_DATA_SOURCE.into(),
                Box::new(vllm_runtime) as Box<dyn DynamicDataSource>,
            ),
            (
                "inference_capabilities".into(),
                Box::new(crate::inference_discovery::InferenceDataSource)
                    as Box<dyn DynamicDataSource>,
            ),
            (
                "target_hardware".into(),
                Box::new(crate::hardware_data::HardwareDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
            (
                "engine_capabilities".into(),
                Box::new(crate::discovery::DiscoveryDataSource {
                    backend: self.backend.clone(),
                    fabric: false,
                }) as Box<dyn DynamicDataSource>,
            ),
            (
                "fabric_capabilities".into(),
                Box::new(crate::discovery::DiscoveryDataSource {
                    backend: self.backend.clone(),
                    fabric: true,
                }) as Box<dyn DynamicDataSource>,
            ),
            (
                "sandbox_readiness".into(),
                Box::new(crate::sandbox_readiness::SandboxReadinessDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
            (
                "runtime_image".into(),
                Box::new(crate::runtime_image::RuntimeImageDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
            (
                "service_readiness".into(),
                Box::new(crate::readiness::ReadinessDataSource(self.backend.clone()))
                    as Box<dyn DynamicDataSource>,
            ),
            (
                "service_capacity".into(),
                Box::new(crate::capacity::CapacityDataSource(self.backend.clone()))
                    as Box<dyn DynamicDataSource>,
            ),
            (
                "gateway_capabilities".into(),
                Box::new(crate::gateway::GatewayDataSource(self.backend.clone()))
                    as Box<dyn DynamicDataSource>,
            ),
            (
                "gateway_readiness".into(),
                Box::new(crate::gateway::GatewayReadinessDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
        ]))
    }
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let mut attributes = HashMap::new();
        for name in [
            "endpoint",
            "credential_env",
            "tls_ca_env",
            "tls_certificate_env",
            "tls_key_env",
            "destroy",
            "platform_only",
        ] {
            attributes.insert(
                name.into(),
                Attribute {
                    attr_type: if matches!(name, "destroy" | "platform_only") {
                        AttributeType::Bool
                    } else {
                        AttributeType::String
                    },
                    constraint: AttributeConstraint::Optional,
                    ..Default::default()
                },
            );
        }
        Some(Schema {
            version: 0,
            block: Block {
                attributes,
                ..Default::default()
            },
        })
    }
    async fn configure<'a>(
        &self,
        diags: &mut Diagnostics,
        _: String,
        config: ProviderConfig,
    ) -> Option<()> {
        // Reconfiguration must not retain a client or teardown permission from
        // an earlier configuration when inputs become unknown or invalid.
        self.destroying.store(false, Ordering::Release);
        let deferred = [
            &config.endpoint,
            &config.credential_env,
            &config.tls_ca_env,
            &config.tls_certificate_env,
            &config.tls_key_env,
        ]
        .into_iter()
        .any(|value| matches!(value, Value::Unknown))
            || matches!(config.destroy, Value::Unknown)
            || matches!(config.platform_only, Value::Unknown);
        match self.backend.0.write() {
            Ok(mut slot) => {
                *slot = if deferred {
                    Connection::Deferred
                } else {
                    Connection::Unconfigured
                }
            }
            Err(_) => {
                diags.root_error_short("Provider configuration lock failed");
                return None;
            }
        }
        if deferred {
            return Some(());
        }
        if matches!(config.platform_only, Value::Value(true)) {
            if [
                &config.endpoint,
                &config.credential_env,
                &config.tls_ca_env,
                &config.tls_certificate_env,
                &config.tls_key_env,
            ]
            .into_iter()
            .any(|value| matches!(value, Value::Value(_)))
            {
                diags.root_error_short("Platform-only provider configuration cannot include gateway connection settings");
                return None;
            }
            self.destroying.store(
                matches!(config.destroy, Value::Value(true)),
                Ordering::Release,
            );
            return Some(());
        }
        if matches!(config.endpoint, Value::Null) {
            if [
                &config.credential_env,
                &config.tls_ca_env,
                &config.tls_certificate_env,
                &config.tls_key_env,
            ]
            .into_iter()
            .any(|value| matches!(value, Value::Value(value) if !value.is_empty()))
                || matches!(config.destroy, Value::Value(true))
            {
                diags.root_error_short("Gateway credentials and teardown require an endpoint");
                return None;
            }
            return Some(());
        }
        let mut gateway = nemoclaw_openshell::Connection {
            endpoint: text(config.endpoint),
            ..Default::default()
        };
        let credential = text(config.credential_env);
        if !credential.is_empty() {
            gateway.credential_env = Some(credential);
        }
        let ca = text(config.tls_ca_env);
        let certificate = text(config.tls_certificate_env);
        let key = text(config.tls_key_env);
        if !ca.is_empty() || !certificate.is_empty() || !key.is_empty() {
            if ca.is_empty() || certificate.is_empty() || key.is_empty() {
                diags.root_error_short("Incomplete TLS credential references");
                return None;
            }
            gateway.tls = Some(nemoclaw_openshell::TlsFiles {
                ca_env: ca,
                certificate_env: certificate,
                key_env: key,
            });
        }
        match OpenShell::connect(&gateway, Arc::new(EnvironmentSecrets)) {
            Ok(client) => {
                match self.backend.0.write() {
                    Ok(mut slot) => *slot = Connection::Ready(client),
                    Err(_) => {
                        diags.root_error_short("Provider configuration lock failed");
                        return None;
                    }
                }
                self.destroying.store(
                    matches!(config.destroy, Value::Value(true)),
                    Ordering::Release,
                );
                Some(())
            }
            Err(error) => {
                diags.root_error("Gateway connection", error.to_string());
                None
            }
        }
    }
    fn get_resources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        let definitions = definitions();
        Some(
            definitions
                .into_iter()
                .map(|definition| {
                    let name = definition.kind.into();
                    let mut resource = ResourceAdapter::new(definition, self.backend.clone());
                    resource.destroying = self.destroying.clone();
                    (name, Box::new(resource) as Box<dyn DynamicResource>)
                })
                .collect(),
        )
    }
}

/// Resource definitions served by this provider.
pub(crate) fn definitions() -> Vec<Definition> {
    let mut definitions = Vec::new();
    definitions.extend(crate::kubernetes::definitions());
    definitions.extend(crate::services::definitions());
    definitions.extend(crate::managed::definitions());
    definitions.extend(crate::openshell::definitions());
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;

    fn known() -> ProviderConfig {
        ProviderConfig {
            endpoint: Value::Value("http://127.0.0.1:1".into()),
            destroy: Value::Value(true),
            ..Default::default()
        }
    }

    #[test]
    fn every_sdk_resource_schema_is_served_once_with_its_fields() {
        let served = definitions();
        for schema in nemoclaw_sdk::services::resource_schemas() {
            let matching: Vec<_> = served
                .iter()
                .filter(|definition| definition.kind == schema.kind)
                .collect();
            assert_eq!(matching.len(), 1, "{}", schema.kind);
            assert_eq!(matching[0].fields, schema.fields, "{}", schema.kind);
            assert_eq!(matching[0].mutable, schema.mutable, "{}", schema.kind);
        }
    }

    #[tokio::test]
    async fn unknown_connection_inputs_clear_old_clients_and_only_defer_fresh_planning() {
        for field in 0..7 {
            let provider = NemoClawProvider::default();
            let mut diagnostics = Diagnostics::default();
            provider
                .configure(&mut diagnostics, String::new(), known())
                .await
                .unwrap();
            assert!(provider.backend.client().is_ok());
            assert!(provider.destroying.load(Ordering::Acquire));
            let mut config = known();
            match field {
                0 => config.endpoint = Value::Unknown,
                1 => config.credential_env = Value::Unknown,
                2 => config.tls_ca_env = Value::Unknown,
                3 => config.tls_certificate_env = Value::Unknown,
                4 => config.tls_key_env = Value::Unknown,
                5 => config.destroy = Value::Unknown,
                _ => config.platform_only = Value::Unknown,
            }
            provider
                .configure(&mut diagnostics, String::new(), config)
                .await
                .unwrap();
            assert!(diagnostics.errors.is_empty());
            assert!(provider.backend.client().is_err());
            assert!(!provider.destroying.load(Ordering::Acquire));
            let row = Row::new();
            assert!(provider.backend.plan("workspace", &row, None).await.is_ok());
            assert!(
                provider
                    .backend
                    .plan("workspace", &row, Some(&row))
                    .await
                    .is_err()
            );
            assert!(
                provider
                    .backend
                    .read("workspace", &row, false)
                    .await
                    .is_err()
            );
            let (state, error) = provider
                .backend
                .ensure("workspace", &row)
                .await
                .into_parts();
            assert!(state.is_none() && error.is_some());
            assert!(
                provider
                    .backend
                    .remove("workspace", &row, true)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn discovery_only_configuration_clears_gateway_client_and_teardown_permission() {
        let provider = NemoClawProvider::default();
        let mut diagnostics = Diagnostics::default();
        provider
            .configure(&mut diagnostics, String::new(), known())
            .await
            .unwrap();
        provider
            .configure(&mut diagnostics, String::new(), ProviderConfig::default())
            .await
            .unwrap();
        assert!(diagnostics.errors.is_empty());
        assert!(provider.backend.client().is_err());
        assert!(!provider.destroying.load(Ordering::Acquire));
        assert!(
            provider
                .backend
                .plan("workspace", &Row::new(), None)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn invalid_known_configuration_clears_previous_client_without_deferring() {
        for endpoint in [Value::Null, Value::Value("invalid".into())] {
            let provider = NemoClawProvider::default();
            let mut diagnostics = Diagnostics::default();
            provider
                .configure(&mut diagnostics, String::new(), known())
                .await
                .unwrap();
            let config = ProviderConfig {
                endpoint,
                ..known()
            };
            assert!(
                provider
                    .configure(&mut diagnostics, String::new(), config)
                    .await
                    .is_none()
            );
            assert!(!diagnostics.errors.is_empty());
            assert!(provider.backend.client().is_err());
            assert!(!provider.destroying.load(Ordering::Acquire));
            assert!(
                provider
                    .backend
                    .plan("workspace", &Row::new(), None)
                    .await
                    .is_err()
            );
        }
    }

    #[tokio::test]
    async fn endpoint_free_teardown_requires_explicit_platform_mode() {
        let provider = NemoClawProvider::default();
        for platform_only in [Value::Null, Value::Value(false), Value::Value(true)] {
            let allowed = matches!(platform_only, Value::Value(true));
            let mut diagnostics = Diagnostics::default();
            let configured = provider
                .configure(
                    &mut diagnostics,
                    String::new(),
                    ProviderConfig {
                        destroy: Value::Value(true),
                        platform_only,
                        ..Default::default()
                    },
                )
                .await;
            assert_eq!(configured.is_some(), allowed);
            assert_eq!(diagnostics.errors.is_empty(), allowed);
            assert_eq!(provider.destroying.load(Ordering::Acquire), allowed);
            assert!(provider.backend.client().is_err());
        }
    }

    #[tokio::test]
    async fn platform_only_clears_gateway_access_and_rejects_connection_inputs() {
        let provider = NemoClawProvider::default();
        provider
            .configure(&mut Diagnostics::default(), String::new(), known())
            .await
            .unwrap();
        let mut diagnostics = Diagnostics::default();
        provider
            .configure(
                &mut diagnostics,
                String::new(),
                ProviderConfig {
                    platform_only: Value::Value(true),
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(diagnostics.errors.is_empty());
        assert!(provider.backend.client().is_err());
        assert!(!provider.destroying.load(Ordering::Acquire));
        assert!(
            provider
                .backend
                .plan("workspace", &Row::new(), None)
                .await
                .is_err()
        );
        assert!(
            provider
                .backend
                .ensure("workspace", &Row::new())
                .await
                .error()
                .is_some()
        );
        for field in 0..5 {
            let mut config = ProviderConfig {
                platform_only: Value::Value(true),
                ..Default::default()
            };
            match field {
                0 => config.endpoint = Value::Value("https://127.0.0.1:17671".into()),
                1 => config.credential_env = Value::Value("UNREAD_TOKEN".into()),
                2 => config.tls_ca_env = Value::Value("UNREAD_CA".into()),
                3 => config.tls_certificate_env = Value::Value("UNREAD_CERT".into()),
                _ => config.tls_key_env = Value::Value("UNREAD_KEY".into()),
            }
            assert!(
                provider
                    .configure(&mut Diagnostics::default(), String::new(), config)
                    .await
                    .is_none()
            );
            assert!(provider.backend.client().is_err());
        }
    }
}

#[cfg(all(test, unix))]
#[path = "gateway_tests.rs"]
mod gateway_tests;
