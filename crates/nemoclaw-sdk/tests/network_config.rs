// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, Network, NetworkPolicy, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    value["spec"]["sandboxes"]["assistant"]["network"] = json!({
        "policy": {"explicit": {
            "version": 1,
            "filesystem_policy": {"include_workdir": false, "read_only": ["/usr", "/opt", "/app"], "read_write": ["/sandbox", "/tmp"]},
            "landlock": {"compatibility": "best_effort"},
            "process": {"run_as_user": "10001", "run_as_group": "10001"},
            "network_policies": {"docs": {"name": "docs", "endpoints": [{"host": "docs.example.com", "port": 443, "protocol": "rest", "enforcement": "enforce", "rules": [{"allow": {"method": "GET", "path": "/docs/**"}}]}], "binaries": [{"path": "/usr/bin/curl"}]}}
        }}
    });
    value
}
fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(serde_json::to_vec(value).unwrap().as_slice())
}
#[test]
fn sandbox_proxy_override_is_rejected_before_deployment() {
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["network"]["proxy"] =
        json!({"host": "10.200.0.1", "port": 3129});
    assert!(
        parse(&value).is_err(),
        "sandbox proxy overrides must not replace OpenShell's policy proxy"
    );
    assert!(
        !jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&value)
    );
}
#[test]
fn explicit_policy_survives_yaml_and_compilation() {
    let value = input();
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(
        validator.is_valid(&value),
        "explicit network input must have an editor schema"
    );
    let document = parse(&value).expect("explicit network input must parse");
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    let rows = targets(&document, &generations).unwrap();
    let sandbox = &rows
        .iter()
        .find(|row| row.kind == "sandbox")
        .unwrap()
        .values;
    let policy: Value = serde_json::from_str(&sandbox["policy_json"]).unwrap();
    assert_eq!(
        policy["explicit"]["network_policies"]["docs"]["endpoints"][0]["rules"][0]["allow"]["method"],
        "GET"
    );
}
#[test]
fn an_endpoint_without_enforcement_leaves_the_mode_to_openshell() {
    use openshell_core::proto::NetworkEnforcementMode;
    let enforcement = |value: &Value| {
        let proto = parse(value).unwrap().spec.sandboxes["assistant"]
            .network
            .policy_proto()
            .unwrap();
        proto.network_policies["docs"].endpoints[0].enforcement()
    };
    let mut value = input();
    assert_eq!(enforcement(&value), NetworkEnforcementMode::Enforce);
    value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["network_policies"]
        ["docs"]["endpoints"][0]
        .as_object_mut()
        .unwrap()
        .remove("enforcement");
    assert_eq!(enforcement(&value), NetworkEnforcementMode::Unspecified);
}
#[test]
fn conflicting_unknown_and_invalid_network_settings_are_rejected() {
    for (path, replacement) in [
        ("/spec/sandboxes/assistant/network/tier", json!("isolated")),
        (
            "/spec/sandboxes/assistant/network/policy/explicit/version",
            json!(0),
        ),
        (
            "/spec/sandboxes/assistant/network/policy/explicit/network_policies/docs/endpoints/0/port",
            json!(0),
        ),
    ] {
        let mut value = input();
        let (parent, key) = path.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[key] = replacement;
        assert!(parse(&value).is_err(), "{path}");
    }
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["network_policies"]
        ["docs"]["endpoints"][0]["credentials"] = json!("secret");
    let error = parse(&value).unwrap_err();
    assert!(!error.to_string().contains("secret"));
}

#[test]
fn policy_rejects_silently_ignored_or_ambiguous_endpoint_options() {
    for (field, value) in [
        ("ports", json!([443])),
        ("protocol", json!("sql")),
        ("rules", json!([])),
        ("json_rpc", json!({"max_body_bytes": 0})),
        ("mcp", json!({"max_body_bytes": 0})),
    ] {
        let mut document = input();
        document["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["network_policies"]
            ["docs"]["endpoints"][0][field] = value;
        assert!(parse(&document).is_err(), "must reject {field}");
    }
}

#[test]
fn explicit_policy_supports_tcp_rest_websocket_rpc_mcp_and_deny_all() {
    let endpoints = [
        json!({"host": "docs.example.com", "ports": [80,443]}),
        json!({"allowed_ips": ["10.50.0.0/24"], "port": 8443}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "rest", "access": "read-only"}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "websocket", "rules": [{"allow": {"method": "GET", "path": "/ws"}}]}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "json-rpc", "json_rpc": {"max_body_bytes": 65536}, "rules": [{"allow": {"method": "ping"}}]}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "mcp", "mcp": {"strict_tool_names": true}, "rules": [{"allow": {"method": "tools/call", "params": {"name": "read_*"}}}]}),
    ];
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for endpoint in endpoints {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["network_policies"]
            ["docs"]["endpoints"][0] = endpoint.clone();
        assert!(validator.is_valid(&value), "schema: {endpoint}");
        let document = parse(&value).unwrap_or_else(|e| panic!("{endpoint}: {e}"));
        let proto = document.spec.sandboxes["assistant"]
            .network
            .policy_proto()
            .unwrap();
        assert!(
            nemoclaw_sdk::config::policy_json(&proto).is_ok(),
            "observation must retain {endpoint}"
        );
    }
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["network_policies"] =
        json!({});
    let document = parse(&value).unwrap();
    assert!(
        nemoclaw_sdk::config::policy_json(
            &document.spec.sandboxes["assistant"]
                .network
                .policy_proto()
                .unwrap()
        )
        .is_ok()
    );
}

/// A middleware binding with every field set.
fn guard() -> Value {
    json!({
        "name": "Decision guard",
        "middleware": "decision-guard",
        "order": 10,
        "on_error": "fail_closed",
        "config": {"mode": "block", "terms": ["forbidden"]},
        "endpoints": {"include": ["docs.example.com"], "exclude": ["trusted.example.com"]}
    })
}

/// The input's explicit policy.
fn explicit(value: &mut Value) -> &mut Value {
    &mut value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]
}

/// The input with `binding` attached as `guard`.
fn with_guard(binding: Value) -> Value {
    let mut value = input();
    explicit(&mut value)["network_middlewares"] = json!({"guard": binding});
    value
}

/// The input with `guard()` attached after `change`.
fn guard_changed(change: impl FnOnce(&mut serde_json::Map<String, Value>)) -> Value {
    let mut binding = guard();
    change(binding.as_object_mut().unwrap());
    with_guard(binding)
}

fn policy(value: &Value) -> openshell_core::proto::SandboxPolicy {
    parse(value).unwrap().spec.sandboxes["assistant"]
        .network
        .policy_proto()
        .unwrap()
}

#[test]
fn a_middleware_binding_reaches_openshell_as_written() {
    let policy = policy(&with_guard(guard()));
    let binding = &policy.network_middlewares["guard"];
    assert_eq!(binding.name, "Decision guard");
    assert_eq!(binding.middleware, "decision-guard");
    assert_eq!(binding.order, 10);
    assert_eq!(binding.on_error, "fail_closed");
    let selector = binding.endpoints.as_ref().unwrap();
    assert_eq!(selector.include, ["docs.example.com"]);
    assert_eq!(selector.exclude, ["trusted.example.com"]);
    assert_eq!(
        openshell_core::proto_struct::struct_to_json_value(binding.config.as_ref().unwrap()),
        guard()["config"]
    );
}

#[test]
fn an_observed_middleware_binding_reads_back_complete() {
    let policy = policy(&with_guard(guard()));
    let observed = nemoclaw_sdk::config::policy_json(&policy)
        .expect("an observation must keep the binding, not report it incomplete");
    let reread: nemoclaw_sdk::config::ExplicitPolicy = serde_json::from_str(&observed).unwrap();
    assert_eq!(
        reread.to_proto().unwrap().network_middlewares,
        policy.network_middlewares
    );
}

#[test]
fn compilation_and_export_keep_a_middleware_binding_as_authored() {
    let document = parse(&with_guard(guard())).unwrap();
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    let rows = targets(&document, &generations).unwrap();
    let sandbox = &rows
        .iter()
        .find(|row| row.kind == "sandbox")
        .unwrap()
        .values;
    let compiled: Value = serde_json::from_str(&sandbox["policy_json"]).unwrap();
    assert_eq!(
        compiled["explicit"]["network_middlewares"],
        json!({"guard": guard()})
    );
}

#[test]
fn middleware_fields_outside_openshells_schema_are_rejected() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    assert!(validator.is_valid(&with_guard(guard())));
    for (case, value) in [
        (
            "unknown field",
            guard_changed(|binding| {
                binding.insert("service".into(), json!("decision-guard"));
            }),
        ),
        (
            "unknown selector field",
            guard_changed(|binding| {
                binding["endpoints"]["ports"] = json!([443]);
            }),
        ),
        (
            "missing selector",
            guard_changed(|binding| {
                binding.remove("endpoints");
            }),
        ),
        (
            "unknown failure behavior",
            guard_changed(|binding| {
                binding["on_error"] = json!("retry");
            }),
        ),
    ] {
        assert!(!validator.is_valid(&value), "schema must reject {case}");
        assert!(parse(&value).is_err(), "parsing must reject {case}");
    }
}

#[test]
fn openshell_rejects_well_formed_but_invalid_middleware_bindings() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut duplicate_order = with_guard(guard());
    explicit(&mut duplicate_order)["network_middlewares"]["second"] = json!({"middleware": "openshell/regex", "order": 10, "endpoints": {"include": ["docs.example.com"]}});
    for (case, value) in [
        (
            "empty middleware name",
            guard_changed(|binding| {
                binding["middleware"] = json!("");
            }),
        ),
        (
            "empty selector",
            guard_changed(|binding| {
                binding["endpoints"] = json!({"include": []});
            }),
        ),
        ("duplicate order", duplicate_order),
    ] {
        assert!(
            validator.is_valid(&value),
            "the schema leaves {case} to OpenShell"
        );
        let error = parse(&value).expect_err(case).to_string();
        assert!(error.contains("OpenShell validation"), "{case}: {error}");
    }
}

#[test]
fn fail_closed_middleware_cannot_select_an_uninspected_endpoint() {
    let uninspected = |mut value: Value| {
        explicit(&mut value)["network_policies"]["docs"]["endpoints"][0] =
            json!({"host": "docs.example.com", "port": 443, "tls": "skip"});
        value
    };
    assert!(parse(&uninspected(input())).is_ok());
    let error = parse(&uninspected(with_guard(guard())))
        .unwrap_err()
        .to_string();
    assert!(error.contains("OpenShell validation"), "{error}");
}

#[test]
fn policy_template_markers_remain_literal_in_opentofu_configuration() {
    let mut value = input();
    value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["network_policies"]
        ["docs"]["endpoints"][0]["rules"][0]["allow"]["path"] = json!("/docs/${file}/%{literal}");
    let document = parse(&value).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    let graph = nemoclaw_sdk::compile::compile(&document, &generations, "0.1.0").unwrap();
    let policy = &graph["resource"]["openshell_sandbox"]["assistant"]["policy"];
    assert_eq!(
        policy["explicit"]["network_policies"]["docs"]["endpoints"][0]["rules"][0]["allow"]["path"],
        "/docs/$${file}/%%{literal}",
        "{policy}"
    );
    let rows = targets(&document, &generations).unwrap();
    assert!(
        rows.iter()
            .find(|row| row.kind == "sandbox")
            .unwrap()
            .values["policy_json"]
            .contains("/docs/${file}/%{literal}")
    );
}

#[test]
fn document_validation_preserves_filesystem_intent_until_image_discovery() {
    for grants in [
        json!(["/usr"]),
        json!(["/srv/runtime"]),
        json!(["/opt", "/app"]),
    ] {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["filesystem_policy"]
            ["read_only"] = grants;
        let document = parse(&value).unwrap();
        assert_eq!(
            serde_json::to_value(&document.spec.sandboxes["assistant"].network).unwrap()["policy"],
            value["spec"]["sandboxes"]["assistant"]["network"]["policy"]
        );
    }
}

#[test]
fn landlock_uses_runtime_spellings_without_main_branch_aliases() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for spelling in ["best_effort", "hard_requirement", "strict"] {
        let mut value = input();
        value["spec"]["sandboxes"]["assistant"]["network"]["policy"]["explicit"]["landlock"]["compatibility"] =
            json!(spelling);
        if spelling == "strict" {
            assert!(
                parse(&value).is_err(),
                "removed alias must not be translated"
            );
            assert!(!validator.is_valid(&value));
        } else {
            assert!(validator.is_valid(&value));
            let document = parse(&value).unwrap();
            assert_eq!(
                document.spec.sandboxes["assistant"]
                    .network
                    .policy_proto()
                    .unwrap()
                    .landlock
                    .unwrap()
                    .compatibility,
                spelling
            );
        }
    }
}

#[test]
fn network_deserialization_rejects_conflicting_policy_choices() {
    let explicit = input()["spec"]["sandboxes"]["assistant"]["network"]["policy"].clone();
    for value in [
        json!({"tier": "isolated", "policy": explicit}),
        json!({"tier": "unrestricted"}),
    ] {
        assert!(serde_json::from_value::<Network>(value).is_err());
    }
}

#[test]
fn default_network_is_a_valid_isolated_policy() {
    let default = Network::default();
    default.validate().unwrap();
    assert_eq!(default.policy, NetworkPolicy::Isolated);
    assert!(
        default
            .policy_proto()
            .unwrap_err()
            .to_string()
            .contains("image runtime metadata")
    );
    for value in [json!({}), json!({"tier": ""}), json!({"tier": "isolated"})] {
        assert_eq!(serde_json::from_value::<Network>(value).unwrap(), default);
    }
}

#[test]
fn policy_choice_preserves_the_export_shape() {
    let explicit_input = input()["spec"]["sandboxes"]["assistant"]["network"]["policy"].clone();
    let explicit = serde_json::from_value(explicit_input["explicit"].clone()).unwrap();
    for (policy, expected) in [
        (NetworkPolicy::Isolated, json!({"tier": "isolated"})),
        (
            NetworkPolicy::Explicit(explicit),
            json!({"policy": explicit_input}),
        ),
    ] {
        let network = Network {
            policy,
            grants: Default::default(),
        };
        network.validate().unwrap();
        assert_eq!(serde_json::to_value(&network).unwrap(), expected);
        assert_eq!(
            serde_json::from_value::<Network>(expected).unwrap(),
            network
        );
    }
}

#[test]
fn removed_tls_modes_are_rejected_and_automatic_tls_round_trips() {
    let mut value = input();
    let endpoint =
        "/spec/sandboxes/assistant/network/policy/explicit/network_policies/docs/endpoints/0";
    value
        .pointer_mut(endpoint)
        .unwrap()
        .as_object_mut()
        .unwrap()
        .remove("tls");
    let document = parse(&value).expect("omitted TLS selects automatic handling");
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );
}
