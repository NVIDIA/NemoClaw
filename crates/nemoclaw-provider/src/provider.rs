// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{Backend, Definition, Mutation, ResourceAdapter, Row};
use async_trait::async_trait;
use nemoclaw_sdk::{
    ObservationError,
    config::{Credential, Gateway, TLS},
    docker::Connections,
    openshell::{EnvironmentSecrets, OpenShell},
    services::BackendRegistry,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};
use tf_provider::{
    Diagnostics, DynamicResource, Provider,
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
}
fn text(value: Value<String>) -> String {
    match value {
        Value::Value(v) => v,
        _ => String::new(),
    }
}
#[derive(Default)]
struct ConfiguredBackend(RwLock<Option<OpenShell>>, Connections);
impl ConfiguredBackend {
    fn client(&self) -> Result<OpenShell, ObservationError> {
        self.0
            .read()
            .map_err(|_| ObservationError::Query)?
            .clone()
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
        if let Some(backend) = BackendRegistry::new(&self.1).resolve(kind, desired)? {
            backend.plan(kind, desired, prior).await?;
        }
        Ok(())
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
        match BackendRegistry::new(&self.1).resolve(kind, desired) {
            Ok(Some(backend)) => return backend.ensure(kind, desired).await,
            Err(error) => return Mutation::failed(error),
            Ok(None) => {}
        }
        match self.client() {
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
    fn schema(&self, _: &mut Diagnostics) -> Option<Schema> {
        let mut attributes = HashMap::new();
        for name in [
            "endpoint",
            "credential_env",
            "tls_ca_env",
            "tls_certificate_env",
            "tls_key_env",
            "destroy",
        ] {
            attributes.insert(
                name.into(),
                Attribute {
                    attr_type: if name == "destroy" {
                        AttributeType::Bool
                    } else {
                        AttributeType::String
                    },
                    constraint: if name == "endpoint" {
                        AttributeConstraint::Required
                    } else {
                        AttributeConstraint::Optional
                    },
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
        let mut gateway = Gateway {
            management: "external".into(),
            endpoint: text(config.endpoint),
            ..Default::default()
        };
        let credential = text(config.credential_env);
        if !credential.is_empty() {
            gateway.credential = Some(Credential { env: credential });
        }
        let ca = text(config.tls_ca_env);
        let certificate = text(config.tls_certificate_env);
        let key = text(config.tls_key_env);
        if !ca.is_empty() || !certificate.is_empty() || !key.is_empty() {
            if ca.is_empty() || certificate.is_empty() || key.is_empty() {
                diags.root_error_short("Incomplete TLS credential references");
                return None;
            }
            gateway.tls = Some(TLS {
                ca: Credential { env: ca },
                certificate: Credential { env: certificate },
                key: Credential { env: key },
            });
        }
        match OpenShell::connect(&gateway, Arc::new(EnvironmentSecrets)) {
            Ok(client) => {
                match self.backend.0.write() {
                    Ok(mut slot) => *slot = Some(client),
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
        let mut definitions: Vec<_> = nemoclaw_sdk::services::resource_schemas()
            .into_iter()
            .map(|schema| Definition::new(schema.kind, schema.fields, schema.mutable))
            .collect();
        definitions.extend([
            Definition::new(
                "managed_gateway",
                &["spec", "running", "image_pull_policy"],
                &["running", "image_pull_policy"],
            ),
            Definition::new(
                "gateway_storage",
                &["spec", "image_pull_policy"],
                &["image_pull_policy"],
            ),
            Definition::new(
                "provider_profile",
                &[
                    "workspace",
                    "name",
                    "owner",
                    "generation",
                    "endpoint",
                    "provider_type",
                    "authenticated",
                ],
                &[],
            ),
            Definition::new("workspace", &["name", "owner", "generation"], &[]),
            Definition::new(
                "provider",
                &[
                    "workspace",
                    "name",
                    "owner",
                    "generation",
                    "endpoint",
                    "credential_env",
                    "provider_type",
                    "credential_source",
                ],
                &["endpoint", "credential_env"],
            ),
            Definition::new(
                "sandbox",
                &[
                    "workspace",
                    "name",
                    "owner",
                    "generation",
                    "image",
                    "agent_name",
                    "agent_runtime",
                    "policy_json",
                    "proxy_host",
                    "proxy_port",
                    "inference_json",
                ],
                &[],
            ),
        ]);
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
