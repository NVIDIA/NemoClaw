// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Shared structural contract for authored input and normalized SDK values.
use crate::config::{API_VERSION, constraints as c};
use serde_json::{Value, json};

pub(crate) use nemoclaw_runtime::schema::{at, forbid, property};

const IMAGE_REF_ERROR: &str = "image.ref must name an agent image pinned by a SHA-256 digest; use the selected release's image digest or build an image from the same source revision, following docs/build-deploy/build.md#building-agent-images in that source (onboarding links the matching guide)";
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
    for collection in ["policies", "grants"] {
        property(
            &mut defs["Spec"],
            collection,
            json!({"propertyNames": {"pattern": c::SLUG}}),
        );
    }
    for name in ["Spec", "Sandbox"] {
        for collection in ["inferences", "harnesses", "inferenceProviders"] {
            property(
                &mut defs[name],
                collection,
                json!({"propertyNames": {"pattern": c::SLUG}}),
            );
        }
    }
    property(
        &mut defs["Spec"],
        "services",
        json!({"propertyNames": {"pattern": c::SLUG}}),
    );
    // OpenShell validates exposure names at creation; NemoClaw only bounds
    // the count it would reject (32 per sandbox).
    property(
        &mut defs["Sandbox"],
        "serviceExposures",
        json!({"maxProperties": 32}),
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
    for name in ["Metadata", "InlineInferenceProvider", "Agent"] {
        property(
            defs.get_mut(name).unwrap(),
            "name",
            json!({"pattern": c::SLUG}),
        );
    }
    property(
        &mut defs["Metadata"],
        "uid",
        json!({"pattern": if normalized { c::UUID } else { c::UUID_INPUT }}),
    );
    // Integration kinds are inlined in Integration's variants.
    for variant in defs["Integration"]["oneOf"]
        .as_array_mut()
        .into_iter()
        .flatten()
    {
        let kind = match variant["properties"]["kind"]["const"].as_str() {
            Some("webSearch") => "web search",
            Some("api") => "api",
            _ => continue,
        };
        property(
            variant,
            "sandboxEnv",
            json!({
                "pattern": c::ENV,
                "x-nemoclaw-error": format!("{kind} sandboxEnv must be an environment variable name")
            }),
        );
    }
    for (name, kind) in [("SecretRef", "secret"), ("FileRef", "file")] {
        property(
            &mut defs[name],
            "env",
            json!({
                "pattern": c::ENV,
                "not": {"anyOf": [
                    {"const": "NEMOCLAW_KUBERNETES_STATE"},
                    {"pattern": "^(?:NEMOCLAW_MANAGED_K8S_|HELM_|KUBE_|KUBERNETES_SERVICE_)"}
                ]},
                "x-nemoclaw-error": format!("{kind} reference must name a valid environment variable that does not shadow managed Kubernetes runtime controls")
            }),
        );
    }
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
                    {"pattern": "^(?:NEMOCLAW_MANAGED_K8S_|HELM_|KUBE_|KUBERNETES_SERVICE_)"}
                ]}
            },
            "x-nemoclaw-error": "Kubernetes environment names must be unique variable names that do not shadow process, trust, proxy, or cluster controls"
        }),
    );
    // The oidc profile requires the token variable; OpenShell's OIDC settings
    // come from spec.gateway.config.
    let oidc_fields = ["caConfigMap", "token"];
    let reserved_names =
        defs["ManagedKubernetes"]["properties"]["kubeconfig"]["properties"]["env"]["not"].clone();
    let authentication = &mut defs["KubernetesAuthentication"];
    property(
        authentication,
        "caConfigMap",
        json!({
            "pattern": c::KUBERNETES_SUBDOMAIN_NAME,
            "x-nemoclaw-error": "caConfigMap must be a Kubernetes ConfigMap name"
        }),
    );
    // The token reaches OpenTofu beside the kubeconfig, so it follows the
    // kubeconfig reference's rules in addition to SecretRef's.
    property(
        authentication,
        "token",
        json!({"properties": {"env": {
            "not": reserved_names,
            "x-nemoclaw-error": "token environment reference must not shadow process, trust, proxy, or cluster controls"
        }}}),
    );
    authentication["allOf"] = json!([
        {
            "if": {"properties": {"profile": {"const": "oidc"}}, "required": ["profile"]},
            "then": {"required": ["token"]},
            "else": {"not": {"anyOf": oidc_fields.iter().map(|field| json!({"required": [field]})).collect::<Vec<_>>()}}
        }
    ]);
    property(
        &mut defs["ManagedKubernetes"],
        "dataStorageClass",
        json!({
            "pattern": c::KUBERNETES_SUBDOMAIN_NAME,
            "x-nemoclaw-error": "dataStorageClass must be a Kubernetes StorageClass name"
        }),
    );
    // Quantities have one spelling each, so plan can compare a request with
    // its limit.
    let quantities = &mut defs["GatewayResourceList"];
    property(
        quantities,
        "cpu",
        json!({
            "pattern": c::KUBERNETES_CPU,
            "x-nemoclaw-error": "resources cpu must be a quoted number of cores with up to three decimals, such as \"1\" or \"0.5\", or millicores, such as 250m"
        }),
    );
    property(
        quantities,
        "memory",
        json!({
            "pattern": c::KUBERNETES_MEMORY,
            "x-nemoclaw-error": "resources memory must be a whole number of Mi or Gi, such as 512Mi or 2Gi"
        }),
    );
    quantities["x-nemoclaw-error"] =
        json!("resources requests and limits take only cpu and memory");
    property(
        &mut defs["Spec"],
        "sandboxes",
        json!({"minProperties":1,"propertyNames": {"pattern": c::SLUG}}),
    );
    defs["Sandbox"]["allOf"] = json!([]);
    // No published agent image exists to default to, so every runtime needs an
    // explicit one; an omitted image would only fail in the engine's pull after
    // the gateway exists.
    property(
        &mut defs["Image"],
        "ref",
        json!({"pattern": c::IMAGE, "x-nemoclaw-error": IMAGE_REF_ERROR}),
    );
    defs["Image"]["required"] = json!(["ref"]);
    property(
        &mut defs["Sandbox"],
        "image",
        json!({"x-nemoclaw-error": IMAGE_REF_ERROR}),
    );
    defs["Sandbox"]
        .as_object_mut()
        .unwrap()
        .entry("required")
        .or_insert(json!([]))
        .as_array_mut()
        .unwrap()
        .push(json!("image"));
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
        json!({"x-nemoclaw-default-rule": "Omitted or empty selects isolated only without policy or policyRef."}),
    );
    property(
        &mut defs["Network"],
        "policyRef",
        json!({"pattern": c::SLUG}),
    );
    property(
        &mut defs["Network"],
        "grantRefs",
        json!({"uniqueItems": true, "items": {"type": "string", "pattern": c::SLUG}}),
    );
    defs["Network"]["if"] =
        json!({"anyOf": [{"required": ["policy"]}, {"required": ["policyRef"]}]});
    defs["Network"]["then"] = json!({
        "properties": {"tier": {"const": ""}},
        "allOf": [forbid(&["grants", "grantRefs"])]
    });
    defs["Network"]["not"] = json!({"required": ["policy", "policyRef"]});
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

    for apf in defs["ApfPolicyAuthority"]["oneOf"]
        .as_array_mut()
        .expect("APF registration variants")
    {
        property(
            apf,
            "registration",
            json!({"description": "Who registers APF with the gateway: managed means NemoClaw does, external means the gateway's operator does."}),
        );
        if apf["properties"]["registration"]["const"] == "managed" {
            property(apf, "endpoint", json!({"pattern": "^https://[^/?#@]+$"}));
        }
    }
    for gateway in defs["Gateway"]["oneOf"]
        .as_array_mut()
        .expect("gateway variants")
    {
        property(
            gateway,
            "management",
            json!({"description": "Whether this deployment manages the gateway."}),
        );
        if gateway["properties"]["management"]["const"] == "external" {
            property(gateway, "endpoint", json!({"pattern": "^https?://"}));
            gateway["if"] = at("endpoint", json!({"pattern": "^http:"}), true);
            gateway["then"] = forbid(&["credential", "tls"]);
        }
    }

    // A client certificate is presented with its key.
    defs["TLS"]["dependentRequired"] = json!({"certificate": ["key"], "key": ["certificate"]});
    // A kubeconfig is used with its context, and its exec plugin's variables
    // need it; without both, clients use the pod's service account.
    defs["ManagedKubernetes"]["dependentRequired"] = json!({
        "kubeconfig": ["context"], "context": ["kubeconfig"], "environment": ["kubeconfig"]
    });
    targets(defs, normalized);

    // An inline definition flattens the same connection fields beside its name.
    for name in ["InferenceProvider", "InlineInferenceProvider"] {
        let provider = &mut defs[name];
        property(provider, "serviceRef", json!({"pattern": c::SLUG}));
        provider["if"] = json!({"required": ["serviceRef"]});
        provider["then"] = json!({"properties": {"provider":{"const":"openai"},"endpoint": {"const": ""}}, "allOf": [forbid(&["credential"])]});
        provider["else"] = json!({"required": ["endpoint"], "properties": {"endpoint": {"pattern": "^https?://"}}});
        provider["allOf"] = json!([
            {"if": {"required":["api"]}, "then": {
                "if": at("api", json!({"const":"anthropic-messages"}), true),
                "then": at("provider", json!({"const":"anthropic"}), false),
                "else": at("provider", json!({"const":"openai"}), false)
            }}
        ]);
    }
    crate::services::constrain_schema(defs, normalized);

    // Cluster sandboxes need image metadata, since no local engine can be
    // inspected; it stands in for engine inspection only there.
    let cluster = || {
        at(
            "spec/gateway/target",
            json!({"anyOf": [{"required": ["kubernetes"]}, {"required": ["openshift"]}]}),
            true,
        )
    };
    let mut local_image = forbid(&["metadata"]);
    local_image["x-nemoclaw-error"] = json!(c::IMAGE_METADATA_TARGETS);
    root["allOf"] = json!([{
        "if": cluster(),
        "then": at("spec/sandboxes/*/image", json!({"required": ["metadata"]}), true),
        "else": at("spec/sandboxes/*/image", local_image, false)
    }]);
    root["allOf"].as_array_mut().unwrap().push(json!({
        "if": cluster(),
        "then": at("spec/services", json!({"maxProperties":0}), false),
        "x-nemoclaw-error": "the kubernetes and openshift targets require external inference endpoints; managed services are not supported"
    }));
    // OpenShell refuses a sandbox's driver configuration unless the target
    // driver's table allows it, which it doesn't by default. A managed
    // gateway's tables are in the document, so a sandbox the gateway would
    // refuse is rejected at its driverConfig. An empty driverConfig sends
    // OpenShell none. An external gateway's administrator allows it.
    for (driver, targets) in [
        ("docker", &["docker"][..]),
        ("podman", &["podman"]),
        ("kubernetes", &["kubernetes", "openshift"]),
    ] {
        let mut target: Vec<Value> = targets
            .iter()
            .map(|target| at("target", json!({"required": [target]}), true))
            .collect();
        // An omitted target selects Docker.
        if driver == "docker" {
            target.push(json!({"not": {"required": ["target"]}}));
        }
        let allowed = |path: &str| {
            at(
                &format!("spec/gateway/config/{path}/allow_driver_config"),
                json!({"const": true}),
                true,
            )
        };
        root["allOf"].as_array_mut().unwrap().push(json!({
            "if": {"allOf": [
                at("spec/gateway", json!({
                    "properties": {"management": {"const": "managed"}},
                    "required": ["management"],
                    "anyOf": target
                }), true),
                {"not": {"anyOf": [
                    allowed(&format!("openshell.drivers.{driver}")),
                    allowed(&format!("openshell.drivers/{driver}")),
                    allowed(&format!("openshell/drivers/{driver}"))
                ]}}
            ]},
            "then": at("spec/sandboxes/*/driverConfig", json!({"maxProperties": 0}), false),
            "x-nemoclaw-error": format!("OpenShell refuses a sandbox's driverConfig unless the gateway allows driver configuration; set allow_driver_config: true in the openshell.drivers.{driver} table of spec.gateway.config")
        }));
    }
    // The gateway target sets the sandbox cap. It lives only here, so an
    // error names the cap that applies, and editors apply it as the parser does.
    root["allOf"].as_array_mut().unwrap().push(json!({
        "if": cluster(),
        "then": at("spec/sandboxes", json!({
            "maxProperties": c::CLUSTER_SANDBOXES,
            "x-nemoclaw-error": format!("a document holds at most {} sandboxes with a Kubernetes or OpenShift gateway, which bounds what one gateway and state affect; split a larger fleet across documents", c::CLUSTER_SANDBOXES)
        }), false),
        "else": at("spec/sandboxes", json!({
            "maxProperties": c::HOST_SANDBOXES,
            "x-nemoclaw-error": format!("a document holds at most {} sandboxes with a Docker or Podman gateway, which runs every sandbox on one host; Kubernetes and OpenShift allow {}", c::HOST_SANDBOXES, c::CLUSTER_SANDBOXES)
        }), false)
    }));
    root["x-nemoclaw-parser-checks"] = json!([
        "Document::parse rejects YAML aliases, anchors, merge keys, all explicit tags (including core tags such as !!binary), duplicate keys, multiple documents, and input larger than 1 MiB. It applies the compiled input schema before defaulting; Document::validate applies the normalized schema and semantic checks, including for directly constructed Rust values.",
        "The parser checks the shape of every endpoint URL and the gateway endpoint's transport and address policy; OpenShell checks inference destinations when sandboxes connect. It also checks canonical private IPv4 /24 networks, local engine socket syntax, and publication address/port/network agreement.",
        "A managed kubernetes or openshift target requires a namespace and an authentication profile, and a kubeconfig environment reference and context together; omitting both selects the service account of the pod that runs NemoClaw. Agent Sandbox, and the StorageClass that dataStorageClass names or else a default one, are platform prerequisites that are not checked. Each request in resources must not exceed its limit, compared in millicores or mebibytes. Without expose, the document names no endpoint: each command forwards a free local port to the gateway pod. With it, expose.endpoint names a lowercase DNS name or IPv4 address and an explicit port. expose.service has the chart's NodePort Service publish that port, which Kubernetes checks against the cluster's node-port range; expose.route, only on the openshift target, has the chart's pass-through Route publish the host, which must be a DNS name, at the port the cluster's router serves. Managed inference services are excluded. OpenShift uses the upstream Kubernetes driver and requires platform-owned OpenShift security prerequisites. Namespace identity, ownership, and credential files are checked during operations.",
        "Explicit sandbox policies are also checked by the pinned OpenShell policy parser and validator, including protocol-specific rule semantics, process identities, filesystem paths, and destination address restrictions.",
        "Explicit filesystem grants must permit reads of the paths the selected image's runtime requires, such as Fabric's /opt/fabric; parent and read-write grants count. Planning checks them against the image's metadata; it does not resolve symlinks or establish runtime permissions.",
        "The schema requires an explicit default for multiple model choices. Rust checks unique route names, that the default names a route, and that native model and tool fields have valid structural shapes. Fabric validates adapter-specific combinations.",
        "The parser resolves integrationRefs only from enclosing deployment or sandbox definitions, rejects name shadowing and missing agent references, and permits at most one attached web search definition per sandbox. Native search must be authored separately through public Fabric configuration and validated by Fabric. Agent-inline definitions attach directly; unused enclosing definitions grant no access.",
        "The schema requires exactly one sandbox harness or harnessRef and rejects agent-level harness selection. Rust resolves visible harnesses without shadowing. Each sandbox requires one agent and hosts one Fabric runtime using the sandbox-selected implementation. Shared definitions reuse configuration across sandboxes.",
        "Native reasoning-effort identifiers are preserved for Fabric validation. Managed inference services may constrain routes to their declared served model.",
        "Rust resolves inferenceRef from enclosing inferences, preserves declaration scope for nested provider references, and rejects missing names and shadowing. The schema rejects inline/reference ambiguity.",
        "The parser resolves providerRef from enclosing inferenceProviders, rejects shadowing, conflicting selected names, more than 32 providers attached to one sandbox (its inference providers, web search, and api integrations, OpenShell's limit per sandbox), incompatible managed-service combinations, and compares route models and authentication with the selected provider. Provider transport and reference consistency are checked after reference resolution for both inline and shared definitions. Unselected definitions create no resources. Snapshot identity must match the service model.",
        "The parser checks memory threshold ordering and GPU/KV budget relationships; that a recipe's GPU belongs to a hardware profile's GPU family; recipe path safety, byte-length limits, environment-map conflicts, snapshot file uniqueness, directory conflicts, and total-size overflow.",
        "Schema validation does not observe hardware, image labels, model weights, credentials, ownership, connectivity, or inference readiness. Those checks run during the relevant SDK operation."
    ]);
    describe_slug_keys(root);
}

/// Say what a definition's name may contain wherever map keys name
/// definitions, since a pattern alone reads as noise and the key is never shown.
fn describe_slug_keys(schema: &mut Value) {
    match schema {
        Value::Object(object) => {
            if let Some(names) = object.get_mut("propertyNames")
                && names["pattern"] == c::SLUG
            {
                names["x-nemoclaw-error"] = json!(c::SLUG_KEYS_ERROR);
            }
            object.values_mut().for_each(describe_slug_keys);
        }
        Value::Array(items) => items.iter_mut().for_each(describe_slug_keys),
        _ => {}
    }
}

/// Give each gateway target a definition of its own, so editors offer only
/// that target's fields and a violation reports that target's rule. Docker and
/// Podman share one Rust type, as do Kubernetes and OpenShift; their
/// definitions differ in defaults, requirements, and what may publish the
/// gateway.
fn targets(defs: &mut serde_json::Map<String, Value>, normalized: bool) {
    let local = defs.remove("LocalTarget").expect("local target definition");
    for (name, engine_rule, description) in [
        (
            "DockerTarget",
            json!({
                "anyOf": [{"const": ""}, {"pattern": "^(unix:///|npipe:////\\./pipe/)"}],
                "default": c::GATEWAY_ENGINE,
                "x-nemoclaw-default-rule": "Omitted or empty selects Docker's default socket."
            }),
            "A managed gateway container on a local Docker engine.",
        ),
        (
            "PodmanTarget",
            json!({
                "minLength": 1,
                "pattern": "^(unix:///|npipe:////\\./pipe/)",
                "x-nemoclaw-error": "target.podman.engine must name the local Podman API service socket, such as unix:///run/user/1000/podman/podman.sock, or on Windows a Podman machine's named pipe, such as npipe:////./pipe/podman-machine-default"
            }),
            "A managed gateway container on a local rootless Linux Podman engine. Podman's socket depends on the user, so engine has no default.",
        ),
    ] {
        let mut target = local.clone();
        target["description"] = json!(description);
        let mut engine_rule = engine_rule;
        let mut network_rule = json!({
            "anyOf": [{"const": ""}, {"pattern": "/24$"}],
            "x-nemoclaw-default-rule": "Omitted or empty selects 172.30.N.0/24, where N is the first byte of SHA-256(metadata.uid)."
        });
        let mut required = if name == "PodmanTarget" {
            vec!["engine"]
        } else {
            Vec::new()
        };
        if normalized {
            for rule in [&mut engine_rule, &mut network_rule] {
                if let Some(choices) = rule.get_mut("anyOf").and_then(Value::as_array_mut) {
                    choices.retain(|choice| choice.get("const") != Some(&json!("")));
                }
            }
            required = vec!["engine", "port", "networkCIDR"];
        }
        property(&mut target, "engine", engine_rule);
        property(&mut target, "networkCIDR", network_rule);
        // The rule below states the port's bounds; the integer type's own
        // bounds would only repeat a wider range.
        let port = target["properties"]["port"]
            .as_object_mut()
            .expect("port property");
        for keyword in ["minimum", "maximum", "format"] {
            port.remove(keyword);
        }
        nemoclaw_runtime::schema::integer(&mut target, "port", &c::GATEWAY_PORTS, normalized);
        if name == "DockerTarget" {
            // Docker pulls only when an image is absent or never.
            property(
                &mut target,
                "imagePullPolicy",
                json!({
                    "enum": ["IfNotPresent", "Never"],
                    "description": "Image acquisition before local container creation: IfNotPresent, the default, or Never.",
                    "x-nemoclaw-error": "target.docker.imagePullPolicy accepts IfNotPresent or Never; Always is available on the podman target"
                }),
            );
        } else {
            property(
                &mut target,
                "imagePullPolicy",
                json!({"description": "Image acquisition before local container creation: IfNotPresent, the default, Never, or Always, which contacts the registry before creation or restart."}),
            );
        }
        if !required.is_empty() {
            target["required"] = json!(required);
        }
        defs.insert(name.into(), target);
    }

    // Only OpenShift serves Routes, so only its expose takes route.
    let expose = &mut defs["KubernetesExpose"];
    property(
        expose,
        "endpoint",
        json!({
            "pattern": c::KUBERNETES_EXPOSED_GATEWAY_ENDPOINT,
            "x-nemoclaw-error": "expose.endpoint must be https://HOST:PORT with a lowercase DNS name or IPv4 address, a nonzero port, and no path"
        }),
    );
    let mut openshift_expose = expose.clone();
    expose["properties"]
        .as_object_mut()
        .expect("expose properties")
        .remove("route");
    expose["description"] = json!(
        "Publication of a managed Kubernetes gateway's endpoint through the chart's Service."
    );
    expose["required"] = json!(["endpoint", "service"]);
    expose["x-nemoclaw-error"] = json!(
        "a kubernetes target's expose takes endpoint and service; only the openshift target publishes the gateway through a route"
    );
    openshift_expose["description"] = json!(
        "Publication of a managed OpenShift gateway's endpoint, through exactly one of service and route."
    );
    openshift_expose["required"] = json!(["endpoint"]);
    openshift_expose["allOf"] = json!([
        {
            "oneOf": [{"required": ["service"]}, {"required": ["route"]}],
            "x-nemoclaw-error": "expose takes exactly one of service and route"
        },
        {
            // The Route's host is the endpoint's, and clients send no SNI host
            // name for an IP address, so the router could never match it.
            "if": {"required": ["route"]},
            "then": {"properties": {"endpoint": {"not": {"pattern": r"^https://[0-9]+(?:\.[0-9]+){3}:[0-9]+$"}}}},
            "x-nemoclaw-error": "expose.route needs an endpoint with a DNS name, because the Route's host is the endpoint's and clients send no SNI host name for an IP address; expose.service accepts an IP address"
        }
    ]);
    defs.insert("OpenShiftExpose".into(), openshift_expose);
    let mut openshift = defs["ManagedKubernetes"].clone();
    openshift["description"] = json!(
        "An existing OpenShift cluster for a managed gateway, with the fields of a kubernetes target. The namespace assigns the gateway's user and group IDs, and expose may also take a Route."
    );
    openshift["properties"]["expose"]["$ref"] = json!("#/$defs/OpenShiftExpose");
    defs.insert("ManagedOpenShift".into(), openshift);

    for variant in defs["ManagedTarget"]["oneOf"]
        .as_array_mut()
        .expect("managed target variants")
    {
        let key = variant["required"][0]
            .as_str()
            .expect("externally tagged target")
            .to_owned();
        let definition = match key.as_str() {
            "docker" => "DockerTarget",
            "podman" => "PodmanTarget",
            "kubernetes" => "ManagedKubernetes",
            "openshift" => "ManagedOpenShift",
            _ => panic!("unknown managed target {key}"),
        };
        variant["properties"][&key]["$ref"] = json!(format!("#/$defs/{definition}"));
    }
    // A target's key is its only field, so it carries the target's
    // description, which editors show beside it.
    for union in ["ManagedTarget", "ExternalTarget"] {
        for variant in defs[union]["oneOf"]
            .as_array_mut()
            .expect("target variants")
        {
            let key = variant["required"][0]
                .as_str()
                .expect("externally tagged target")
                .to_owned();
            let description = variant["description"].clone();
            variant["properties"][&key]["description"] = description;
        }
    }
}
