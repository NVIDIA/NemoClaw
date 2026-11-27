// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Dispatch for service definitions and installer-owned resource backends.
use crate::config::ComputeDriver;

use super::{
    ManagedOllama, OllamaProxy,
    contract::{InstallPlan, InstallStage, Installer, RemovePlan},
    installers,
};
use crate::{
    compile::{Generations, Target},
    config::{ConfigError, Document, Gateway, InferenceProvider},
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
    /// Managed llama.cpp runtime and immutable GGUF.
    LlamaCpp(Box<installers::llama_cpp::Service>),
    /// Native vLLM-backed NIM behind a private Docker network and route filter.
    Nim(Box<installers::nim::Service>),
    /// Image-owned container with explicit launch settings and bounded readiness.
    Container(Box<installers::container::Service>),
}

/// Retention and process roles of a service installer resource.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceBehavior {
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

/// Managed Kubernetes resource fields: the cluster target and identity, the
/// environment list as JSON, and the observed reconciliation. Each command
/// forwards a free local port to the gateway, so none names an endpoint.
const KUBERNETES_FIELDS: [&str; 11] = [
    "name",
    "owner",
    "generation",
    "compute_driver",
    "kubeconfig_env",
    "context",
    "namespace",
    "authentication_profile",
    crate::kubernetes::ENVIRONMENT_FIELD,
    crate::kubernetes::OIDC_FIELD,
    "running",
];
const KUBERNETES_AUTH_FIELDS: [&str; 12] = [
    "name",
    "owner",
    "generation",
    "compute_driver",
    "kubeconfig_env",
    "context",
    "namespace",
    "authentication_profile",
    crate::kubernetes::ENVIRONMENT_FIELD,
    crate::kubernetes::OIDC_FIELD,
    "running",
    "release_present",
];
pub fn resource_schemas() -> Vec<ResourceSchema> {
    vec![
        ResourceSchema {
            kind: crate::kubernetes::STORAGE_KIND,
            fields: &KUBERNETES_FIELDS,
            mutable: &["running"],
        },
        ResourceSchema {
            kind: crate::kubernetes::GATEWAY_KIND,
            fields: &KUBERNETES_FIELDS,
            mutable: &["running"],
        },
        ResourceSchema {
            kind: crate::kubernetes::AUTH_KIND,
            fields: &KUBERNETES_AUTH_FIELDS,
            mutable: &["running", "release_present"],
        },
        ResourceSchema {
            kind: "ollama_proxy_storage",
            fields: &["name", "owner", "generation", "engine"],
            mutable: &[],
        },
        ResourceSchema {
            kind: installers::vllm::STORAGE_KIND,
            fields: &crate::managed::Storage::ATTRIBUTES,
            mutable: &[],
        },
    ]
}

pub fn resource_behavior(kind: &str) -> ResourceBehavior {
    ResourceBehavior {
        retained_storage: matches!(
            kind,
            installers::ollama::STORAGE_KIND
                | installers::vllm::STORAGE_KIND
                | crate::kubernetes::STORAGE_KIND
        ),
        runtime_process: matches!(
            kind,
            installers::ollama::SERVICE_KIND
                | installers::vllm::SERVICE_KIND
                | installers::container::SERVICE_KIND
        ),
    }
}

pub(crate) fn resource_label(kind: &str) -> Option<&'static str> {
    match kind {
        installers::vllm::SERVICE_KIND => Some("inference service"),
        installers::ollama::SERVICE_KIND => Some("Ollama service"),
        "ollama_proxy" => Some("Ollama proxy"),
        installers::container::SERVICE_KIND => Some("application container"),
        _ => None,
    }
}

pub(crate) fn constrain_schema(
    defs: &mut serde_json::Map<String, serde_json::Value>,
    normalized: bool,
) {
    installers::ollama::constrain_schema(defs, normalized);
    installers::vllm::schema::constrain(defs, normalized);
    nemoclaw_runtime::llama_cpp::schema::constrain(defs);
    let llama = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["properties"]["kind"]["const"] == "llamaCpp")
        .unwrap();
    crate::config::schema::validation::property(
        llama,
        "image",
        serde_json::json!({"pattern":crate::config::constraints::IMAGE}),
    );
    llama["dependentRequired"] =
        serde_json::json!({"placement":["publication"],"publication":["placement"]});
    let nim = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["properties"]["kind"]["const"] == "nim")
        .unwrap();
    crate::config::schema::validation::property(
        nim,
        "image",
        serde_json::json!({"pattern":crate::config::constraints::IMAGE}),
    );
    nim["dependentRequired"] =
        serde_json::json!({"placement":["publication"],"publication":["placement"]});
    installers::container::constrain_schema(defs);
    for service in defs["ServiceDefinition"]["oneOf"].as_array_mut().unwrap() {
        crate::config::schema::validation::property(
            service,
            "image",
            serde_json::json!({
                "x-nemoclaw-error": "service image must be pinned by a SHA-256 digest"
            }),
        );
        if service["properties"]["kind"]["const"] == "container" {
            continue;
        }
        crate::config::schema::validation::property(
            service,
            "imagePullPolicy",
            serde_json::json!({"enum":["IfNotPresent", "Never"]}),
        );
        if matches!(
            service["properties"]["kind"]["const"].as_str(),
            Some("vllm" | "ollama" | "llamaCpp" | "nim")
        ) {
            crate::config::schema::validation::property(
                service,
                "updatePolicy",
                serde_json::json!({"default": super::ServiceUpdatePolicy::default()}),
            );
        }
    }
}

impl ServiceDefinition {
    /// Update policy of a managed model; none for a proxy or application.
    pub(crate) fn update_policy(&self) -> Option<super::ServiceUpdatePolicy> {
        match self {
            Self::Ollama(service) => Some(service.update_policy),
            Self::Vllm(service) => Some(service.update_policy),
            Self::LlamaCpp(service) => Some(service.update_policy),
            Self::Nim(service) => Some(service.update_policy),
            Self::OllamaProxy(_) | Self::Container(_) => None,
        }
    }

    /// Address of a managed model's container resource; none for a proxy or application.
    pub(crate) fn model_address(&self, name: &str) -> Option<String> {
        match self {
            Self::Ollama(_) => Some(installers::ollama::service_address(name)),
            Self::Vllm(_) => Some(installers::vllm::service_address(name)),
            Self::LlamaCpp(_) => Some(installers::llama_cpp::service_address(name)),
            Self::Nim(_) => Some(installers::nim::service_address(name)),
            Self::OllamaProxy(_) | Self::Container(_) => None,
        }
    }

    fn stage(&self) -> InstallStage {
        match self {
            Self::Ollama(_) | Self::Vllm(_) | Self::LlamaCpp(_) | Self::Nim(_) => {
                InstallStage::Runtime
            }
            Self::OllamaProxy(_) | Self::Container(_) => InstallStage::Deployment,
        }
    }

    fn validate_definition(&self) -> Result<(), ConfigError> {
        match self {
            Self::Ollama(service) => service.validate(),
            Self::OllamaProxy(service) => service.validate_definition(),
            Self::Vllm(service) => service.validate(),
            Self::LlamaCpp(service) => service.validate(),
            Self::Nim(service) => service.validate(),
            Self::Container(service) => service.validate(),
        }
    }

    fn validate_installation(&self, document: &Document) -> Result<(), ConfigError> {
        let (container, preparation_memory) = match self {
            Self::Container(_) => {
                installers::container::Service::gateway(document)?;
                return Ok(());
            }
            Self::LlamaCpp(service) => (service.container.as_ref(), 0),
            Self::Nim(service) => (service.container.as_ref(), 0),
            Self::Vllm(service) => (
                service.container.as_ref(),
                service
                    .recipe
                    .as_ref()
                    .map_or(0, |recipe| recipe.resources.preparation_memory_gi_b),
            ),
            Self::Ollama(service) => (service.container.as_ref(), 0),
            Self::OllamaProxy(_) => (None, 0),
        };
        installers::container::ServiceContainer::validate_memory(container, preparation_memory)?;
        let gateway = &document.spec.gateway;
        let local_docker = gateway
            .as_managed()
            .is_some_and(|gateway| crate::config::engine_socket(gateway.engine()).is_some())
            && gateway.compute_driver() == ComputeDriver::Docker;
        let (placement, package) = match self {
            Self::Ollama(service) => (service.published_placement()?, "Ollama"),
            Self::Vllm(service) => (service.published_placement()?, "vLLM"),
            Self::LlamaCpp(service) => (service.published_placement()?, "llama.cpp"),
            Self::Nim(service) => (service.published_placement()?, "NIM"),
            Self::OllamaProxy(service) => {
                return crate::config::validation::require(
                    local_docker || service.engine.is_some(),
                    "Ollama proxy requires a managed local Docker gateway or explicit local engine",
                );
            }
            Self::Container(_) => unreachable!(),
        };
        crate::config::validation::require(
            placement.is_some() || local_docker,
            if package == "NIM" {
                "NIM requires the managed gateway Docker engine or explicit placement"
            } else if package == "llama.cpp" {
                "llama.cpp requires the managed gateway Docker engine or explicit placement"
            } else if package == "Ollama" {
                "Ollama requires the managed gateway Docker engine or explicit placement"
            } else {
                "vLLM requires the managed gateway Docker engine or explicit placement"
            },
        )?;
        Ok(())
    }

    fn allocation(&self, gateway: &Gateway) -> Result<Option<NetworkAllocation>, ConfigError> {
        if let Self::Container(service) = self {
            let gateway = gateway.managed()?;
            return Ok(Some(NetworkAllocation {
                engine: gateway.engine().to_owned(),
                network_cidr: gateway.network_cidr().to_owned(),
                bind_address: service
                    .publication
                    .as_ref()
                    .map_or(String::new(), |p| p.bind_address.clone()),
                port: service
                    .publication
                    .as_ref()
                    .map_or(0, |p| i64::from(p.port)),
            }));
        }
        let (placement, port) = match self {
            Self::Ollama(service) => (service.published_placement()?, service.serving.port),
            Self::Vllm(service) => (service.published_placement()?, service.serving.port),
            Self::LlamaCpp(service) => (
                service.published_placement()?,
                i64::from(service.serving.port),
            ),
            Self::Nim(service) => (
                service.published_placement()?,
                i64::from(service.serving.port),
            ),
            Self::OllamaProxy(_) => return Ok(None),
            Self::Container(_) => unreachable!(),
        };
        let placed = super::placement::ResolvedPlacement::resolve(placement, gateway, port)?;
        Ok(Some(NetworkAllocation {
            engine: placed.engine,
            network_cidr: placed.network_cidr,
            bind_address: placed.bind_address,
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
            Self::LlamaCpp(service) => service.install(document, name, generations),
            Self::Nim(service) => service.install(document, name, generations),
            Self::Container(service) => service.install(document, name, generations),
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
            Self::LlamaCpp(service) => service.remove(document, name, generations),
            Self::Nim(service) => service.remove(document, name, generations),
            Self::Container(service) => service.remove(document, name, generations),
        }
    }
}

impl ServiceDefinition {
    fn resolve(&self, document: &Document, name: &str) -> Result<ResolvedInference, ConfigError> {
        Ok(match self {
            ServiceDefinition::Container(service) => {
                let publication = service.publication.as_ref().ok_or_else(|| {
                    ConfigError::new("a container inference service requires a private publication")
                })?;
                crate::config::validation::require(
                    publication
                        .bind_address
                        .parse::<std::net::Ipv4Addr>()
                        .is_ok_and(|ip| ip.is_private()),
                    "a container inference service requires a private address reachable by OpenShell",
                )?;
                ResolvedInference {
                    endpoint: format!(
                        "http://{}:{}/v1",
                        publication.bind_address, publication.port
                    ),
                    served_model: String::new(),
                    requires_authentication: false,
                    resource_dependencies: vec![format!(
                        "data.{}.container_service_{name}",
                        installers::container::HEALTH_DATA_SOURCE
                    )],
                }
            }
            ServiceDefinition::Ollama(service) => ResolvedInference {
                endpoint: super::placement::ResolvedPlacement::resolve(
                    service.published_placement()?,
                    &document.spec.gateway,
                    service.serving.port,
                )?
                .endpoint,
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
                endpoint: super::placement::ResolvedPlacement::resolve(
                    service.published_placement()?,
                    &document.spec.gateway,
                    service.serving.port,
                )?
                .endpoint,
                served_model: service.served_model().into(),
                requires_authentication: service.authentication.is_some(),
                resource_dependencies: Vec::new(),
            },
            ServiceDefinition::LlamaCpp(service) => ResolvedInference {
                endpoint: super::placement::ResolvedPlacement::resolve(
                    service.published_placement()?,
                    &document.spec.gateway,
                    i64::from(service.serving.port),
                )?
                .endpoint,
                served_model: service.served_model().into(),
                requires_authentication: service.authentication.is_some(),
                resource_dependencies: Vec::new(),
            },
            ServiceDefinition::Nim(service) => ResolvedInference {
                endpoint: super::placement::ResolvedPlacement::resolve(
                    service.published_placement()?,
                    &document.spec.gateway,
                    i64::from(service.serving.port),
                )?
                .endpoint,
                served_model: service.served_model().into(),
                requires_authentication: service.authentication.is_some(),
                resource_dependencies: Vec::new(),
            },
        })
    }

    fn validate_route(
        &self,
        provider: &InferenceProvider,
        sandbox_runtime: ComputeDriver,
        model: &str,
    ) -> Result<(), ConfigError> {
        match self {
            ServiceDefinition::Container(_) => Ok(()),
            ServiceDefinition::Ollama(_) => crate::config::validation::require(
                provider.api.is_none()
                    || provider.api == Some(crate::config::InferenceApi::OpenaiCompletions),
                "managed Ollama requires the OpenAI Completions API",
            ),
            ServiceDefinition::OllamaProxy(service) => service.validate(provider, model),
            ServiceDefinition::Vllm(service) => crate::config::validation::require(
                sandbox_runtime == ComputeDriver::Docker || service.placement.is_some(),
                "vLLM service requires compatible sandbox placement",
            ),
            ServiceDefinition::LlamaCpp(service) => crate::config::validation::require(
                sandbox_runtime == ComputeDriver::Docker || service.placement.is_some(),
                "llama.cpp service requires compatible sandbox placement",
            ),
            ServiceDefinition::Nim(service) => crate::config::validation::require(
                sandbox_runtime == ComputeDriver::Docker || service.placement.is_some(),
                "NIM service requires compatible sandbox placement",
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
            ServiceDefinition::Container(_) => Ok(None),
            ServiceDefinition::Ollama(_) => Ok(None),
            ServiceDefinition::OllamaProxy(service) => service
                .credential_source(document, name, generations)
                .map(Some),
            ServiceDefinition::Vllm(service) => {
                service.credential_source(document, name, generations)
            }
            ServiceDefinition::LlamaCpp(service) => {
                service.credential_source(document, name, generations)
            }
            ServiceDefinition::Nim(service) => {
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

/// Execution engines selected by service owners, without inferring the caller's host.
pub(crate) fn discovery_engines(document: &Document) -> Result<BTreeSet<String>, ConfigError> {
    document
        .spec
        .services
        .values()
        .map(|service| {
            if let Some(allocation) = service.allocation(&document.spec.gateway)? {
                return Ok(allocation.engine);
            }
            let ServiceDefinition::OllamaProxy(proxy) = service else {
                unreachable!()
            };
            proxy
                .engine
                .clone()
                .or_else(|| {
                    document
                        .spec
                        .gateway
                        .as_managed()
                        .map(|gateway| gateway.engine().to_owned())
                })
                .ok_or(ConfigError::new("service engine is not configured"))
        })
        .collect()
}

pub(crate) fn defaults(definition: &mut ServiceDefinition) {
    match definition {
        ServiceDefinition::Ollama(service) => {
            service.defaults();
        }
        ServiceDefinition::LlamaCpp(_) => {}
        ServiceDefinition::Nim(_) => {}
        ServiceDefinition::OllamaProxy(_) => {}
        ServiceDefinition::Container(_) => {}
        ServiceDefinition::Vllm(service) => {
            service.defaults();
        }
    }
}

fn definition<'a>(
    document: &'a Document,
    provider: &InferenceProvider,
) -> Result<Option<(&'a str, &'a ServiceDefinition)>, ConfigError> {
    let crate::config::InferenceTarget::Service { name } = provider.target()? else {
        return Ok(None);
    };
    document
        .spec
        .services
        .get_key_value(name)
        .map(|(name, definition)| Some((name.as_str(), definition)))
        .ok_or_else(|| {
            let error = crate::config::references::missing_reference(
                "service",
                name,
                document.spec.services.keys().map(String::as_str),
            );
            match document.provider_pointer(provider) {
                Some(pointer) => error.or_at(&format!("{pointer}/serviceRef")),
                None => error,
            }
        })
}

pub(crate) fn resolve(
    document: &Document,
    provider: &InferenceProvider,
) -> Result<Option<ResolvedInference>, ConfigError> {
    let Some((name, definition)) = definition(document, provider)? else {
        return Ok(None);
    };
    definition.resolve(document, name).map(Some)
}

pub(crate) fn provider_authenticated(
    document: &Document,
    provider: &InferenceProvider,
) -> Result<bool, ConfigError> {
    match provider.target()? {
        crate::config::InferenceTarget::External { credential, .. } => Ok(credential.is_some()),
        crate::config::InferenceTarget::Service { .. } => {
            Ok(resolve(document, provider)?.is_some_and(|service| service.requires_authentication))
        }
    }
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
    use crate::config::validation::{Errors, require};
    // Each service's error names that service, and the others are still
    // checked. The checks across services rely on every definition's.
    let mut errors = Errors::default();
    for (name, definition) in &document.spec.services {
        errors.check(
            &format!("/spec/services/{name}"),
            definition
                .validate_definition()
                .and_then(|()| definition.validate_installation(document)),
        );
    }
    errors.finish()?;
    let gateway = &document.spec.gateway;
    let mut publications = BTreeSet::new();
    let mut networks = BTreeMap::new();
    if let Gateway::Managed(gateway) = gateway {
        networks.insert(
            gateway.engine().to_owned(),
            gateway.network_cidr().to_owned(),
        );
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
            allocation.port == 0
                || publications.insert((
                    allocation.engine,
                    allocation.bind_address,
                    allocation.port,
                )),
            "managed service publication addresses must be distinct on each engine",
        )?;
    }
    let mut backends = BTreeSet::new();
    for definition in document.spec.services.values() {
        if let ServiceDefinition::Nim(service) = definition {
            let allocation = definition.allocation(gateway)?.expect("NIM has placement");
            let backend = &service.backend_network_cidr;
            require(
                networks.get(&allocation.engine) != Some(backend)
                    && backends.insert((allocation.engine.clone(), backend.clone())),
                "NIM backend networks must be distinct from gateway, publication and other model networks on each engine",
            )?;
            let backend = crate::config::private_network(backend).expect("NIM network validated");
            for other in document.spec.services.values() {
                if let Some(publication) = other.allocation(gateway)? {
                    require(
                        publication.engine != allocation.engine
                            || publication
                                .bind_address
                                .parse::<std::net::Ipv4Addr>()
                                .is_ok_and(|ip| !backend.contains(&ip)),
                        "NIM backend subnet must not contain a service publication host address",
                    )?;
                }
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_provider(
    document: &Document,
    provider: &InferenceProvider,
) -> Result<bool, ConfigError> {
    let referenced = definition(document, provider)?;
    if let Some((name, definition @ ServiceDefinition::Container(_))) = referenced {
        definition.resolve(document, name)?;
    }
    Ok(referenced.is_some())
}

pub(crate) fn validate_route(
    document: &Document,
    provider: &InferenceProvider,
    sandbox_runtime: ComputeDriver,
    model: &str,
) -> Result<(), ConfigError> {
    use crate::config::validation::require;
    let Some((name, definition)) = definition(document, provider)? else {
        return Ok(());
    };
    let resolved = definition.resolve(document, name)?;
    require(
        matches!(definition, ServiceDefinition::Container(_)) || model == resolved.served_model,
        "service requires its declared served model",
    )?;
    definition.validate_route(provider, sandbox_runtime, model)
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
            ServiceDefinition::Vllm(_)
            | ServiceDefinition::LlamaCpp(_)
            | ServiceDefinition::Nim(_) => {
                kinds.insert(installers::vllm::SERVICE_KIND);
            }
            ServiceDefinition::Container(_) => {
                kinds.insert(installers::container::SERVICE_KIND);
            }
        }
    }
    Ok(kinds.into_iter().collect())
}

pub(crate) fn supported_generation_kind(kind: &str) -> bool {
    // Removed services may still own resources under their retained generation.
    matches!(
        kind,
        installers::ollama::SERVICE_KIND
            | installers::ollama::proxy::PROXY
            | installers::vllm::SERVICE_KIND
            | installers::container::SERVICE_KIND
    )
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
        .find_map(|(candidate, storage)| {
            (candidate == process || crate::docker_compute::address(&candidate) == process)
                .then_some(storage)
        }))
}
