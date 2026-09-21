// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::config::{HarnessKind, InferenceProviderKind};

use crate::{
    backend::Row,
    config::{ConfigError, Document, InferenceProvider},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const PROVIDER_ADDRESS: &str = "registry.opentofu.org/nvidia/nemoclaw";
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
        address: "nemoclaw_workspace.deployment".into(),
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
        let harness = document.sandbox_harness(sandbox)?;
        let settings = document.sandbox_runtime_settings(sandbox)?;
        // OpenClaw's hosted runtime identity remains the sandbox name; its native agent
        // identity is carried separately in the runtime settings.
        let agent_name = if harness.kind == HarnessKind::OpenClaw {
            &sandbox.name
        } else {
            &sandbox.agent.name
        };
        let mut values: Row = [
            ("name".into(), sandbox.name.clone()),
            ("workspace".into(), workspace.clone()),
            ("owner".into(), document.metadata.uid.clone()),
            (
                "generation".into(),
                generation(generations, "sandbox")?.into(),
            ),
            ("image".into(), sandbox.image.ref_.clone()),
            ("agent_name".into(), agent_name.clone()),
            ("agent_runtime".into(), harness.runtime()),
            (
                "inference_json".into(),
                serde_json::to_string(&settings).expect("typed sandbox settings"),
            ),
        ]
        .into();
        let mut policy = sandbox.policy_proto(
            settings.web_search.is_some(),
            harness.observability.as_ref(),
        )?;
        for provider in document.sandbox_inference_providers(sandbox)? {
            let connection = document.provider_connection(provider.definition)?;
            let profile = crate::openshell::inference_profile(
                &provider.key,
                &connection.endpoint,
                provider.definition.provider,
                false,
            )
            .map_err(|_| ConfigError::new("invalid native inference policy"))?;
            if policy.network_policies.contains_key(&profile.id) {
                return Err(ConfigError::new("inference policy name is reserved"));
            }
            policy.network_policies.insert(
                profile.id.clone(),
                openshell_core::proto::NetworkPolicyRule {
                    name: profile.id,
                    endpoints: profile.endpoints,
                    binaries: profile.binaries,
                },
            );
        }
        values.insert(
            "policy_json".into(),
            crate::openshell::policy_json(&policy)
                .map_err(|_| ConfigError::new("cannot encode sandbox policy"))?,
        );
        if let Some(proxy) = &sandbox.network.proxy {
            values.insert("proxy_host".into(), proxy.host.clone());
            values.insert("proxy_port".into(), proxy.port.to_string());
        }
        if harness.kind == HarnessKind::Pi {
            result.push(Target {
                kind: "pi_configuration".into(),
                address: format!("nemoclaw_pi_configuration.{}", sandbox.name),
                values: [
                    ("workspace".into(), workspace.clone()),
                    ("name".into(), sandbox.name.clone()),
                    ("owner".into(), document.metadata.uid.clone()),
                    (
                        "generation".into(),
                        generation(generations, "sandbox")?.into(),
                    ),
                    (
                        "sandbox_id".into(),
                        format!("${{nemoclaw_sandbox.{}.id}}", sandbox.name),
                    ),
                    (
                        "model_json".into(),
                        serde_json::to_string(
                            &document
                                .sandbox_inference(sandbox)?
                                .default_route()?
                                .overrides,
                        )
                        .expect("typed Pi model settings"),
                    ),
                ]
                .into(),
            });
        }
        result.push(Target {
            kind: "sandbox".into(),
            address: format!("nemoclaw_sandbox.{}", sandbox.name),
            values,
        });
        if let Some(search) = settings.web_search {
            let provider_name = crate::config::search_provider_name(&search.credential.env);
            for (kind, name) in [
                ("provider_profile", "nemoclaw-brave"),
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
                        ("endpoint".into(), "https://api.search.brave.com".into()),
                        ("credential_env".into(), search.credential.env.clone()),
                        ("provider_type".into(), "brave".into()),
                    ]);
                }
                let target = Target {
                    kind: kind.into(),
                    address: if kind == "provider" {
                        format!(
                            "nemoclaw_provider.web_search_{}",
                            provider_name.strip_prefix("brave-search-").unwrap()
                        )
                    } else {
                        "nemoclaw_provider_profile.web_search".into()
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
            address: format!("nemoclaw_provider_profile.{logical}"),
            values: profile,
        },
        Target {
            kind: "provider".into(),
            address: format!("nemoclaw_provider.{logical}"),
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
    document.validate()?;
    let service_plans = service_plans(
        document,
        generations,
        crate::services::InstallStage::Deployment,
    )?;
    let mut graph = compile_with_plans(document, generations, version, &service_plans)?;
    let raw = targets_with_plans(document, generations, &service_plans)?;
    crate::docker_compute::configure(&mut graph, &raw)
        .map_err(|_| ConfigError::new("invalid Docker compute graph"))?;
    Ok(graph)
}

pub(crate) const GATEWAY_CAPABILITIES_ADDRESS: &str = "data.nemoclaw_gateway_capabilities.current";
pub(crate) const GATEWAY_APPLY_CAPABILITIES_ADDRESS: &str =
    "data.nemoclaw_gateway_capabilities.apply";

pub(crate) fn is_gateway_observation(address: &str) -> bool {
    [
        GATEWAY_CAPABILITIES_ADDRESS,
        GATEWAY_APPLY_CAPABILITIES_ADDRESS,
    ]
    .contains(&address)
}

// Both graphs report the provider's observation through OpenTofu conditions.
pub(super) fn gateway_error_message(reference: &str) -> String {
    let message = "Gateway version or compute driver does not satisfy the configuration. Required version: %s; observed version: %s. Required drivers: %s; observed entries: %d; names: %s. Retain state, correct gateway compatibility, and reapply the same configuration.";
    format!(
        "${{format({}, {}, {reference}.gateway_version, jsonencode({reference}.required_compute_drivers), {reference}.compute_driver_count, jsonencode({reference}.compute_drivers))}}",
        serde_json::to_string(message).expect("literal diagnostic"),
        serde_json::to_string(crate::artifact_pins::OPENSHELL_VERSION).expect("pinned version"),
    )
}

pub(super) fn compile_with_plans(
    document: &Document,
    generations: &Generations,
    version: &str,
    service_plans: &crate::services::InstallPlans,
) -> Result<Value, ConfigError> {
    let targets = targets_with_plans(document, generations, service_plans)?;
    let providers = document.selected_providers()?;
    let gateway = &document.spec.gateway;
    let mut provider = json!({"endpoint":gateway.endpoint()});
    if let Some(c) = gateway.credential() {
        provider["credential_env"] = json!(c.env);
    }
    if let Some(tls) = gateway.tls() {
        provider["tls_ca_env"] = json!(tls.ca.env);
        provider["tls_certificate_env"] = json!(tls.certificate.env);
        provider["tls_key_env"] = json!(tls.key.env);
    }
    let mut resources = json!({});
    let provider_dependencies: Vec<_> = targets
        .iter()
        .filter(|target| target.kind == "provider")
        .map(|target| target.address.clone())
        .collect();
    for target in targets {
        let mut attributes = serde_json::to_value(&target.values).expect("string map");
        if target.values.contains_key("workspace") {
            attributes["workspace"] = json!("${nemoclaw_workspace.deployment.name}");
        }
        if let Some(value) = attributes["credential_source"].as_str() {
            attributes["credential_source"] =
                json!(value.replace("${", "$${").replace("%{", "%%{"));
        }
        if target.kind == "pi_configuration" {
            let model = attributes["model_json"].as_str().expect("Pi model JSON");
            attributes["model_json"] = json!(model.replace("${", "$${").replace("%{", "%%{"));
        }
        if target.kind == "sandbox" {
            // JSON configuration strings are still OpenTofu templates. Preserve
            // literal policy paths and matchers across that interpretation layer.
            for field in ["policy_json", "inference_json"] {
                if let Some(value) = attributes[field].as_str() {
                    attributes[field] = json!(value.replace("${", "$${").replace("%{", "%%{"));
                }
            }
            attributes["depends_on"] = json!(provider_dependencies);
        }
        if let Some(dependencies) = service_plans.dependencies(&target.address) {
            attributes["depends_on"] = json!(dependencies);
        }
        if target.kind == "provider"
            && target
                .values
                .get("provider_type")
                .is_none_or(|kind| kind != "brave")
        {
            let logical = target.address.split_once('.').unwrap().1;
            let mut dependencies = vec![format!("nemoclaw_provider_profile.{logical}")];
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
                .is_some_and(|kind| kind == "brave")
        {
            attributes["depends_on"] = json!(["nemoclaw_provider_profile.web_search"]);
        }
        attributes
            .as_object_mut()
            .expect("resource attributes")
            .entry("depends_on")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .expect("resource dependencies")
            .push(json!(GATEWAY_APPLY_CAPABILITIES_ADDRESS));
        attributes["lifecycle"] = json!({"prevent_destroy":true, "precondition":[{
            "condition":format!("${{{GATEWAY_CAPABILITIES_ADDRESS}.compatible}}"),
            "error_message":gateway_error_message(GATEWAY_CAPABILITIES_ADDRESS)
        }]});
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
    let drivers: std::collections::BTreeSet<_> = document
        .spec
        .sandboxes
        .iter()
        .map(|sandbox| &sandbox.runtime.provider)
        .collect();
    // timestamp() is unknown while planning. Its nonempty test becomes a
    // stable true at apply, forcing a fresh read without perpetual state drift.
    let apply_readiness = json!({
        "required_compute_drivers":drivers,
        "read_trigger":"${timestamp() != \"\"}",
        "lifecycle":{"postcondition":[{
            "condition":"${self.compatible}",
            "error_message":gateway_error_message("self")
        }]}
    });
    Ok(json!({
        "terraform":{"required_version":format!("= {OPENTOFU_VERSION}"),"required_providers":{"nemoclaw":{"source":PROVIDER_ADDRESS,"version":format!("= {version}")}}},
        "provider":{"nemoclaw":provider}, "resource":resources,
        "data":{"nemoclaw_gateway_capabilities":{
            "current":{"required_compute_drivers":drivers},
            "apply":apply_readiness
        }}
    }))
}

#[path = "compile_runtime.rs"]
mod runtime;
pub use runtime::{compile_runtime, runtime_targets};

#[cfg(test)]
pub(crate) use runtime::runtime_graph;
