// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The record's configuration fields, read from the deployment document as the
//! Field Rules of `internal-docs/design/telemetry.md` say. Names, addresses,
//! and paths in the document never reach the record: harness IDs outside the
//! bundled Fabric catalog become `other`, a model name that could hold an
//! address becomes `unknown`, and an endpoint becomes a host word.

use super::record::{ComputeDriver, InferenceHost, WebSearch};
use nemoclaw_sdk::config::{self, Document, InferenceProvider, Integration, NamedSandbox};
use nemoclaw_sdk::fabric_catalog::FabricCatalog;
use reqwest::Url;
use std::collections::BTreeSet;
use std::net::IpAddr;

/// The longest model name the record carries.
const MAX_MODEL: usize = 64;

/// The record's configuration fields.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Config {
    pub harnesses: BTreeSet<String>,
    pub models: BTreeSet<String>,
    pub inference_hosts: BTreeSet<InferenceHost>,
    pub compute_driver: ComputeDriver,
    pub sandbox_count: u64,
    pub agent_count: u64,
    pub web_search: WebSearch,
    pub mcp_configured: bool,
}

/// The values of a configuration the sender cannot read.
impl Default for Config {
    fn default() -> Self {
        Self {
            harnesses: BTreeSet::new(),
            models: BTreeSet::new(),
            inference_hosts: BTreeSet::new(),
            compute_driver: ComputeDriver::Unknown,
            sandbox_count: 0,
            agent_count: 0,
            web_search: WebSearch::Unknown,
            mcp_configured: false,
        }
    }
}

/// The configuration fields of `document`, or the unread values without one.
/// A reference that does not resolve leaves out what it would have added.
pub fn config(document: Option<&Document>) -> Config {
    let Some(document) = document else {
        return Config::default();
    };
    let count = document.spec.sandboxes.len() as u64;
    let mut config = Config {
        compute_driver: match document.spec.gateway.compute_driver() {
            config::ComputeDriver::Docker => ComputeDriver::Docker,
            config::ComputeDriver::Podman => ComputeDriver::Podman,
            config::ComputeDriver::Kubernetes => ComputeDriver::Kubernetes,
            config::ComputeDriver::OpenShift => ComputeDriver::Openshift,
        },
        // Each sandbox hosts exactly one agent.
        sandbox_count: count,
        agent_count: count,
        web_search: WebSearch::None,
        ..Config::default()
    };
    let mut search = BTreeSet::new();
    for sandbox in document.sandboxes() {
        if let Ok(harness) = document.sandbox_harness(sandbox) {
            config.harnesses.insert(harness_id(harness.kind.as_str()));
        }
        if let Ok(inference) = document.sandbox_inference(sandbox) {
            if let Ok(route) = inference.default_route() {
                config.models.insert(model_name(&route.overrides.model));
            }
            for route in &inference.routes {
                let provider = match (&route.provider, &route.provider_ref) {
                    (Some(inline), _) => Some(&inline.definition),
                    (None, Some(name)) => provider(document, sandbox, name),
                    (None, None) => None,
                };
                if let Some(provider) = provider {
                    config.inference_hosts.insert(match provider.service_ref {
                        Some(_) => InferenceHost::Local,
                        None => host_word(&provider.endpoint),
                    });
                }
            }
        }
        for binding in sandbox
            .integration_bindings(&document.spec.integrations)
            .unwrap_or_default()
        {
            if let Integration::WebSearch(web_search) = binding.definition {
                search.insert(web_search.provider.name());
            }
        }
        config.mcp_configured |= sandbox
            .agent
            .mcp
            .as_ref()
            .is_some_and(|mcp| !mcp.is_empty());
    }
    config.web_search = match search.into_iter().collect::<Vec<_>>().as_slice() {
        [] => WebSearch::None,
        ["brave"] => WebSearch::Brave,
        ["tavily"] => WebSearch::Tavily,
        _ => WebSearch::Other,
    };
    config
}

/// The inference definition `name` visible to the sandbox's routes.
fn provider<'a>(
    document: &'a Document,
    sandbox: NamedSandbox<'a>,
    name: &str,
) -> Option<&'a InferenceProvider> {
    sandbox
        .definition
        .inference_providers
        .get(name)
        .or_else(|| document.spec.inference_providers.get(name))
}

/// An ID of the bundled Fabric catalog as written, any other ID as `other`.
fn harness_id(id: &str) -> String {
    if FabricCatalog::bundled_ref()
        .adapters
        .iter()
        .any(|adapter| adapter.adapter_id() == id)
    {
        id.into()
    } else {
        "other".into()
    }
}

/// A model name as written, or `unknown` when it could hold a path or an
/// address: longer than 64 characters, holding `://`, `\` or `@`, starting
/// with `/`, `~` or `.`, or with an IP address or `host:port` before its first
/// `/`. An Ollama tag such as `llama3.1:8b` is not a port, so it is kept.
fn model_name(model: &str) -> String {
    let first = model.split('/').next().unwrap_or_default();
    let address = |host: &str| host.trim_matches(['[', ']']).parse::<IpAddr>().is_ok();
    let host_port = first.rsplit_once(':').is_some_and(|(host, port)| {
        !host.is_empty() && !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit())
    });
    if model.chars().count() > MAX_MODEL
        || ["://", "\\", "@"].iter().any(|part| model.contains(part))
        || model.starts_with(['/', '~', '.'])
        || address(first)
        || host_port
    {
        "unknown".into()
    } else {
        model.into()
    }
}

/// The word for an endpoint's host, matched here so the address never leaves.
/// A loopback or private address, or a name only a local network resolves, is
/// `local`.
fn host_word(endpoint: &str) -> InferenceHost {
    let Some(host) = Url::parse(endpoint)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
    else {
        return InferenceHost::Other;
    };
    let host = host.trim_end_matches('.');
    if let Ok(address) = host.trim_matches(['[', ']']).parse::<IpAddr>() {
        return if local_address(address) {
            InferenceHost::Local
        } else {
            InferenceHost::Other
        };
    }
    let within = |domain: &str| host == domain || host.ends_with(&format!(".{domain}"));
    if !host.contains('.') || ["localhost", "local", "internal"].into_iter().any(within) {
        InferenceHost::Local
    } else if within("build.nvidia.com") || within("integrate.api.nvidia.com") {
        InferenceHost::BuildNvidiaCom
    } else if within("inference.nvidia.com") {
        InferenceHost::InferenceNvidiaCom
    } else if within("openai.com") {
        InferenceHost::Openai
    } else if within("anthropic.com") {
        InferenceHost::Anthropic
    } else {
        InferenceHost::Other
    }
}

fn local_address(address: IpAddr) -> bool {
    match address {
        IpAddr::V4(v4) => {
            v4.is_loopback() || v4.is_private() || v4.is_link_local() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => local_address(IpAddr::V4(v4)),
            None => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    || v6.is_unique_local()
                    || v6.is_unicast_link_local()
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::record::{Record, tests::sample};
    use serde_json::{Value, json};

    fn sandbox(harness: &str, inference: Value) -> Value {
        json!({
            "harness": {"kind": harness},
            "image": {"ref": "example.com/agent@sha256:0"},
            "agent": {"name": "agent", "inference": inference},
        })
    }

    fn route(name: &str, model: &str, provider: Value) -> Value {
        json!({"name": name, "overrides": {"model": model}, "provider": provider})
    }

    fn endpoint(name: &str, url: &str) -> Value {
        json!({"name": name, "provider": "openai", "endpoint": url})
    }

    fn document(spec: Value) -> Document {
        serde_json::from_value(json!({
            "apiVersion": "nemoclaw.nvidia.com/v1alpha1",
            "kind": "NemoClawConfig",
            "metadata": {"name": "home", "uid": "0f8fad5b-d9cb-469f-a165-70867728950e"},
            "spec": spec,
        }))
        .unwrap()
    }

    /// Three sandboxes on Kubernetes that between them set every field.
    fn full() -> Document {
        let mut search = sandbox(
            "nvidia.fabric.hermes",
            json!({"routes": [{
                "name": "main", "providerRef": "vllm",
                "overrides": {"model": "nvidia/nemotron-3-super-120b-a12b"},
            }]}),
        );
        search["agent"]["integrationRefs"] = json!(["search"]);
        search["agent"]["mcp"] = json!({"servers": {"docs": {"url": "https://mcp.example.com"}}});
        document(json!({
            "gateway": {"management": "managed", "target": {"kubernetes": {
                "namespace": "nemoclaw", "authentication": {"profile": "development"},
            }}},
            "inferenceProviders": {"vllm": {"provider": "openai", "serviceRef": "vllm"}},
            "integrations": {"search": {
                "kind": "webSearch", "provider": "tavily", "credential": {"env": "TAVILY_API_KEY"},
            }},
            "sandboxes": {
                "alice": sandbox("nvidia.fabric.openclaw", json!({"default": "fast", "routes": [
                    route("fast", "nvidia/nemotron-3-super-120b-a12b",
                        endpoint("nim", "https://integrate.api.nvidia.com/v1")),
                    route("slow", "gpt-5", endpoint("openai", "https://api.openai.com/v1")),
                ]})),
                "bob": sandbox("/home/alice/my-harness", json!({"routes": [
                    route("main", "http://10.0.0.5:8000/v1/models/x",
                        endpoint("lan", "http://10.0.0.5:8000/v1")),
                ]})),
                "carol": search,
            },
        }))
    }

    fn record(config: Config) -> Record {
        Record {
            harnesses: config.harnesses,
            models: config.models,
            inference_hosts: config.inference_hosts,
            compute_driver: config.compute_driver,
            sandbox_count: config.sandbox_count,
            agent_count: config.agent_count,
            web_search: config.web_search,
            mcp_configured: config.mcp_configured,
            ..sample()
        }
    }

    #[test]
    fn every_config_field_comes_from_the_document() {
        let config = config(Some(&full()));
        assert_eq!(
            config,
            Config {
                harnesses: ["nvidia.fabric.hermes", "nvidia.fabric.openclaw", "other"]
                    .map(String::from)
                    .into(),
                models: ["nvidia/nemotron-3-super-120b-a12b", "unknown"]
                    .map(String::from)
                    .into(),
                inference_hosts: [
                    InferenceHost::BuildNvidiaCom,
                    InferenceHost::Local,
                    InferenceHost::Openai,
                ]
                .into(),
                compute_driver: ComputeDriver::Kubernetes,
                sandbox_count: 3,
                agent_count: 3,
                web_search: WebSearch::Tavily,
                mcp_configured: true,
            }
        );
        let sent = serde_json::to_string(&record(config)).unwrap();
        for private in [
            "alice",
            "/home",
            "10.0.0.5",
            "api.openai.com",
            "integrate",
            "mcp.example",
        ] {
            assert!(!sent.contains(private), "{private} in {sent}");
        }
    }

    #[test]
    fn lists_are_sent_sorted_without_duplicates() {
        let config = config(Some(&full()));
        let sent = serde_json::to_value(record(config)).unwrap();
        assert_eq!(
            sent["harnesses"],
            json!(["nvidia.fabric.hermes", "nvidia.fabric.openclaw", "other"])
        );
        assert_eq!(
            sent["models"],
            json!(["nvidia/nemotron-3-super-120b-a12b", "unknown"])
        );
        assert_eq!(
            sent["inferenceHosts"],
            json!(["build.nvidia.com", "local", "openai"])
        );
    }

    #[test]
    fn an_unread_config_sends_the_unread_values() {
        let sent = serde_json::to_value(record(config(None))).unwrap();
        for (field, value) in [
            ("harnesses", json!([])),
            ("models", json!([])),
            ("inferenceHosts", json!([])),
            ("computeDriver", json!("unknown")),
            ("sandboxCount", json!(0)),
            ("agentCount", json!(0)),
            ("webSearch", json!("unknown")),
            ("mcpConfigured", json!(false)),
        ] {
            assert_eq!(sent[field], value, "{field}");
        }
    }

    #[test]
    fn a_url_shaped_or_long_model_is_unknown() {
        assert_eq!(
            model_name("meta/llama-3.1-8b-instruct"),
            "meta/llama-3.1-8b-instruct"
        );
        assert_eq!(model_name(&"m".repeat(64)), "m".repeat(64));
        assert_eq!(model_name(&"m".repeat(65)), "unknown");
        assert_eq!(model_name("hf://alice/private-model"), "unknown");
        assert_eq!(model_name("https://models.example.com/x"), "unknown");
    }

    #[test]
    fn a_path_or_address_shaped_model_is_unknown() {
        for model in [
            "/home/alice/models/llama-3-8b",
            "~/models/llama",
            "./llama",
            "../llama",
            ".cache/llama",
            r"C:\models\llama",
            r"models\llama",
            "alice@models.example.com/llama",
            "10.0.0.5/llama",
            "10.0.0.5:8000/llama",
            "10.0.0.5:8000",
            "[::1]:8000/llama",
            "::1/llama",
            "models.corp.example:443/acme-ft",
            "vllm:8000/llama",
        ] {
            assert_eq!(model_name(model), "unknown", "{model}");
        }
        for model in [
            "meta/llama-3.1-8b-instruct",
            "nvidia/nemotron-3-super-120b-a12b",
            "llama3.1:8b",
            "qwen2.5-coder:32b",
            "gpt-5",
        ] {
            assert_eq!(model_name(model), model);
        }
    }

    #[test]
    fn only_catalog_harness_ids_are_sent() {
        assert_eq!(
            harness_id("nvidia.fabric.openclaw"),
            "nvidia.fabric.openclaw"
        );
        assert_eq!(harness_id("openclaw"), "other");
        assert_eq!(harness_id("acme.private-agent"), "other");
    }

    #[test]
    fn an_endpoint_becomes_a_host_word() {
        for (endpoint, word) in [
            ("http://localhost:11434/v1", InferenceHost::Local),
            ("http://127.0.0.1:8000/v1", InferenceHost::Local),
            ("http://[::1]:8000/v1", InferenceHost::Local),
            ("http://192.168.1.20:8000/v1", InferenceHost::Local),
            (
                "http://host.openshell.internal:11434/v1",
                InferenceHost::Local,
            ),
            ("http://vllm:8000/v1", InferenceHost::Local),
            ("http://gpu-box.local:8000/v1", InferenceHost::Local),
            (
                "https://integrate.api.nvidia.com/v1",
                InferenceHost::BuildNvidiaCom,
            ),
            ("https://build.nvidia.com/v1", InferenceHost::BuildNvidiaCom),
            (
                "https://inference.nvidia.com/v1",
                InferenceHost::InferenceNvidiaCom,
            ),
            ("https://API.OpenAI.com./v1", InferenceHost::Openai),
            ("https://api.anthropic.com", InferenceHost::Anthropic),
            ("https://anthropic.example.com", InferenceHost::Other),
            ("https://notopenai.com/v1", InferenceHost::Other),
            ("https://8.8.8.8/v1", InferenceHost::Other),
            ("not a url", InferenceHost::Other),
            ("", InferenceHost::Other),
        ] {
            assert_eq!(host_word(endpoint), word, "{endpoint}");
        }
    }

    #[test]
    fn compute_driver_and_web_search_follow_the_document() {
        let search = |provider: &str| json!({"kind": "webSearch", "provider": provider, "credential": {"env": "KEY"}});
        let spec = |gateway: Value, refs: [&[&str]; 2]| {
            let sandboxes: serde_json::Map<_, _> = refs
                .iter()
                .enumerate()
                .map(|(index, refs)| {
                    let mut one = sandbox(
                        "nvidia.fabric.pi",
                        json!({"routes": [route("main", "m", endpoint("p", "http://localhost/v1"))]}),
                    );
                    one["agent"]["integrationRefs"] = json!(refs);
                    (format!("s{index}"), one)
                })
                .collect();
            document(json!({
                "gateway": gateway,
                "integrations": {"b": search("brave"), "t": search("tavily")},
                "sandboxes": sandboxes,
            }))
        };
        for (gateway, driver) in [
            (
                json!({"management": "managed", "target": {"docker": {}}}),
                ComputeDriver::Docker,
            ),
            (
                json!({"management": "managed", "target": {"podman": {}}}),
                ComputeDriver::Podman,
            ),
            (
                json!({"management": "external", "endpoint": "https://gw", "target": {"openshift": {}}}),
                ComputeDriver::Openshift,
            ),
        ] {
            let config = config(Some(&spec(gateway, [&[], &[]])));
            assert_eq!(config.compute_driver, driver);
            assert_eq!(config.web_search, WebSearch::None);
            assert!(!config.mcp_configured);
        }
        let managed = || json!({"management": "managed"});
        let web_search = |refs| config(Some(&spec(managed(), refs))).web_search;
        assert_eq!(web_search([&["b"], &["b"]]), WebSearch::Brave);
        assert_eq!(web_search([&[], &["t"]]), WebSearch::Tavily);
        // Sandboxes that use different search services send `other`.
        assert_eq!(web_search([&["b"], &["t"]]), WebSearch::Other);
    }
}
