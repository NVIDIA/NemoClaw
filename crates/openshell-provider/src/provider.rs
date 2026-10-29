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
/// gateway data source, each through the gateway its `gateway` ref names, and,
/// with the `installation` feature, the types that install a gateway.
pub struct OpenShellProvider {
    client: Arc<GatewayClient>,
    destroying: Arc<AtomicBool>,
    #[cfg(feature = "installation")]
    installation: nemoclaw_provider::GatewayInstallation,
}

impl Default for OpenShellProvider {
    fn default() -> Self {
        Self::with_client(Arc::default())
    }
}

impl OpenShellProvider {
    /// Serve resources using the deployment's managed service identity checks.
    pub fn with_services(services: Arc<dyn crate::Services>) -> Self {
        Self::with_client(Arc::new(GatewayClient::with_services(services)))
    }

    fn with_client(client: Arc<GatewayClient>) -> Self {
        let destroying = Arc::<AtomicBool>::default();
        Self {
            client,
            #[cfg(feature = "installation")]
            installation: nemoclaw_provider::GatewayInstallation::new(destroying.clone()),
            destroying,
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
        #[cfg_attr(
            not(feature = "installation"),
            expect(unused_mut, reason = "only the installation feature extends this map")
        )]
        let mut resources: HashMap<String, Box<dyn DynamicResource>> = crate::definitions()
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
            .collect();
        #[cfg(feature = "installation")]
        resources.extend(self.installation.resources());
        Some(resources)
    }

    fn get_data_sources(
        &self,
        _: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        #[cfg_attr(
            not(feature = "installation"),
            expect(unused_mut, reason = "only the installation feature extends this map")
        )]
        let mut sources = HashMap::from([(
            "gateway".into(),
            Box::new(GatewayDataSource(self.client.clone())) as Box<dyn DynamicDataSource>,
        )]);
        #[cfg(feature = "installation")]
        sources.extend(self.installation.data_sources());
        Some(sources)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_provider::value::Value;

    #[tokio::test]
    async fn reconfiguration_without_destroy_withdraws_teardown_permission() {
        let provider = OpenShellProvider::default();
        let permitted = GatewayConfig {
            destroy: Value::Value(true),
        };
        let mut diagnostics = Diagnostics::default();
        provider
            .configure(&mut diagnostics, String::new(), permitted)
            .await
            .unwrap();
        assert!(provider.destroying.load(Ordering::Acquire));
        provider
            .configure(&mut diagnostics, String::new(), GatewayConfig::default())
            .await
            .unwrap();
        assert!(!provider.destroying.load(Ordering::Acquire));
        assert!(diagnostics.errors.is_empty());
    }
}
