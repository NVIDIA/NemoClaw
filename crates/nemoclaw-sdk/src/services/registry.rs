// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Dispatch for service definitions and installer-owned resource backends.

use super::{
    ManagedOllama, OllamaProxy,
    contract::{InstallPlan, InstallStage, Installer, RemovePlan},
    installers,
};
use crate::{
    ObservationError,
    backend::{Backend, Row},
    compile::{Generations, Target},
    config::{ConfigError, Document, Gateway, InferenceProvider},
    state::StateBinding,
};
use std::collections::{BTreeMap, BTreeSet};

/// Inference-specific connection data produced by the service registry.
///
/// This is deliberately separate from the installer lifecycle contract: a
/// managed service need not be an inference server.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ResolvedInference {
    pub endpoint: String,
    pub served_model: String,
    pub requires_authentication: bool,
    pub resource_dependencies: Vec<String>,
}

#[derive(
    Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize, schemars::JsonSchema,
)]
#[serde(tag = "kind", rename_all = "camelCase")]
/// One explicitly supported managed container package.
pub enum ServiceDefinition {
    /// Managed Ollama daemon and selected model.
    Ollama(Box<ManagedOllama>),
    /// Managed authentication proxy for an external Ollama daemon and model.
    OllamaProxy(OllamaProxy),
    /// Managed vLLM runtime and immutable model snapshot.
    Vllm(Box<installers::vllm::Service>),
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

pub fn resource_schemas() -> Vec<ResourceSchema> {
    vec![
        ResourceSchema {
            kind: "ollama_proxy_storage",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "image_pull_policy",
                "bind_address",
                "upstream",
                "model",
                "digest",
            ],
            mutable: &["image_pull_policy"],
        },
        ResourceSchema {
            kind: "ollama_proxy",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "image_pull_policy",
                "bind_address",
                "upstream",
                "model",
                "digest",
                "running",
            ],
            mutable: &["running", "image_pull_policy"],
        },
        ResourceSchema {
            kind: "ollama_external_model",
            fields: &[
                "name",
                "owner",
                "generation",
                "engine",
                "image",
                "image_pull_policy",
                "bind_address",
                "upstream",
                "model",
                "digest",
            ],
            mutable: &["image_pull_policy"],
        },
        ResourceSchema {
            kind: installers::ollama::SERVICE_KIND,
            fields: &["spec", "running", "image_pull_policy"],
            mutable: &["running", "image_pull_policy"],
        },
        ResourceSchema {
            kind: installers::ollama::STORAGE_KIND,
            fields: &["spec"],
            mutable: &[],
        },
        ResourceSchema {
            kind: installers::vllm::SERVICE_KIND,
            fields: &["spec", "running", "image_pull_policy"],
            mutable: &["running", "image_pull_policy"],
        },
        ResourceSchema {
            kind: installers::vllm::STORAGE_KIND,
            fields: &["spec"],
            mutable: &[],
        },
    ]
}

pub fn resource_behavior(kind: &str) -> ResourceBehavior {
    ResourceBehavior {
        computed_digest: false,
        observed_running: matches!(
            kind,
            installers::ollama::SERVICE_KIND | installers::vllm::SERVICE_KIND
        ),
        retained_storage: matches!(
            kind,
            installers::ollama::STORAGE_KIND | installers::vllm::STORAGE_KIND
        ),
        runtime_process: matches!(
            kind,
            installers::ollama::SERVICE_KIND | installers::vllm::SERVICE_KIND
        ),
    }
}

pub(crate) fn resource_label(kind: &str) -> Option<&'static str> {
    match kind {
        installers::vllm::SERVICE_KIND => Some("inference service"),
        installers::ollama::SERVICE_KIND => Some("Ollama service"),
        "ollama_proxy" => Some("Ollama proxy"),
        _ => None,
    }
}

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, serde_json::Value>) {
    installers::ollama::constrain_schema(defs);
    installers::vllm::schema::constrain(defs);
}

trait InferenceCapability {
    fn resolve(&self, document: &Document, name: &str) -> Result<ResolvedInference, ConfigError>;

    fn validate_route(
        &self,
        provider: &InferenceProvider,
        sandbox_runtime: &str,
        harness: &str,
        model: &str,
    ) -> Result<(), ConfigError>;

    fn credential_source(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<Option<String>, crate::Error>;
}

impl ServiceDefinition {
    fn stage(&self) -> InstallStage {
        match self {
            Self::Ollama(_) | Self::Vllm(_) => InstallStage::Runtime,
            Self::OllamaProxy(_) => InstallStage::Deployment,
        }
    }

    fn inference(&self) -> Option<&dyn InferenceCapability> {
        match self {
            Self::Ollama(_) | Self::OllamaProxy(_) | Self::Vllm(_) => Some(self),
        }
    }

    fn validate_definition(&self) -> Result<(), ConfigError> {
        match self {
            Self::Ollama(service) => service.validate(),
            Self::OllamaProxy(service) => service.validate_definition(),
            Self::Vllm(service) => service.validate(),
        }
    }

    fn validate_installation(&self, gateway: &Gateway) -> Result<(), ConfigError> {
        let (placement, package) = match self {
            Self::Ollama(service) => (service.placement.as_ref(), "Ollama"),
            Self::Vllm(service) => (service.placement.as_ref(), "vLLM"),
            Self::OllamaProxy(_) => {
                return crate::config::validation::require(
                    gateway.management == "managed"
                        && gateway.engine.starts_with("unix:///")
                        && crate::docker::Engine::validate_endpoint(&gateway.engine).is_ok(),
                    "Ollama proxy requires a managed local Docker gateway",
                );
            }
        };
        crate::config::validation::require(
            placement.is_some()
                || (gateway.management == "managed"
                    && gateway.engine.starts_with("unix:///")
                    && crate::docker::Engine::validate_endpoint(&gateway.engine).is_ok()),
            if package == "Ollama" {
                "Ollama requires the managed gateway Docker engine or explicit placement"
            } else {
                "vLLM requires the managed gateway Docker engine or explicit placement"
            },
        )?;
        Ok(())
    }

    fn allocation(&self, gateway: &Gateway) -> Result<Option<NetworkAllocation>, ConfigError> {
        let (placement, publication, port) = match self {
            Self::Ollama(service) => (
                &service.placement,
                &service.publication,
                service.serving.port,
            ),
            Self::Vllm(service) => (
                &service.placement,
                &service.publication,
                service.serving.port,
            ),
            Self::OllamaProxy(_) => return Ok(None),
        };
        Ok(Some(NetworkAllocation {
            engine: placement
                .as_ref()
                .map_or(gateway.engine.clone(), |placement| placement.engine.clone()),
            network_cidr: placement
                .as_ref()
                .map_or(gateway.network_cidr.as_str(), |placement| {
                    placement.network_cidr.as_str()
                })
                .into(),
            bind_address: publication.as_ref().map_or_else(
                || gateway.bridge(),
                |publication| Ok(publication.bind_address.clone()),
            )?,
            port,
        }))
    }
}

impl Installer for ServiceDefinition {
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

    async fn check_running(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
        connections: &crate::docker::Connections,
        bindings: &BTreeMap<String, StateBinding>,
        cancel: &crate::CancellationToken,
    ) -> Result<(), crate::Error> {
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
}

impl InferenceCapability for ServiceDefinition {
    fn resolve(&self, document: &Document, name: &str) -> Result<ResolvedInference, ConfigError> {
        Ok(match self {
            ServiceDefinition::Ollama(service) => ResolvedInference {
                endpoint: match &service.publication {
                    Some(publication) => publication.endpoint.clone(),
                    None => format!(
                        "http://{}:{}/v1",
                        document.spec.gateway.bridge()?,
                        service.serving.port
                    ),
                },
                served_model: service.model.name.clone(),
                requires_authentication: false,
                resource_dependencies: Vec::new(),
            },
            ServiceDefinition::OllamaProxy(service) => ResolvedInference {
                endpoint: service.endpoint.clone(),
                served_model: service.upstream.model.name.clone(),
                requires_authentication: true,
                resource_dependencies: vec![format!("nemoclaw_ollama_proxy.{name}")],
            },
            ServiceDefinition::Vllm(service) => ResolvedInference {
                endpoint: match &service.publication {
                    Some(publication) => publication.endpoint.clone(),
                    None => format!(
                        "http://{}:{}/v1",
                        document.spec.gateway.bridge()?,
                        service.serving.port
                    ),
                },
                served_model: service.served_model().into(),
                requires_authentication: service.authentication.is_some(),
                resource_dependencies: Vec::new(),
            },
        })
    }

    fn validate_route(
        &self,
        provider: &InferenceProvider,
        sandbox_runtime: &str,
        harness: &str,
        model: &str,
    ) -> Result<(), ConfigError> {
        match self {
            ServiceDefinition::Ollama(_) => crate::config::validation::require(
                provider.api.is_none()
                    || provider.api == Some(crate::config::InferenceApi::OpenaiCompletions),
                "managed Ollama requires the OpenAI Completions API",
            ),
            ServiceDefinition::OllamaProxy(service) => service.validate(provider, model, harness),
            ServiceDefinition::Vllm(service) => crate::config::validation::require(
                sandbox_runtime == "docker" || service.placement.is_some(),
                "vLLM service requires compatible sandbox placement",
            ),
        }
    }

    fn credential_source(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<Option<String>, crate::Error> {
        match self {
            ServiceDefinition::Ollama(_) => Ok(None),
            ServiceDefinition::OllamaProxy(service) => service
                .credential_source(document, name, generations)
                .map(Some),
            ServiceDefinition::Vllm(service) => {
                service.credential_source(document, name, generations)
            }
        }
    }
}

struct NetworkAllocation {
    engine: String,
    network_cidr: String,
    bind_address: String,
    port: i64,
}

pub(crate) fn defaults(definition: &mut ServiceDefinition) {
    match definition {
        ServiceDefinition::Ollama(service) => {
            service.defaults();
        }
        ServiceDefinition::OllamaProxy(_) => {}
        ServiceDefinition::Vllm(service) => {
            service.defaults();
        }
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
    definition
        .inference()
        .ok_or_else(|| ConfigError::new("serviceRef must name an inference-capable service"))?
        .resolve(document, name)
        .map(Some)
}

pub(crate) fn provider_authenticated(
    document: &Document,
    provider: &InferenceProvider,
) -> Result<bool, ConfigError> {
    Ok(provider.credential.is_some()
        || resolve(document, provider)?.is_some_and(|service| service.requires_authentication))
}

/// Installer results retained for one graph compilation.
pub(crate) struct InstallPlans {
    plans: Vec<InstallPlan>,
}

impl InstallPlans {
    pub(crate) fn targets(&self) -> impl Iterator<Item = &Target> {
        self.plans.iter().flat_map(|plan| plan.targets.iter())
    }

    pub(crate) fn dependencies(&self, address: &str) -> Option<&[String]> {
        self.plans
            .iter()
            .find_map(|plan| plan.dependencies.get(address).map(Vec::as_slice))
    }
}

pub(crate) fn install_plans(
    document: &Document,
    generations: &Generations,
    stage: InstallStage,
) -> Result<InstallPlans, crate::Error> {
    let plans = document
        .spec
        .services
        .iter()
        .filter(|(_, definition)| definition.stage() == stage)
        .map(|(name, definition)| definition.install(document, name, generations))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(InstallPlans { plans })
}

pub(crate) fn has_runtime(document: &Document) -> bool {
    document
        .spec
        .services
        .values()
        .any(|definition| definition.stage() == InstallStage::Runtime)
}

pub(crate) fn validate(document: &Document) -> Result<(), ConfigError> {
    use crate::config::validation::{SLUG, require};
    for (name, definition) in &document.spec.services {
        require(SLUG.is_match(name), "service names must be lowercase slugs")?;
        definition.validate_definition()?;
        definition.validate_installation(&document.spec.gateway)?;
    }
    let gateway = &document.spec.gateway;
    let mut publications = BTreeSet::new();
    let mut networks = BTreeMap::new();
    if gateway.management == "managed" {
        networks.insert(gateway.engine.clone(), gateway.network_cidr.clone());
    }
    for definition in document.spec.services.values() {
        let Some(allocation) = definition.allocation(gateway)? else {
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
            "managed service publication addresses must be distinct on each engine",
        )?;
    }
    Ok(())
}

pub(crate) fn validate_provider(
    document: &Document,
    provider: &InferenceProvider,
) -> Result<bool, ConfigError> {
    use crate::config::validation::require;
    let Some((_, definition)) = definition(document, provider)? else {
        return Ok(false);
    };
    require(
        definition.inference().is_some(),
        "serviceRef must name an inference-capable service",
    )?;
    require(
        provider.endpoint.is_empty() && provider.credential.is_none(),
        "serviceRef excludes endpoint and external credentials",
    )?;
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
    let inference = definition
        .inference()
        .ok_or_else(|| ConfigError::new("serviceRef must name an inference-capable service"))?;
    let resolved = inference.resolve(
        document,
        provider.service_ref.as_deref().unwrap_or_default(),
    )?;
    require(
        model == resolved.served_model,
        "service requires its declared served model",
    )?;
    inference.validate_route(provider, sandbox_runtime, harness, model)
}

pub(crate) fn credential_source_json(
    document: &Document,
    provider: &InferenceProvider,
    generations: &Generations,
) -> Result<Option<String>, ConfigError> {
    let Some((name, definition)) = definition(document, provider)? else {
        return Ok(None);
    };
    definition
        .inference()
        .ok_or_else(|| ConfigError::new("serviceRef must name an inference-capable service"))?
        .credential_source(document, name, generations)
        .map_err(|_| ConfigError::new("invalid managed credential source"))
}

pub(crate) fn generation_kinds(document: &Document) -> Result<Vec<&'static str>, ConfigError> {
    let mut kinds = BTreeSet::new();
    for definition in document.spec.services.values() {
        match definition {
            ServiceDefinition::Ollama(_) => {
                kinds.insert(installers::ollama::SERVICE_KIND);
            }
            ServiceDefinition::OllamaProxy(_) => {
                kinds.insert(installers::ollama::proxy::PROXY);
            }
            ServiceDefinition::Vllm(_) => {
                kinds.insert(installers::vllm::SERVICE_KIND);
            }
        }
    }
    Ok(kinds.into_iter().collect())
}

pub(crate) fn remove_plans(
    document: &Document,
    generations: &Generations,
) -> Result<Vec<RemovePlan>, crate::Error> {
    document
        .spec
        .services
        .iter()
        .map(|(name, definition)| (name.as_str(), definition))
        .map(|(name, definition)| definition.remove(document, name, generations))
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

/// Opaque installer capacity input retained between per-runtime and combined-engine checks.
pub(crate) struct RuntimeCapacity {
    engine: String,
    service: CapacityService,
    starting: bool,
}

enum CapacityService {
    Ollama(ManagedOllama),
    Vllm(installers::vllm::Service),
}

pub(crate) async fn check_process_capacity(
    engine: &crate::docker::Engine,
    spec: &crate::managed::Spec,
    observed: Option<&crate::managed::RuntimeObservation>,
) -> Result<(), crate::Error> {
    match spec.kind.as_str() {
        installers::vllm::SERVICE_KIND => engine.check_capacity(spec, observed).await,
        installers::ollama::SERVICE_KIND => {
            installers::ollama::capacity::check(engine, spec, observed).await
        }
        _ => Err(crate::Error::Conflict(
            "managed process kind has no registered capacity check",
        )),
    }
}

pub(crate) async fn check_runtime_capacity(
    engine: &crate::docker::Engine,
    spec: &crate::managed::Spec,
    observed: Option<&crate::managed::RuntimeObservation>,
) -> Result<Option<RuntimeCapacity>, crate::Error> {
    let service = match spec.kind.as_str() {
        installers::vllm::SERVICE_KIND => {
            CapacityService::Vllm(installers::vllm::configured_service(spec)?)
        }
        installers::ollama::SERVICE_KIND => {
            CapacityService::Ollama(installers::ollama::configured_service(spec)?)
        }
        _ => return Ok(None),
    };
    check_process_capacity(engine, spec, observed).await?;
    Ok(Some(RuntimeCapacity {
        engine: spec.engine().into(),
        service,
        starting: observed.is_none_or(|runtime| !runtime.running),
    }))
}

pub(crate) async fn check_combined_capacity(
    connections: &crate::docker::Connections,
    checks: Vec<RuntimeCapacity>,
) -> Result<(), crate::Error> {
    let mut grouped: BTreeMap<String, Vec<(CapacityService, bool)>> = BTreeMap::new();
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
        let mut total_budget = 0_u64;
        let mut new_budget = 0_u64;
        let mut reserve = 0_u64;
        let mut startup = 0_u64;
        let mut architecture = None;
        for (service, starting) in &services {
            let (kind, budget, host_reserve, headroom) = match service {
                CapacityService::Ollama(service) => {
                    installers::ollama::hardware_capacity::check_memory(
                        service, &capacity, *starting,
                    )?;
                    (
                        service.memory_architecture()?,
                        installers::ollama::hardware_capacity::budget(service, &capacity)?,
                        service.memory.host_reserve_gib as u64 * crate::hardware::GIB,
                        20 * crate::hardware::GIB,
                    )
                }
                CapacityService::Vllm(service) => {
                    installers::vllm::hardware_capacity::check_memory(
                        service, &capacity, *starting,
                    )?;
                    let total =
                        installers::vllm::hardware_capacity::serving_memory(service, &capacity)?;
                    let budget = service
                        .memory
                        .gpu_memory_utilization
                        .as_ref()
                        .and_then(serde_json::Number::as_f64)
                        .map_or(service.gpu_bytes()?, |ratio| {
                            (total as f64 * ratio).floor() as u64
                        });
                    let headroom = service.recipe.as_ref().map_or(20, |recipe| {
                        recipe
                            .resources
                            .startup_headroom_gi_b
                            .max(recipe.resources.preparation_memory_gi_b)
                    }) * crate::hardware::GIB;
                    (
                        service.memory_architecture()?,
                        budget,
                        service.memory.host_reserve_gib as u64 * crate::hardware::GIB,
                        headroom,
                    )
                }
            };
            if architecture.is_some_and(|expected| expected != kind) {
                return Err(crate::Error::Conflict(
                    "services sharing an engine must use the same GPU memory contract",
                ));
            }
            architecture = Some(kind);
            total_budget = total_budget
                .checked_add(budget)
                .ok_or(crate::Error::State("combined GPU budget overflow"))?;
            reserve = reserve.max(host_reserve);
            if *starting {
                new_budget = new_budget
                    .checked_add(budget)
                    .ok_or(crate::Error::State("combined GPU budget overflow"))?;
                startup = startup
                    .checked_add(headroom)
                    .ok_or(crate::Error::State("combined startup budget overflow"))?;
            }
        }
        let fits = if architecture == Some(installers::vllm::MemoryArchitecture::Dedicated) {
            capacity
                .gpu_memory
                .as_ref()
                .is_some_and(|gpu| total_budget <= gpu.total && new_budget <= gpu.free)
                && (new_budget == 0 || reserve + startup <= capacity.available)
        } else {
            total_budget + reserve <= capacity.total && new_budget + startup <= capacity.available
        };
        if !fits {
            return Err(crate::Error::Conflict(
                "combined service budgets exceed available GPU or host startup memory",
            ));
        }
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
) -> Result<(), crate::Error> {
    for (name, definition) in &document.spec.services {
        if definition.stage() == stage {
            definition
                .check_running(document, name, generations, connections, bindings, cancel)
                .await?;
        }
    }
    Ok(())
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
        let managed_service = if matches!(
            kind,
            installers::vllm::SERVICE_KIND | installers::vllm::STORAGE_KIND
        ) {
            Some((
                installers::vllm::SERVICE_KIND,
                installers::vllm::STORAGE_KIND,
            ))
        } else if matches!(
            kind,
            installers::ollama::SERVICE_KIND | installers::ollama::STORAGE_KIND
        ) {
            Some((
                installers::ollama::SERVICE_KIND,
                installers::ollama::STORAGE_KIND,
            ))
        } else {
            None
        };
        if let Some((process_kind, storage_kind)) = managed_service {
            let engine = crate::managed::runtime_engine(self.connections, kind, row)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(RegisteredBackend(Box::new(
                crate::managed::ManagedBackend::service(engine, process_kind, storage_kind),
            ))));
        }
        if crate::managed::ManagedBackend::supports(kind) {
            let engine = crate::managed::runtime_engine(self.connections, kind, row)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(RegisteredBackend(Box::new(
                crate::managed::ManagedBackend::new(engine),
            ))));
        }
        if installers::ollama::ProxyBackend::supports(kind) {
            let endpoint = row
                .get("engine")
                .filter(|endpoint| !endpoint.is_empty())
                .ok_or(ObservationError::Incomplete)?;
            let engine = self
                .connections
                .resolve(endpoint)
                .map_err(|_| ObservationError::Backend("engine connection unavailable"))?;
            return Ok(Some(RegisteredBackend(Box::new(
                installers::ollama::ProxyBackend::new(engine),
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
