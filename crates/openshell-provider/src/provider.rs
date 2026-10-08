// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `openshell` OpenTofu provider: OpenShell objects and gateway reads.

use crate::{
    client::{GatewayClient, GatewayConfig, OpenShellBackend},
    gateway_source::GatewayDataSource,
};
use async_trait::async_trait;
use nemoclaw_tofu::{ResourceAdapter, StructuredAdapter};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};
use tf_provider::{Diagnostics, DynamicDataSource, DynamicResource, Provider, schema::Schema};

use nemoclaw_openshell::RESOURCE_TYPES;

/// Serves workspaces, provider registrations and profiles, sandboxes, and the
/// gateway data source through one configured gateway.
#[derive(Default)]
pub struct OpenShellProvider {
    client: Arc<GatewayClient>,
    destroying: Arc<AtomicBool>,
}

#[async_trait]
impl Provider for OpenShellProvider {
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
        let backend = Arc::new(OpenShellBackend(self.client.clone()));
        Some(
            crate::definitions()
                .into_iter()
                .map(|definition| {
                    let name = RESOURCE_TYPES
                        .iter()
                        .find(|(kind, _)| *kind == definition.kind)
                        .map_or(definition.kind, |(_, name)| *name)
                        .to_owned();
                    let mut resource = ResourceAdapter::new(definition, backend.clone());
                    resource.destroying = self.destroying.clone();
                    (
                        name,
                        Box::new(StructuredAdapter(resource)) as Box<dyn DynamicResource>,
                    )
                })
                .collect(),
        )
    }

    fn get_data_sources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        Some(HashMap::from([(
            "gateway".into(),
            Box::new(GatewayDataSource(self.client.clone())) as Box<dyn DynamicDataSource>,
        )]))
    }
}
