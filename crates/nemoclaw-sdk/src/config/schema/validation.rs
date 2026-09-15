// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Conditional input rules supplement the structure derived from Rust types.
use crate::config::network as n;
use crate::config::{API_VERSION, DEFAULT_AGENT_IMAGE, DEFAULT_GATEWAY_IMAGE, constraints as c};
use serde_json::{Value, json};

fn property(schema: &mut Value, field: &str, extra: Value) {
    let Value::Object(extra) = extra else {
        panic!("property constraints must be objects");
    };
    schema["properties"][field]
        .as_object_mut()
        .expect("derived field exists")
        .extend(extra);
}
fn integer(schema: &mut Value, field: &str, rule: &c::DefaultedInteger) {
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
fn forbid(names: &[&str]) -> Value {
    json!({"not": {"anyOf": names.iter().map(|name| json!({"required": [name]})).collect::<Vec<_>>()}})
}
// Required ancestors make a condition false when a field is omitted.
// Consequences constrain only fields that are present, allowing SDK defaults.
fn at(path: &str, rule: Value, required: bool) -> Value {
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
    for name in ["Metadata", "InferenceProvider", "Sandbox", "Agent"] {
        property(
            defs.get_mut(name).unwrap(),
            "name",
            json!({"pattern": c::SLUG}),
        );
    }
    property(&mut defs["Metadata"], "uid", json!({"pattern": c::UUID}));
    property(&mut defs["Credential"], "env", json!({"pattern": c::ENV}));
    for (name, field) in [
        ("Spec", "inferenceProviders"),
        ("Spec", "sandboxes"),
        ("Inference", "routes"),
    ] {
        property(
            defs.get_mut(name).unwrap(),
            field,
            json!({"minItems": 1, "maxItems": 1}),
        );
    }
    property(
        &mut defs["Sandbox"],
        "agents",
        json!({
            "minItems": 1,
            "prefixItems": [{"$ref": "#/$defs/Agent"}],
            "items": {"$ref": "#/$defs/Agent", "not": {"required": ["execution"]}}
        }),
    );
    defs["Sandbox"]["allOf"] = json!([{
        "if": {"properties": {"agents": {"minItems": 2}}, "required": ["agents"]},
        "then": {"properties": {"agents": {"items": {"properties": {"harness": {"const": "openclaw"}}}}}}
    }]);
    defs["Agent"]["allOf"] = json!([{
        "if": {"required": ["tools"]},
        "then": {"properties": {"harness": {"const": "openclaw"}}}
    }]);
    optional_string(
        &mut defs["Image"],
        "ref",
        DEFAULT_AGENT_IMAGE,
        &json!({"pattern": c::IMAGE}),
    );
    optional_string(
        &mut defs["Runtime"],
        "provider",
        c::RUNTIME,
        &json!({"enum": c::RUNTIMES}),
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
        json!({"enum": ["best_effort", "hard_requirement", "strict"]}),
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
        &mut defs["AgentAuth"],
        "providerRef",
        json!({"pattern": c::SLUG}),
    );
    property(&mut defs["Agent"], "harness", json!({"enum": c::HARNESSES}));
    property(&mut defs["Route"], "name", json!({"const": "primary"}));
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

    let gateway = &mut defs["Gateway"];
    property(gateway, "management", json!({"enum": c::MANAGEMENT}));
    gateway["oneOf"] = json!([
        {"title": "Managed gateway", "properties": {
            "management": {"const": "managed"},
            "endpoint": {"anyOf": [{"const": ""}, {"pattern": "^http://127\\.0\\.0\\.1:[0-9]+/?$"}], "default": c::GATEWAY_ENDPOINT},
            "engine": {"enum": ["", c::GATEWAY_ENGINE], "default": c::GATEWAY_ENGINE},
            "image": {"enum": ["", DEFAULT_GATEWAY_IMAGE], "default": DEFAULT_GATEWAY_IMAGE},
            "networkCIDR": {"anyOf": [{"const": ""}, {"pattern": "/24$"}]}
        }, "allOf": [forbid(&["credential", "tls"])]},
        {"title": "External gateway", "required": ["endpoint"], "properties": {
            "management": {"const": "external"}, "endpoint": {"pattern": "^https?://"},
            "engine": {"const": ""}, "image": {"const": ""}, "networkCIDR": {"const": ""}
        }, "allOf": [forbid(&["network", "storage"])]}
    ]);
    gateway["if"] = at("endpoint", json!({"pattern": "^http:"}), true);
    gateway["then"] = forbid(&["credential", "tls"]);
    for (field, description) in [
        ("endpoint", format!("Managed only: omitted or empty selects {}.", c::GATEWAY_ENDPOINT)),
        ("engine", format!("Managed only: omitted or empty selects {}.", c::GATEWAY_ENGINE)),
        ("image", format!("Managed only: omitted or empty selects {DEFAULT_GATEWAY_IMAGE}.")),
        ("networkCIDR", "Managed only: omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid).".into()),
    ] { property(gateway, field, json!({"x-nemoclaw-default-rule": description})); }

    let provider = &mut defs["InferenceProvider"];
    property(provider, "provider", json!({"enum": c::PROVIDERS}));
    provider["if"] = json!({"required": ["service"]});
    provider["then"] = json!({"properties": {"endpoint": {"const": ""}}, "allOf": [forbid(&["credential", "ollama"])]});
    provider["else"] =
        json!({"required": ["endpoint"], "properties": {"endpoint": {"pattern": "^https?://"}}});
    provider["allOf"] = json!([
        {"if": {"anyOf": [{"required": ["service"]}, {"required": ["ollama"]}]},
         "then": {"properties": {"management": {"const": "managed"}}},
         "else": {"properties": {"management": {"const": "external"}}}},
        {"if": at("endpoint", json!({"pattern": "^http:"}), true), "then": forbid(&["credential"])},
        {"if": {"required": ["ollama"]}, "then": {
            "properties": {"endpoint": {"pattern": "^http://.+:[0-9]+/v1$"}},
            "allOf": [forbid(&["credential"])]
        }}
    ]);
    property(
        &mut defs["ManagedOllama"],
        "engine",
        json!({"pattern": "^unix:///"}),
    );
    defs["NetworkReference"]["anyOf"][0]["pattern"] = json!(c::SLUG);
    property(
        &mut defs["ExternalNetwork"],
        "name",
        json!({"pattern": c::SLUG}),
    );
    property(
        &mut defs["ManagedOllama"],
        "image",
        json!({"pattern": "^ollama/ollama@sha256:[a-f0-9]{64}$"}),
    );
    property(
        &mut defs["OpenClawDashboard"],
        "port",
        json!({"not":{"minimum":8642,"maximum":8652}}),
    );
    defs["OpenClawDashboard"]["minProperties"] = json!(1);
    defs["AgentExecution"]["minProperties"] = json!(1);
    // JSON Schema's dollar anchor also matches before a trailing newline.
    property(
        &mut defs["AgentExecution"],
        "heartbeatEvery",
        json!({"pattern":"^[0-9]+[smh]$(?![\\s\\S])"}),
    );
    defs["Agent"]["allOf"].as_array_mut().unwrap().push(json!({"if":{"required":["execution"]},"then":{"properties":{"harness":{"const":"openclaw"}}}}));
    defs["HermesInterfaces"]["minProperties"] = json!(1);
    for field in ["port", "internalPort"] {
        property(
            &mut defs["HermesDashboard"],
            field,
            json!({"not":{"anyOf":[{"minimum":8642,"maximum":8652},{"const":18642}]}}),
        );
    }
    defs["HermesDashboard"]["allOf"] = json!([{"if":{"properties":{"enabled":{"const":false}}},"then":forbid(&["port","internalPort","tui"])}]);
    defs["Agent"]["allOf"].as_array_mut().unwrap().push(json!({"if":{"required":["interfaces"]},"then":{"properties":{"harness":{"enum":["openclaw","hermes"]}},"allOf":[
        {"if":{"properties":{"harness":{"const":"openclaw"}}},"then":{"properties":{"interfaces":{"$ref":"#/$defs/OpenClawInterfaces"}}},"else":{"properties":{"interfaces":{"$ref":"#/$defs/HermesInterfaces"}}}}
    ]}}));
    service_constraints(defs);

    let provider = "spec/inferenceProviders/[]";
    let agent = "spec/sandboxes/[]/agents/[]";
    let runtime = "spec/sandboxes/[]/runtime/provider";
    let route = format!("{agent}/inference/routes/[]/overrides");
    let service = format!("{provider}/service");
    root["allOf"] = json!([
        {"if": at(&format!("{agent}/harness"), json!({"const": "pi"}), true), "then": at(provider, forbid(&["api"]), false)},
        {"if": at("spec/gateway/management", json!({"const": "managed"}), true),
         "then": at(runtime, json!({"enum": ["", "docker"]}), false)},
        {"if": {"allOf": [at(&service, json!({}), true), {"anyOf": [
            at("spec/gateway/management", json!({"const": "external"}), true),
            at(runtime, json!({"const": "podman"}), true)
         ]}]}, "then": at(&service, json!({"required": ["placement"]}), true)},
        {"if": at(&format!("{agent}/harness"), json!({"not": {"enum": ["openclaw", "hermes"]}}), true),
         "then": {"allOf": [at("spec/gateway/management", json!({"const": "external"}), false), at(provider, forbid(&["service", "ollama"]), false)]}},
        {"if": {"anyOf": [at(&format!("{provider}/api"), json!({"const": "anthropic-messages"}), true),
            {"allOf": [at(&format!("{agent}/harness"), json!({"const": "claude"}), true), at(provider, forbid(&["api"]), true)]}]},
         "then": at(&format!("{provider}/provider"), json!({"const": "anthropic"}), false),
         "else": at(&format!("{provider}/provider"), json!({"const": "openai"}), false)},
        {"if": at(&format!("{agent}/harness"), json!({"const": "claude"}), true), "then": at(&format!("{provider}/api"), json!({"const": "anthropic-messages"}), false)},
        {"if": at(&format!("{agent}/harness"), json!({"const": "codex"}), true), "then": at(&format!("{provider}/api"), json!({"const": "openai-responses"}), false)},
        {"if": at(&format!("{agent}/harness"), json!({"not": {"enum": ["openclaw", "hermes", "claude", "codex"]}}), true), "then": at(&format!("{provider}/api"), json!({"const": "openai-completions"}), false)},
        {"if": at(&format!("{agent}/harness"), json!({"not": {"const": "openclaw"}}), true),
         "then": at(&route, forbid(&["contextWindow", "maxTokens", "reasoning", "reasoningEffort"]), false)},
        {"if": at(&format!("{agent}/auth"), json!({}), true), "then": {"allOf": [at(&format!("{agent}/harness"), json!({"const": "hermes"}), false), at(provider, json!({"required": ["credential"]}), true)]}},
        {"if": at(&format!("{agent}/harness"), json!({"not": {"const": "pi"}}), true),
         "then": at(&route, forbid(&["piModel"]), false)},
        {"if": at(&format!("{provider}/ollama"), json!({}), true),
         "then": at(&format!("{route}/model"), json!({"pattern": c::OLLAMA_MODEL}), false)}
    ]);
    root["x-nemoclaw-parser-checks"] = json!([
        "Document::parse remains authoritative. It rejects YAML aliases, anchors, merge keys, unsupported tags, duplicate keys, multiple documents, and input larger than 1 MiB.",
        "The parser checks endpoint transport and address policy, managed gateway port bounds, canonical private IPv4 /24 networks, Docker engine syntax, and publication address/port/network agreement.",
        "Explicit sandbox policies are also checked by the pinned OpenShell policy parser and validator, including protocol-specific rule semantics, process identities, filesystem paths, and destination address restrictions.",
        "The parser checks unique agent names, identical inference settings across multiple OpenClaw agents, and a shared disclosure mode among unrestricted agents; omitted disclosure means progressive.",
        "The parser compares providerRef with provider.name, route model with the served model, and snapshot identity with the service model.",
        "The parser checks memory threshold ordering and GPU/KV budget relationships; recipe path safety, byte-length limits, environment-map conflicts, snapshot file uniqueness, directory conflicts, and total-size overflow.",
        "Schema validation does not observe hardware, image labels, model weights, credentials, ownership, connectivity, or inference readiness. Those checks run during the relevant SDK operation."
    ]);
}

fn service_constraints(defs: &mut serde_json::Map<String, Value>) {
    let service = &mut defs["Service"];
    property(service, "backend", json!({"const": c::BACKEND}));
    property(service, "image", json!({"pattern": c::IMAGE}));
    service["dependentRequired"] =
        json!({"placement": ["publication"], "publication": ["placement"]});
    service["if"] = json!({"required": ["recipe"]});
    service["then"] = at("memory/gpuMemoryGiB", json!({"const": 0}), false);
    service["else"] = at("serving/speculativeTokens", json!({"const": 0}), false);
    property(
        &mut defs["Model"],
        "repository",
        json!({"pattern": c::REPOSITORY, "maxLength": 200}),
    );
    property(
        &mut defs["Model"],
        "revision",
        json!({"pattern": c::REVISION}),
    );
    property(
        &mut defs["ServicePlacement"],
        "engine",
        json!({"pattern": "^ssh://"}),
    );
    property(
        &mut defs["ServicePlacement"],
        "networkCidr",
        json!({"pattern": "/24$"}),
    );
    property(
        &mut defs["ServicePublication"],
        "endpoint",
        json!({"pattern": "^http://.+:[0-9]+/v1$"}),
    );
    let serving = &mut defs["Serving"];
    for (field, rule) in [
        ("port", &c::PORT),
        ("contextTokens", &c::CONTEXT_TOKENS),
        ("maxSequences", &c::MAX_SEQUENCES),
        ("batchTokens", &c::BATCH_TOKENS),
        ("startupTimeoutSeconds", &c::STARTUP_TIMEOUT),
    ] {
        integer(serving, field, rule);
    }
    property(
        serving,
        "speculativeTokens",
        json!({"minimum": 0, "maximum": c::SPECULATIVE_TOKENS_MAX, "default": 0}),
    );
    property(
        serving,
        "toolParser",
        json!({"enum": c::TOOL_PARSERS, "default": ""}),
    );
    property(
        serving,
        "reasoningParser",
        json!({"enum": c::REASONING_PARSERS, "default": ""}),
    );
    let memory = &mut defs["Memory"];
    for (field, rule) in [
        ("hostReserveGiB", &c::HOST_RESERVE),
        ("kvCacheGiB", &c::KV_CACHE),
        ("minAvailableGiB", &c::MIN_AVAILABLE),
        ("minFreeGiB", &c::MIN_FREE),
        ("freeGateGiB", &c::FREE_GATE),
        ("consecutiveSamples", &c::CONSECUTIVE_SAMPLES),
    ] {
        integer(memory, field, rule);
    }
    property(
        memory,
        "gpuMemoryGiB",
        json!({"minimum": 0, "maximum": c::GPU_MEMORY_MAX,
        "x-nemoclaw-default-rule": format!("Omitted or zero stays zero in the document. Without a recipe, the backend uses {} GiB. With a recipe, resources.gpuMemoryBytes supplies the budget.", c::GPU_MEMORY_DEFAULT)}),
    );
    recipe_constraints(defs);
}

fn recipe_constraints(defs: &mut serde_json::Map<String, Value>) {
    use crate::recipes::inline::limits as r;
    property(
        &mut defs["InlineRecipe"],
        "apiVersion",
        json!({"const": r::API_VERSION}),
    );
    for field in ["licenses", "sourceNotices"] {
        property(
            &mut defs["InlineRecipe"],
            field,
            json!({"minItems": 1, "items": {"type": "string", "pattern": "^/"}}),
        );
    }
    let compatibility = &mut defs["Compatibility"];
    property(
        compatibility,
        "architecture",
        json!({"enum": r::ARCHITECTURES}),
    );
    property(compatibility, "gpu", json!({"minLength": 1}));
    property(
        compatibility,
        "minDriverMajor",
        json!({"minimum": 1, "maximum": r::DRIVER_MAX}),
    );
    property(
        compatibility,
        "minHostMemoryGiB",
        json!({"minimum": 1, "maximum": r::MEMORY_MAX}),
    );
    property(
        compatibility,
        "imageLabels",
        json!({"required": [r::PROTOCOL_LABEL],
        "properties": {r::PROTOCOL_LABEL: {"const": "v1"}}, "propertyNames": {"pattern": "^org\\.nemoclaw\\."},
        "additionalProperties": {"type": "string", "minLength": 1, "maxLength": r::TOKEN_MAX}}),
    );
    property(
        &mut defs["Tool"],
        "executable",
        json!({"pattern": "^/", "maxLength": r::PATH_MAX}),
    );
    for (name, field) in [
        ("Tool", "sha256"),
        ("Reuse", "preparationKey"),
        ("File", "sha256"),
    ] {
        property(
            defs.get_mut(name).unwrap(),
            field,
            json!({"pattern": r::SHA256}),
        );
    }
    property(
        &mut defs["Reuse"],
        "snapshotDirectory",
        json!({"minLength": 1}),
    );
    let resources = &mut defs["Resources"];
    for (field, min, max) in [
        ("preparedBytes", 1, r::PREPARED_MAX),
        ("preparationMemoryGiB", 1, r::MEMORY_MAX),
        ("gpuMemoryBytes", r::GPU_MIN, r::GPU_MAX),
        ("startupHeadroomGiB", 0, r::MEMORY_MAX),
    ] {
        property(resources, field, json!({"minimum": min, "maximum": max}));
    }
    let settings = &mut defs["Settings"];
    property(
        settings,
        "modelName",
        json!({"pattern": r::TOKEN, "maxLength": r::TOKEN_MAX}),
    );
    for field in [
        "toolParser",
        "reasoningParser",
        "kvCacheDtype",
        "mambaCacheDtype",
    ] {
        property(
            settings,
            field,
            json!({"anyOf": [{"const": ""}, {"pattern": r::TOKEN}], "maxLength": r::TOKEN_MAX, "default": ""}),
        );
    }
    for field in ["lazyLoading", "chunkedPrefill"] {
        property(settings, field, json!({"default": false}));
    }
    for field in ["environment", "preparedEnvironment"] {
        property(
            settings,
            field,
            json!({"propertyNames": {"pattern": "^VLLM_[A-Z0-9_]*$"}, "default": {}}),
        );
    }
    property(
        settings,
        "environment",
        json!({"additionalProperties": {"type": "string", "maxLength": r::PATH_MAX, "pattern": "^[^\\u0000]*$"}}),
    );
    let compilation = &mut defs["Compilation"];
    property(
        compilation,
        "mode",
        json!({"maximum": r::COMPILATION_MODE_MAX}),
    );
    property(
        compilation,
        "cudagraphMode",
        json!({"enum": r::CUDAGRAPH_MODES}),
    );
    property(
        compilation,
        "captureSizes",
        json!({"minItems": 1, "maxItems": r::CAPTURE_COUNT_MAX,
        "items": {"type": "integer", "minimum": 1, "maximum": r::CAPTURE_SIZE_MAX}}),
    );
    property(
        &mut defs["Manifest"],
        "repository",
        json!({"pattern": c::REPOSITORY, "maxLength": 200}),
    );
    property(
        &mut defs["Manifest"],
        "revision",
        json!({"pattern": c::REVISION}),
    );
    property(&mut defs["Manifest"], "files", json!({"minItems": 1}));
    property(&mut defs["File"], "name", json!({"minLength": 1}));
    property(&mut defs["File"], "size", json!({"minimum": 1}));
}
