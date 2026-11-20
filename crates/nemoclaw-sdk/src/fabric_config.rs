// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Deployment-owned projection into the public Fabric configuration contract.
use crate::config::{ConfigError, Document, NamedSandbox};
use serde_json::{Value, json};
use std::collections::BTreeMap;

/// Resolve deployment references without interpreting native adapter settings.
/// This exact configuration is planned against the image descriptors and sent to Fabric.
pub fn for_sandbox(document: &Document, sandbox: NamedSandbox<'_>) -> Result<Value, ConfigError> {
    Ok(projection(document, sandbox)?.0)
}

/// The Fabric configuration and where each of its fields was authored: a map
/// from a generated Fabric path to the path of the field the user wrote. A
/// path stands for everything beneath it, so a rejected `models.default.max_tokens`
/// finds `<route>.overrides.maxTokens` and a rejected `tools.enabled.x` finds
/// `agent.tools.enabled.x`. The empty path names the sandbox, for fields the
/// deployment generates from nothing the user wrote.
pub type Provenance = BTreeMap<String, String>;

/// The configuration for `sandbox` with the provenance of its fields.
pub fn projection(
    document: &Document,
    sandbox: NamedSandbox<'_>,
) -> Result<(Value, Provenance), ConfigError> {
    let mut provenance = Provenance::new();
    provenance.insert(String::new(), document.sandbox_path(sandbox));
    let harness = document.sandbox_harness(sandbox)?;
    let selection = document.scoped_inference(sandbox)?;
    let mut result = json!({
        "schema_version":"fabric.agent/v1alpha1",
        "metadata":{"name":sandbox.agent.name},
        "harness":{"adapter_id":harness.kind.as_str(),"settings":harness.settings.clone().unwrap_or_default()},
        "runtime":{"artifacts":"/sandbox/artifacts"},
        "environment":{"provider":"local","workspace":"/sandbox/workspace"},
        "models":{}
    });
    let selected = selection.inference.default_route()?;
    if selection
        .inference
        .routes
        .iter()
        .any(|route| route.name == "default")
        && selected.name != "default"
    {
        return Err(ConfigError::new(
            "model role default conflicts with the selected Fabric default role",
        ));
    }
    // Fabric rejects a model field an adapter doesn't accept, so values the
    // deployment generates follow the adapter's descriptor. A base URL also goes
    // to adapters outside the bundled catalog; an API goes only where declared.
    let catalog = crate::fabric_catalog::FabricCatalog::bundled_ref();
    let descriptor = catalog
        .adapters
        .iter()
        .find(|adapter| adapter.adapter_id() == harness.kind.as_str())
        .map(|adapter| &adapter.descriptor);
    let accepts_base_url = descriptor.is_none_or(|descriptor| {
        descriptor["config"]["accepts"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "models.base_url"))
    });
    let declares_api = descriptor.is_some_and(|descriptor| {
        [
            &descriptor["model_schema"],
            &descriptor["extension_schemas"]["model"],
        ]
        .iter()
        .any(|schema| schema["properties"].get("api").is_some())
    });
    // Fabric gives every runtime of an agent one state folder only when asked,
    // and rejects the request for an adapter that doesn't accept it.
    if descriptor.is_some_and(|descriptor| {
        descriptor["config"]["accepts"]
            .as_array()
            .is_some_and(|fields| fields.iter().any(|field| field == "runtime.keep_state"))
    }) {
        result["runtime"]["keep_state"] = true.into();
    }
    for route in &selection.inference.routes {
        let provider = document.sandbox_route_registration(sandbox, route)?;
        let definition = provider.definition;
        let connection = document.provider_connection(definition)?;
        let profile = crate::config::inference_profile(
            &provider.key,
            &connection.endpoint,
            definition.provider,
            crate::services::provider_authenticated(document, definition)?,
        )
        .map_err(|_| ConfigError::new("invalid inference transport"))?;
        let mut projected = json!({"provider":definition.provider,"model":route.overrides.model,
            "base_url":connection.endpoint,"api_key_env":profile.credentials.first().map(|credential|credential.name.as_str()).unwrap_or("NEMOCLAW_ANONYMOUS_API_KEY"),
            "settings":route.overrides.settings.clone().unwrap_or_default()});
        if !accepts_base_url {
            projected.as_object_mut().unwrap().remove("base_url");
        }
        if declares_api {
            projected["api"] = serde_json::to_value(definition.api.unwrap_or(
                crate::config::InferenceApi::for_provider(definition.provider),
            ))
            .map_err(|_| ConfigError::new("invalid inference API"))?;
        }
        if let Some(limit) = route.overrides.tuning.max_tokens {
            projected["max_tokens"] = limit.into();
        }
        if let Some(provider) = &route.overrides.harness_provider {
            projected["provider"] = provider.clone().into();
        }
        for (field, value) in [
            ("temperature", &route.overrides.tuning.temperature),
            ("top_p", &route.overrides.tuning.top_p),
        ] {
            if let Some(value) = value {
                projected[field] = Value::Number(value.clone());
            }
        }
        // Authored extensions may set an API explicitly, but not a field the
        // deployment owns or already sets.
        for (field, value) in route.overrides.extensions.iter().flatten() {
            let owned = ["provider", "model", "base_url", "api_key_env", "settings"]
                .contains(&field.as_str())
                || (field != "api" && projected.get(field).is_some());
            if owned {
                return Err(ConfigError::new(
                    "model extensions cannot set a field the deployment sets",
                ));
            }
            projected[field] = value.clone();
        }
        result["models"][&route.name] = projected.clone();
        let route_path = selection.route_path(route);
        let roles: &[&str] = if route.name == selected.name {
            &[route.name.as_str(), "default"]
        } else {
            &[route.name.as_str()]
        };
        for role in roles {
            provenance.insert(format!("models.{role}"), route_path.clone());
            let overrides = format!("{route_path}.overrides");
            for (field, authored) in [
                ("model", "model"),
                ("max_tokens", "maxTokens"),
                ("temperature", "temperature"),
                ("top_p", "topP"),
                ("settings", "settings"),
            ] {
                provenance.insert(
                    format!("models.{role}.{field}"),
                    format!("{overrides}.{authored}"),
                );
            }
            if route.overrides.harness_provider.is_some() {
                provenance.insert(
                    format!("models.{role}.provider"),
                    format!("{overrides}.harnessProvider"),
                );
            }
            // An authored key that isn't safe to print stays under its route.
            for field in route
                .overrides
                .extensions
                .iter()
                .flat_map(|values| values.keys())
                .filter(|field| {
                    nemoclaw_fabric::capabilities::diagnostic_field(field) == field.as_str()
                })
            {
                provenance.insert(
                    format!("models.{role}.{field}"),
                    format!("{overrides}.extensions.{field}"),
                );
            }
        }
        if route.name == selected.name {
            result["models"]["default"] = projected;
        }
    }
    // Fabric's adapters that declare the setting (OpenCode, and Claude, Codex
    // and Pi under Relay) refuse a plain-HTTP model endpoint outside loopback
    // unless their settings list the host. The deployment names each
    // endpoint, so an adapter that declares the setting trusts their hosts.
    let lists_trusted_hosts = descriptor.is_some_and(|descriptor| {
        descriptor["settings_schema"]["properties"]
            .get(TRUSTED_HTTP_HOSTS)
            .is_some()
    });
    if lists_trusted_hosts {
        let hosts: Vec<String> = result["models"]
            .as_object()
            .into_iter()
            .flat_map(|models| models.values())
            .filter_map(|model| model["base_url"].as_str())
            .filter_map(plain_http_host)
            .collect();
        if let Some(settings) = result["harness"]["settings"].as_object_mut()
            && !hosts.is_empty()
        {
            let listed = settings
                .entry(TRUSTED_HTTP_HOSTS)
                .or_insert_with(|| Value::Array(Vec::new()));
            if let Some(listed) = listed.as_array_mut() {
                for host in hosts {
                    if !listed.iter().any(|value| value == host.as_str()) {
                        listed.push(host.into());
                    }
                }
            }
        }
    }
    // OpenShell's policy DNS answers every name in a sandbox from
    // 198.18.0.0/15 and decides each connection itself. OpenClaw's fetch tools
    // refuse that range unless told it belongs to such a proxy, so an adapter
    // that declares OpenClaw's setting gets it unless the harness sets it.
    // A value of the wrong type is left for Fabric's schema to reject.
    let fetch_policy = "/settings_schema/properties/tools/properties/web/properties/fetch/properties/ssrfPolicy/properties";
    if descriptor.is_some_and(|descriptor| {
        descriptor
            .pointer(&format!("{fetch_policy}/{FAKE_IP_RANGE}"))
            .is_some()
    }) {
        let mut section = result["harness"]["settings"].as_object_mut();
        for key in ["tools", "web", "fetch", "ssrfPolicy"] {
            section = section.and_then(|section| {
                section
                    .entry(key)
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
            });
        }
        if let Some(policy) = section {
            policy.entry(FAKE_IP_RANGE).or_insert(true.into());
        }
    }
    // The harness and the agent each author their own Fabric sections; the
    // deployment's values fill in around them and must not be contradicted.
    let agent = &sandbox.agent;
    let mut authored = Value::Object(
        [
            ("runtime", &harness.runtime),
            ("environment", &harness.environment),
            ("discovery", &harness.discovery),
            ("telemetry", &harness.telemetry),
            ("relay", &harness.relay),
            ("instructions", &agent.instructions),
            ("tools", &agent.tools),
            ("skills", &agent.skills),
            ("mcp", &agent.mcp),
            ("workflow", &agent.workflow),
        ]
        .into_iter()
        .filter_map(|(key, section)| {
            section
                .as_ref()
                .map(|section| (key.to_owned(), Value::Object(section.clone())))
        })
        .collect(),
    );
    merge_owned(&mut authored, result)?;
    let result = authored;
    serde_json::from_value::<nemo_fabric_core::FabricConfig>(result.clone())
        .map_err(|_| ConfigError::new("invalid public Fabric configuration"))?;
    // Each authored section keeps its own name in Fabric's configuration, so
    // the authored path is the declaring definition's path plus the section.
    let (harness_path, agent_path) = (document.harness_path(sandbox), document.agent_path(sandbox));
    provenance.insert("harness.adapter_id".into(), format!("{harness_path}.kind"));
    provenance.insert(
        "harness.settings".into(),
        format!("{harness_path}.settings"),
    );
    for section in ["runtime", "environment", "discovery", "telemetry", "relay"] {
        provenance.insert(section.into(), format!("{harness_path}.{section}"));
    }
    for section in ["instructions", "tools", "skills", "mcp", "workflow"] {
        provenance.insert(section.into(), format!("{agent_path}.{section}"));
    }
    Ok((result, provenance))
}

const TRUSTED_HTTP_HOSTS: &str = "insecure_http_model_hosts";
const FAKE_IP_RANGE: &str = "allowRfc2544BenchmarkRange";

/// The host of a plain-HTTP endpoint that Fabric would refuse without trust:
/// not loopback, and spelled as the setting's hostname pattern allows.
fn plain_http_host(endpoint: &str) -> Option<String> {
    let url = url::Url::parse(endpoint).ok()?;
    if url.scheme() != "http" {
        return None;
    }
    match url.host()? {
        url::Host::Domain(name) if name.eq_ignore_ascii_case("localhost") => None,
        url::Host::Domain(name) => Some(name.to_ascii_lowercase()),
        url::Host::Ipv4(address) if address.is_loopback() => None,
        url::Host::Ipv4(address) => Some(address.to_string()),
        url::Host::Ipv6(_) => None,
    }
}

fn merge_owned(authored: &mut Value, owned: Value) -> Result<(), ConfigError> {
    match (authored, owned) {
        (Value::Object(authored), Value::Object(owned)) => {
            for (key, value) in owned {
                if let Some(existing) = authored.get_mut(&key) {
                    merge_owned(existing, value)?;
                } else {
                    authored.insert(key, value);
                }
            }
            Ok(())
        }
        (authored, owned) if *authored == owned => Ok(()),
        _ => Err(ConfigError::new(
            "public Fabric configuration conflicts with a deployment-owned field",
        )),
    }
}
