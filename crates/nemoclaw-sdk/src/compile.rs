// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::InferenceProviderKind;

use crate::{
    backend::Row,
    config::{ConfigError, Document, InferenceProvider},
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

/// The kind of the `terraform_data` that holds an agent's configuration. A
/// changed configuration replaces the agent's sandbox through
/// `replace_triggered_by`, because Fabric starts one agent runtime per sandbox.
pub const AGENT_CONFIGURATION: &str = "agent_configuration";

/// The address of the `terraform_data` holding a sandbox's agent configuration.
pub fn agent_configuration_address(sandbox: &str) -> String {
    format!("terraform_data.agent_{sandbox}")
}

/// The OpenTofu resource type that reconciles a resource kind.
pub fn resource_type(kind: &str) -> String {
    nemoclaw_openshell::resource_type(kind)
        .or_else(|| nemoclaw_openshell::installation_type(kind))
        .or_else(|| crate::services::provider_types::runtime_type(kind).map(str::to_owned))
        .unwrap_or_else(|| match kind {
            "agent" => nemoclaw_fabric::agent::RESOURCE_TYPE.to_owned(),
            AGENT_CONFIGURATION => "terraform_data".to_owned(),
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
            provider_names.push(
                nemoclaw_openshell::search::web_search_names(
                    search.provider,
                    &search.credential.env,
                    &image_scope,
                )
                .1,
            );
        }
        let apis = document.apis(sandbox)?;
        for api in &apis {
            provider_names.push(api.registration(&image_scope));
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
        if let Some(config) = &sandbox.driver_config {
            values.insert(
                "driver_config_json".into(),
                serde_json::to_string(config).expect("driver configuration"),
            );
        }
        {
            // The agent's inputs are Fabric's configuration sections; the
            // sandbox fields name the sandbox whose ref the graph passes.
            let configuration = crate::fabric_config::for_sandbox(document, sandbox)?;
            let mut values = nemoclaw_fabric::agent::decompose(&configuration);
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
            result.push(Target {
                kind: AGENT_CONFIGURATION.into(),
                address: agent_configuration_address(&sandbox.name),
                values: [("input".into(), configuration.to_string())].into(),
            });
        }
        result.push(Target {
            kind: "sandbox".into(),
            address: format!("openshell_sandbox.{}", sandbox.name),
            values,
        });
        // One web search resource per provider, credential reference, and
        // image: sandboxes sharing all three share it.
        if let Some(search) = web_search {
            let mut target = Target {
                kind: "web_search".into(),
                address: format!(
                    "openshell_web_search.{}_{}_{}",
                    search.provider.name(),
                    image_scope,
                    search.credential.env.to_ascii_lowercase()
                ),
                values: [
                    ("workspace".into(), workspace.clone()),
                    ("name".into(), image_scope.clone()),
                    ("owner".into(), document.metadata.uid.clone()),
                    (
                        "generation".into(),
                        generation(generations, "provider")?.into(),
                    ),
                    ("provider_type".into(), search.provider.name().into()),
                    ("credential_env".into(), search.credential.env.clone()),
                ]
                .into(),
            };
            if let Some(name) = &search.sandbox_env {
                target.values.insert("sandbox_env".into(), name.clone());
            }
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
        // One API resource per definition and image: sandboxes sharing both
        // share it.
        for api in apis {
            let registration = api.registration(&image_scope);
            let mut target = Target {
                kind: "api".into(),
                address: format!("openshell_api.{}", registration.replace('-', "_")),
                values: [
                    ("workspace".into(), workspace.clone()),
                    ("name".into(), registration),
                    ("owner".into(), document.metadata.uid.clone()),
                    (
                        "generation".into(),
                        generation(generations, "provider")?.into(),
                    ),
                    ("endpoint".into(), api.api.endpoint.clone()),
                    ("credential_env".into(), api.api.credential.env.clone()),
                ]
                .into(),
            };
            if let Some(style) = api.api.auth_style {
                target
                    .values
                    .insert("auth_style".into(), style.name().into());
            }
            if let Some(header) = &api.api.header_name {
                target.values.insert("header_name".into(), header.clone());
            }
            if let Some(previous) = result.iter().find(|t| t.address == target.address) {
                if previous != &target {
                    return Err(ConfigError::new(
                        "api registration conflicts with an existing target",
                    ));
                }
            } else {
                result.push(target);
            }
        }
    }
    for provider in &providers {
        if let Some(source) =
            crate::services::credential_source_json(document, provider.definition, generations)?
        {
            result
                .iter_mut()
                .find(|r| r.kind == "inference" && r.values["name"] == provider.key)
                .unwrap()
                .values
                .insert("credential_source".into(), source);
        }
    }
    // OpenShell objects and Fabric configurations name their gateway.
    let gateway = gateway_values(document, generations)?;
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
) -> Result<[Target; 1], ConfigError> {
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
            "api".into(),
            match provider.provider {
                InferenceProviderKind::Anthropic => "anthropic-messages".into(),
                InferenceProviderKind::Openai => "openai-completions".into(),
            },
        ),
    ]
    .into();
    Ok([Target {
        kind: "inference".into(),
        address: format!("openshell_inference.{logical}"),
        values,
    }])
}

/// Compile only data. No filesystem access, backend calls, or runtime effects.
pub fn compile(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<Value, crate::Error> {
    deployment_graph(document, generations, version).map(|compiled| compiled.graph)
}

/// One deployment's graph: the runtime NemoClaw manages and the OpenShell and
/// Fabric objects it serves, planned and applied together.
pub(crate) struct Compiled {
    pub graph: Value,
    /// OpenShell and Fabric objects, and the containers that serve them.
    pub objects: Vec<Target>,
    /// The managed gateway, model servers, and their storage.
    pub runtime: Vec<Target>,
}

pub(crate) fn deployment_graph(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<Compiled, crate::Error> {
    let (mut graph, objects) = objects_graph(document, generations, version)?;
    let runtime = if document.has_runtime() {
        let (runtime_graph, runtime) = compiled_runtime(document, generations, version)?;
        join(&mut graph, runtime_graph)?;
        runtime
    } else {
        Vec::new()
    };
    Ok(Compiled {
        graph,
        objects,
        runtime,
    })
}

/// Add the runtime graph to the objects graph. Objects change only after the
/// runtime settles: each waits on the apply-time gateway read, which waits on
/// every runtime resource and readiness read.
fn join(graph: &mut Value, mut runtime: Value) -> Result<(), crate::Error> {
    let conflict =
        || crate::Error::State("runtime and objects graphs declare the same address differently");
    // The runtime graph's gateway read waits for the gateway it installs, so it
    // replaces the plan-time read of the same gateway.
    let current = runtime["data"]["openshell_gateway"]
        .as_object_mut()
        .and_then(|reads| reads.remove("current"));
    let mut gates: Vec<Value> = Vec::new();
    for section in ["resource", "data"] {
        for (kind, instances) in runtime[section].as_object().into_iter().flatten() {
            for (name, value) in instances.as_object().into_iter().flatten() {
                let slot = &mut graph[section][kind][name];
                if !slot.is_null() && slot != value {
                    return Err(conflict());
                }
                *slot = value.clone();
                let prefix = if section == "data" { "data." } else { "" };
                gates.push(json!(format!("{prefix}{kind}.{name}")));
            }
        }
    }
    for (name, value) in runtime["terraform"]["required_providers"]
        .as_object()
        .into_iter()
        .flatten()
    {
        let slot = &mut graph["terraform"]["required_providers"][name];
        if !slot.is_null() && slot != value {
            return Err(conflict());
        }
        *slot = value.clone();
    }
    for (name, value) in runtime["provider"].as_object().into_iter().flatten() {
        let slot = &mut graph["provider"][name];
        // Docker providers are aliased per engine; both graphs may reach one.
        if let (true, Some(added)) = (slot.is_array(), value.as_array()) {
            let existing = slot.as_array_mut().expect("provider list");
            for provider in added {
                if !existing.contains(provider) {
                    existing.push(provider.clone());
                }
            }
        } else if slot.is_null() || slot == value {
            *slot = value.clone();
        } else {
            return Err(conflict());
        }
    }
    // Variables, locals, outputs, and checks are maps of named blocks.
    for (block, entries) in runtime.as_object().into_iter().flatten() {
        if matches!(
            block.as_str(),
            "resource" | "data" | "terraform" | "provider"
        ) {
            continue;
        }
        for (name, value) in entries.as_object().into_iter().flatten() {
            let slot = &mut graph[block.as_str()][name];
            if !slot.is_null() && slot != value {
                return Err(conflict());
            }
            *slot = value.clone();
        }
    }
    let reads = &mut graph["data"]["openshell_gateway"];
    if let Some(current) = current {
        reads["current"] = current;
    } else {
        // A Kubernetes gateway's read waits for its installation instead.
        let installed: Vec<Value> = gates
            .iter()
            .filter(|gate| {
                gate.as_str().is_some_and(|address| {
                    address.starts_with(&format!(
                        "{}.",
                        resource_type(crate::kubernetes::GATEWAY_KIND)
                    ))
                })
            })
            .cloned()
            .collect();
        if !installed.is_empty() {
            reads["current"]["depends_on"] = json!(installed);
        }
    }
    let apply = &mut reads["apply"];
    let mut dependencies = apply["depends_on"].as_array().cloned().unwrap_or_default();
    dependencies.extend(gates);
    apply["depends_on"] = json!(dependencies);
    Ok(())
}

fn objects_graph(
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
    let mut raw = targets_with_plans(document, generations, &service_plans)?;
    let mut graph = compile_with_plans(document, generations, version, &service_plans, &raw)?;
    // Docker pulls sandbox images with the logins `spec.registries` selects.
    for (_, pull) in sandbox_image_pulls(document) {
        if !raw.iter().any(|target| target.address == pull.address) {
            raw.push(pull);
        }
    }
    crate::docker_compute::configure(&mut graph, &raw)
        .map_err(|_| ConfigError::new("invalid Docker compute graph"))?;
    crate::docker_compute::authenticate(&mut graph, &document.spec.registries);
    crate::services::configure_readiness(&mut graph, &raw)
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
fn gateway_values(
    document: &Document,
    generations: &Generations,
) -> Result<BTreeMap<String, String>, ConfigError> {
    let connection = gateway_connection(document, generations)?;
    Ok(nemoclaw_openshell::GATEWAY_FIELDS
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
        .collect())
}

/// How a deployment's objects reach its gateway: an endpoint and the
/// variables naming its credentials, or a managed Kubernetes gateway's
/// specification, from which providers connect themselves.
pub(crate) fn gateway_connection(
    document: &Document,
    generations: &Generations,
) -> Result<Value, ConfigError> {
    let gateway = &document.spec.gateway;
    let mut provider = json!({"endpoint":gateway.endpoint()});
    let invalid = || ConfigError::new("invalid managed Kubernetes gateway");
    if let Some(spec) =
        crate::kubernetes::gateway_spec(document, generations).map_err(|_| invalid())?
    {
        provider["kubernetes"] = json!(serde_json::to_string(&spec).map_err(|_| invalid())?);
        return Ok(provider);
    }
    if let Some(c) = gateway.credential() {
        provider["credential_env"] = json!(c.env);
    }
    if let Some(tls) = gateway.tls() {
        provider["tls_ca_env"] = json!(tls.ca.env);
        provider["tls_certificate_env"] = json!(tls.certificate.env);
        provider["tls_key_env"] = json!(tls.key.env);
    }
    Ok(provider)
}

/// The gateway's `ref` as a literal object, equal to what the gateway data
/// source exports. Objects take it so their gateway is known while planning,
/// even when the read waits for apply.
pub(crate) fn gateway_ref(
    document: &Document,
    generations: &Generations,
) -> Result<Value, ConfigError> {
    let connection = gateway_connection(document, generations)?;
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
    Ok(Value::Object(reference))
}

fn graph_base(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<Value, ConfigError> {
    let connection = gateway_connection(document, generations)?;
    let drivers = [document.spec.gateway.runtime().provider.openshell_driver()];
    let mut graph = json!({
        "terraform":{"required_providers":{
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

/// On Docker and Podman, the pull that precedes each sandbox image's reads, by
/// sandbox name. A Kubernetes sandbox, or one with a metadata bundle, reads
/// verified metadata instead and pulls nothing.
pub(crate) fn sandbox_image_pulls(document: &Document) -> BTreeMap<String, Target> {
    let engine = match &document.spec.gateway {
        _ if document.spec.gateway.runtime().provider.is_kubernetes() => return BTreeMap::new(),
        crate::config::Gateway::Managed(gateway) => gateway.engine.clone(),
        crate::config::Gateway::External(gateway) => gateway.engine.clone(),
    };
    document
        .spec
        .sandboxes
        .iter()
        .filter(|sandbox| sandbox.image.metadata.is_none() && !engine.is_empty())
        .map(|sandbox| {
            let name = sandbox.image.ref_.clone();
            (
                sandbox.name.clone(),
                Target {
                    kind: "docker_image".into(),
                    address: format!(
                        "docker_image.image_{}",
                        crate::docker_compute::digest(&engine, &name)
                    ),
                    values: Row::from([("engine".into(), engine.clone()), ("name".into(), name)]),
                },
            )
        })
        .collect()
}

fn compile_with_plans(
    document: &Document,
    generations: &Generations,
    version: &str,
    service_plans: &crate::services::InstallPlans,
    targets: &[Target],
) -> Result<Value, ConfigError> {
    let providers = document.selected_providers()?;
    let mut graph = graph_base(document, generations, version)?;
    let mut resources = json!({});
    // Objects take the gateway's ref as a literal, known while planning; the
    // gateway reads gate them through depends_on and a precondition.
    let gateway = gateway_ref(document, generations)?;
    let provider_dependencies: BTreeMap<_, _> = targets
        .iter()
        .filter_map(|target| {
            nemoclaw_openshell::registration_name(&target.kind, &target.values)
                .map(|name| (name, target.address.clone()))
        })
        .collect();
    let mut runtime_sources = BTreeMap::new();
    let mut profile_sources = BTreeMap::new();
    let mut ordered: Vec<_> = document.spec.sandboxes.iter().collect();
    ordered.sort_by_key(|sandbox| &sandbox.name);
    let pulls = sandbox_image_pulls(document);
    for (index, sandbox) in ordered.iter().enumerate() {
        let mut source = format!("data.fabric_harnesses.sandbox_{index}");
        if let Some(pull) = pulls.get(&sandbox.name) {
            // The sandbox and its agent use reads that wait for the pull: an
            // unknown image ID defers them to apply. The plan-time discovery
            // read stays, and accepts an image the engine doesn't hold yet.
            let image_id = json!(format!("${{{}.image_id}}", pull.address));
            let discovered = graph["data"]["fabric_harnesses"][format!("sandbox_{index}")].clone();
            let mut acquired = discovered.clone();
            acquired["image_id"] = image_id.clone();
            acquired["lifecycle"]["postcondition"][1]["condition"] =
                json!("${self.runtime_json != \"\"}");
            graph["data"]["fabric_harnesses"][format!("sandbox_{index}_acquired")] = acquired;
            let literal = |value: &str| value.replace("${", "$${").replace("%{", "%%{");
            let requirements =
                crate::fabric_capabilities::requirements_for_sandbox(document, sandbox)?;
            graph["data"]["fabric_harness"][format!("{}_acquired", sandbox.name)] = json!({
                "image": discovered["image"],
                "engine": discovered["engine"],
                "image_id": image_id,
                "adapter_id": literal(
                    requirements.configuration["harness"]["adapter_id"]
                        .as_str()
                        .unwrap_or_default()
                ),
                "agent_name": literal(&sandbox.agent.name),
            });
            source = format!("data.fabric_harnesses.sandbox_{index}_acquired");
        }
        runtime_sources.insert(sandbox.name.clone(), source.clone());
        for provider in document.sandbox_inference_providers(sandbox)? {
            profile_sources
                .entry(format!("nemoclaw-inference-{}", provider.key))
                .or_insert_with(|| source.clone());
        }
        if document.web_search(sandbox)?.is_some() {
            profile_sources
                .entry(format!("web_search:{}", document.image_scope(sandbox)?))
                .or_insert_with(|| source.clone());
        }
        for api in document.apis(sandbox)? {
            profile_sources
                .entry(format!(
                    "api:{}",
                    api.registration(&document.image_scope(sandbox)?)
                ))
                .or_insert_with(|| source.clone());
        }
    }
    for target in targets {
        if target.kind == AGENT_CONFIGURATION {
            // Only OpenTofu reads it, so it takes no OpenShell rules; like the
            // objects, it waits for the apply-time gateway check, so a failed
            // runtime leaves none behind.
            let (kind, name) = target
                .address
                .split_once('.')
                .expect("internal resource address");
            let input = target.values["input"]
                .replace("${", "$${")
                .replace("%{", "%%{");
            resources
                .as_object_mut()
                .unwrap()
                .entry(kind)
                .or_insert_with(|| json!({}))[name] = json!({
                "input": input,
                "depends_on": [GATEWAY_APPLY_CAPABILITIES_ADDRESS],
            });
            continue;
        }
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
                crate::services::literal(&mut value);
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
                attributes[reference.attribute] = gateway.clone();
                continue;
            }
            // The server a registration reaches, as the ref a readiness read
            // would export for it.
            if reference.kind == nemoclaw_openshell::INFERENCE_SERVER_TYPE {
                let mut server = json!({"type": nemoclaw_openshell::INFERENCE_SERVER_TYPE});
                for (attribute, field) in &reference.fields {
                    let value = target.values.get(*field).cloned().unwrap_or_default();
                    server[*attribute] = json!(value.replace("${", "$${").replace("%{", "%%{"));
                }
                attributes[reference.attribute] = server;
                continue;
            }
            // An agent's harness is the one its sandbox's image read selects.
            if reference.kind == nemoclaw_fabric::agent::HARNESS_TYPE {
                let sandbox = &target.values[nemoclaw_fabric::agent::SANDBOX];
                let harness = if pulls.contains_key(sandbox) {
                    format!("{sandbox}_acquired")
                } else {
                    sandbox.clone()
                };
                attributes[reference.attribute] =
                    json!(format!("${{data.fabric_harness.{harness}.ref}}"));
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
                        nemoclaw_openshell::ref_type(&candidate.kind) == reference.kind
                            && if reference.kind == nemoclaw_openshell::PROVIDER_TYPE {
                                nemoclaw_openshell::registration_name(
                                    &candidate.kind,
                                    &candidate.values,
                                )
                                .as_deref()
                                    == Some(name)
                            } else {
                                candidate.values.get("name").map(String::as_str) == Some(name)
                            }
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
        if target.kind == "inference" {
            attributes["binaries"] = json!(format!(
                "${{jsondecode({}.binaries_json)}}",
                profile_sources[&format!("nemoclaw-inference-{}", target.values["name"])]
            ));
        }
        if target.kind == "web_search" {
            attributes["binaries"] = json!(format!(
                "${{jsondecode({}.binaries_json)}}",
                profile_sources[&format!("web_search:{}", target.values["name"])]
            ));
        }
        if target.kind == "api" {
            attributes["binaries"] = json!(format!(
                "${{jsondecode({}.binaries_json)}}",
                profile_sources[&format!("api:{}", target.values["name"])]
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
                let name = nemoclaw_openshell::search::web_search_names(
                    search.provider,
                    &search.credential.env,
                    &document.image_scope(sandbox)?,
                )
                .1;
                dependencies.push(provider_dependencies[&name].clone());
            }
            let image_scope = document.image_scope(sandbox)?;
            for api in document.apis(sandbox)? {
                dependencies.push(provider_dependencies[&api.registration(&image_scope)].clone());
            }
            attributes["depends_on"] = json!(dependencies);
        }
        if let Some(dependencies) = service_plans.dependencies(&target.address) {
            attributes["depends_on"] = json!(dependencies);
        }
        if target.kind == "inference" {
            let mut dependencies = Vec::new();
            if let Some(selected) = providers
                .iter()
                .find(|provider| provider.key == target.values["name"])
                && let Some(service) = crate::services::resolve(document, selected.definition)?
            {
                dependencies.extend(service.resource_dependencies);
            }
            attributes["depends_on"] = json!(dependencies);
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
        if target.kind == "sandbox" {
            let (_, name) = target
                .address
                .split_once('.')
                .expect("internal resource address");
            attributes["lifecycle"]["replace_triggered_by"] =
                json!([agent_configuration_address(name)]);
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
        &gateway_connection(document, generations)?,
        graph["data"]["openshell_gateway"]["current"]["required_compute_drivers"].clone(),
    );
    apply_readiness["read_trigger"] = json!("${timestamp() != \"\"}");
    // A managed gateway may have started moments earlier in this apply, and
    // a Podman gateway has no other readiness check, so the read waits for it
    // as the plan-time read does.
    if document.spec.gateway.as_managed().is_some() {
        apply_readiness["wait_timeout_seconds"] = json!(90);
    }
    apply_readiness["lifecycle"] = json!({"postcondition":[{
        "condition":"${self.compatible}",
        "error_message":gateway_error_message("self")
    }]});
    graph["resource"] = resources;
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
