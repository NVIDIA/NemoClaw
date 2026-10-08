// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `openshell` OpenTofu provider: OpenShell objects and gateway reads.

use crate::{
    client::{GatewayClient, GatewaySettings, OpenShellBackend},
    gateway_source::GatewayDataSource,
};
use async_trait::async_trait;
use nemoclaw_tofu::{ResourceAdapter, StructuredAdapter};
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
    schema::{Attribute, AttributeConstraint, AttributeType, Block, Description, Schema},
    value::Value,
};

use nemoclaw_openshell::RESOURCE_TYPES;

#[derive(Default, Serialize, Deserialize)]
pub struct OpenShellProviderConfig {
    endpoint: Value<String>,
    credential_env: Value<String>,
    tls_ca_env: Value<String>,
    tls_certificate_env: Value<String>,
    tls_key_env: Value<String>,
    destroy: Value<bool>,
}

/// Serves workspaces, provider registrations and profiles, sandboxes, and the
/// gateway data source through one configured gateway.
#[derive(Default)]
pub struct OpenShellProvider {
    client: Arc<GatewayClient>,
    destroying: Arc<AtomicBool>,
}

#[async_trait]
impl Provider for OpenShellProvider {
    type Config<'a> = OpenShellProviderConfig;
    type MetaState<'a> = tf_provider::value::ValueEmpty;

    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let attribute = |attr_type, description: &str| Attribute {
            attr_type,
            constraint: AttributeConstraint::Optional,
            description: Description::plain(description.to_owned()),
            ..Default::default()
        };
        Some(Schema {
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
        })
    }

    async fn configure<'a>(
        &self,
        diags: &mut Diagnostics,
        _: String,
        config: OpenShellProviderConfig,
    ) -> Option<()> {
        // Reconfiguration must not retain a client or teardown permission from
        // an earlier configuration when inputs become unknown or invalid.
        self.destroying.store(false, Ordering::Release);
        let settings = GatewaySettings {
            endpoint: &config.endpoint,
            credential_env: &config.credential_env,
            tls_ca_env: &config.tls_ca_env,
            tls_certificate_env: &config.tls_certificate_env,
            tls_key_env: &config.tls_key_env,
        };
        let deferred = settings.unknown() || matches!(config.destroy, Value::Unknown);
        if let Err(error) = self.client.reset(deferred) {
            diags.root_error_short(error);
            return None;
        }
        if deferred {
            return Some(());
        }
        let connection = match settings.connection() {
            Ok(Some(connection)) => connection,
            Ok(None) => {
                if settings.credentials() || matches!(config.destroy, Value::Value(true)) {
                    diags.root_error_short("Gateway credentials and teardown require an endpoint");
                    return None;
                }
                return Some(());
            }
            Err(error) => {
                diags.root_error_short(error);
                return None;
            }
        };
        if let Err(error) = self.client.connect(&connection) {
            diags.root_error("Gateway connection", error);
            return None;
        }
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
