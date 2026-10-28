// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Backend, Definition, Mutation, ResourceAdapter, Row};
use crate::{docker::Connections, services::BackendRegistry};
use async_trait::async_trait;
use nemoclaw_sdk::ObservationError;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tf_provider::{
    Diagnostics, DynamicDataSource, DynamicResource, Provider,
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Schema},
    value::{Value, ValueEmpty},
};

/// The provider reaches engines and clusters named on each resource, so its
/// only setting is the teardown permission.
#[derive(Default, Serialize, Deserialize)]
pub struct ProviderConfig {
    destroy: Value<bool>,
}
#[derive(Default)]
pub(crate) struct ConfiguredBackend(Connections);
impl ConfiguredBackend {
    #[cfg(test)]
    pub(crate) fn fixed(connections: Connections) -> Self {
        Self(connections)
    }
    pub(crate) fn connections(&self) -> &Connections {
        &self.0
    }
    /// The backend for a resource kind; every kind this provider serves has one.
    fn resolve(&self, kind: &str, row: &Row) -> Result<Box<dyn Backend>, ObservationError> {
        BackendRegistry::new(&self.0)
            .resolve(kind, row)?
            .ok_or(ObservationError::Query)
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
        self.resolve(kind, desired)?
            .plan(kind, desired, prior)
            .await
    }

    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.resolve(kind, prior)?.read(kind, prior, removing).await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        // Image and model downloads during a mutation report progress to the SDK.
        crate::download::with_provider_download_progress(
            crate::download::resource_label(kind, desired),
            async {
                match self.resolve(kind, desired) {
                    Ok(backend) => backend.ensure(kind, desired).await,
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
        self.resolve(kind, prior)?
            .remove(kind, prior, destroying)
            .await
    }
}
/// A resource for `definition`, reconciled by `backend`.
fn adapter(
    definition: Definition,
    backend: &Arc<ConfiguredBackend>,
    destroying: &Arc<AtomicBool>,
) -> Box<dyn DynamicResource> {
    let structured = definition.is_structured();
    let mut resource = ResourceAdapter::new(definition, backend.clone());
    resource.destroying = destroying.clone();
    // Typed list and block inputs need the structured adapter.
    if structured {
        Box::new(nemoclaw_tofu::StructuredAdapter(resource))
    } else {
        Box::new(resource)
    }
}

/// Every resource definition this crate implements.
pub(crate) fn all_definitions() -> Vec<Definition> {
    let mut definitions = Vec::new();
    definitions.extend(crate::kubernetes::definitions());
    definitions.extend(crate::services::definitions());
    definitions.extend(crate::managed::definitions());
    definitions
}

/// Whether the openshell provider serves a kind: gateway installation.
fn installs_gateway(definition: &Definition) -> bool {
    nemoclaw_openshell::installation_type(definition.kind).is_some()
}

/// The teardown permission, the only setting of this crate's providers.
fn destroy_schema() -> Schema {
    let mut attributes = HashMap::new();
    attributes.insert(
        "destroy".into(),
        Attribute {
            attr_type: AttributeType::Bool,
            constraint: AttributeConstraint::Optional,
            ..Default::default()
        },
    );
    Schema {
        version: 0,
        block: Block {
            attributes,
            ..Default::default()
        },
    }
}

/// Grant teardown only for an explicit `destroy = true`. Reconfiguration must
/// not retain permission from an earlier configuration when the input becomes
/// unknown.
fn configure_destroy(destroying: &AtomicBool, config: &ProviderConfig) {
    destroying.store(
        matches!(config.destroy, Value::Value(true)),
        Ordering::Release,
    );
}

/// The vllm or ollama type a service kind's definition serves, if any.
fn runtime_type(definition: &Definition) -> Option<&'static str> {
    nemoclaw_sdk::services::provider_types::runtime_type(definition.kind)
}

/// The `host` provider: read-only observations of a container engine, its
/// images, and container health.
#[derive(Default)]
pub struct HostProvider {
    backend: Arc<ConfiguredBackend>,
}
#[async_trait]
impl Provider for HostProvider {
    type Config<'a> = ValueEmpty;
    type MetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(Schema {
            version: 0,
            block: Block::default(),
        })
    }
    async fn configure<'a>(&self, _: &mut Diagnostics, _: String, _: ValueEmpty) -> Option<()> {
        Some(())
    }
    fn get_resources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        Some(HashMap::new())
    }
    fn get_data_sources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        Some(HashMap::from([
            (
                "engine".into(),
                Box::new(crate::host_engine::HostEngineDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
            (
                "image".into(),
                Box::new(crate::host_image::HostImageDataSource(self.backend.clone()))
                    as Box<dyn DynamicDataSource>,
            ),
            (
                "container_health".into(),
                Box::new(crate::host_container_health::HostContainerHealthDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
        ]))
    }
}

/// The `vllm` or `ollama` provider: one runtime's credential storage, runtime
/// contracts, readiness, and capacity.
pub struct ServiceProvider {
    name: &'static str,
    backend: Arc<ConfiguredBackend>,
    destroying: Arc<AtomicBool>,
}

impl ServiceProvider {
    fn new(name: &'static str) -> Self {
        Self {
            name,
            backend: Arc::default(),
            destroying: Arc::default(),
        }
    }

    /// The `vllm` provider.
    pub fn vllm() -> Self {
        Self::new("vllm")
    }

    /// The `ollama` provider.
    pub fn ollama() -> Self {
        Self::new("ollama")
    }

    /// A type name without this provider's prefix, if this provider serves it.
    fn local(&self, name: &str) -> Option<String> {
        name.strip_prefix(self.name)
            .and_then(|name| name.strip_prefix('_'))
            .map(str::to_owned)
    }
}

#[async_trait]
impl Provider for ServiceProvider {
    type Config<'a> = ProviderConfig;
    type MetaState<'a> = ValueEmpty;
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(destroy_schema())
    }
    async fn configure<'a>(
        &self,
        _: &mut Diagnostics,
        _: String,
        config: ProviderConfig,
    ) -> Option<()> {
        configure_destroy(&self.destroying, &config);
        Some(())
    }
    fn get_resources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        Some(
            all_definitions()
                .into_iter()
                .filter_map(|definition| {
                    let name = self.local(runtime_type(&definition)?)?;
                    Some((name, adapter(definition, &self.backend, &self.destroying)))
                })
                .collect(),
        )
    }
    fn get_data_sources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        use crate::runtime_contract::RuntimeDataSource;
        use crate::services::ServiceRuntime::{Ollama, OllamaProxy, Vllm};
        use crate::{capacity::CapacityDataSource, readiness::ReadinessDataSource};
        let backend = &self.backend;
        let runtime = match self.name {
            "vllm" => RuntimeDataSource::vllm(),
            _ => RuntimeDataSource::ollama(),
        };
        let runtime = match runtime {
            Ok(runtime) => Box::new(runtime) as Box<dyn DynamicDataSource>,
            Err(error) => {
                diags.root_error(
                    "A runtime contract has no OpenTofu schema",
                    error.to_string(),
                );
                return None;
            }
        };
        let mut sources: HashMap<String, Box<dyn DynamicDataSource>> =
            HashMap::from([("runtime".into(), runtime)]);
        let readiness = |runtime| {
            Box::new(ReadinessDataSource(backend.clone(), runtime)) as Box<dyn DynamicDataSource>
        };
        let capacity = |runtime| {
            Box::new(CapacityDataSource(backend.clone(), runtime)) as Box<dyn DynamicDataSource>
        };
        if self.name == "vllm" {
            sources.insert("readiness".into(), readiness(Vllm));
            sources.insert("capacity".into(), capacity(Vllm));
        } else {
            sources.insert(
                "proxy_runtime".into(),
                Box::new(crate::services::installers::ollama::ProxyRuntimeDataSource),
            );
            sources.insert("readiness".into(), readiness(Ollama));
            sources.insert("proxy_readiness".into(), readiness(OllamaProxy));
            sources.insert("capacity".into(), capacity(Ollama));
            sources.insert(
                "model".into(),
                Box::new(crate::ollama_model::OllamaModelDataSource),
            );
        }
        Some(sources)
    }
}

/// The gateway installation types: Podman and Kubernetes gateways, their
/// storage and credentials, and Docker gateway reads. The openshell provider
/// serves them, sharing its teardown permission.
pub struct GatewayInstallation {
    backend: Arc<ConfiguredBackend>,
    destroying: Arc<AtomicBool>,
}

impl GatewayInstallation {
    /// Installation types that may tear down only while `destroying` holds.
    pub fn new(destroying: Arc<AtomicBool>) -> Self {
        Self {
            backend: Arc::default(),
            destroying,
        }
    }

    /// The type name, without the provider prefix, for an installation kind.
    fn name(kind: &str) -> String {
        nemoclaw_openshell::installation_type(kind)
            .and_then(|name| name.strip_prefix("openshell_").map(str::to_owned))
            .expect("an installation kind")
    }

    /// Resources by type name, without the provider prefix.
    pub fn resources(&self) -> HashMap<String, Box<dyn DynamicResource>> {
        all_definitions()
            .into_iter()
            .filter(installs_gateway)
            .map(|definition| {
                let name = Self::name(definition.kind);
                (name, adapter(definition, &self.backend, &self.destroying))
            })
            .collect()
    }

    /// Data sources by type name, without the provider prefix.
    pub fn data_sources(&self) -> HashMap<String, Box<dyn DynamicDataSource>> {
        HashMap::from([
            (
                Self::name(nemoclaw_sdk::managed::GATEWAY_RUNTIME_DATA_SOURCE),
                Box::new(crate::gateway::GatewayRuntimeDataSource) as Box<dyn DynamicDataSource>,
            ),
            (
                Self::name("gateway_readiness"),
                Box::new(crate::gateway::GatewayReadinessDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
            (
                Self::name("gateway_prerequisites"),
                Box::new(crate::discovery::GatewayPrerequisitesDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_sdk_resource_schema_is_served_once_with_its_fields() {
        let served = all_definitions();
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
    async fn configuration_only_grants_or_withdraws_teardown_permission() {
        let provider = ServiceProvider::vllm();
        let mut diagnostics = Diagnostics::default();
        let schema = provider.schema(&mut diagnostics).unwrap();
        assert_eq!(
            schema.block.attributes.keys().collect::<Vec<_>>(),
            ["destroy"]
        );
        for (destroy, allowed) in [
            (Value::Value(true), true),
            (Value::Unknown, false),
            (Value::Value(false), false),
            (Value::Null, false),
        ] {
            provider
                .configure(&mut diagnostics, String::new(), ProviderConfig { destroy })
                .await
                .unwrap();
            assert_eq!(provider.destroying.load(Ordering::Acquire), allowed);
        }
        assert!(diagnostics.errors.is_empty());
    }
}

#[cfg(test)]
#[path = "gateway_tests.rs"]
mod gateway_tests;
