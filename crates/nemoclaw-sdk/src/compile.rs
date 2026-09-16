// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    backend::Row,
    config::{ConfigError, Document},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

pub const PROVIDER_ADDRESS: &str = "registry.opentofu.org/nvidia/nemoclaw";
pub const OPENTOFU_VERSION: &str = "1.12.6";
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
        .ok_or(ConfigError("missing resource generation"))
}
pub fn targets(document: &Document, generations: &Generations) -> Result<Vec<Target>, ConfigError> {
    document.validate()?;
    let workspace = document.workspace();
    let provider = document.inference_provider()?;
    let connection = document.inference_connection()?;
    let sandbox = &document.spec.sandboxes[0];
    let agent = &sandbox.agents[0];
    let mut result = Vec::new();
    for (kind, name, logical, generation_kind, extra) in [
        (
            "workspace",
            workspace.as_str(),
            "deployment",
            "workspace",
            vec![],
        ),
        (
            "provider",
            provider.name.as_str(),
            "inference",
            "provider",
            vec![
                ("endpoint", connection.endpoint.clone()),
                (
                    "credential_env",
                    connection
                        .credential
                        .as_ref()
                        .map(|c| c.env.clone())
                        .unwrap_or_default(),
                ),
                (
                    "provider_type",
                    if provider.provider == "anthropic" {
                        "anthropic"
                    } else {
                        ""
                    }
                    .into(),
                ),
            ],
        ),
        (
            "route",
            "primary",
            "primary",
            "workspace",
            vec![
                ("provider_name", provider.name.clone()),
                ("model", agent.inference.routes[0].overrides.model.clone()),
            ],
        ),
        (
            "sandbox",
            sandbox.name.as_str(),
            "agent",
            "sandbox",
            vec![
                ("image", sandbox.image.ref_.clone()),
                ("agent_name", agent.name.clone()),
                ("agent_runtime", agent.runtime()),
            ],
        ),
    ] {
        let mut values: Row = [
            ("name", name),
            ("owner", document.metadata.uid.as_str()),
            ("generation", generation(generations, generation_kind)?),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        if kind != "workspace" {
            values.insert("workspace".into(), workspace.clone());
        }
        values.extend(extra.into_iter().map(|(k, v)| (k.into(), v)));
        if kind == "sandbox" {
            if let Some(settings) = document.runtime_inference()? {
                values.insert(
                    "inference_json".into(),
                    serde_json::to_string(&settings).expect("typed inference settings"),
                );
            }
            let policy = crate::openshell::policy_json(
                &sandbox.policy_proto(document.web_search()?.is_some())?,
            )
            .map_err(|_| ConfigError("cannot encode sandbox policy"))?;
            if !policy.is_empty() {
                values.insert("policy_json".into(), policy);
            }
            if let Some(proxy) = &sandbox.network.proxy {
                values.insert("proxy_host".into(), proxy.host.clone());
                values.insert("proxy_port".into(), proxy.port.to_string());
            }
        }
        result.push(Target {
            kind: kind.into(),
            address: format!("nemoclaw_{kind}.{logical}"),
            values,
        });
    }
    if let Some(search) = document.web_search()? {
        for (kind, name) in [
            ("provider_profile", "nemoclaw-brave"),
            ("provider", "brave-search"),
        ] {
            let mut values: Row = [
                ("workspace", workspace.as_str()),
                ("name", name),
                ("owner", document.metadata.uid.as_str()),
                ("generation", generation(generations, "provider")?),
            ]
            .into_iter()
            .map(|(k, v)| (k.into(), v.into()))
            .collect();
            if kind == "provider" {
                values.extend([
                    ("endpoint".into(), "https://api.search.brave.com".into()),
                    ("credential_env".into(), search.credential.env.clone()),
                    ("provider_type".into(), "brave".into()),
                ]);
            }
            result.push(Target {
                kind: kind.into(),
                address: format!("nemoclaw_{kind}.web_search"),
                values,
            });
        }
    }
    if provider
        .service
        .as_ref()
        .is_some_and(|s| s.authentication.is_some())
    {
        let spec = runtime_targets(document, generations)
            .map_err(|_| ConfigError("invalid managed credential source"))?
            .into_iter()
            .find(|t| t.kind == crate::managed::SERVICE_KIND)
            .ok_or(ConfigError("missing managed credential source"))?
            .values["spec"]
            .clone();
        let source = crate::inference_auth::Source::ManagedService {
            spec: serde_json::from_str(&spec)
                .map_err(|_| ConfigError("invalid managed credential source"))?,
        };
        result
            .iter_mut()
            .find(|r| r.address == "nemoclaw_provider.inference")
            .unwrap()
            .values
            .insert("credential_source".into(), source.json()?);
    }
    if let Some(proxy) = &provider.ollama_proxy {
        let spec = crate::ollama::proxy::specification(document, generations)
            .map_err(|_| ConfigError("invalid Ollama proxy specification"))?;
        let source = crate::inference_auth::Source::OllamaProxy {
            engine: proxy.engine.clone(),
            spec: Box::new(spec),
        };
        result
            .iter_mut()
            .find(|r| r.address == "nemoclaw_provider.inference")
            .unwrap()
            .values
            .insert("credential_source".into(), source.json()?);
        result.extend(
            crate::ollama::proxy::targets(document, generations)
                .map_err(|_| ConfigError("invalid proxy resources"))?,
        );
    }
    Ok(result)
}

/// Compile only data. No filesystem access, backend calls, or runtime effects.
pub fn compile(
    document: &Document,
    generations: &Generations,
    version: &str,
) -> Result<Value, ConfigError> {
    let targets = targets(document, generations)?;
    let gateway = &document.spec.gateway;
    let inference = document.inference_provider()?;
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
            .ok_or(ConfigError("invalid Ollama endpoint"))?
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
            "model":document.spec.sandboxes[0].agents[0].inference.routes[0].overrides.model,
            "lifecycle":{"prevent_destroy":true}
        }});
    }
    for target in targets {
        let mut attributes = serde_json::to_value(&target.values).expect("string map");
        if target.values.contains_key("workspace") {
            attributes["workspace"] = json!("${nemoclaw_workspace.deployment.name}");
        }
        if target.kind == "route" {
            attributes["provider_name"] = json!("${nemoclaw_provider.inference.name}");
            if inference.ollama.is_some() {
                attributes["depends_on"] = json!(["nemoclaw_ollama_model.inference"]);
            }
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
            attributes["depends_on"] = if document.web_search()?.is_some() {
                json!(["nemoclaw_route.primary", "nemoclaw_provider.web_search"])
            } else {
                json!(["nemoclaw_route.primary"])
            };
        }
        match target.address.as_str() {
            "nemoclaw_provider.inference" if inference.ollama_proxy.is_some() => {
                attributes["depends_on"] = json!(["nemoclaw_ollama_proxy.service"]);
            }
            "nemoclaw_ollama_proxy.service" => {
                attributes["depends_on"] = json!([
                    "nemoclaw_ollama_proxy_storage.credentials",
                    "nemoclaw_ollama_external_model.inference"
                ]);
            }
            _ => {}
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
