// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A gateway whose sandbox policy APF authors.
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};

fn example(source: &str) -> Value {
    serde_saphyr::from_str(source).unwrap()
}

fn governed(mut value: Value) -> Value {
    value["spec"]["gateway"]["policyAuthority"] = json!({"apf": {"registration": "external"}});
    value
}

const APF_ENDPOINT: &str = "https://host.docker.internal:18202";

/// A managed Docker gateway on which NemoClaw registers APF itself.
fn registered(ca: bool) -> Value {
    let mut value = example(include_str!("../../../examples/managed-hermes.yaml"));
    let mut apf = json!({"registration": "managed", "endpoint": APF_ENDPOINT});
    if ca {
        apf["tls"] = json!({"ca": {"env": "APF_CA_FILE"}});
    }
    value["spec"]["gateway"]["policyAuthority"] = json!({"apf": apf});
    value
}

fn runtime_graph(document: &Document) -> Value {
    let generations: Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
        "ollama",
        "ollama_service",
        "container_service",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    nemoclaw_sdk::compile::compile_runtime(document, &generations, "0.1.0").unwrap()
}

fn parse(value: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(value.to_string().as_bytes())
}

fn values(document: &Document, kind: &str) -> std::collections::BTreeMap<String, String> {
    let generations: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    targets(document, &generations)
        .unwrap()
        .into_iter()
        .find(|row| row.kind == kind)
        .unwrap()
        .values
}

fn sandbox_values(document: &Document) -> std::collections::BTreeMap<String, String> {
    values(document, "sandbox")
}

#[test]
fn either_gateway_mode_accepts_apf_as_the_policy_authority() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for source in [
        include_str!("../../../examples/local.yaml"),
        include_str!("../../../examples/managed-hermes.yaml"),
    ] {
        let value = governed(example(source));
        assert!(validator.is_valid(&value), "{value}");
        let document = parse(&value).unwrap();
        assert_eq!(document.validate().map_err(|e| e.to_string()), Ok(()));
        assert_eq!(parse(&json!(document)).unwrap(), document);
        assert_eq!(sandbox_values(&document)["policy_authority"], "apf");
        // APF also serves the credential profiles.
        assert_eq!(values(&document, "inference")["policy_authority"], "apf");
    }
}

#[test]
fn apf_serves_every_credential_profile_on_a_governed_gateway() {
    let source = include_str!("../../../examples/travel-team.yaml");
    let kinds = ["inference", "web_search", "api"];
    let document = parse(&governed(example(source))).unwrap();
    for kind in kinds {
        assert_eq!(values(&document, kind)["policy_authority"], "apf", "{kind}");
    }
    let document = parse(&example(source)).unwrap();
    for kind in kinds {
        assert!(
            !values(&document, kind).contains_key("policy_authority"),
            "{kind}"
        );
    }
}

#[test]
fn without_a_policy_authority_nemoclaw_authors_the_policy() {
    let document = parse(&example(include_str!("../../../examples/local.yaml"))).unwrap();
    assert!(!sandbox_values(&document).contains_key("policy_authority"));
    assert!(!values(&document, "inference").contains_key("policy_authority"));
}

#[test]
fn an_unknown_policy_authority_is_rejected() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let mut value = example(include_str!("../../../examples/local.yaml"));
    value["spec"]["gateway"]["policyAuthority"] = json!({"other": {}});
    assert!(!validator.is_valid(&value));
    assert!(parse(&value).is_err());
    value["spec"]["gateway"]["policyAuthority"] = json!({"apf": {"unknown": true}});
    assert!(!validator.is_valid(&value));
    assert!(parse(&value).is_err());
    // The document says who registers APF.
    value["spec"]["gateway"]["policyAuthority"] = json!({"apf": {}});
    assert!(!validator.is_valid(&value));
    assert!(parse(&value).is_err());
    // An operator who registers APF also owns its connection settings.
    value["spec"]["gateway"]["policyAuthority"] =
        json!({"apf": {"registration": "external", "endpoint": APF_ENDPOINT}});
    assert!(!validator.is_valid(&value));
    assert!(parse(&value).is_err());
}

#[test]
fn a_managed_docker_gateway_registers_apf_with_its_connection_settings() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for ca in [false, true] {
        let value = registered(ca);
        assert!(validator.is_valid(&value), "{value}");
        let document = parse(&value).unwrap();
        assert_eq!(document.validate().map_err(|e| e.to_string()), Ok(()));
        assert_eq!(parse(&json!(document)).unwrap(), document);
        assert_eq!(sandbox_values(&document)["policy_authority"], "apf");
        assert_eq!(
            document.credential_names().contains(&"APF_CA_FILE"),
            ca,
            "the CA file reaches the providers that read it"
        );
        let graph = runtime_graph(&document);
        let launch = "data.openshell_docker_gateway_runtime.managed_gateway_runtime";
        let settings =
            &graph["data"]["openshell_docker_gateway_runtime"]["managed_gateway_runtime"];
        assert_eq!(settings["apf_endpoint"], APF_ENDPOINT);
        let gateway = &graph["resource"]["docker_container"]["managed_gateway_runtime"];
        let mut upload = vec![json!({
            "file": "${openshell_gateway_storage.runtime.data_path}/gateway.toml",
            "content": format!("${{{launch}.config_file}}"),
        })];
        if ca {
            assert_eq!(settings["apf_ca_env"], "APF_CA_FILE");
            upload.push(json!({
                "file": "${openshell_gateway_storage.runtime.data_path}/apf/ca.pem",
                "content": format!("${{{launch}.apf_ca}}"),
            }));
        } else {
            assert!(settings.get("apf_ca_env").is_none());
        }
        assert_eq!(gateway["upload"], json!(upload));
    }
}

#[test]
fn the_gateway_file_registers_apf_as_interceptor_and_profile_source() {
    use nemoclaw_sdk::managed::{ApfRegistration, docker_gateway_config};
    let name = "nc-0123456789abcdef-gateway";
    for ca in [false, true] {
        let apf = ApfRegistration {
            endpoint: APF_ENDPOINT.into(),
            ca: ca.then(|| "/data/apf/ca.pem".into()),
        };
        let file: toml::Table =
            toml::from_str(&docker_gateway_config(name, "/data", "", Some(&apf)).unwrap()).unwrap();
        let gateway = serde_json::to_value(&file["openshell"]["gateway"]).unwrap();
        let mut interceptor = json!({
            "name": "apf-policy-adapter",
            "grpc_endpoint": APF_ENDPOINT,
            "order": 0,
            "failure_policy": "fail_closed",
        });
        if ca {
            interceptor["tls_ca_cert_path"] = json!("/data/apf/ca.pem");
        }
        assert_eq!(gateway["interceptors"], json!([interceptor]));
        assert_eq!(
            gateway["provider_profile_sources"],
            json!([{"type": "interceptor", "name": "apf-policy-adapter"}])
        );
    }
    let file: toml::Table =
        toml::from_str(&docker_gateway_config(name, "/data", "", None).unwrap()).unwrap();
    assert!(file["openshell"]["gateway"].get("interceptors").is_none());
}

#[test]
fn nemoclaw_registers_apf_only_where_it_owns_the_gateway_file() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    let rejected = |value: &Value, reason: &str| {
        let error = parse(value)
            .and_then(|document| document.validate().map(|()| document))
            .expect_err(reason);
        assert!(
            error.to_string().contains("policyAuthority.apf"),
            "{reason}: {error}"
        );
    };
    // An external gateway's operator registers its interceptors.
    let mut value = example(include_str!("../../../examples/local.yaml"));
    value["spec"]["gateway"]["policyAuthority"] =
        json!({"apf": {"registration": "managed", "endpoint": APF_ENDPOINT}});
    rejected(&value, "external gateway");
    // The registration has one source.
    for key in [
        "openshell.gateway.interceptors",
        "openshell.gateway.provider_profile_sources",
    ] {
        let mut value = registered(false);
        value["spec"]["gateway"]["config"] = json!({key: [{"name": "other"}]});
        rejected(&value, key);
    }
    // OpenShell dials APF over TLS.
    let mut value = registered(false);
    value["spec"]["gateway"]["policyAuthority"]["apf"]["endpoint"] =
        json!("http://host.docker.internal:18202");
    rejected(&value, "plaintext endpoint");
    let mut value = registered(false);
    value["spec"]["gateway"]["policyAuthority"]["apf"]
        .as_object_mut()
        .unwrap()
        .remove("endpoint");
    assert!(!validator.is_valid(&value));
    assert!(parse(&value).is_err(), "missing endpoint");
    // Podman and Kubernetes gateways register APF in spec.gateway.config.
    let mut value = registered(false);
    value["spec"]["gateway"]["runtime"]["provider"] = json!("podman");
    rejected(&value, "podman");
}

#[test]
fn an_apf_governed_sandbox_cannot_author_its_own_policy() {
    let mut value = governed(example(include_str!("../../../examples/local.yaml")));
    value["spec"]["sandboxes"]["assistant"]["network"] = json!({"policy": {"explicit": {
        "version": 1,
        "filesystem_policy": {"include_workdir": false, "read_only": ["/usr"], "read_write": ["/tmp"]},
        "landlock": {"compatibility": "best_effort"},
        "process": {"run_as_user": "10001", "run_as_group": "10001"},
        "network_policies": {}
    }}});
    let error = parse(&value).unwrap_err();
    assert!(error.to_string().contains("policyAuthority"), "{error}");
    value["spec"]["gateway"]
        .as_object_mut()
        .unwrap()
        .remove("policyAuthority");
    parse(&value).expect("without APF, the sandbox may author its policy");
}
