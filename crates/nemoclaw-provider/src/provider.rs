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
        use crate::runtime_contract::RuntimeDataSource;
        use nemoclaw_sdk::services::installers::{ollama, vllm};
        let (vllm_runtime, ollama_runtime) =
            match (RuntimeDataSource::vllm(), RuntimeDataSource::ollama()) {
                (Ok(vllm), Ok(ollama)) => (vllm, ollama),
                (Err(error), _) | (_, Err(error)) => {
                    diags.root_error(
                        "A runtime contract has no OpenTofu schema",
                        error.to_string(),
                    );
                    return None;
                }
            };
        Some(HashMap::from([
            (
                vllm::RUNTIME_DATA_SOURCE.into(),
                Box::new(vllm_runtime) as Box<dyn DynamicDataSource>,
            ),
            (
                ollama::RUNTIME_DATA_SOURCE.into(),
                Box::new(ollama_runtime) as Box<dyn DynamicDataSource>,
            ),
            (
                ollama::proxy::RUNTIME_DATA_SOURCE.into(),
                Box::new(crate::services::installers::ollama::ProxyRuntimeDataSource)
                    as Box<dyn DynamicDataSource>,
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
                "gateway_readiness".into(),
                Box::new(crate::gateway::GatewayReadinessDataSource(
                    self.backend.clone(),
                )) as Box<dyn DynamicDataSource>,
            ),
        ]))
    }
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let mut attributes = HashMap::new();
        attributes.insert(
            "destroy".into(),
            Attribute {
                attr_type: AttributeType::Bool,
                constraint: AttributeConstraint::Optional,
                ..Default::default()
            },
        );
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
        _: &mut Diagnostics,
        _: String,
        config: ProviderConfig,
    ) -> Option<()> {
        // Reconfiguration must not retain teardown permission from an earlier
        // configuration when the input becomes unknown.
        self.destroying.store(
            matches!(config.destroy, Value::Value(true)),
            Ordering::Release,
        );
        Some(())
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
    definitions
}

#[cfg(test)]
mod tests {
    use super::*;

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
    async fn configuration_only_grants_or_withdraws_teardown_permission() {
        let provider = NemoClawProvider::default();
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

#[cfg(all(test, unix))]
#[path = "gateway_tests.rs"]
mod gateway_tests;
