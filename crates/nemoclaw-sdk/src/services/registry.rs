// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Dispatch for service definitions and installer-owned resource backends.

use super::{
    ManagedOllama, OllamaProxy, ServiceRuntime,
    contract::{InstallPlan, InstallStage, Installer, RemovePlan, ResolvedInference},
    installers,
};
use crate::{
    ObservationError,
    backend::{Backend, Row},
    compile::{Generations, Target},
    config::{ConfigError, Document, Gateway, InferenceProvider, Service},
    state::StateBinding,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(
    Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(tag = "kind", rename_all = "camelCase")]
/// One explicitly supported managed container package.
pub enum ServiceDefinition {
    /// Managed Ollama daemon and selected model.
    Ollama(ManagedOllama),
    /// Managed authentication proxy for an external Ollama daemon and model.
    OllamaProxy(OllamaProxy),
    /// Managed vLLM runtime and immutable model snapshot.
    Vllm(Box<Service>),
}

/// OpenTofu schema behavior owned by a service installer resource.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceBehavior {
    pub computed_digest: bool,
    pub observed_running: bool,
    pub retained_storage: bool,
    pub runtime_process: bool,
}

/// Provider schema for one installer-owned OpenTofu resource.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ResourceSchema {
    pub kind: &'static str,
    pub fields: &'static [&'static str],
    pub mutable: &'static [&'static str],
}

pub fn resource_schemas() -> [ResourceSchema; 8] {
    [
        ResourceSchema {
            kind: "ollama_proxy_storage",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "bind_address",
                "upstream",
                "model",
                "digest",
            ],
            mutable: &[],
        },
        ResourceSchema {
            kind: "ollama_proxy",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "bind_address",
                "upstream",
                "model",
                "digest",
                "running",
            ],
            mutable: &["running"],
        },
        ResourceSchema {
            kind: "ollama_external_model",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "bind_address",
                "upstream",
                "model",
                "digest",
            ],
            mutable: &[],
        },
        ResourceSchema {
            kind: "ollama_storage",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "network",
                "bind_address",
            ],
            mutable: &[],
        },
        ResourceSchema {
            kind: "ollama",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "network",
                "bind_address",
                "running",
            ],
            mutable: &["running"],
        },
        ResourceSchema {
            kind: "ollama_model",
            fields: &["engine", "service_id", "endpoint", "model"],
            mutable: &["model"],
        },
        ResourceSchema {
            kind: crate::managed::SERVICE_KIND,
            fields: &["spec", "running"],
            mutable: &["running"],
        },
        ResourceSchema {
            kind: crate::managed::STORAGE_KIND,
            fields: &["spec"],
            mutable: &[],
        },
    ]
}

pub fn resource_behavior(kind: &str) -> ResourceBehavior {
    ResourceBehavior {
        computed_digest: kind == "ollama_model",
        observed_running: kind == crate::managed::SERVICE_KIND,
        retained_storage: kind == crate::managed::STORAGE_KIND,
        runtime_process: kind == crate::managed::SERVICE_KIND,
    }
}

enum RegisteredInstaller<'a> {
    Ollama(&'a ManagedOllama),
    OllamaProxy(&'a OllamaProxy),
    Vllm(&'a Service),
}

impl<'a> RegisteredInstaller<'a> {
    fn from_definition(definition: &'a ServiceDefinition) -> Self {
        match definition {
            ServiceDefinition::Ollama(service) => Self::Ollama(service),
            ServiceDefinition::OllamaProxy(service) => Self::OllamaProxy(service),
            ServiceDefinition::Vllm(service) => Self::Vllm(service),
        }
    }

    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, crate::Error> {
        match self {
            Self::Ollama(service) => service.install(document, name, generations),
            Self::OllamaProxy(service) => service.install(document, name, generations),
            Self::Vllm(service) => service.install(document, name, generations),
        }
    }

    fn stage(&self) -> InstallStage {
        match self {
            Self::Ollama(_) | Self::OllamaProxy(_) => InstallStage::Deployment,
            Self::Vllm(_) => InstallStage::Runtime,
        }
    }

    async fn check_running(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
        connections: &crate::docker::Connections,
        bindings: &BTreeMap<String, StateBinding>,
        cancel: &crate::CancellationToken,
    ) -> Result<ResolvedInference, crate::Error> {
        match self {
            Self::Ollama(service) => {
                service
                    .check_running(document, name, generations, connections, bindings, cancel)
                    .await
            }
            Self::OllamaProxy(service) => {
                service
                    .check_running(document, name, generations, connections, bindings, cancel)
                    .await
            }
            Self::Vllm(service) => {
                service
                    .check_running(document, name, generations, connections, bindings, cancel)
                    .await
            }
        }
    }

    fn remove(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<RemovePlan, crate::Error> {
        match self {
            Self::Ollama(service) => service.remove(document, name, generations),
            Self::OllamaProxy(service) => service.remove(document, name, generations),
            Self::Vllm(service) => service.remove(document, name, generations),
        }
    }

    fn resolve(&self, document: &Document, name: &str) -> Result<ResolvedInference, ConfigError> {
        Ok(match self {
            Self::Ollama(service) => ResolvedInference {
                name: name.into(),
                endpoint: service.endpoint.clone(),
                served_model: service.model.name.clone(),
                authentication: None,
                ready_after: vec![format!("nemoclaw_ollama_model.{name}")],
                resource_dependencies: vec![format!("nemoclaw_ollama_model.{name}")],
            },
            Self::OllamaProxy(service) => ResolvedInference {
                name: name.into(),
                endpoint: service.endpoint.clone(),
                served_model: service.upstream.model.name.clone(),
                authentication: Some(String::new()),
                ready_after: vec![format!("nemoclaw_ollama_proxy.{name}")],
                resource_dependencies: vec![format!("nemoclaw_ollama_proxy.{name}")],
            },
            Self::Vllm(service) => ResolvedInference {
                name: name.into(),
                endpoint: match &service.publication {
                    Some(publication) => publication.endpoint.clone(),
                    None => format!(
                        "http://{}:{}/v1",
                        document.spec.gateway.bridge()?,
                        service.serving.port
                    ),
                },
                served_model: service.served_model().into(),
                authentication: service.authentication.as_ref().map(|_| String::new()),
                ready_after: vec![format!("nemoclaw_inference_service.inference_{name}")],
                resource_dependencies: Vec::new(),
            },
        })
    }

    fn validate_definition(&self) -> Result<(), ConfigError> {
        match self {
            Self::Ollama(service) => service.validate(),
            Self::OllamaProxy(service) => service.validate_definition(),
            Self::Vllm(service) => service.validate(),
        }
    }

    fn validate_provider(&self, gateway: &Gateway) -> Result<(), ConfigError> {
        if let Self::Vllm(service) = self {
            crate::config::validation::require(
                (gateway.management == "managed"
                    && service.placement.is_none()
                    && service.runtime.engine == gateway.engine)
                    || service.placement.is_some(),
                "vLLM requires the managed gateway Docker engine or explicit placement",
            )?;
        }
        Ok(())
    }

    fn validate_route(
        &self,
        provider: &InferenceProvider,
        sandbox_runtime: &str,
        harness: &str,
        model: &str,
    ) -> Result<(), ConfigError> {
        match self {
            Self::Ollama(_) => Ok(()),
            Self::OllamaProxy(service) => service.validate(provider, model, harness),
            Self::Vllm(service) => crate::config::validation::require(
                sandbox_runtime == "docker" || service.placement.is_some(),
                "vLLM service requires compatible sandbox placement",
            ),
        }
    }

    fn allocation(&self, gateway: &Gateway) -> Result<Option<NetworkAllocation>, ConfigError> {
        let Self::Vllm(service) = self else {
            return Ok(None);
        };
        Ok(Some(NetworkAllocation {
            engine: service.runtime.engine.clone(),
            network_cidr: service
                .placement
                .as_ref()
                .map_or(gateway.network_cidr.as_str(), |placement| {
                    placement.network_cidr.as_str()
                })
                .into(),
            bind_address: service.publication.as_ref().map_or_else(
                || gateway.bridge(),
                |publication| Ok(publication.bind_address.clone()),
            )?,
            port: service.serving.port,
        }))
    }
}

struct NetworkAllocation {
    engine: String,
    network_cidr: String,
    bind_address: String,
    port: i64,
}

impl ServiceDefinition {
    pub fn runtime(&self) -> &ServiceRuntime {
        match self {
            Self::Ollama(service) => &service.runtime,
            Self::OllamaProxy(service) => &service.runtime,
            Self::Vllm(service) => &service.runtime,
        }
    }
}

pub(crate) fn defaults(definition: &mut ServiceDefinition) {
    let runtime = match definition {
        ServiceDefinition::Ollama(service) => &mut service.runtime,
        ServiceDefinition::OllamaProxy(service) => &mut service.runtime,
        ServiceDefinition::Vllm(service) => {
            service.defaults();
            &mut service.runtime
        }
    };
    if runtime.provider.is_empty() {
        runtime.provider = "docker".into();
    }
}

fn definition<'a>(
    document: &'a Document,
    provider: &InferenceProvider,
) -> Result<Option<(&'a str, &'a ServiceDefinition)>, ConfigError> {
    let Some(name) = provider.service_ref.as_deref() else {
        return Ok(None);
    };
    document
        .spec
        .services
        .get_key_value(name)
        .map(|(name, definition)| Some((name.as_str(), definition)))
        .ok_or_else(|| {
            crate::config::references::missing_reference(
                "inferenceProviders[].serviceRef",
                "service",
                name,
                document.spec.services.keys().map(String::as_str),
            )
        })
}

pub(crate) fn resolve(
    document: &Document,
    provider: &InferenceProvider,
) -> Result<Option<ResolvedInference>, ConfigError> {
    let Some((name, definition)) = definition(document, provider)? else {
        return Ok(None);
    };
    RegisteredInstaller::from_definition(definition)
        .resolve(document, name)
        .map(Some)
}

pub(crate) fn provider_authenticated(
    document: &Document,
    provider: &InferenceProvider,
) -> Result<bool, ConfigError> {
    Ok(provider.credential.is_some()
        || resolve(document, provider)?.is_some_and(|service| service.authentication.is_some()))
}

pub(crate) fn selected(
    document: &Document,
) -> Result<Vec<(&str, &ServiceDefinition)>, ConfigError> {
    let mut selected = BTreeMap::new();
    for provider in document.selected_inference_providers()? {
        if let Some((name, definition)) = definition(document, provider)? {
            selected.insert(name, definition);
        }
    }
    Ok(selected.into_iter().collect())
}

fn plans(
    document: &Document,
    generations: &Generations,
    stage: InstallStage,
) -> Result<Vec<InstallPlan>, crate::Error> {
    selected(document)?
        .into_iter()
        .filter(|(_, definition)| RegisteredInstaller::from_definition(definition).stage() == stage)
        .map(|(name, definition)| {
            RegisteredInstaller::from_definition(definition).install(document, name, generations)
        })
        .collect()
}

pub(crate) fn has_runtime(document: &Document) -> Result<bool, ConfigError> {
    Ok(selected(document)?
        .into_iter()
        .any(|(_, definition)| matches!(definition, ServiceDefinition::Vllm(_))))
}

pub(crate) fn validate(document: &Document) -> Result<(), ConfigError> {
    use crate::config::validation::{SLUG, require};
    for (name, definition) in &document.spec.services {
        require(SLUG.is_match(name), "service names must be lowercase slugs")?;
        RegisteredInstaller::from_definition(definition).validate_definition()?;
    }
    let gateway = &document.spec.gateway;
    let mut publications = BTreeSet::new();
    let mut networks = BTreeMap::new();
    if gateway.management == "managed" {
        networks.insert(gateway.engine.clone(), gateway.network_cidr.clone());
    }
    for (_, definition) in selected(document)? {
        let installer = RegisteredInstaller::from_definition(definition);
        let Some(allocation) = installer.allocation(gateway)? else {
            continue;
        };
        require(
            networks
                .insert(allocation.engine.clone(), allocation.network_cidr.clone())
                .is_none_or(|previous| previous == allocation.network_cidr),
            "managed services sharing an engine must use the same network CIDR",
        )?;
        require(
            publications.insert((allocation.engine, allocation.bind_address, allocation.port)),
            "managed inference publication addresses must be distinct on each engine",
        )?;
    }
    Ok(())
}

pub(crate) fn validate_provider(
    document: &Document,
    provider: &InferenceProvider,
    gateway: &Gateway,
) -> Result<bool, ConfigError> {
    use crate::config::validation::require;
    let Some((_, definition)) = definition(document, provider)? else {
        return Ok(false);
    };
    require(
        provider.endpoint.is_empty() && provider.credential.is_none(),
        "serviceRef excludes endpoint and external credentials",
    )?;
    RegisteredInstaller::from_definition(definition).validate_provider(gateway)?;
    require(
        provider.provider == "openai",
        "managed services require the OpenAI provider implementation",
    )?;
    Ok(true)
}

pub(crate) fn validate_route(
    document: &Document,
    provider: &InferenceProvider,
    sandbox_runtime: &str,
    harness: &str,
    model: &str,
) -> Result<(), ConfigError> {
    use crate::config::validation::require;
    let Some((_, definition)) = definition(document, provider)? else {
        return Ok(());
    };
    let resolved = RegisteredInstaller::from_definition(definition).resolve(
        document,
        provider.service_ref.as_deref().unwrap_or_default(),
    )?;
    require(
        model == resolved.served_model,
        "service requires its declared served model",
    )?;
    RegisteredInstaller::from_definition(definition).validate_route(
        provider,
        sandbox_runtime,
        harness,
        model,
    )
}

pub(crate) fn runtime_targets(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<Target>, crate::Error> {
    Ok(plans(document, generations, InstallStage::Runtime)?
        .into_iter()
        .flat_map(|plan| plan.targets)
        .collect())
}

pub(crate) fn deployment_targets(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<Target>, ConfigError> {
    Ok(plans(document, generations, InstallStage::Deployment)
        .map_err(|_| ConfigError::new("invalid service install plan"))?
        .into_iter()
        .flat_map(|plan| plan.targets)
        .collect())
}

pub(crate) fn dependencies(
    document: &Document,
    generations: &Generations,
    stage: InstallStage,
    address: &str,
) -> Result<Option<Vec<String>>, ConfigError> {
    Ok(plans(document, generations, stage)
        .map_err(|_| ConfigError::new("invalid service install plan"))?
        .into_iter()
        .find_map(|plan| plan.dependencies.get(address).cloned()))
}

pub(crate) fn credential_source_json(
    document: &Document,
    provider: &InferenceProvider,
    generations: &Generations,
) -> Result<Option<String>, ConfigError> {
    let Some((name, definition)) = definition(document, provider)? else {
        return Ok(None);
    };
    let installer = RegisteredInstaller::from_definition(definition);
    if installer.resolve(document, name)?.authentication.is_none() {
        return Ok(None);
    }
    Ok(installer
        .install(document, name, generations)
        .map_err(|_| ConfigError::new("invalid managed credential source"))?
        .inference
        .authentication)
}

pub(crate) fn generation_kinds(document: &Document) -> Result<Vec<&'static str>, ConfigError> {
    let mut kinds = BTreeSet::new();
    for (_, definition) in selected(document)? {
        match definition {
            ServiceDefinition::Ollama(_) | ServiceDefinition::OllamaProxy(_) => {
                kinds.insert("ollama");
            }
            ServiceDefinition::Vllm(_) => {
                kinds.insert(crate::managed::SERVICE_KIND);
            }
        }
    }
    Ok(kinds.into_iter().collect())
}

pub(crate) fn remove_plans(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<RemovePlan>, crate::Error> {
    selected(document)?
        .into_iter()
        .map(|(name, definition)| {
            RegisteredInstaller::from_definition(definition).remove(document, name, generations)
        })
        .collect()
}

pub(crate) fn required_storage_address(
    document: &Document,
    generations: &Generations,
    process: &str,
) -> Result<Option<String>, crate::Error> {
    Ok(remove_plans(document, generations)?
        .into_iter()
        .flat_map(|plan| plan.required_storage)
        .find_map(|(candidate, storage)| (candidate == process).then_some(storage)))
}

/// Opaque vLLM capacity input retained by the registry between per-runtime and
/// combined-engine checks. Generic deployment code never inspects its package.
pub(crate) struct RuntimeCapacity {
    engine: String,
    service: Service,
    starting: bool,
}

pub(crate) async fn check_runtime_capacity(
    engine: &crate::docker::Engine,
    spec: &crate::managed::Spec,
    observed: Option<&crate::managed::RuntimeObservation>,
) -> Result<Option<RuntimeCapacity>, crate::Error> {
    let Some(service) = &spec.service else {
        return Ok(None);
    };
    engine.check_capacity(spec, observed).await?;
    Ok(Some(RuntimeCapacity {
        engine: spec.engine().into(),
        service: service.clone(),
        starting: observed.is_none_or(|runtime| !runtime.running),
    }))
}

pub(crate) async fn check_combined_capacity(
    connections: &crate::docker::Connections,
    checks: Vec<RuntimeCapacity>,
) -> Result<(), crate::Error> {
    let mut grouped: BTreeMap<String, Vec<(Service, bool)>> = BTreeMap::new();
    for check in checks {
        grouped
            .entry(check.engine)
            .or_default()
            .push((check.service, check.starting));
    }
    for (endpoint, services) in grouped {
        if services.len() < 2 {
            continue;
        }
        let engine = connections.resolve(&endpoint)?;
        let host = tokio::time::timeout(
            std::time::Duration::from_secs(30),
            engine.host_observer.observe(&engine),
        )
        .await
        .map_err(|_| crate::Error::State("combined capacity observation timed out"))??;
        let info = engine.info().await?;
        let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
        let services: Vec<_> = services
            .iter()
            .map(|(service, starting)| (service, *starting))
            .collect();
        crate::hardware::check_service_budgets(&services, &capacity)?;
    }
    Ok(())
}

pub(crate) async fn check_running(
    document: &Document,
    generations: &Generations,
    stage: InstallStage,
    connections: &crate::docker::Connections,
    bindings: &BTreeMap<String, StateBinding>,
    cancel: &crate::CancellationToken,
) -> Result<Vec<ResolvedInference>, crate::Error> {
    let mut result = Vec::new();
    for (name, definition) in selected(document)? {
        let installer = RegisteredInstaller::from_definition(definition);
        if installer.install(document, name, generations)?.stage == stage {
            result.push(
                installer
                    .check_running(document, name, generations, connections, bindings, cancel)
                    .await?,
            );
        }
    }
    Ok(result)
}

/// Resolves a provider resource row to its package-owned backend.
pub struct BackendRegistry<'a> {
    connections: &'a crate::docker::Connections,
}

impl<'a> BackendRegistry<'a> {
    pub fn new(connections: &'a crate::docker::Connections) -> Self {
        Self { connections }
    }

    pub fn resolve(
        &self,
        kind: &str,
        row: &Row,
    ) -> Result<Option<RegisteredBackend>, ObservationError> {
        if crate::managed::ManagedBackend::supports(kind) {
            let engine = crate::managed::runtime_engine(self.connections, kind, row)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(RegisteredBackend(Box::new(
                crate::managed::ManagedBackend::new(engine),
            ))));
        }
        if installers::ollama::OllamaBackend::supports(kind) {
            let endpoint = row
                .get("engine")
                .filter(|endpoint| !endpoint.is_empty())
                .ok_or(ObservationError::Incomplete)?;
            let engine = self
                .connections
                .resolve(endpoint)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(RegisteredBackend(Box::new(
                installers::ollama::OllamaBackend::new(engine),
            ))));
        }
        Ok(None)
    }
}

pub struct RegisteredBackend(Box<dyn Backend>);

#[async_trait::async_trait]
impl Backend for RegisteredBackend {
    async fn read(
        &self,
        kind: &str,
        prior: &Row,
        removing: bool,
    ) -> Result<Option<Row>, ObservationError> {
        self.0.read(kind, prior, removing).await
    }

    async fn ensure(&self, kind: &str, desired: &Row) -> crate::backend::Mutation {
        self.0.ensure(kind, desired).await
    }

    async fn remove(
        &self,
        kind: &str,
        prior: &Row,
        destroying: bool,
    ) -> Result<(), ObservationError> {
        self.0.remove(kind, prior, destroying).await
    }
}
