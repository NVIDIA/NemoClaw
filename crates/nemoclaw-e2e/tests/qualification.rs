// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::qualification::StateSnapshot;
use serde_json::{Value, json};

fn resource(name: &str, id: &str) -> Value {
    json!({"type":"nemoclaw_sandbox","name":name,"instances":[{"attributes":{"id":id}}]})
}

#[test]
fn state_observation_rejects_ambiguous_or_incomplete_bindings() {
    for value in [
        json!({}),
        json!({"resources":[resource("agent", "one"), resource("agent", "two")]}),
        json!({"resources":[{"type":"nemoclaw_sandbox","name":"agent","instances":[]}]}),
        json!({"resources":[resource("agent", "")]}),
        json!({"resources":[{"type":"nemoclaw_sandbox","name":"agent","instances":[{"attributes":{"id":null}}]}]}),
    ] {
        assert!(StateSnapshot::parse(&serde_json::to_vec(&value).unwrap()).is_err());
    }
}

#[test]
fn replacement_check_requires_the_same_addresses_and_exactly_one_new_identity() {
    let snapshot = |resources| {
        StateSnapshot::parse(&serde_json::to_vec(&json!({"resources":resources})).unwrap())
            .unwrap()
            .identities()
    };
    let before = snapshot(vec![resource("agent", "one"), resource("peer", "two")]);
    let after = snapshot(vec![resource("agent", "new"), resource("peer", "two")]);
    assert!(
        before
            .require_replacement(&after, "nemoclaw_sandbox.agent")
            .is_ok()
    );
    for invalid in [
        before.clone(),
        snapshot(vec![resource("agent", "new")]),
        snapshot(vec![resource("agent", "new"), resource("peer", "changed")]),
        snapshot(vec![
            resource("agent", "new"),
            resource("peer", "two"),
            resource("extra", "three"),
        ]),
    ] {
        assert!(
            before
                .require_replacement(&invalid, "nemoclaw_sandbox.agent")
                .is_err()
        );
    }
    assert!(
        before
            .require_replacement(&after, "nemoclaw_sandbox.absent")
            .is_err()
    );
}

#[test]
fn only_missing_optional_state_is_empty() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("terraform.tfstate");
    assert!(
        StateSnapshot::read_optional(&path)
            .unwrap()
            .identities()
            .is_empty()
    );
    assert!(StateSnapshot::read(&path).is_err());
    std::fs::write(&path, b"invalid state").unwrap();
    assert!(StateSnapshot::read_optional(&path).is_err());
    std::fs::remove_file(&path).unwrap();
    std::fs::create_dir(&path).unwrap();
    assert!(StateSnapshot::read_optional(&path).is_err());
}

#[test]
fn state_errors_do_not_echo_attribute_values() {
    let value = json!({"resources":[{"type":"nemoclaw_sandbox","name":"agent","instances":[{"attributes":{"id": {"secret":"never-print-this"}}}]}]});
    let error = StateSnapshot::parse(&serde_json::to_vec(&value).unwrap()).unwrap_err();
    assert!(!error.to_string().contains("never-print-this"));
}

#[test]
fn evidence_requires_explicit_success_and_preserves_progress_on_failure() {
    use nemoclaw_e2e::qualification::Evidence;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("evidence.json");
    let read = || serde_json::from_slice::<Value>(&std::fs::read(&path).unwrap()).unwrap();
    {
        let mut evidence = Evidence::new(path.clone(), json!({"passed":true})).unwrap();
        assert_eq!(read()["passed"], false);
        evidence.record("apply", json!({"complete":true})).unwrap();
        assert!(evidence.record("passed", true).is_err());
    }
    assert_eq!(read()["passed"], false);
    assert_eq!(read()["apply"]["complete"], true);
    assert!(read()["finishedEpoch"].is_u64());
    Evidence::new(path.clone(), json!({}))
        .unwrap()
        .finish()
        .unwrap();
    assert_eq!(read()["passed"], true);
}

#[test]
fn evidence_cleanup_does_not_panic_when_its_directory_disappears() {
    use nemoclaw_e2e::qualification::Evidence;
    let directory = tempfile::tempdir().unwrap();
    let evidence = Evidence::new(directory.path().join("evidence.json"), json!({})).unwrap();
    std::fs::remove_dir_all(directory.path()).unwrap();
    let failure = std::panic::catch_unwind(move || {
        let _evidence = evidence;
        panic!("original scenario failure");
    });
    assert_eq!(
        failure.unwrap_err().downcast_ref::<&str>(),
        Some(&"original scenario failure")
    );
}

#[test]
fn observations_preserve_attributes_and_reject_unsupported_instance_layouts() {
    let mut good = resource("agent", "one");
    good["instances"][0]["attributes"]["metadata"] = json!({"generation":"generation-one"});
    let parse = |resources: Vec<Value>| {
        StateSnapshot::parse(&serde_json::to_vec(&json!({"resources":resources})).unwrap())
    };
    let snapshot = parse(vec![good.clone()]).unwrap();
    assert_eq!(
        snapshot.only("nemoclaw_sandbox").unwrap()["metadata"]["generation"],
        "generation-one"
    );
    assert_eq!(
        snapshot.attributes()["nemoclaw_sandbox.agent"],
        good["instances"][0]["attributes"]
    );
    assert!(snapshot.only("nemoclaw_gateway").is_err());
    assert!(
        parse(vec![good.clone(), resource("other", "two")])
            .unwrap()
            .only("nemoclaw_sandbox")
            .is_err()
    );
    let mut identities = snapshot.identities();
    assert!(identities.merge(snapshot.identities()).is_err());
    assert_eq!(identities, snapshot.identities());
    for pointer in [
        "/module",
        "/mode",
        "/instances/0/deposed",
        "/instances/0/index_key",
    ] {
        let mut unsupported = good.clone();
        if pointer == "/module" {
            unsupported["module"] = json!("module.nested");
        } else if pointer == "/mode" {
            unsupported["mode"] = json!("data");
        } else if pointer.ends_with("deposed") {
            unsupported["instances"][0]["deposed"] = json!("old");
        } else {
            unsupported["instances"][0]["index_key"] = json!(0);
        }
        assert!(parse(vec![unsupported]).is_err());
    }
    good["instances"]
        .as_array_mut()
        .unwrap()
        .push(json!({"attributes":{"id":"extra"}}));
    assert!(parse(vec![good]).is_err());
}
