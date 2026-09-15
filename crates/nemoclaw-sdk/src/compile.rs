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
    let provider = &document.spec.inference_providers[0];
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
            if let Some(settings) = document.runtime_inference() {
                values.insert(
                    "inference_json".into(),
                    serde_json::to_string(&settings).expect("typed inference settings"),
                );
            }
            if sandbox.network.policy.is_some() {
                values.insert(
                    "policy_json".into(),
                    crate::openshell::policy_json(&sandbox.network.policy_proto()?)
                        .map_err(|_| ConfigError("cannot encode sandbox policy"))?,
                );
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
    let inference = &document.spec.inference_providers[0];
    let mut provider = json!({"endpoint":gateway.endpoint});
    if let Some(c) = &gateway.credential {
        provider["credential_env"] = json!(c.env);
    }
    if let Some(tls) = &gateway.tls {
        provider["tls_ca_env"] = json!(tls.ca.env);
        provider["tls_certificate_env"] = json!(tls.certificate.env);
        provider["tls_key_env"] = json!(tls.key.env);
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
        if target.kind != "workspace" {
            attributes["workspace"] = json!("${nemoclaw_workspace.deployment.name}");
        }
        if target.kind == "route" {
            attributes["provider_name"] = json!("${nemoclaw_provider.inference.name}");
            if inference.ollama.is_some() {
                attributes["depends_on"] = json!(["nemoclaw_ollama_model.inference"]);
            }
        }
        if target.kind == "sandbox" {
            // JSON configuration strings are still OpenTofu templates. Preserve
            // literal policy paths and matchers across that interpretation layer.
            if let Some(policy) = attributes["policy_json"].as_str() {
                attributes["policy_json"] = json!(policy.replace("${", "$${").replace("%{", "%%{"));
            }
            attributes["depends_on"] = json!(["nemoclaw_route.primary"]);
        }
        attributes["lifecycle"] = json!({"prevent_destroy":true});
        let (kind, name) = target
            .address
            .split_once('.')
            .expect("internal resource address");
        resources[kind] = json!({name:attributes});
    }
    Ok(
        json!({"terraform":{"required_version":format!("= {OPENTOFU_VERSION}"),"required_providers":{"nemoclaw":{"source":PROVIDER_ADDRESS,"version":format!("= {version}")}}},"provider":{"nemoclaw":provider},"resource":resources}),
    )
}

#[path = "compile_runtime.rs"]
mod runtime;
pub use runtime::{compile_runtime, runtime_targets};
