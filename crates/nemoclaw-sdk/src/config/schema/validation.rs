// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Conditional input rules supplement the structure derived from Rust types.
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
pub(crate) fn integer(schema: &mut Value, field: &str, rule: &c::DefaultedInteger) {
    property(
        schema,
        field,
        json!({
            "anyOf": [{"const": 0}, {"minimum": rule.min, "maximum": rule.max}],
            "default": rule.default,
            "x-nemoclaw-default-rule": "Omitted or zero selects the default."
        }),
    );
}
fn optional_string(schema: &mut Value, field: &str, default: &str, constraint: &Value) {
    property(
        schema,
        field,
        json!({
            "anyOf": [{"const": ""}, constraint], "default": default,
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

pub(super) fn constrain(root: &mut Value) {
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
    defs["Sandbox"]["allOf"] = json!([{
        "if": at("agent/tools/allow", json!({}), true),
        "then": at("harness/kind",json!({"enum":["openclaw","deepagents","pi"]}),false)
    }, {
        "if": at("agent/tools/disclosure", json!({}), true),
        "then": at("harness/kind",json!({"const":"openclaw"}),false)
    }, {
        "if": at("agent/inference/routes",json!({"minItems":2}),true),
        "then": at("harness/kind", json!({"enum":["openclaw","pi"]}), false)
    }]);
    optional_string(
        &mut defs["Image"],
        "ref",
        DEFAULT_AGENT_IMAGE,
        &json!({"pattern": c::IMAGE}),
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
    );
    optional_string(
        &mut defs["Network"],
        "tier",
        c::NETWORK_TIER,
        &json!({"const": c::NETWORK_TIER}),
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
        {"anyOf": [{"required": ["host"]}, {"required": ["allowed_ips"]}]},
        {"not": {"required": ["access", "rules"]}}
    ]);
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
    defs["Harness"]["allOf"] = json!([]);
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
        {"if": at("endpoint", json!({"pattern": "^http:"}), true), "then": forbid(&["credential"])}
    ]);
    property(
        &mut defs["OpenClawDashboard"],
        "port",
        json!({"not":{"minimum":8642,"maximum":8652}}),
    );
    defs["OpenClawDashboard"]["minProperties"] = json!(1);
    defs["AgentExecution"]["minProperties"] = json!(1);
    property(&mut defs["OtlpTracing"], "enabled", json!({"const":true}));
    property(&mut defs["RelayTracing"], "enabled", json!({"const":true}));
    property(
        &mut defs["OtlpTracing"],
        "endpoint",
        json!({"const":super::super::observability::OTLP_ENDPOINT}),
    );
    property(
        &mut defs["OtlpTracing"],
        "serviceName",
        json!({"minLength":1,"maxLength":256,"pattern":"^[!-~](?:[ -~]*[!-~])?$(?![\\s\\S])"}),
    );
    defs["Harness"]["allOf"].as_array_mut().unwrap().extend([
        json!({"if":{"required":["observability"],"properties":{"observability":{"required":["otlp"]}}},"then":{"properties":{"kind":{"const":"openclaw"}}}}),
        json!({"if":{"required":["observability"],"properties":{"observability":{"required":["relay"]}}},"then":{"properties":{"kind":{"const":"hermes"}}}})
    ]);
    // JSON Schema's dollar anchor also matches before a trailing newline.
    property(
        &mut defs["AgentExecution"],
        "heartbeatEvery",
        json!({"pattern":"^[0-9]+[smh]$(?![\\s\\S])"}),
    );
    defs["Harness"]["allOf"].as_array_mut().unwrap().push(json!({"if":{"required":["execution"],"properties":{"execution":{"required":["heartbeatEvery"]}}},"then":{"properties":{"kind":{"const":"openclaw"}}}}));
    defs["HermesInterfaces"]["minProperties"] = json!(1);
    for field in ["port", "internalPort"] {
        property(
            &mut defs["HermesDashboard"],
            field,
            json!({"not":{"anyOf":[{"minimum":8642,"maximum":8652},{"const":18642}]}}),
        );
    }
    defs["HermesDashboard"]["allOf"] = json!([{"if":{"properties":{"enabled":{"const":false}}},"then":forbid(&["port","internalPort","tui"])}]);
    defs["Harness"]["allOf"].as_array_mut().unwrap().push(json!({"if":{"required":["interfaces"]},"then":{"properties":{"kind":{"enum":["openclaw","hermes"]}},"allOf":[
        {"if":{"properties":{"kind":{"const":"openclaw"}}},"then":{"properties":{"interfaces":{"$ref":"#/$defs/OpenClawInterfaces"}}},"else":{"properties":{"interfaces":{"$ref":"#/$defs/HermesInterfaces"}}}}
    ]}}));
    crate::services::constrain_schema(defs);

    root["allOf"] = json!([{
        "if": {"not": at("spec/sandboxes/[]/runtime/provider", json!({"const":"podman"}), true)},
        "then": at("spec/gateway/imagePullPolicy", json!({"enum":["IfNotPresent", "Never"]}), false)
    }]);
    let route_path = "spec/sandboxes/[]/agent/inference/routes/[]";
    root["allOf"].as_array_mut().unwrap().push(json!({
        "if": at(route_path, json!({"required":["providerRef"]}), true),
        "then": {"anyOf":[
            at("spec/inferenceProviders", json!({"minItems":1}), true),
            at("spec/sandboxes/[]/inferenceProviders", json!({"minItems":1}), true)
        ]}
    }));
    for (provider, selection) in [
        (
            "spec/inferenceProviders/[]",
            json!({"allOf": [
                at("spec/inferenceProviders", json!({"minItems":1,"maxItems":1}), true),
                at("spec/sandboxes/[]/inferenceProviders", json!({"maxItems":0}), false),
                at(route_path, json!({"required":["providerRef"]}), true)
            ]}),
        ),
        (
            "spec/sandboxes/[]/inferenceProviders/[]",
            json!({"allOf": [
                at("spec/inferenceProviders", json!({"maxItems":0}), false),
                at("spec/sandboxes/[]/inferenceProviders", json!({"minItems":1,"maxItems":1}), true),
                at(route_path, json!({"required":["providerRef"]}), true)
            ]}),
        ),
        (
            "spec/sandboxes/[]/agent/inference/routes/[]/provider",
            at(route_path, json!({"required":["provider"]}), true),
        ),
    ] {
        let agent = "spec/sandboxes/[]/agent";
        let route = format!("{agent}/inference/routes/[]/overrides");
        let rules = json!([
            {"if": at("spec/sandboxes/[]/harness/kind", json!({"const": "pi"}), true), "then": at(provider, forbid(&["api"]), false)},
            {"if": {"anyOf": [at(&format!("{provider}/api"), json!({"const": "anthropic-messages"}), true),
                {"allOf": [at("spec/sandboxes/[]/harness/kind", json!({"const": "claude"}), true), at(provider, forbid(&["api"]), true)]}]},
             "then": at(&format!("{provider}/provider"), json!({"const": "anthropic"}), false),
             "else": at(&format!("{provider}/provider"), json!({"const": "openai"}), false)},
            {"if": at("spec/sandboxes/[]/harness/kind", json!({"const": "claude"}), true), "then": at(&format!("{provider}/api"), json!({"const": "anthropic-messages"}), false)},
            {"if": at("spec/sandboxes/[]/harness/kind", json!({"const": "codex"}), true), "then": at(&format!("{provider}/api"), json!({"const": "openai-responses"}), false)},
            {"if": at("spec/sandboxes/[]/harness/kind", json!({"not": {"enum": ["openclaw", "hermes", "claude", "codex"]}}), true), "then": at(&format!("{provider}/api"), json!({"const": "openai-completions"}), false)},
            {"if": at("spec/sandboxes/[]/harness/kind", json!({"not": {"const": "openclaw"}}), true),
             "then": at(&route, forbid(&["contextWindow", "reasoning", "reasoningEffort"]), false)},
            {"if": at("spec/sandboxes/[]/harness/kind", json!({"not": {"enum": ["openclaw", "deepagents", "mini-swe-agent", "remote-agent"]}}), true),
             "then": at(&route, forbid(&["maxTokens"]), false)},
            {"if": at(&format!("{agent}/auth"), json!({}), true), "then": {"allOf": [at("spec/sandboxes/[]/harness/kind", json!({"const": "hermes"}), false), at(provider, json!({"anyOf":[{"required":["credential"]},{"required":["serviceRef"]}]}), true)]}},
            {"if": at("spec/sandboxes/[]/harness/kind", json!({"not": {"const": "pi"}}), true),
             "then": at(&route, forbid(&["piModel"]), false)}
        ]);
        root["allOf"]
            .as_array_mut()
            .unwrap()
            .push(json!({"if":{"allOf":[selection,at("spec/sandboxes/[]/harness/kind",json!({}),true)]},"then":{"allOf":rules}}));
    }
    root["x-nemoclaw-parser-checks"] = json!([
        "Document::parse remains authoritative. It rejects YAML aliases, anchors, merge keys, unsupported tags, duplicate keys, multiple documents, and input larger than 1 MiB.",
        "The parser checks endpoint transport and address policy, managed gateway port bounds, canonical private IPv4 /24 networks, local engine socket syntax, one compute driver per managed gateway, and publication address/port/network agreement.",
        "Explicit sandbox policies are also checked by the pinned OpenShell policy parser and validator, including protocol-specific rule semantics, process identities, filesystem paths, and destination address restrictions.",
        "Explicit filesystem grants must permit reads of the selected harness runtime directories; parent and read-write grants count. This parser check does not inspect images, resolve symlinks, or establish runtime permissions.",
        "The parser checks uniquely named model choices with an explicit default for multiple choices, multiple choices for OpenClaw and Pi, and the OpenClaw disclosure mode; omitted disclosure means progressive.",
        "The parser resolves integrationRefs only from enclosing deployment or sandbox definitions, rejects name shadowing and incompatible agent grants, and permits at most one attached Brave search definition per sandbox. Agent-inline definitions attach directly; unused enclosing definitions grant no access.",
        "The parser requires exactly one sandbox harness or harnessRef, resolves visible harnesses without shadowing, and rejects agent-level harness selection. Each sandbox requires one agent and hosts one Fabric runtime using the sandbox-selected implementation. Shared definitions reuse configuration across sandboxes.",
        "The parser permits non-default reasoningEffort values only on the initial default choice. Managed inference services may constrain routes to their declared served model.",
        "The parser resolves inferenceRef from enclosing inferences, preserves declaration scope for nested provider references, and rejects missing names, shadowing, and inline/reference ambiguity.",
        "The parser resolves providerRef from enclosing inferenceProviders, rejects shadowing, conflicting selected names, more than 32 selected providers, incompatible managed-service combinations, and compares route models and authentication with the selected provider. With multiple named definitions, provider/agent compatibility is a parser check. Unselected definitions create no resources. Snapshot identity must match the service model.",
        "The parser checks memory threshold ordering and GPU/KV budget relationships; recipe path safety, byte-length limits, environment-map conflicts, snapshot file uniqueness, directory conflicts, and total-size overflow.",
        "Schema validation does not observe hardware, image labels, model weights, credentials, ownership, connectivity, or inference readiness. Those checks run during the relevant SDK operation."
    ]);
}
