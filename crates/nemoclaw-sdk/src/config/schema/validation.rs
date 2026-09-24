// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Shared structural contract for authored input and normalized SDK values.
use crate::config::network as n;
use crate::config::{API_VERSION, DEFAULT_AGENT_IMAGE, DEFAULT_GATEWAY_IMAGE, constraints as c};
use serde_json::{Value, json};

pub(crate) fn property(schema: &mut Value, field: &str, extra: Value) {
    let Value::Object(extra) = extra else {
        panic!("property constraints must be objects");
    };
    schema["properties"][field]
        .as_object_mut()
        .expect("derived field exists")
        .extend(extra);
}
pub(crate) fn integer(
    schema: &mut Value,
    field: &str,
    rule: &c::DefaultedInteger,
    normalized: bool,
) {
    property(
        schema,
        field,
        json!({
            "anyOf": if normalized { json!([{ "minimum": rule.min, "maximum": rule.max }]) } else { json!([{ "const": 0 }, { "minimum": rule.min, "maximum": rule.max }]) },
            "default": rule.default,
            "x-nemoclaw-default-rule": "Omitted or zero selects the default."
        }),
    );
}
fn optional_string(
    schema: &mut Value,
    field: &str,
    default: &str,
    constraint: &Value,
    normalized: bool,
) {
    if normalized {
        schema
            .as_object_mut()
            .unwrap()
            .entry("required")
            .or_insert(json!([]))
            .as_array_mut()
            .unwrap()
            .push(json!(field));
    }
    property(
        schema,
        field,
        json!({
            "anyOf": if normalized { json!([constraint]) } else { json!([{ "const": "" }, constraint]) }, "default": default,
            "x-nemoclaw-default-rule": "Omitted or empty selects the default."
        }),
    );
}
pub(crate) fn forbid(names: &[&str]) -> Value {
    json!({"not": {"anyOf": names.iter().map(|name| json!({"required": [name]})).collect::<Vec<_>>()}})
}
// Required ancestors make a condition false when a field is omitted.
// Consequences constrain only fields that are present, allowing SDK defaults.
pub(crate) fn at(path: &str, rule: Value, required: bool) -> Value {
    path.split('/').rev().fold(rule, |child, segment| {
        if segment == "[]" {
            json!({"items": child})
        } else if required {
            json!({"required": [segment], "properties": {segment: child}})
        } else {
            json!({"properties": {segment: child}})
        }
    })
}

pub(super) fn constrain(root: &mut Value, normalized: bool) {
    property(root, "apiVersion", json!({"const": API_VERSION}));
    property(root, "kind", json!({"const": c::KIND}));
    let defs = root["$defs"].as_object_mut().unwrap();
    for variant in defs["Integration"]["oneOf"]
        .as_array_mut()
        .expect("tagged integration variants")
    {
        property(
            variant,
            "kind",
            json!({"description": "Integration implementation selected by this definition."}),
        );
    }
    for variant in defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .expect("tagged service variants")
    {
        property(
            variant,
            "kind",
            json!({"description": "Supported installer selected by this service definition."}),
        );
    }
    for name in ["Spec", "Sandbox", "Agent"] {
        property(
            &mut defs[name],
            "integrations",
            json!({"propertyNames": {"pattern": c::SLUG}}),
        );
    }
    for name in ["Spec", "Sandbox"] {
        property(
            &mut defs[name],
            "inferences",
            json!({"propertyNames": {"pattern": c::SLUG}}),
        );
        property(
            &mut defs[name],
            "harnesses",
            json!({"propertyNames": {"pattern": c::SLUG}}),
        );
    }
    property(
        &mut defs["Spec"],
        "services",
        json!({"propertyNames": {"pattern": c::SLUG}}),
    );
    property(
        &mut defs["Agent"],
        "inferenceRef",
        json!({"pattern": c::SLUG}),
    );
    defs["Agent"]["oneOf"] = json!([
        {"required": ["inference"], "not": {"required": ["inferenceRef"]}},
        {"required": ["inferenceRef"], "not": {"required": ["inference"]}}
    ]);
    property(
        &mut defs["Agent"],
        "integrationRefs",
        json!({"uniqueItems": true, "items": {"type": "string", "pattern": c::SLUG}}),
    );
    for name in ["Metadata", "InferenceProvider", "Sandbox", "Agent"] {
        property(
            defs.get_mut(name).unwrap(),
            "name",
            json!({"pattern": c::SLUG}),
        );
    }
    property(&mut defs["Metadata"], "uid", json!({"pattern": c::UUID}));
    property(&mut defs["Credential"], "env", json!({"pattern": c::ENV}));
    property(
        &mut defs["Spec"],
        "sandboxes",
        json!({"minItems":1,"maxItems":32}),
    );
    defs["Sandbox"]["allOf"] = json!([]);
    optional_string(
        &mut defs["Image"],
        "ref",
        DEFAULT_AGENT_IMAGE,
        &json!({"pattern": c::IMAGE}),
        normalized,
    );
    defs["Image"]["properties"]["ref"]
        .as_object_mut()
        .unwrap()
        .remove("default");
    defs["Image"]["properties"]["ref"]["x-nemoclaw-default-rule"] = json!(
        "Omitted or empty selects the generic SDK agent image pin; verify that it contains the selected Fabric adapter."
    );
    let driver_values = defs["Runtime"]["properties"]["provider"]
        .as_object_mut()
        .unwrap()
        .remove("enum")
        .expect("derived compute driver choices");
    optional_string(
        &mut defs["Runtime"],
        "provider",
        c::RUNTIME,
        &json!({"enum": driver_values}),
        normalized,
    );
    optional_string(
        &mut defs["Network"],
        "tier",
        c::NETWORK_TIER,
        &json!({"const": c::NETWORK_TIER}),
        false,
    );
    property(
        &mut defs["Network"],
        "tier",
        json!({"x-nemoclaw-default-rule": "Omitted or empty selects isolated only without policy.explicit."}),
    );
    defs["Network"]["if"] = json!({"required": ["policy"]});
    defs["Network"]["then"] = json!({"properties": {"tier": {"const": ""}}});
    property(
        &mut defs["Proxy"],
        "host",
        json!({"pattern": "^[A-Za-z0-9._-]+$", "minLength": 1, "maxLength": 256}),
    );
    property(&mut defs["Proxy"], "port", json!({"minimum": 1}));
    property(&mut defs["ExplicitPolicy"], "version", json!({"const": 1}));
    property(
        &mut defs["PolicyLandlock"],
        "compatibility",
        json!({"enum": ["best_effort", "hard_requirement"]}),
    );
    for (field, choices) in [
        ("protocol", json!(n::POLICY_PROTOCOLS)),
        ("tls", json!(n::POLICY_TLS)),
        ("enforcement", json!(n::POLICY_ENFORCEMENT)),
        ("access", json!(n::POLICY_ACCESS)),
    ] {
        property(&mut defs["PolicyEndpoint"], field, json!({"enum": choices}));
    }
    property(&mut defs["PolicyEndpoint"], "port", json!({"minimum": 1}));
    property(
        &mut defs["PolicyEndpoint"],
        "ports",
        json!({"minItems": 1, "uniqueItems": true, "items": {"type": "integer", "minimum": 1, "maximum": 65535}}),
    );
    defs["PolicyEndpoint"]["allOf"] = json!([
        {"oneOf": [{"required": ["port"], "not": {"required": ["ports"]}}, {"required": ["ports"], "not": {"required": ["port"]}}]},
        {"anyOf": [{"required": ["host"], "properties":{"host":{"minLength":1}}}, {"required": ["allowed_ips"], "properties":{"allowed_ips":{"minItems":1}}}]},
        {"not": {"required": ["access", "rules"]}}
    ]);
    for field in ["rules", "deny_rules"] {
        property(&mut defs["PolicyEndpoint"], field, json!({"minItems": 1}));
    }
    for name in ["PolicyJsonRpc", "PolicyMcp"] {
        property(
            &mut defs[name],
            "max_body_bytes",
            json!({"minimum": 1, "maximum": n::POLICY_BODY_MAX}),
        );
    }
    property(
        &mut defs["Sandbox"],
        "harnessRef",
        json!({"pattern": c::SLUG}),
    );
    defs["Sandbox"]["allOf"]
        .as_array_mut()
        .unwrap()
        .push(json!({"oneOf": [
            {"required": ["harness"], "not": {"required": ["harnessRef"]}},
            {"required": ["harnessRef"], "not": {"required": ["harness"]}}
        ]}));
    let native_identifier =
        json!({"minLength":1,"maxLength":256,"pattern":"^[^\\u0000-\\u001f\\u007f]+$(?![\\s\\S])"});
    let allow = &mut defs["AgentTools"]["properties"]["allow"];
    allow["items"] = json!({"type":"string"});
    allow["items"]
        .as_object_mut()
        .unwrap()
        .extend(native_identifier.as_object().unwrap().clone());
    allow["uniqueItems"] = json!(true);

    property(&mut defs["Route"], "name", json!({"pattern": c::SLUG}));
    property(
        &mut defs["Inference"],
        "default",
        json!({"pattern": c::SLUG}),
    );
    property(
        &mut defs["Inference"],
        "routes",
        json!({"minItems":1,"maxItems":32}),
    );
    defs["Inference"]["if"] = json!({"properties":{"routes":{"minItems":2}},"required":["routes"]});
    defs["Inference"]["then"] = json!({"required":["default"]});
    defs["Route"]["oneOf"] = json!([
        {"required":["providerRef"],"not":{"required":["provider"]}},
        {"required":["provider"],"not":{"required":["providerRef"]}}
    ]);
    property(
        &mut defs["Route"],
        "providerRef",
        json!({"pattern": c::SLUG}),
    );
    property(
        &mut defs["Overrides"],
        "model",
        json!({"pattern": c::MODEL}),
    );

    for gateway in defs["Gateway"]["oneOf"]
        .as_array_mut()
        .expect("gateway variants")
    {
        property(
            gateway,
            "management",
            json!({"description": "Whether this deployment manages the gateway."}),
        );
        if gateway["properties"]["management"]["const"] == "managed" {
            for (field, rule) in [
                (
                    "endpoint",
                    json!({"anyOf": [{"const": ""}, {"pattern": "^http://127\\.0\\.0\\.1:[0-9]+/?$"}], "default": c::GATEWAY_ENDPOINT}),
                ),
                (
                    "engine",
                    json!({"anyOf": [{"const":""},{"pattern":"^unix:///"}], "default": c::GATEWAY_ENGINE}),
                ),
                (
                    "image",
                    json!({"enum": ["", DEFAULT_GATEWAY_IMAGE], "default": DEFAULT_GATEWAY_IMAGE}),
                ),
                (
                    "networkCIDR",
                    json!({"anyOf": [{"const": ""}, {"pattern": "/24$"}], "x-nemoclaw-default-rule": "Omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid)."}),
                ),
            ] {
                let mut rule = rule;
                if normalized {
                    gateway["required"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!(field));
                    if let Some(choices) = rule.get_mut("anyOf").and_then(Value::as_array_mut) {
                        choices.retain(|choice| choice.get("const") != Some(&json!("")));
                    }
                    if field == "image" {
                        rule["enum"] = json!([DEFAULT_GATEWAY_IMAGE]);
                    }
                }
                property(gateway, field, rule);
                if field != "networkCIDR" {
                    property(
                        gateway,
                        field,
                        json!({"x-nemoclaw-default-rule": "Omitted or empty selects the default."}),
                    );
                }
            }
        } else {
            property(gateway, "endpoint", json!({"pattern": "^https?://"}));
            gateway["if"] = at("endpoint", json!({"pattern": "^http:"}), true);
            gateway["then"] = forbid(&["credential", "tls"]);
        }
    }

    let provider = &mut defs["InferenceProvider"];
    property(provider, "serviceRef", json!({"pattern": c::SLUG}));
    provider["if"] = json!({"required": ["serviceRef"]});
    provider["then"] = json!({"properties": {"provider":{"const":"openai"},"endpoint": {"const": ""}}, "allOf": [forbid(&["credential"])]});
    provider["else"] =
        json!({"required": ["endpoint"], "properties": {"endpoint": {"pattern": "^https?://"}}});
    provider["allOf"] = json!([
        {"if": at("endpoint", json!({"pattern": "^http:"}), true), "then": forbid(&["credential"])},
        {"if": {"required":["api"]}, "then": {
            "if": at("api", json!({"const":"anthropic-messages"}), true),
            "then": at("provider", json!({"const":"anthropic"}), false),
            "else": at("provider", json!({"const":"openai"}), false)
        }}
    ]);
    defs["AgentExecution"]["minProperties"] = json!(1);
    crate::services::constrain_schema(defs, normalized);

    root["allOf"] = json!([{
        "if": {"not": at("spec/sandboxes/[]/runtime/provider", json!({"const":"podman"}), true)},
        "then": at("spec/gateway/imagePullPolicy", json!({"enum":["IfNotPresent", "Never"]}), false)
    }]);
    root["allOf"].as_array_mut().unwrap().push(json!({
        "if": at("spec/gateway/management", json!({"const":"managed"}), true),
        "then": {"anyOf": [
            at("spec/sandboxes/[]/runtime/provider", json!({"enum":["", "docker"]}), false),
            at("spec/sandboxes/[]/runtime/provider", json!({"const":"podman"}), true)
        ]}
    }));
    root["x-nemoclaw-parser-checks"] = json!([
        "Document::parse rejects YAML aliases, anchors, merge keys, unsupported tags, duplicate keys, multiple documents, and input larger than 1 MiB. It applies the compiled input schema before defaulting; Document::validate applies the normalized schema and semantic checks, including for directly constructed Rust values.",
        "The parser checks endpoint transport and address policy, managed gateway port bounds, canonical private IPv4 /24 networks, local engine socket syntax, and publication address/port/network agreement.",
        "Explicit sandbox policies are also checked by the pinned OpenShell policy parser and validator, including protocol-specific rule semantics, process identities, filesystem paths, and destination address restrictions.",
        "Explicit filesystem grants must permit reads of the packaged Fabric runtime and NemoClaw bridge directories; parent and read-write grants count. This parser check does not inspect images, resolve symlinks, or establish runtime permissions.",
        "The schema requires an explicit default for multiple model choices. Rust checks unique route names, that the default names a route, and that native model and tool fields have valid structural shapes. Fabric validates adapter-specific combinations.",
        "The parser resolves integrationRefs only from enclosing deployment or sandbox definitions, rejects name shadowing and missing agent references, and permits at most one attached web search definition per sandbox. Native search must be authored separately through public Fabric configuration and validated by Fabric. Agent-inline definitions attach directly; unused enclosing definitions grant no access.",
        "The schema requires exactly one sandbox harness or harnessRef and rejects agent-level harness selection. Rust resolves visible harnesses without shadowing. Each sandbox requires one agent and hosts one Fabric runtime using the sandbox-selected implementation. Shared definitions reuse configuration across sandboxes.",
        "Native reasoning-effort identifiers are preserved for Fabric validation. Managed inference services may constrain routes to their declared served model.",
        "Rust resolves inferenceRef from enclosing inferences, preserves declaration scope for nested provider references, and rejects missing names and shadowing. The schema rejects inline/reference ambiguity.",
        "The parser resolves providerRef from enclosing inferenceProviders, rejects shadowing, conflicting selected names, more than 32 selected providers, incompatible managed-service combinations, and compares route models and authentication with the selected provider. Provider transport and reference consistency are checked after reference resolution for both inline and shared definitions. Unselected definitions create no resources. Snapshot identity must match the service model.",
        "The parser checks memory threshold ordering and GPU/KV budget relationships; recipe path safety, byte-length limits, environment-map conflicts, snapshot file uniqueness, directory conflicts, and total-size overflow.",
        "Schema validation does not observe hardware, image labels, model weights, credentials, ownership, connectivity, or inference readiness. Those checks run during the relevant SDK operation."
    ]);
}
