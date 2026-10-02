// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{Error, config::Document};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

const REJECTED: &str =
    "apply did not fail solely on fresh unsupported Fabric health; resources retained";

fn rows<'a>(
    state: &'a Value,
    resource_type: &str,
    mode: &str,
) -> Result<BTreeMap<String, &'a Value>, &'static str> {
    let mut result = BTreeMap::new();
    for resource in state["resources"]
        .as_array()
        .ok_or(REJECTED)?
        .iter()
        .filter(|resource| resource["type"] == resource_type)
    {
        if resource["mode"] != mode || !resource["module"].is_null() {
            return Err(REJECTED);
        }
        let name = resource["name"]
            .as_str()
            .filter(|name| !name.is_empty())
            .ok_or(REJECTED)?;
        let instances = resource["instances"].as_array().ok_or(REJECTED)?;
        let [instance] = instances.as_slice() else {
            return Err(REJECTED);
        };
        if !instance["deposed"].is_null()
            || !instance["index_key"].is_null()
            || !instance["status"].is_null()
            || !instance["attributes"].is_object()
            || result
                .insert(name.into(), &instance["attributes"])
                .is_some()
        {
            return Err(REJECTED);
        }
    }
    Ok(result)
}

pub(super) fn tokens(state: &Value) -> Result<BTreeMap<String, String>, &'static str> {
    rows(state, "nemoclaw_sandbox_readiness", "data")?
        .into_iter()
        .map(|(name, attributes)| {
            let token = attributes["read_trigger"]
                .as_str()
                .filter(|token| !token.is_empty())
                .ok_or(REJECTED)?;
            Ok((name, token.into()))
        })
        .collect()
}

pub(super) fn verify(
    error: &Error,
    document: &Document,
    prior: &BTreeMap<String, String>,
    intent: &Value,
    state: &Value,
) -> Result<(), &'static str> {
    let expected: BTreeSet<_> = document
        .spec
        .sandboxes
        .iter()
        .map(|sandbox| sandbox.name.as_str())
        .collect();
    let Error::Execution {
        operation,
        postcondition_failures: Some(failures),
        ..
    } = error
    else {
        return Err(REJECTED);
    };
    let addresses: BTreeSet<_> = expected
        .iter()
        .map(|name| format!("data.nemoclaw_sandbox_readiness.{name}"))
        .collect();
    if operation != "apply"
        || expected.is_empty()
        || failures.len() != addresses.len()
        || failures.iter().collect::<BTreeSet<_>>() != addresses.iter().collect()
    {
        return Err(REJECTED);
    }
    // The SDK persists completed mutations separately from successful health.
    // An incomplete mutation must never become a development-test success.
    if intent["pending"] != false
        || intent["succeeded"] != false
        || [
            "runtimePending",
            "destroying",
            "destroyed",
            "destroyRuntime",
        ]
        .iter()
        .any(|field| !intent[*field].is_null() && intent[*field] != false)
        || (!intent["pendingCreations"].is_null()
            && intent["pendingCreations"] != serde_json::json!({}))
        || intent["digest"].as_str() != Some(document.digest().as_str())
    {
        return Err(REJECTED);
    }
    let retained: Document =
        serde_json::from_value(intent["document"].clone()).map_err(|_| REJECTED)?;
    if retained.digest() != document.digest() {
        return Err(REJECTED);
    }
    let generations =
        serde_json::from_value(intent["generations"].clone()).map_err(|_| REJECTED)?;
    let targets = nemoclaw_sdk::compile::targets(document, &generations).map_err(|_| REJECTED)?;
    let observations = rows(state, "nemoclaw_sandbox_readiness", "data")?;
    let bindings = rows(state, "nemoclaw_sandbox", "managed")?;
    if observations
        .keys()
        .map(String::as_str)
        .collect::<BTreeSet<_>>()
        != expected
        || bindings.keys().map(String::as_str).collect::<BTreeSet<_>>() != expected
    {
        return Err(REJECTED);
    }
    let mut ids = BTreeSet::new();
    let mut fresh_tokens = BTreeSet::new();
    for (name, observation) in observations {
        let token = observation["read_trigger"]
            .as_str()
            .filter(|token| !token.is_empty())
            .ok_or(REJECTED)?;
        if !fresh_tokens.insert(token)
            || prior.values().any(|previous| previous == token)
            || observation["ready"] != false
            || observation.get("error_message") != Some(&Value::Null)
        {
            return Err(REJECTED);
        }
        let health: Value =
            serde_json::from_str(observation["health_json"].as_str().ok_or(REJECTED)?)
                .map_err(|_| REJECTED)?;
        if health
            != serde_json::json!({"supported":false,"report":null,"reason_code":"fabric_health_unsupported"})
        {
            return Err(REJECTED);
        }
        let binding = bindings[&name];
        let id = binding["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or(REJECTED)?;
        if !ids.insert(id) {
            return Err(REJECTED);
        }
        let target = targets
            .iter()
            .find(|target| target.address == format!("nemoclaw_sandbox.{name}"))
            .ok_or(REJECTED)?;
        if target
            .values
            .iter()
            .any(|(key, value)| binding[key].as_str() != Some(value))
        {
            return Err(REJECTED);
        }
        let configuration = targets
            .iter()
            .find(|target| target.address == format!("nemoclaw_agent_configuration.{name}"))
            .ok_or(REJECTED)?;
        let mut expected_binding = binding.clone();
        expected_binding["config_json"] = serde_json::json!(configuration.values["config_json"]);
        if observation["sandbox"] != expected_binding {
            return Err(REJECTED);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture() -> (Document, BTreeMap<String, String>, Value, Value) {
        let document = Document::parse(
            include_str!("../../../../examples/kubernetes/managed-development.yaml").as_bytes(),
        )
        .unwrap();
        let generations: BTreeMap<String, String> = ["workspace", "provider", "sandbox"]
            .into_iter()
            .map(|kind| (kind.into(), format!("{kind}-generation")))
            .collect();
        let targets = nemoclaw_sdk::compile::targets(&document, &generations).unwrap();
        let mut resources = Vec::new();
        let mut prior = BTreeMap::new();
        for target in targets.iter().filter(|target| target.kind == "sandbox") {
            let name = &target.values["name"];
            let mut binding = serde_json::to_value(&target.values).unwrap();
            binding["id"] = json!(format!("physical-{name}"));
            binding["runtime_json"] = json!("verified-image-runtime");
            resources.push(json!({"mode":"managed", "type":"nemoclaw_sandbox",
                "name":name, "instances":[{"attributes":binding}]}));
            binding["config_json"] = json!(
                targets
                    .iter()
                    .find(|target| target.address == format!("nemoclaw_agent_configuration.{name}"))
                    .unwrap()
                    .values["config_json"]
            );
            resources.push(json!({"mode":"data", "type":"nemoclaw_sandbox_readiness",
            "name":name, "instances":[{"attributes":{
                "sandbox":binding, "ready":false, "error_message":null,
                "read_trigger":format!("fresh-{name}"),
                "health_json":json!({"supported":false,"report":null,
                    "reason_code":"fabric_health_unsupported"}).to_string()
            }}]}));
            prior.insert(name.clone(), format!("previous-{name}"));
        }
        let intent = json!({"document": document, "digest":document.digest(),
            "generations":generations, "pending":false, "succeeded":false});
        (document, prior, intent, json!({"resources":resources}))
    }

    fn failure() -> Error {
        Error::Execution {
            operation: "apply".into(),
            diagnostic: "PRIVATE_SENTINEL".into(),
            postcondition_failures: Some(
                ["assistant", "researcher", "reviewer"]
                    .map(|name| format!("data.nemoclaw_sandbox_readiness.{name}"))
                    .into(),
            ),
        }
    }

    #[test]
    fn exact_fresh_unsupported_health_is_a_development_only_exception() {
        let (document, prior, intent, state) = fixture();
        assert_eq!(
            verify(&failure(), &document, &prior, &intent, &state),
            Ok(())
        );
    }

    #[test]
    fn unrelated_or_ambiguous_failures_are_never_accepted() {
        let (document, prior, intent, state) = fixture();
        for error in [
            Error::Cancelled,
            Error::Conflict("PRIVATE_SENTINEL"),
            Error::State("PRIVATE_SENTINEL"),
            Error::Execution {
                operation: "plan".into(),
                diagnostic: "PRIVATE_SENTINEL".into(),
                postcondition_failures: Some(vec![
                    "data.nemoclaw_sandbox_readiness.assistant".into(),
                ]),
            },
            Error::Execution {
                operation: "apply".into(),
                diagnostic: "PRIVATE_SENTINEL".into(),
                postcondition_failures: None,
            },
            Error::Execution {
                operation: "apply".into(),
                diagnostic: "PRIVATE_SENTINEL".into(),
                postcondition_failures: Some(vec![]),
            },
        ] {
            let message = verify(&error, &document, &prior, &intent, &state).unwrap_err();
            assert!(!message.contains("PRIVATE_SENTINEL"));
        }
        for addresses in [
            vec!["data.nemoclaw_sandbox_readiness.assistant"],
            vec![
                "data.nemoclaw_sandbox_readiness.assistant",
                "data.nemoclaw_sandbox_readiness.researcher",
                "data.nemoclaw_sandbox_readiness.reviewer",
                "data.foreign.other",
            ],
            vec![
                "data.nemoclaw_sandbox_readiness.assistant",
                "data.nemoclaw_sandbox_readiness.researcher",
                "data.nemoclaw_sandbox_readiness.reviewer",
                "data.nemoclaw_sandbox_readiness.assistant",
            ],
        ] {
            let mut error = failure();
            if let Error::Execution {
                postcondition_failures,
                ..
            } = &mut error
            {
                *postcondition_failures = Some(addresses.into_iter().map(String::from).collect());
            }
            assert!(verify(&error, &document, &prior, &intent, &state).is_err());
        }
    }

    #[test]
    fn missing_stale_failed_or_substituted_observations_are_never_accepted() {
        let (document, prior, intent, state) = fixture();
        for (pointer, value) in [
            ("/resources/1/instances/0/attributes/ready", json!(true)),
            ("/resources/1/instances/0/attributes/ready", Value::Null),
            (
                "/resources/1/instances/0/attributes/error_message",
                json!("PRIVATE_SENTINEL"),
            ),
            (
                "/resources/1/instances/0/attributes/read_trigger",
                json!("previous-assistant"),
            ),
            (
                "/resources/1/instances/0/attributes/read_trigger",
                json!(""),
            ),
            (
                "/resources/1/instances/0/attributes/health_json",
                Value::Null,
            ),
            (
                "/resources/1/instances/0/attributes/health_json",
                json!("invalid PRIVATE_SENTINEL"),
            ),
            (
                "/resources/1/instances/0/attributes/sandbox/id",
                json!("foreign"),
            ),
            (
                "/resources/1/instances/0/attributes/sandbox/config_json",
                json!("foreign"),
            ),
            (
                "/resources/0/instances/0/attributes/owner",
                json!("foreign"),
            ),
            ("/resources/1/mode", json!("managed")),
            ("/resources/1/name", json!("foreign")),
            ("/resources/1/instances", json!([])),
            ("/resources", json!([])),
        ] {
            let mut changed = state.clone();
            *changed.pointer_mut(pointer).unwrap() = value;
            let message = verify(&failure(), &document, &prior, &intent, &changed).unwrap_err();
            assert!(!message.contains("PRIVATE_SENTINEL"), "{pointer}");
        }
        for health in [
            json!({"supported":false,"reason_code":"fabric_health_unsupported"}),
            json!({"supported":true,"report":null,"reason_code":"fabric_health_unsupported"}),
            json!({"supported":false,"report":{},"reason_code":"fabric_health_unsupported"}),
            json!({"supported":false,"report":null,"reason_code":"fabric_health_timeout"}),
            json!({"supported":false,"report":null,"reason_code":"fabric_health_failed"}),
            json!({"supported":false,"report":null,"reason_code":"fabric_health_unsupported","unexpected":true}),
        ] {
            let mut changed = state.clone();
            changed["resources"][1]["instances"][0]["attributes"]["health_json"] =
                json!(health.to_string());
            assert!(verify(&failure(), &document, &prior, &intent, &changed).is_err());
        }
        for resource in [0, 1] {
            let mut changed = state.clone();
            changed["resources"]
                .as_array_mut()
                .unwrap()
                .push(state["resources"][resource].clone());
            assert!(verify(&failure(), &document, &prior, &intent, &changed).is_err());
            for (field, value) in [
                ("deposed", json!("old")),
                ("index_key", json!(0)),
                ("status", json!("tainted")),
            ] {
                let mut changed = state.clone();
                changed["resources"][resource]["instances"][0][field] = value;
                assert!(verify(&failure(), &document, &prior, &intent, &changed).is_err());
            }
        }
        let mut missing = state.clone();
        missing["resources"][1]["instances"][0]["attributes"]
            .as_object_mut()
            .unwrap()
            .remove("error_message");
        assert!(verify(&failure(), &document, &prior, &intent, &missing).is_err());
        let mut duplicate_token = state.clone();
        duplicate_token["resources"][3]["instances"][0]["attributes"]["read_trigger"] =
            json!("fresh-assistant");
        assert!(verify(&failure(), &document, &prior, &intent, &duplicate_token).is_err());
    }

    #[test]
    fn unsettled_or_mismatched_intent_cannot_use_the_exception() {
        let (document, prior, intent, state) = fixture();
        for (field, value) in [
            ("pending", json!(true)),
            ("pending", Value::Null),
            ("runtimePending", json!(true)),
            ("pendingCreations", json!({"unknown":{}})),
            ("succeeded", json!(true)),
            ("destroying", json!(true)),
            ("destroyed", json!(true)),
            ("digest", json!("foreign")),
            ("document", Value::Null),
            ("generations", Value::Null),
        ] {
            let mut changed = intent.clone();
            changed[field] = value;
            assert!(
                verify(&failure(), &document, &prior, &changed, &state).is_err(),
                "{field}"
            );
        }
    }
}
