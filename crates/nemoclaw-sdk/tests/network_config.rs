// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, Network, NetworkPolicy, Proxy, schema::input_schema},
};
use serde_json::{Value, json};

fn input() -> Value {
    let mut value: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    value["spec"]["sandboxes"][0]["network"] = json!({
        "policy": {"explicit": {
            "version": 1,
            "filesystem_policy": {"include_workdir": false, "read_only": ["/usr", "/opt", "/app"], "read_write": ["/sandbox", "/tmp"]},
            "landlock": {"compatibility": "best_effort"},
            "process": {"run_as_user": "1000", "run_as_group": "1000"},
            "network_policies": {"docs": {"name": "docs", "endpoints": [{"host": "docs.example.com", "port": 443, "protocol": "rest", "tls": "terminate", "enforcement": "enforce", "rules": [{"allow": {"method": "GET", "path": "/docs/**"}}]}], "binaries": [{"path": "/usr/bin/curl"}]}}
        }},
        "proxy": {"host": "10.200.0.1", "port": 3129}
    });
    value
}
fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(serde_json::to_vec(value).unwrap().as_slice())
}
#[test]
fn explicit_policy_and_proxy_survive_yaml_and_compilation() {
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
        policy["network_policies"]["docs"]["endpoints"][0]["rules"][0]["allow"]["method"],
        "GET"
    );
    assert_eq!(sandbox["proxy_host"], "10.200.0.1");
    assert_eq!(sandbox["proxy_port"], "3129");
}
#[test]
fn conflicting_unknown_and_invalid_network_settings_are_rejected() {
    for (path, replacement) in [
        ("/spec/sandboxes/0/network/tier", json!("isolated")),
        (
            "/spec/sandboxes/0/network/proxy/host",
            json!("user:secret@proxy"),
        ),
        ("/spec/sandboxes/0/network/proxy/port", json!(0)),
        ("/spec/sandboxes/0/network/proxy/port", json!(65536)),
        (
            "/spec/sandboxes/0/network/policy/explicit/version",
            json!(0),
        ),
        (
            "/spec/sandboxes/0/network/policy/explicit/network_policies/docs/endpoints/0/port",
            json!(0),
        ),
    ] {
        let mut value = input();
        let (parent, key) = path.rsplit_once('/').unwrap();
        value.pointer_mut(parent).unwrap()[key] = replacement;
        assert!(parse(&value).is_err(), "{path}");
    }
    let mut value = input();
    value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["network_policies"]["docs"]["endpoints"]
        [0]["credentials"] = json!("secret");
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
        document["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["network_policies"]["docs"]
            ["endpoints"][0][field] = value;
        assert!(parse(&document).is_err(), "must reject {field}");
    }
}

#[test]
fn explicit_policy_supports_tcp_rest_websocket_rpc_mcp_and_deny_all() {
    let endpoints = [
        json!({"host": "docs.example.com", "ports": [80,443]}),
        json!({"allowed_ips": ["10.50.0.0/24"], "port": 8443}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "rest", "tls": "terminate", "access": "read-only"}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "websocket", "tls": "terminate", "rules": [{"allow": {"method": "GET", "path": "/ws"}}]}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "json-rpc", "tls": "terminate", "json_rpc": {"max_body_bytes": 65536}, "rules": [{"allow": {"method": "ping"}}]}),
        json!({"host": "docs.example.com", "port": 443, "protocol": "mcp", "tls": "terminate", "mcp": {"strict_tool_names": true}, "rules": [{"allow": {"method": "tools/call", "params": {"name": "read_*"}}}]}),
    ];
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for endpoint in endpoints {
        let mut value = input();
        value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["network_policies"]["docs"]
            ["endpoints"][0] = endpoint.clone();
        assert!(validator.is_valid(&value), "schema: {endpoint}");
        let document = parse(&value).unwrap_or_else(|e| panic!("{endpoint}: {e}"));
        let proto = document.spec.sandboxes[0].network.policy_proto().unwrap();
        assert!(
            nemoclaw_sdk::openshell::policy_json(&proto).is_ok(),
            "observation must retain {endpoint}"
        );
    }
    let mut value = input();
    value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["network_policies"] = json!({});
    let document = parse(&value).unwrap();
    assert!(
        nemoclaw_sdk::openshell::policy_json(
            &document.spec.sandboxes[0].network.policy_proto().unwrap()
        )
        .is_ok()
    );
}

#[test]
fn policy_template_markers_remain_literal_in_opentofu_configuration() {
    let mut value = input();
    value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["network_policies"]["docs"]["endpoints"]
        [0]["rules"][0]["allow"]["path"] = json!("/docs/${file}/%{literal}");
    let document = parse(&value).unwrap();
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    let graph = nemoclaw_sdk::compile::compile(&document, &generations, "0.1.0").unwrap();
    let encoded = graph["resource"]["nemoclaw_sandbox"]["assistant"]["policy_json"]
        .as_str()
        .unwrap();
    assert!(encoded.contains("/docs/$${file}/%%{literal}"));
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
fn explicit_filesystem_policy_must_allow_the_selected_runtime() {
    for (harness, extra) in [
        ("openclaw", "/app"),
        ("hermes", "/opt/hermes"),
        ("pi", "/opt/fabric-source"),
        ("deepagents", "/opt/fabric"),
    ] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["harness"] = json!({"kind": harness});
        let fs = "/spec/sandboxes/0/network/policy/explicit/filesystem_policy";
        value.pointer_mut(fs).unwrap()["read_only"] = json!(["/usr"]);
        assert!(
            parse(&value)
                .unwrap_err()
                .to_string()
                .contains("/opt/fabric")
        );
        value.pointer_mut(fs).unwrap()["read_only"] =
            json!(["/usr", "/opt/fabric", "/opt/nemoclaw", extra]);
        parse(&value).unwrap();
        value.pointer_mut(fs).unwrap()["read_only"] = json!(["/usr", "/opt/fabric", extra]);
        assert!(
            parse(&value)
                .unwrap_err()
                .to_string()
                .contains("/opt/nemoclaw")
        );
    }
}

#[test]
fn runtime_grants_accept_parents_and_writable_paths_without_rewriting_policy() {
    for grants in [
        json!(["/opt", "/app"]),
        json!(["/opt/fabric", "/opt/nemoclaw", "/app/"]),
    ] {
        let mut value = input();
        let fs = value
            .pointer_mut("/spec/sandboxes/0/network/policy/explicit/filesystem_policy")
            .unwrap();
        fs["read_only"] = json!(["/usr"]);
        fs["read_write"] = grants;
        let document = parse(&value).unwrap();
        let expected = value["spec"]["sandboxes"][0]["network"]["policy"].clone();
        assert_eq!(
            serde_json::to_value(&document.spec.sandboxes[0].network).unwrap()["policy"],
            expected
        );
    }
    for grants in [
        json!(["/op", "/app"]),
        json!(["/opt/fabric-source", "/opt/nemoclaw", "/app"]),
        json!(["/opt/../unrelated", "/app"]),
    ] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["filesystem_policy"]["read_only"] =
            grants;
        assert!(parse(&value).is_err());
    }
}

#[test]
fn shared_harness_policy_is_checked_but_omitted_filesystem_grants_keep_defaults() {
    let mut value = input();
    value["spec"]["harnesses"] = json!({"shared": {"kind": "openclaw"}});
    value["spec"]["sandboxes"][0]
        .as_object_mut()
        .unwrap()
        .remove("harness");
    value["spec"]["sandboxes"][0]["harnessRef"] = json!("shared");
    let policy = &mut value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"];
    policy["filesystem_policy"]["read_only"] = json!(["/usr", "/opt"]);
    parse(&value).unwrap();
    value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]
        .as_object_mut()
        .unwrap()
        .remove("filesystem_policy");
    parse(&value).unwrap();
}

#[tokio::test]
async fn plan_and_apply_reject_a_blocked_runtime_before_opening_bundle_or_state() {
    use nemoclaw_sdk::{CancellationToken, Deployment};
    let mut document = parse(&input()).unwrap();
    let mut second = document.spec.sandboxes[0].clone();
    second.name = "blocked".into();
    let NetworkPolicy::Explicit(policy) = &mut second.network.policy else {
        panic!("expected explicit policy");
    };
    let filesystem = policy.filesystem_policy.as_mut().unwrap();
    filesystem.read_only = Some(vec!["/usr".into()]);
    filesystem.include_workdir = Some(true);
    document.spec.sandboxes.push(second);
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &directory.path().join("missing-bundle"));
    let cancel = CancellationToken::new();
    assert!(
        deployment
            .plan(&document, &cancel)
            .await
            .unwrap_err()
            .to_string()
            .contains("/opt/fabric")
    );
    assert!(
        deployment
            .apply(&document, &cancel)
            .await
            .unwrap_err()
            .to_string()
            .contains("/opt/fabric")
    );
    assert!(!state.exists());
}

#[test]
fn landlock_uses_runtime_spellings_without_main_branch_aliases() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for spelling in ["best_effort", "hard_requirement", "strict"] {
        let mut value = input();
        value["spec"]["sandboxes"][0]["network"]["policy"]["explicit"]["landlock"]["compatibility"] =
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
                document.spec.sandboxes[0]
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
    let explicit = input()["spec"]["sandboxes"][0]["network"]["policy"].clone();
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
    for value in [json!({}), json!({"tier": ""}), json!({"tier": "isolated"})] {
        assert_eq!(serde_json::from_value::<Network>(value).unwrap(), default);
    }
}

#[test]
fn policy_choice_and_proxy_are_independent_and_keep_the_export_shape() {
    let explicit_input = input()["spec"]["sandboxes"][0]["network"]["policy"].clone();
    let explicit = serde_json::from_value(explicit_input["explicit"].clone()).unwrap();
    for (policy, expected) in [
        (NetworkPolicy::Isolated, json!({"tier": "isolated"})),
        (
            NetworkPolicy::Explicit(explicit),
            json!({"policy": explicit_input}),
        ),
    ] {
        for proxy in [
            None,
            Some(Proxy {
                host: "proxy.example.com".into(),
                port: 3128,
            }),
        ] {
            let network = Network {
                policy: policy.clone(),
                proxy: proxy.clone(),
            };
            network.validate().unwrap();
            let mut expected = expected.clone();
            if let Some(proxy) = &proxy {
                expected["proxy"] = serde_json::to_value(proxy).unwrap();
            }
            assert_eq!(serde_json::to_value(&network).unwrap(), expected);
            assert_eq!(
                serde_json::from_value::<Network>(expected).unwrap(),
                network
            );
            assert_eq!(
                network.policy_proto().unwrap(),
                Network {
                    policy: policy.clone(),
                    proxy: None
                }
                .policy_proto()
                .unwrap()
            );
        }
    }
}
