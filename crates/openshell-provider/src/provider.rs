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

impl OpenShellProvider {
    /// Serve resources using the deployment's managed service identity checks.
    pub fn with_services(services: Arc<dyn crate::Services>) -> Self {
        Self {
            client: Arc::new(GatewayClient::with_services(services)),
            destroying: Arc::default(),
        }
    }
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
        // Withdraw teardown permission before validating, so a rejected
        // reconfiguration cannot keep an earlier grant.
        self.destroying.store(false, Ordering::Release);
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

#[cfg(test)]
mod tests {
    use super::*;
    use tf_provider::value::Value;

    // Connecting starts a lazy channel, which needs a runtime.
    #[tokio::test]
    async fn rejected_reconfiguration_withdraws_teardown_permission() {
        let provider = OpenShellProvider::default();
        let permitted = GatewayConfig {
            endpoint: Value::Value("http://127.0.0.1:1".into()),
            destroy: Value::Value(true),
            ..Default::default()
        };
        let mut diagnostics = Diagnostics::default();
        provider
            .configure(&mut diagnostics, String::new(), permitted)
            .await
            .unwrap();
        assert!(provider.destroying.load(Ordering::Acquire));
        // Teardown without an endpoint is refused.
        let rejected = GatewayConfig {
            destroy: Value::Value(true),
            ..Default::default()
        };
        assert!(
            provider
                .configure(&mut diagnostics, String::new(), rejected)
                .await
                .is_none()
        );
        assert!(!provider.destroying.load(Ordering::Acquire));
    }
}
