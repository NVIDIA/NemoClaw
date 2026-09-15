// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::{
    compile::{Generations, targets},
    config::{Document, schema::input_schema},
};
use serde_json::{Value, json};
fn input(harness: &str) -> Value {
    let mut v: Value =
        serde_saphyr::from_str(include_str!("../../../examples/local.yaml")).unwrap();
    v["spec"]["sandboxes"][0]["agents"][0]["harness"] = json!(harness);
    v
}
fn parse(v: &Value) -> Result<Document, nemoclaw_sdk::config::ConfigError> {
    Document::parse(serde_json::to_vec(v).unwrap().as_slice())
}
#[test]
fn api_and_tuning_survive_compilation_and_yaml() {
    let mut v = input("openclaw");
    v["spec"]["inferenceProviders"][0]["api"] = json!("openai-responses");
    let route = &mut v["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"];
    route["contextWindow"] = json!(65536);
    route["maxTokens"] = json!(8192);
    route["reasoning"] = json!(true);
    route["reasoningEffort"] = json!("high");
    let d = parse(&v).expect("API and tuning must parse");
    assert!(
        jsonschema::validator_for(&input_schema())
            .unwrap()
            .is_valid(&v)
    );
    assert_eq!(parse(&serde_json::to_value(&d).unwrap()).unwrap(), d);
    let g: Generations = ["workspace", "provider", "sandbox"]
        .map(|k| (k.into(), format!("{k}-generation")))
        .into();
    let rows = targets(&d, &g).unwrap();
    let settings: Value = serde_json::from_str(&rows[3].values["inference_json"]).unwrap();
    assert_eq!(settings["api"], "openai-responses");
    assert_eq!(settings["tuning"]["contextWindow"], 65536);
    assert_eq!(settings["tuning"]["reasoningEffort"], "high");
}
#[test]
fn hermes_auth_requires_the_routed_credential_provider() {
    let mut v = input("hermes");
    let name = v["spec"]["inferenceProviders"][0]["name"].clone();
    v["spec"]["inferenceProviders"][0]["endpoint"] =
        json!("https://inference-api.nousresearch.com/v1");
    v["spec"]["inferenceProviders"][0]["credential"] = json!({"env":"NOUS_API_KEY"});
    v["spec"]["sandboxes"][0]["agents"][0]["auth"] = json!({"method":"api-key","providerRef":name});
    assert!(parse(&v).is_ok());
    v["spec"]["sandboxes"][0]["agents"][0]["auth"]["providerRef"] = json!("foreign");
    assert!(parse(&v).is_err());
}
#[test]
fn unsupported_or_out_of_range_options_fail_before_deployment() {
    for (field, value) in [
        ("contextWindow", json!(0)),
        ("contextWindow", json!(4194305)),
        ("maxTokens", json!(1000000001u64)),
        ("reasoningEffort", json!("extreme")),
    ] {
        let mut v = input("openclaw");
        v["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"][field] =
            value;
        assert!(parse(&v).is_err());
        assert!(
            !jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&v)
        );
    }
    let mut v = input("deepagents");
    v["spec"]["inferenceProviders"][0]["api"] = json!("openai-responses");
    assert!(parse(&v).is_err());
}

#[test]
fn schema_and_parser_agree_on_api_families_and_harness_limits() {
    let validator = jsonschema::validator_for(&input_schema()).unwrap();
    for harness in ["openclaw", "hermes", "claude", "codex", "deepagents", "pi"] {
        for api in [
            "openai-completions",
            "openai-responses",
            "anthropic-messages",
        ] {
            let mut v = input(harness);
            v["spec"]["inferenceProviders"][0]["api"] = json!(api);
            v["spec"]["inferenceProviders"][0]["provider"] =
                json!(if api == "anthropic-messages" {
                    "anthropic"
                } else {
                    "openai"
                });
            let accepted = matches!(harness, "openclaw" | "hermes")
                || matches!(
                    (harness, api),
                    ("claude", "anthropic-messages")
                        | ("codex", "openai-responses")
                        | ("deepagents", "openai-completions")
                );
            assert_eq!(parse(&v).is_ok(), accepted, "{harness}/{api}");
            assert_eq!(validator.is_valid(&v), accepted, "schema {harness}/{api}");
            v["spec"]["inferenceProviders"][0]["provider"] =
                json!(if api == "anthropic-messages" {
                    "openai"
                } else {
                    "anthropic"
                });
            assert!(parse(&v).is_err());
            assert!(!validator.is_valid(&v));
        }
    }
}

#[test]
fn explicit_false_and_default_survive_and_auth_cannot_bypass_credentials() {
    let mut v = input("openclaw");
    let overrides =
        &mut v["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"];
    overrides["reasoning"] = json!(false);
    overrides["reasoningEffort"] = json!("default");
    let d = parse(&v).unwrap();
    let exported: Value = serde_saphyr::from_str(&d.yaml().unwrap()).unwrap();
    assert_eq!(
        exported["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"]["reasoning"],
        false
    );
    for harness in ["hermes", "openclaw"] {
        let mut v = input(harness);
        let name = v["spec"]["inferenceProviders"][0]["name"].clone();
        v["spec"]["sandboxes"][0]["agents"][0]["auth"] =
            json!({"method":"api-key", "providerRef":name});
        assert!(parse(&v).is_err());
        assert!(
            !jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&v)
        );
    }
    for (field, value) in [
        ("contextWindow", json!(null)),
        ("reasoning", json!("false")),
        ("unexpected", json!(true)),
    ] {
        let mut v = input("openclaw");
        v["spec"]["sandboxes"][0]["agents"][0]["inference"]["routes"][0]["overrides"][field] =
            value;
        assert!(parse(&v).is_err());
        assert!(
            !jsonschema::validator_for(&input_schema())
                .unwrap()
                .is_valid(&v)
        );
    }
}
