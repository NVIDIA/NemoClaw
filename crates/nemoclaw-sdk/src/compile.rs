// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
pub fn targets(document: &Document, generations: &Generations) -> Result<Vec<Target>, ConfigError> {
    document.validate()?;
    let workspace = document.workspace();
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
    for provider in document.selected_inference_providers()? {
        result.extend(inference_targets(document, provider, generations)?);
    }
    let mut sandboxes: Vec<_> = document.spec.sandboxes.iter().collect();
    sandboxes.sort_by_key(|sandbox| &sandbox.name);
    for sandbox in sandboxes {
        let harness = document.sandbox_harness(sandbox)?;
        let settings = document.sandbox_runtime_settings(sandbox)?;
        let agent_name = if harness.kind == "openclaw" {
            &sandbox.name
        } else {
            &sandbox.sole_agent()?.name
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
            let connection = document.provider_connection(provider)?;
            let profile = crate::openshell::inference_profile(
                &document.provider_key(provider),
                &connection.endpoint,
                &provider.provider,
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
        result.push(Target {
            kind: "sandbox".into(),
            address: format!("nemoclaw_sandbox.{}", sandbox.name),
            values,
        });
        if let Some(search) = settings.web_search {
            for (kind, name) in [
                ("provider_profile", "nemoclaw-brave"),
                ("provider", "brave-search"),
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
                    address: format!("nemoclaw_{kind}.web_search"),
                    values,
                };
                if let Some(previous) = result.iter().find(|t| t.address == target.address) {
                    if previous != &target {
                        return Err(ConfigError::new(
                            "sandboxes sharing web search must use the same provider credential",
                        ));
                    }
                } else {
                    result.push(target);
                }
            }
        }
    }
    let provider = document.lifecycle_provider()?;
    if provider
        .service
        .as_ref()
        .is_some_and(|s| s.authentication.is_some())
    {
        let spec = runtime_targets(document, generations)
            .map_err(|_| ConfigError::new("invalid managed credential source"))?
            .into_iter()
            .find(|t| t.kind == crate::managed::SERVICE_KIND)
            .ok_or(ConfigError::new("missing managed credential source"))?
            .values["spec"]
            .clone();
        let source = crate::inference_auth::Source::ManagedService {
            spec: serde_json::from_str(&spec)
                .map_err(|_| ConfigError::new("invalid managed credential source"))?,
        };
        result
            .iter_mut()
            .find(|r| r.kind == "provider" && r.values["name"] == document.provider_key(provider))
            .unwrap()
            .values
            .insert("credential_source".into(), source.json()?);
    }
    if let Some(proxy) = &provider.ollama_proxy {
        let spec = crate::ollama::proxy::specification(document, generations)
            .map_err(|_| ConfigError::new("invalid Ollama proxy specification"))?;
        let source = crate::inference_auth::Source::OllamaProxy {
            engine: proxy.engine.clone(),
            spec: Box::new(spec),
        };
        result
            .iter_mut()
            .find(|r| r.kind == "provider" && r.values["name"] == document.provider_key(provider))
            .unwrap()
            .values
            .insert("credential_source".into(), source.json()?);
        result.extend(
            crate::ollama::proxy::targets(document, generations)
                .map_err(|_| ConfigError::new("invalid proxy resources"))?,
        );
    }
    Ok(result)
}

fn inference_targets(
    document: &Document,
    provider: &InferenceProvider,
    generations: &Generations,
) -> Result<[Target; 2], ConfigError> {
    let connection = document.provider_connection(provider)?;
    let logical = format!("inference_{}", document.provider_key(provider));
    let values: Row = [
        ("workspace".into(), document.workspace()),
        ("name".into(), document.provider_key(provider)),
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
            if provider.provider == "anthropic" {
                "anthropic".into()
            } else {
                String::new()
            },
        ),
    ]
    .into();
    let mut profile = values.clone();
    profile.insert(
        "name".into(),
        format!("nemoclaw-inference-{}", document.provider_key(provider)),
    );
    profile.remove("credential_env");
    profile.insert("authenticated".into(), provider.authenticated().to_string());
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
    let targets = targets(document, generations)?;
    let gateway = &document.spec.gateway;
    let inference = document.lifecycle_provider()?;
    let mut provider = json!({"endpoint":gateway.endpoint});
    if let Some(c) = &gateway.credential {
        provider["credential_env"] = json!(c.env);
    }
    if let Some(tls) = &gateway.tls {
        provider["tls_ca_env"] = json!(tls.ca.env);
        provider["tls_certificate_env"] = json!(tls.certificate.env);
        provider["tls_key_env"] = json!(tls.key.env);
    }
    if let Some(proxy) = &inference.ollama_proxy {
        provider["ollama_engine"] = json!(proxy.engine);
    }
    let mut resources = json!({});
    if let Some(ollama) = &inference.ollama {
        provider["ollama_engine"] = json!(ollama.engine);
        let authority = inference
            .endpoint
            .strip_prefix("http://")
            .ok_or(ConfigError::new("invalid Ollama endpoint"))?
            .split('/')
            .next()
            .unwrap_or("");
        resources["nemoclaw_ollama"] = json!({"service":{
            "name":format!("{}-ollama",document.workspace()),"owner":document.metadata.uid,
            "generation":generation(generations,"ollama")?,"image":ollama.image,"network":ollama.network.name(),
            "bind_address":authority,"running":"true","lifecycle":{"prevent_destroy":true}
        }});
        let mut storage = resources["nemoclaw_ollama"]["service"].clone();
        storage.as_object_mut().unwrap().remove("running");
        resources["nemoclaw_ollama_storage"] = json!({"models": storage});
        resources["nemoclaw_ollama"]["service"]["depends_on"] =
            json!(["nemoclaw_ollama_storage.models"]);
        resources["nemoclaw_ollama_model"] = json!({"inference":{
            "service_id":"${nemoclaw_ollama.service.id}","endpoint":inference.endpoint,
            "model":document.provider_model(inference)?,
            "lifecycle":{"prevent_destroy":true}
        }});
    }
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
        if target.address == "nemoclaw_ollama_proxy.service" {
            attributes["depends_on"] = json!([
                "nemoclaw_ollama_proxy_storage.credentials",
                "nemoclaw_ollama_external_model.inference"
            ]);
        }
        if target.kind == "provider" && target.address != "nemoclaw_provider.web_search" {
            let logical = target.address.split_once('.').unwrap().1;
            let mut dependencies = vec![format!("nemoclaw_provider_profile.{logical}")];
            if target.values["name"] == document.provider_key(inference) {
                if inference.ollama.is_some() {
                    dependencies.push("nemoclaw_ollama_model.inference".into());
                }
                if inference.ollama_proxy.is_some() {
                    dependencies.push("nemoclaw_ollama_proxy.service".into());
                }
            }
            attributes["depends_on"] = json!(dependencies);
        }
        if target.address == "nemoclaw_provider.web_search" {
            attributes["depends_on"] = json!(["nemoclaw_provider_profile.web_search"]);
        }
        attributes["lifecycle"] = json!({"prevent_destroy":true});
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
    Ok(
        json!({"terraform":{"required_version":format!("= {OPENTOFU_VERSION}"),"required_providers":{"nemoclaw":{"source":PROVIDER_ADDRESS,"version":format!("= {version}")}}},"provider":{"nemoclaw":provider},"resource":resources}),
    )
}

#[path = "compile_runtime.rs"]
mod runtime;
pub use runtime::{compile_runtime, runtime_targets};
