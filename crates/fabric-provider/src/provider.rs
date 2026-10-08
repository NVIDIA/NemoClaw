// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fabric` provider's configuration, resources, and data sources.

use crate::{AgentConfigurationBackend, SandboxReadinessDataSource};
use async_trait::async_trait;
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use nemoclaw_tofu::ResourceAdapter;
use openshell_provider::{GatewayClient, GatewayConfig};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tf_provider::{Diagnostics, DynamicDataSource, DynamicResource, Provider, schema::Schema};

/// Reaches agent configurations through the configured gateway client.
struct FabricBackend(Arc<GatewayClient>);

#[async_trait]
impl Backend for FabricBackend {
    async fn plan(&self, kind: &str, desired: &Row, prior: Option<&Row>) -> Result<(), Error> {
        // Unknown provider inputs may be produced by an upstream resource.
        // Only fresh-resource planning can defer its read.
        if prior.is_none() && self.0.deferred()? {
            return Ok(());
        }
        AgentConfigurationBackend(self.0.client()?)
            .plan(kind, desired, prior)
            .await
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        AgentConfigurationBackend(self.0.client()?)
            .read(kind, prior, removing)
            .await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.0.client() {
            Ok(client) => {
                AgentConfigurationBackend(client)
                    .ensure(kind, desired)
                    .await
            }
            Err(error) => Mutation::failed(error),
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        AgentConfigurationBackend(self.0.client()?)
            .remove(kind, prior, destroying)
            .await
    }
}

/// Serves agent configuration and sandbox readiness through one configured gateway.
#[derive(Default)]
pub struct FabricProvider {
    client: Arc<GatewayClient>,
    destroying: Arc<AtomicBool>,
}

#[async_trait]
impl Provider for FabricProvider {
    type Config<'a> = GatewayConfig;
    type MetaState<'a> = tf_provider::value::ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        Some(GatewayConfig::schema())
    }

    async fn configure<'a>(
        &self,
        diags: &mut Diagnostics,
        _: String,
        config: GatewayConfig,
    ) -> Option<()> {
        let destroying = self.client.configure(diags, &config)?;
        self.destroying.store(destroying, Ordering::Release);
        Some(())
    }

    fn get_resources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        let backend = Arc::new(FabricBackend(self.client.clone()));
        Some(
            crate::definitions()
                .into_iter()
                .map(|definition| {
                    let name = definition.kind.to_owned();
                    let mut resource = ResourceAdapter::new(definition, backend.clone());
                    resource.destroying = self.destroying.clone();
                    (name, Box::new(resource) as Box<dyn DynamicResource>)
                })
                .collect(),
        )
    }

    fn get_data_sources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        Some(HashMap::from([(
            "sandbox_readiness".into(),
            Box::new(SandboxReadinessDataSource(self.client.clone())) as Box<dyn DynamicDataSource>,
        )]))
    }
}
