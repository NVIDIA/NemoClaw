// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The `fabric` provider's configuration, resources, and data sources.

use crate::{AgentBackend, FabricCapabilitiesDataSource, FabricHarnessDataSource};
use async_trait::async_trait;
use nemoclaw_backend::{Backend, Error, Mutation, ObservationError, Row};
use nemoclaw_tofu::{ResourceAdapter, StructuredAdapter};
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
        AgentBackend(self.0.planning_client(desired).await?)
            .plan(kind, desired, prior)
            .await
    }
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        AgentBackend(self.0.client_for(prior).await?)
            .read(kind, prior, removing)
            .await
    }
    async fn ensure(&self, kind: &str, desired: &Row) -> Mutation {
        match self.0.client_for(desired).await {
            Ok(client) => AgentBackend(client).ensure(kind, desired).await,
            Err(error) => Mutation::failed(error),
        }
    }
    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        AgentBackend(self.0.client_for(prior).await?)
            .remove(kind, prior, destroying)
            .await
    }
}

/// Serves agent configuration and sandbox readiness through one configured
/// gateway, and Fabric image capabilities through the engine each read names.
#[derive(Default)]
pub struct FabricProvider {
    client: Arc<GatewayClient>,
    destroying: Arc<AtomicBool>,
}

impl FabricProvider {
    /// Observe sandbox parents with the deployment's credential checks.
    pub fn with_services(services: Arc<dyn openshell_provider::Services>) -> Self {
        Self {
            client: Arc::new(GatewayClient::with_services(services)),
            destroying: Arc::default(),
        }
    }
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
        let backend = Arc::new(FabricBackend(self.client.clone()));
        Some(
            crate::definitions()
                .into_iter()
                .map(|definition| {
                    let name = definition.kind.to_owned();
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
        Some(HashMap::from([
            (
                "harnesses".into(),
                Box::new(FabricCapabilitiesDataSource::default()) as Box<dyn DynamicDataSource>,
            ),
            (
                "harness".into(),
                Box::new(FabricHarnessDataSource::default()) as Box<dyn DynamicDataSource>,
            ),
        ]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tf_provider::value::Value;

    #[tokio::test]
    async fn reconfiguration_without_destroy_withdraws_teardown_permission() {
        let provider = FabricProvider::default();
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
    }

    const FIXTURE_SOURCE: &str = "fixture-credential-source";

    /// Accepts only the fixture credential source and counts validations.
    /// Docker credentials reject that source, so a provider that drops the
    /// injected services fails to observe the registration.
    #[derive(Default)]
    struct FixtureServices {
        validations: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl openshell_provider::Services for FixtureServices {
        fn validate_credential_source(
            &self,
            source: &str,
            _: &str,
            _: &str,
        ) -> Result<(), ObservationError> {
            self.validations.fetch_add(1, Ordering::SeqCst);
            if source == FIXTURE_SOURCE {
                Ok(())
            } else {
                Err(ObservationError::BindingMismatch)
            }
        }

        async fn resolve_credential_source(
            &self,
            source: &str,
            _: &str,
            _: &str,
        ) -> Result<String, ObservationError> {
            if source == FIXTURE_SOURCE {
                Ok("fixture-secret".into())
            } else {
                Err(ObservationError::BindingMismatch)
            }
        }

        fn validate_cluster_source(&self, _: &Row) -> Result<(), ObservationError> {
            Err(ObservationError::BindingMismatch)
        }

        async fn cluster_addresses(
            &self,
            _: &Row,
        ) -> Result<Vec<std::net::IpAddr>, ObservationError> {
            Err(ObservationError::BindingMismatch)
        }
    }

    #[tokio::test]
    async fn configured_provider_observes_registrations_through_its_injected_services() {
        use nemoclaw_test_fixtures::openshell::{Fixture, contract_rows};

        let fixture = Fixture::start().await;
        let services = Arc::new(FixtureServices::default());
        let creator = GatewayClient::with_services(services.clone());
        let creator = creator
            .connect(&openshell_provider::GatewayConnection::Direct(
                nemoclaw_openshell::Connection {
                    endpoint: fixture.endpoint.clone(),
                    ..Default::default()
                },
            ))
            .await
            .unwrap();
        let rows = contract_rows("fabric-openclaw");
        let row = |kind: &str| {
            rows.iter()
                .find(|(name, _)| *name == kind)
                .unwrap()
                .1
                .clone()
        };
        let mut profile = row("provider_profile");
        profile.insert("authenticated".into(), "true".into());
        let mut registration = row("provider");
        registration.insert("credential_source".into(), FIXTURE_SOURCE.into());
        let mut saved = None;
        for (kind, desired) in [
            ("workspace", row("workspace")),
            ("provider_profile", profile),
            ("provider", registration),
        ] {
            let created = creator.ensure(kind, &desired).await;
            assert!(created.error().is_none(), "{kind}: {:?}", created.error());
            saved = created.into_parts().0;
        }
        let saved = saved.unwrap();

        let provider = FabricProvider::with_services(services.clone());
        let mut diagnostics = Diagnostics::default();
        let config = GatewayConfig::default();
        provider
            .configure(&mut diagnostics, String::new(), config)
            .await
            .unwrap();
        assert!(diagnostics.errors.is_empty());
        let before = services.validations.load(Ordering::SeqCst);
        // Fabric resources and data sources observe sandbox parents through
        // this client, so it must keep the injected credential checks.
        let observed = provider
            .client
            .client_for(&[("gateway_endpoint".to_owned(), fixture.endpoint.clone())].into())
            .await
            .unwrap()
            .read("provider", &saved, false)
            .await;
        assert_eq!(observed, Ok(Some(saved)));
        assert!(services.validations.load(Ordering::SeqCst) > before);
    }

    /// Accepts every cluster source, reports one Service address, and counts
    /// both calls. The test uses no credential source, so those methods fail.
    #[derive(Default)]
    struct ClusterServices {
        validations: std::sync::atomic::AtomicUsize,
        address_reads: std::sync::atomic::AtomicUsize,
    }

    #[async_trait]
    impl openshell_provider::Services for ClusterServices {
        fn validate_credential_source(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<(), ObservationError> {
            Err(ObservationError::Incomplete)
        }

        async fn resolve_credential_source(
            &self,
            _: &str,
            _: &str,
            _: &str,
        ) -> Result<String, ObservationError> {
            Err(ObservationError::Incomplete)
        }

        fn validate_cluster_source(&self, _: &Row) -> Result<(), ObservationError> {
            self.validations.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }

        async fn cluster_addresses(
            &self,
            _: &Row,
        ) -> Result<Vec<std::net::IpAddr>, ObservationError> {
            self.address_reads.fetch_add(1, Ordering::SeqCst);
            Ok(vec!["10.96.0.23".parse().unwrap()])
        }
    }

    #[tokio::test]
    async fn configured_provider_observes_cluster_grants_through_its_injected_services() {
        use nemoclaw_test_fixtures::openshell::{Fixture, contract_rows};

        let fixture = Fixture::start().await;
        let services = Arc::new(ClusterServices::default());
        let creator = GatewayClient::with_services(services.clone());
        let creator = creator
            .connect(&openshell_provider::GatewayConnection::Direct(
                nemoclaw_openshell::Connection {
                    endpoint: fixture.endpoint.clone(),
                    ..Default::default()
                },
            ))
            .await
            .unwrap();
        let rows = contract_rows("fabric-openclaw");
        let row = |kind: &str| {
            rows.iter()
                .find(|(name, _)| *name == kind)
                .unwrap()
                .1
                .clone()
        };
        let mut profile = row("provider_profile");
        profile.insert(
            "endpoint".into(),
            "http://model.agents.svc.cluster.local:8000/v1".into(),
        );
        profile.insert("cluster_source".into(), "fixture-cluster-source".into());
        let mut saved = None;
        for (kind, desired) in [
            ("workspace", row("workspace")),
            ("provider_profile", profile),
        ] {
            let created = creator.ensure(kind, &desired).await;
            assert!(created.error().is_none(), "{kind}: {:?}", created.error());
            saved = created.into_parts().0;
        }
        let saved = saved.unwrap();

        let provider = FabricProvider::with_services(services.clone());
        let mut diagnostics = Diagnostics::default();
        let config = GatewayConfig::default();
        provider
            .configure(&mut diagnostics, String::new(), config)
            .await
            .unwrap();
        assert!(diagnostics.errors.is_empty());
        let calls = || {
            (
                services.validations.load(Ordering::SeqCst),
                services.address_reads.load(Ordering::SeqCst),
            )
        };
        let before = calls();
        // Fabric resources and data sources observe sandbox parents through
        // this client, so it must keep the injected cluster checks.
        let observed = provider
            .client
            .client_for(&[("gateway_endpoint".to_owned(), fixture.endpoint.clone())].into())
            .await
            .unwrap()
            .read("provider_profile", &saved, false)
            .await;
        assert_eq!(observed, Ok(Some(saved)));
        let after = calls();
        assert!(
            after.0 > before.0 && after.1 > before.1,
            "{before:?} {after:?}"
        );
    }
}
