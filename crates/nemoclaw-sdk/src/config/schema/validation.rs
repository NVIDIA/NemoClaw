// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Shared structural contract for authored input and normalized SDK values.
use crate::config::{API_VERSION, DEFAULT_AGENT_IMAGE, DEFAULT_GATEWAY_IMAGE, constraints as c};
use serde_json::{Value, json};

pub(crate) use nemoclaw_runtime::schema::{at, forbid, property};
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
    property(
        &mut defs["Credential"],
        "env",
        json!({
            "pattern": c::ENV,
            "not": {"anyOf": [
                {"const": "NEMOCLAW_KUBERNETES_STATE"},
                {"pattern": "^(?:NEMOCLAW_MANAGED_K8S_|HELM_|KUBE_)"}
            ]},
            "x-nemoclaw-error": "credential environment reference must be valid and must not shadow managed Kubernetes runtime controls"
        }),
    );
    property(
        &mut defs["ManagedKubernetes"],
        "kubeconfig",
        json!({"properties": {"env": {
            "not": {"anyOf": [
                {"enum": [
                    "PATH", "HOME", "USERPROFILE", "KUBECONFIG", "TMPDIR", "TMP", "TEMP",
                    "SYSTEMROOT", "COMSPEC", "PATHEXT", "SHELL", "ENV", "BASH_ENV", "IFS", "CDPATH",
                    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE",
                    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "KUBERNETES_MASTER",
                    "KUBERNETES_SERVICE_HOST", "KUBERNETES_SERVICE_PORT", "KUBERNETES_SERVICE_PORT_HTTPS"
                ]},
                {"pattern": "^(?:PYTHON|HELM|LD_|DYLD_|TF_|TOFU_|PLUGIN_|NEMOCLAW_INTERNAL_)"}
            ]},
            "x-nemoclaw-error": "kubeconfig environment reference must not shadow process, trust, proxy, or cluster controls"
        }}}),
    );
    // The listed variables reach OpenTofu beside its platform variables, so
    // they follow the kubeconfig reference's rules and cannot replace those.
    let reserved =
        defs["ManagedKubernetes"]["properties"]["kubeconfig"]["properties"]["env"]["not"].clone();
    property(
        &mut defs["ManagedKubernetes"],
        "environment",
        json!({
            "uniqueItems": true,
            "items": {
                "type": "string",
                "pattern": c::ENV,
                "not": {"anyOf": [
                    reserved,
                    {"const": "NEMOCLAW_KUBERNETES_STATE"},
                    {"pattern": "^(?:NEMOCLAW_MANAGED_K8S_|HELM_|KUBE_)"}
                ]}
            },
            "x-nemoclaw-error": "Kubernetes environment names must be unique variable names that do not shadow process, trust, proxy, or cluster controls"
        }),
    );
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
        "Kubernetes and OpenShift require an explicit immutable image reference. For other drivers, omitted or empty selects the generic SDK agent image pin; verify that it contains the selected Fabric adapter."
    );
    property(
        &mut defs["Runtime"],
        "provider",
        json!({"default": super::super::ComputeDriver::default()}),
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
    nemoclaw_openshell::policy::constrain(defs);
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
            let mut local = json!({"properties": {}, "required": []});
            for (field, rule) in [
                (
                    "endpoint",
                    json!({"anyOf": [{"const": ""}, {"pattern": "^http://127\\.0\\.0\\.1:[0-9]+/?$"}], "default": c::GATEWAY_ENDPOINT}),
                ),
                (
                    "engine",
                    // Docker's socket is the default for a Docker runtime only;
                    // the Podman rule below requires an explicit socket.
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
                    local["required"].as_array_mut().unwrap().push(json!(field));
                    if let Some(choices) = rule.get_mut("anyOf").and_then(Value::as_array_mut) {
                        choices.retain(|choice| choice.get("const") != Some(&json!("")));
                    }
                    if field == "image" {
                        rule["enum"] = json!([DEFAULT_GATEWAY_IMAGE]);
                    }
                }
                // A default only annotates; the Kubernetes branch still
                // excludes these fields. Editors and onboarding read a field's
                // default from its own schema, not from a conditional branch.
                if let Some(default) = rule.get("default").cloned() {
                    property(gateway, field, json!({"default": default}));
                }
                local["properties"][field] = rule;
                property(
                    gateway,
                    field,
                    json!({"x-nemoclaw-default-rule": if field == "endpoint" {
                        "Without kubernetes, omitted or empty selects the local HTTP endpoint. Kubernetes requires an explicit HTTPS loopback endpoint and port."
                    } else if field == "networkCIDR" {
                        "Without kubernetes, omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid). Excluded by kubernetes."
                    } else if field == "engine" {
                        "With runtime.provider docker, omitted or empty selects Docker's default socket. Podman requires its API service socket. Excluded by kubernetes."
                    } else {
                        "Without kubernetes, omitted or empty selects the SDK default. Excluded by kubernetes."
                    }}),
                );
            }
            gateway["if"] = json!({"required": ["kubernetes"]});
            gateway["then"] = json!({
                "required": ["endpoint"],
                "properties": {"endpoint": {"pattern": c::KUBERNETES_GATEWAY_ENDPOINT}},
                "allOf": [forbid(&["engine", "image", "imagePullPolicy", "networkCIDR"])],
                "x-nemoclaw-error": "managed Kubernetes requires an explicit HTTPS 127.0.0.1 endpoint with a nonzero port and excludes local engine settings"
            });
            gateway["else"] = local;
            // Podman's socket depends on the host user, so it has no default.
            gateway["allOf"] = json!([{
                "if": at("runtime/provider", json!({"const":"podman"}), true),
                "then": {
                    "required": ["engine"],
                    "properties": {"engine": {"minLength": 1}},
                    "x-nemoclaw-error": "Podman requires spec.gateway.engine to name its local API service socket."
                }
            }]);
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
    crate::services::cluster_config::constrain(defs);

    root["allOf"] = json!([{
        "if": {"not": at("spec/gateway/runtime/provider", json!({"const":"podman"}), true)},
        "then": at("spec/gateway/imagePullPolicy", json!({"enum":["IfNotPresent", "Never"]}), false)
    }]);
    root["allOf"].as_array_mut().unwrap().push(json!({
        "if": at("spec/gateway/management", json!({"const":"managed"}), true),
        "then": {
            "if": at("spec/gateway", json!({"required":["kubernetes"]}), true),
            "then": at("spec/gateway/runtime/provider", json!({"enum":["kubernetes", "openshift"]}), true),
            "else": at("spec/gateway/runtime/provider", json!({"enum":["docker", "podman"]}), false)
        }
    }));
    // Cluster sandboxes need an explicit image, since no local engine supplies
    // a default; image metadata stands in for engine inspection only there.
    root["allOf"].as_array_mut().unwrap().push(json!({
        "if": at("spec/gateway/runtime/provider", json!({"enum":["kubernetes", "openshift"]}), true),
        "then": at("spec/sandboxes/[]/image", json!({"required": ["ref", "metadata"], "properties": {"ref": {"pattern": c::IMAGE}}}), true),
        "else": at("spec/sandboxes/[]/image", forbid(&["metadata"]), false)
    }));
    root["allOf"].as_array_mut().unwrap().push(json!({
        "if": at("spec/gateway/runtime/provider", json!({"enum":["kubernetes", "openshift"]}), true),
        "then": {
            "allOf": [
                {"anyOf": [
                    at("spec/gateway/management", json!({"const":"external"}), true),
                    at("spec/gateway", json!({"required":["management","kubernetes"], "properties":{"management":{"const":"managed"}}}), true)
                ]},
                {"if": at("spec/gateway/management", json!({"const":"managed"}), true),
                 "then": at("spec/services", json!({"additionalProperties": {
                    "required": ["kubernetes"],
                    "properties": {"kind": {"enum": ["vllm", "ollama"]}},
                    "allOf": [forbid(&["placement", "publication"]), at("container/ipc", json!({"const":"private"}), false)]
                 }}), false),
                 "else": at("spec/services", json!({"maxProperties":0}), false)}
            ],
            "x-nemoclaw-error": "cluster model services require a managed Kubernetes target, explicit service kubernetes settings, and private IPC without Docker placement or publication"
        },
        "else": at("spec/services", json!({"additionalProperties": forbid(&["kubernetes"])}), false)
    }));
    root["x-nemoclaw-parser-checks"] = json!([
        "Document::parse rejects YAML aliases, anchors, merge keys, all explicit tags (including core tags such as !!binary), duplicate keys, multiple documents, and input larger than 1 MiB. It applies the compiled input schema before defaulting; Document::validate applies the normalized schema and semantic checks, including for directly constructed Rust values.",
        "The parser checks endpoint transport and address policy, managed gateway port bounds, canonical private IPv4 /24 networks, local engine socket syntax, and publication address/port/network agreement.",
        "Managed Kubernetes requires explicit kubeconfig environment, context, namespace, and development authentication profile; Agent Sandbox and one default StorageClass must already be installed. Its HTTPS endpoint is exactly 127.0.0.1 with an explicit port from 1 through 65535 and no path. Local engine fields are excluded; gateway.runtime.provider is kubernetes or openshift. Managed vLLM and Ollama services require explicit kubernetes capacity, storage, and scheduling settings; Docker placement, publication, and host IPC are excluded. OpenShift uses the upstream Kubernetes driver and requires platform-owned OpenShift security prerequisites. Cluster identity, ownership, prerequisite compatibility, and credential files are checked during operations.",
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
