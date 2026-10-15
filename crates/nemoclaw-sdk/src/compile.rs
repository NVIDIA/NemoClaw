// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::InferenceProviderKind;

use crate::{
    backend::Row,
    config::{ConfigError, Document, InferenceProvider, SearchProvider},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};

/// Registry address of the provider that reconciles OpenShell objects.
pub const OPENSHELL_PROVIDER_ADDRESS: &str = "registry.opentofu.org/nvidia/openshell";
/// Registry address of the provider that configures Fabric agents in sandboxes.
pub const FABRIC_PROVIDER_ADDRESS: &str = "registry.opentofu.org/nvidia/fabric";
pub const VLLM_PROVIDER_ADDRESS: &str = "registry.opentofu.org/nvidia/vllm";
pub const OLLAMA_PROVIDER_ADDRESS: &str = "registry.opentofu.org/nvidia/ollama";
/// Registry address of the provider that observes container engines; it has
/// no settings, so it is not one of [`NEMOCLAW_PROVIDERS`].
pub const HOST_PROVIDER_ADDRESS: &str = "registry.opentofu.org/nvidia/host";
/// This repository's providers that take `destroy`.
pub const NEMOCLAW_PROVIDERS: [&str; 4] = ["openshell", "fabric", "vllm", "ollama"];

/// The OpenTofu resource type that reconciles a resource kind.
pub fn resource_type(kind: &str) -> String {
    nemoclaw_openshell::resource_type(kind)
        .or_else(|| nemoclaw_openshell::installation_type(kind))
        .or_else(|| crate::services::provider_types::runtime_type(kind).map(str::to_owned))
        .unwrap_or_else(|| match kind {
            "agent" => nemoclaw_fabric::agent::RESOURCE_TYPE.to_owned(),
            _ => format!("nemoclaw_{kind}"),
        })
}

/// The OpenTofu data source type for a data source kind.
pub fn data_source_type(kind: &str) -> String {
    nemoclaw_openshell::installation_type(kind)
        .or_else(|| crate::services::provider_types::runtime_type(kind).map(str::to_owned))
        .unwrap_or_else(|| format!("nemoclaw_{kind}"))
}
pub use crate::artifact_pins::OPENTOFU_VERSION;
pub type Generations = BTreeMap<String, String>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Target {
    pub kind: String,
    pub address: String,
    pub values: Row,
}

fn generation<'a>(generations: &'a Generations, kind: &str) -> Result<&'a str, ConfigError> {
    generations
        .get(kind)
        .filter(|value| !value.is_empty())
        .map(String::as_str)
        .ok_or(ConfigError::new("missing resource generation"))
}

pub(super) fn service_plans(
    document: &Document,
    generations: &Generations,
    stage: crate::services::InstallStage,
) -> Result<crate::services::InstallPlans, ConfigError> {
    crate::services::install_plans(document, generations, stage)
        .map_err(|_| ConfigError::new("invalid service install plan"))
}

pub fn targets(document: &Document, generations: &Generations) -> Result<Vec<Target>, ConfigError> {
    document.validate()?;
    let service_plans = service_plans(
        document,
        generations,
        crate::services::InstallStage::Deployment,
    )?;
    crate::docker_compute::targets(&targets_with_plans(document, generations, &service_plans)?)
        .map_err(|_| ConfigError::new("invalid Docker compute plan"))
}

fn targets_with_plans(
    document: &Document,
    generations: &Generations,
    service_plans: &crate::services::InstallPlans,
) -> Result<Vec<Target>, ConfigError> {
    let workspace = document.workspace();
    let providers = document.selected_providers()?;
    let mut result = vec![Target {
        kind: "workspace".into(),
        address: "openshell_workspace.deployment".into(),
        values: [
            ("name".into(), workspace.clone()),
            ("owner".into(), document.metadata.uid.clone()),
            (
                "generation".into(),
                generation(generations, "workspace")?.into(),
            ),
        ]
        .into(),
    }];
    for provider in &providers {
        result.extend(inference_targets(
            document,
            provider.definition,
            &provider.key,
            generations,
        )?);
    }
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by_key(|sandbox| &sandbox.name);
    for sandbox in sandboxes {
        document.sandbox_harness(sandbox)?;
        let web_search = document.web_search(sandbox)?;
        let image_scope = document.image_scope(sandbox)?;
        let mut provider_names = document
            .sandbox_inference_providers(sandbox)?
            .iter()
            .map(|provider| provider.key.clone())
            .collect::<Vec<_>>();
        if let Some(search) = &web_search {
            provider_names.push(crate::config::search_provider_name(
                search.provider,
                &search.credential.env,
                &search.provider.image_profile(&image_scope),
            ));
        }

        let mut values: Row = [
            ("name".into(), sandbox.name.clone()),
            ("workspace".into(), workspace.clone()),
            ("owner".into(), document.metadata.uid.clone()),
            (
                "generation".into(),
                generation(generations, "sandbox")?.into(),
            ),
            ("image".into(), sandbox.image.ref_.clone()),
            // Not a sandbox input: the launch carries the agent. Bound-sandbox
            // checks compare it so renaming the agent is refused.
            ("agent_name".into(), sandbox.agent.name.clone()),
            (
                "provider_names_json".into(),
                serde_json::to_string(&provider_names).expect("provider names"),
            ),
        ]
        .into();
        values.insert(
            "policy_json".into(),
            serde_json::to_string(&crate::image_runtime::policy_input(document, sandbox)?)
                .expect("policy input"),
        );
        {
            // The agent's inputs are Fabric's configuration sections; the
            // sandbox fields name the sandbox whose ref the graph passes.
            let mut values = nemoclaw_fabric::agent::decompose(&crate::fabric_config::for_sandbox(
                document, sandbox,
            )?);
            values.extend([
                ("workspace".into(), workspace.clone()),
                (nemoclaw_fabric::agent::SANDBOX.into(), sandbox.name.clone()),
                ("owner".into(), document.metadata.uid.clone()),
                (
                    "generation".into(),
                    generation(generations, "sandbox")?.into(),
                ),
                (
                    "sandbox_id".into(),
                    format!("${{openshell_sandbox.{}.id}}", sandbox.name),
                ),
            ]);
            result.push(Target {
                kind: "agent".into(),
                address: format!("{}.{}", nemoclaw_fabric::agent::RESOURCE_TYPE, sandbox.name),
                values,
            });
        }
        result.push(Target {
            kind: "sandbox".into(),
            address: format!("openshell_sandbox.{}", sandbox.name),
            values,
        });
        if let Some(search) = web_search {
            let profile_name = search.provider.image_profile(&image_scope);
            let provider_name = crate::config::search_provider_name(
                search.provider,
                &search.credential.env,
                &profile_name,
            );
            for (kind, name) in [
                ("provider_profile", profile_name.as_str()),
                ("provider", provider_name.as_str()),
            ] {
                let mut values: Row = [
                    ("workspace".into(), workspace.clone()),
                    ("name".into(), name.into()),
                    ("owner".into(), document.metadata.uid.clone()),
                    (
                        "generation".into(),
                        generation(generations, "provider")?.into(),
                    ),
                ]
                .into();
                if kind == "provider" {
                    values.extend([
                        ("endpoint".into(), search.provider.endpoint().into()),
                        ("credential_env".into(), search.credential.env.clone()),
                        ("provider_type".into(), search.provider.name().into()),
                        ("profile_name".into(), profile_name.clone()),
                    ]);
                }
                let target = Target {
                    kind: kind.into(),
                    address: if kind == "provider" {
                        let logical = crate::config::profile_address(search.provider)
                            .strip_prefix("openshell_provider_profile.")
                            .unwrap();
                        let prefix = format!("{}-search-", search.provider.name());
                        format!(
                            "openshell_provider_registration.{logical}_{}",
                            provider_name.strip_prefix(&prefix).unwrap()
                        )
                    } else {
                        crate::config::image_profile_address(search.provider, &image_scope)
                    },
                    values,
                };
                if let Some(previous) = result.iter().find(|t| t.address == target.address) {
                    if previous != &target {
                        return Err(ConfigError::new(
                            "web search provider registration conflicts with an existing target",
                        ));
                    }
                } else {
                    result.push(target);
                }
            }
        }
    }
    for provider in &providers {
        if let Some(source) =
            crate::services::credential_source_json(document, provider.definition, generations)?
        {
            result
                .iter_mut()
                .find(|r| r.kind == "provider" && r.values["name"] == provider.key)
                .unwrap()
                .values
                .insert("credential_source".into(), source);
        }
    }
    // OpenShell objects and Fabric configurations name their gateway.
    let gateway = gateway_values(&document.spec.gateway);
    for target in &mut result {
        if nemoclaw_openshell::references(&target.kind)
            .iter()
            .any(|reference| reference.kind == nemoclaw_openshell::GATEWAY_TYPE)
        {
            target.values.extend(gateway.clone());
        }
    }
    result.extend(service_plans.targets().cloned());
    Ok(result)
}

fn inference_targets(
    document: &Document,
    provider: &InferenceProvider,
    key: &str,
    generations: &Generations,
) -> Result<[Target; 2], ConfigError> {
    let connection = document.provider_connection(provider)?;
    let logical = format!("inference_{key}");
    let values: Row = [
        ("workspace".into(), document.workspace()),
        ("name".into(), key.into()),
        ("owner".into(), document.metadata.uid.clone()),
        (
            "generation".into(),
            generation(generations, "provider")?.into(),
        ),
        ("endpoint".into(), connection.endpoint),
        (
            "credential_env".into(),
            connection
                .credential
                .as_ref()
                .map(|credential| credential.env.clone())
                .unwrap_or_default(),
        ),
        (
            "provider_type".into(),
            match provider.provider {
                InferenceProviderKind::Anthropic => "anthropic".into(),
                InferenceProviderKind::Openai => String::new(),
            },
        ),
    ]
    .into();
    let mut profile = values.clone();
    profile.insert("name".into(), format!("nemoclaw-inference-{key}"));
    profile.remove("credential_env");
    profile.insert(
        "authenticated".into(),
        crate::services::provider_authenticated(document, provider)?.to_string(),
    );
    Ok([
        Target {
            kind: "provider_profile".into(),
            address: format!("openshell_provider_profile.{logical}"),
            values: profile,
        },
        Target {
            kind: "provider".into(),
            address: format!("openshell_provider_registration.{logical}"),
            values,
        },
    ])
}

/// Compile only data. No filesystem access, backend calls, or runtime effects.
pub fn compile(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<Value, ConfigError> {
    deployment_graph(document, generations, version).map(|(graph, _)| graph)
}

pub(crate) fn deployment_graph(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<(Value, Vec<Target>), ConfigError> {
    document.validate()?;
    let service_plans = service_plans(
        document,
        generations,
        crate::services::InstallStage::Deployment,
    )?;
    let raw = targets_with_plans(document, generations, &service_plans)?;
    let mut graph = compile_with_plans(document, version, &service_plans, &raw)?;
    crate::docker_compute::configure(&mut graph, &raw)
        .map_err(|_| ConfigError::new("invalid Docker compute graph"))?;
    crate::services::configure_proxy_readiness(&mut graph, &raw)
        .map_err(|_| ConfigError::new("invalid proxy readiness graph"))?;
    let targets = crate::docker_compute::targets(&raw)
        .map_err(|_| ConfigError::new("invalid Docker compute plan"))?;
    Ok((graph, targets))
}

pub(crate) const GATEWAY_CAPABILITIES_ADDRESS: &str = "data.openshell_gateway.current";
pub(crate) const GATEWAY_APPLY_CAPABILITIES_ADDRESS: &str = "data.openshell_gateway.apply";

/// The data-source addresses a compiled graph reads, which are the only
/// observations its plans may contain.
pub(crate) fn observations(graph: &Value) -> BTreeSet<String> {
    graph["data"]
        .as_object()
        .into_iter()
        .flatten()
        .flat_map(|(kind, instances)| {
            instances
                .as_object()
                .into_iter()
                .flatten()
                .map(move |(name, _)| format!("data.{kind}.{name}"))
        })
        .collect()
}

// Both graphs report the provider's observation through OpenTofu conditions.
pub(super) fn gateway_error_message(reference: &str) -> String {
    let message = "Gateway is incompatible with this configuration: %s. Retain state, correct the gateway or the configuration, and reapply.";
    format!(
        "${{format({}, {reference}.incompatibility)}}",
        serde_json::to_string(message).expect("literal diagnostic"),
    )
}

/// The gateway data source's inputs: its connection and required drivers.
fn gateway_data(connection: &Value, drivers: Value) -> Value {
    let mut data = connection.clone();
    data["required_compute_drivers"] = drivers;
    data
}

/// The gateway connection a deployment's objects carry in their rows.
fn gateway_values(gateway: &crate::config::Gateway) -> BTreeMap<String, String> {
    let connection = gateway_provider(gateway);
    nemoclaw_openshell::GATEWAY_FIELDS
        .iter()
        .map(|(attribute, field)| {
            (
                (*field).to_owned(),
                connection[*attribute]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
            )
        })
        .collect()
}

pub(crate) fn gateway_provider(gateway: &crate::config::Gateway) -> Value {
    let mut provider = json!({"endpoint":gateway.endpoint()});
    if let Some(c) = gateway.credential() {
        provider["credential_env"] = json!(c.env);
    }
    if let Some(tls) = gateway.tls() {
        provider["tls_ca_env"] = json!(tls.ca.env);
        provider["tls_certificate_env"] = json!(tls.certificate.env);
        provider["tls_key_env"] = json!(tls.key.env);
    }
    if gateway.as_kubernetes().is_some() {
        provider["credential_env"] = json!("NEMOCLAW_MANAGED_K8S_TOKEN");
        provider["tls_ca_env"] = json!("NEMOCLAW_MANAGED_K8S_CA");
        provider["tls_certificate_env"] = json!("NEMOCLAW_MANAGED_K8S_CERT");
        provider["tls_key_env"] = json!("NEMOCLAW_MANAGED_K8S_KEY");
    }
    provider
}

/// The gateway's `ref` as a literal object, for graphs without its data source.
pub(crate) fn gateway_ref(gateway: &crate::config::Gateway) -> Value {
    let connection = gateway_provider(gateway);
    let mut reference = serde_json::Map::new();
    reference.insert(
        nemoclaw_tofu::REF_TYPE.into(),
        json!(nemoclaw_openshell::GATEWAY_TYPE),
    );
    for (attribute, _) in nemoclaw_openshell::GATEWAY_FIELDS {
        reference.insert(
            attribute.into(),
            json!(connection[attribute].as_str().unwrap_or_default()),
        );
    }
    Value::Object(reference)
}

/// The expression every OpenShell object and Fabric configuration takes as `gateway`.
pub(crate) fn gateway_ref_expression() -> String {
    format!("${{{GATEWAY_CAPABILITIES_ADDRESS}.ref}}")
}

fn graph_base(document: &Document, version: &str) -> Result<Value, ConfigError> {
    let connection = gateway_provider(&document.spec.gateway);
    let drivers = [document.spec.gateway.runtime().provider.openshell_driver()];
    let mut graph = json!({
        "terraform":{"required_version":format!("= {OPENTOFU_VERSION}"),"required_providers":{
            "openshell":{"source":OPENSHELL_PROVIDER_ADDRESS,"version":format!("= {version}")},
            "fabric":{"source":FABRIC_PROVIDER_ADDRESS,"version":format!("= {version}")},
            "vllm":{"source":VLLM_PROVIDER_ADDRESS,"version":format!("= {version}")},
            "ollama":{"source":OLLAMA_PROVIDER_ADDRESS,"version":format!("= {version}")},
            "host":{"source":HOST_PROVIDER_ADDRESS,"version":format!("= {version}")}
        }},
        // Each provider reaches the engines, clusters, and gateways named on
        // its resources; providers take at most `destroy`.
        "provider":{"openshell":{},"fabric":{},"vllm":{},"ollama":{},"host":{}}, "resource":{},
        "data":{"openshell_gateway":{"current":gateway_data(&connection, json!(drivers))}}
    });
    crate::discovery_graph::populate(&mut graph, document)?;
    Ok(graph)
}

fn compile_with_plans(
    document: &Document,
    version: &str,
    service_plans: &crate::services::InstallPlans,
    targets: &[Target],
) -> Result<Value, ConfigError> {
    let providers = document.selected_providers()?;
    let mut graph = graph_base(document, version)?;
    let mut resources = json!({});
    let provider_dependencies: BTreeMap<_, _> = targets
        .iter()
        .filter(|target| target.kind == "provider")
        .map(|target| (target.values["name"].clone(), target.address.clone()))
        .collect();
    let mut runtime_sources = BTreeMap::new();
    let mut profile_sources = BTreeMap::new();
    let mut ordered: Vec<_> = document.spec.sandboxes.iter().collect();
    ordered.sort_by_key(|sandbox| &sandbox.name);
    for (index, sandbox) in ordered.iter().enumerate() {
        let source = format!("data.fabric_harnesses.sandbox_{index}");
        runtime_sources.insert(sandbox.name.clone(), source.clone());
        for provider in document.sandbox_inference_providers(sandbox)? {
            profile_sources
                .entry(format!("nemoclaw-inference-{}", provider.key))
                .or_insert_with(|| source.clone());
        }
        if let Some(search) = document.web_search(sandbox)? {
            profile_sources
                .entry(
                    search
                        .provider
                        .image_profile(&document.image_scope(sandbox)?),
                )
                .or_insert(source);
        }
    }
    for target in targets {
        let mut attributes = serde_json::to_value(&target.values).expect("string map");
        if let Some(value) = attributes["credential_source"].as_str() {
            attributes["credential_source"] =
                json!(value.replace("${", "$${").replace("%{", "%%{"));
        }
        let agent = target.kind == "agent";
        if agent
            && target
                .values
                .get(nemoclaw_fabric::agent::DESCRIPTION)
                .is_some_and(String::is_empty)
        {
            attributes
                .as_object_mut()
                .expect("attribute object")
                .remove(nemoclaw_fabric::agent::DESCRIPTION);
        }
        // OpenShell objects and Fabric agents take typed inputs; their rows
        // carry the JSON.
        let structured = nemoclaw_openshell::structured_inputs(&target.kind)
            .into_iter()
            .chain(
                agent
                    .then(nemoclaw_fabric::agent::structured_inputs)
                    .into_iter()
                    .flatten(),
            );
        for input in structured {
            let encoded = attributes
                .as_object_mut()
                .expect("attribute object")
                .remove(input.field);
            if let Some(encoded) = encoded.as_ref().and_then(Value::as_str)
                && !encoded.is_empty()
            {
                let mut value = input.configuration(encoded).map_err(ConfigError::new)?;
                // Values are still OpenTofu templates; keep literal policy
                // paths and matchers intact through that interpretation.
                crate::docker_compute::literal(&mut value);
                attributes[input.attribute] = value;
            }
        }
        // Rows name other objects; OpenTofu takes their refs, which also
        // order those objects first.
        let references = if agent {
            nemoclaw_fabric::agent::references()
        } else {
            nemoclaw_openshell::references(&target.kind)
        };
        for reference in references {
            let object = attributes.as_object_mut().expect("attribute object");
            let carried: Vec<_> = reference
                .fields
                .iter()
                .filter_map(|(_, field)| object.remove(*field))
                .collect();
            if reference.kind == nemoclaw_openshell::GATEWAY_TYPE {
                attributes[reference.attribute] = json!(gateway_ref_expression());
                continue;
            }
            // An agent's harness is the one its sandbox's image read selects.
            if reference.kind == nemoclaw_fabric::agent::HARNESS_TYPE {
                let sandbox = &target.values[nemoclaw_fabric::agent::SANDBOX];
                attributes[reference.attribute] =
                    json!(format!("${{data.fabric_harness.{sandbox}.ref}}"));
                continue;
            }
            let Some(encoded) = carried.into_iter().next() else {
                continue;
            };
            let encoded = encoded.as_str().unwrap_or_default();
            if encoded.is_empty() {
                continue;
            }
            let address = |name: &str| {
                targets
                    .iter()
                    .find(|candidate| {
                        nemoclaw_openshell::type_name(&candidate.kind) == reference.kind
                            && candidate.values.get("name").map(String::as_str) == Some(name)
                    })
                    .map(|candidate| format!("${{{}.ref}}", candidate.address))
                    .ok_or_else(|| {
                        ConfigError::new(
                            "a reference names an object the deployment does not declare",
                        )
                    })
            };
            attributes[reference.attribute] = if reference.list {
                let names: Vec<String> = serde_json::from_str(encoded)
                    .map_err(|_| ConfigError::new("invalid reference list"))?;
                json!(
                    names
                        .iter()
                        .map(|name| address(name))
                        .collect::<Result<Vec<_>, _>>()?
                )
            } else {
                json!(address(encoded)?)
            };
        }
        if target.kind == "provider_profile" {
            attributes["binaries"] = json!(format!(
                "${{jsondecode({}.binaries_json)}}",
                profile_sources[&target.values["name"]]
            ));
        }
        if target.kind == "sandbox" {
            attributes
                .as_object_mut()
                .expect("sandbox attributes")
                .remove("agent_name");
            attributes["launch_json"] = json!(format!(
                "${{{}.launch_json}}",
                runtime_sources[&target.values["name"]]
            ));
            let sandbox = document.sandbox(&target.values["name"])?;
            let mut dependencies: Vec<_> = document
                .sandbox_inference_providers(sandbox)?
                .into_iter()
                .map(|provider| provider_dependencies[&provider.key].clone())
                .collect();
            if let Some(search) = document.web_search(sandbox)? {
                let name = crate::config::search_provider_name(
                    search.provider,
                    &search.credential.env,
                    &search
                        .provider
                        .image_profile(&document.image_scope(sandbox)?),
                );
                dependencies.push(provider_dependencies[&name].clone());
            }
            attributes["depends_on"] = json!(dependencies);
        }
        if let Some(dependencies) = service_plans.dependencies(&target.address) {
            attributes["depends_on"] = json!(dependencies);
        }
        if target.kind == "provider"
            && target
                .values
                .get("provider_type")
                .is_none_or(|kind| SearchProvider::from_name(kind).is_none())
        {
            let logical = target.address.split_once('.').unwrap().1;
            let mut dependencies = vec![format!("openshell_provider_profile.{logical}")];
            if let Some(selected) = providers
                .iter()
                .find(|provider| provider.key == target.values["name"])
                && let Some(service) = crate::services::resolve(document, selected.definition)?
            {
                dependencies.extend(service.resource_dependencies);
            }
            attributes["depends_on"] = json!(dependencies);
        }
        if target.kind == "provider"
            && target
                .values
                .get("provider_type")
                .and_then(|kind| SearchProvider::from_name(kind))
                .is_some()
        {
            let profile = targets
                .iter()
                .find(|candidate| {
                    candidate.kind == "provider_profile"
                        && candidate.values["name"] == target.values["profile_name"]
                })
                .expect("search profile target");
            attributes["depends_on"] = json!([profile.address]);
        }
        attributes
            .as_object_mut()
            .expect("resource attributes")
            .entry("depends_on")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("resource dependencies")
            .push(json!(GATEWAY_APPLY_CAPABILITIES_ADDRESS));
        attributes["lifecycle"] = json!({"precondition":[{
            "condition":format!("${{{GATEWAY_CAPABILITIES_ADDRESS}.compatible}}"),
            "error_message":gateway_error_message(GATEWAY_CAPABILITIES_ADDRESS)
        }]});
        if crate::backend::openshell_lifecycle(&target.kind)
            != Some(crate::backend::OpenShellLifecycle::Reconstructible)
        {
            attributes["lifecycle"]["prevent_destroy"] = json!(true);
        }
        let (kind, name) = target
            .address
            .split_once('.')
            .expect("internal resource address");
        resources
            .as_object_mut()
            .unwrap()
            .entry(kind)
            .or_insert_with(|| json!({}))[name] = attributes;
    }
    // timestamp() is unknown while planning. Its nonempty test becomes a
    // stable true at apply, forcing a fresh read without perpetual state drift.
    let mut apply_readiness = gateway_data(
        &gateway_provider(&document.spec.gateway),
        graph["data"]["openshell_gateway"]["current"]["required_compute_drivers"].clone(),
    );
    apply_readiness["read_trigger"] = json!("${timestamp() != \"\"}");
    apply_readiness["lifecycle"] = json!({"postcondition":[{
        "condition":"${self.compatible}",
        "error_message":gateway_error_message("self")
    }]});
    let agent_readiness: BTreeMap<_, _> = document
        .spec
        .sandboxes
        .iter()
        .map(|sandbox| {
            // The agent's ref names its sandbox and the document it applied.
            let readiness = json!({
                "gateway": gateway_ref_expression(),
                "agent": format!("${{{}.{}.ref}}", nemoclaw_fabric::agent::RESOURCE_TYPE, sandbox.name),
                // uuid() is unknown in a saved plan and records a unique observation
                // token, so failed applies cannot report stale health as a new result.
                "read_trigger": "${uuid()}",
                "lifecycle": {"postcondition":[{
                    "condition":"${self.ready}",
                    "error_message":"${self.error_message != null ? self.error_message : \"Fabric readiness could not be established; resources retained\"}"
                }]},
            });
            (sandbox.name.clone(), readiness)
        })
        .collect();
    graph["resource"] = resources;
    graph["data"]["fabric_agent_readiness"] = json!(agent_readiness);
    graph["data"]["openshell_gateway"]["apply"] = apply_readiness;
    Ok(graph)
}

#[path = "compile_runtime.rs"]
mod runtime;
pub(crate) use runtime::compiled_runtime;
pub use runtime::{compile_runtime, runtime_targets};

#[cfg(test)]
pub(crate) use runtime::runtime_graph;

#[path = "compile_teardown.rs"]
mod teardown;
pub use teardown::{CompiledTeardown, compile_teardown};
