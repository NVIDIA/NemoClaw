// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::openshell::{command, environment, policy};
use serde_json::{Value, json};
#[test]
fn all_fabric_launch_contracts_match_the_pinned_go_reference() {
    let reference: Value =
        serde_json::from_str(include_str!("../fixtures/agent-runtime.json")).unwrap();
    assert_eq!(reference["runtimes"].as_object().unwrap().len(), 10);
    assert!(command("").is_empty());
    assert!(environment("main", "").is_empty());
    for (runtime, expected) in reference["runtimes"].as_object().unwrap() {
        assert_eq!(
            json!(environment("main", runtime)),
            expected["environment"],
            "{runtime} environment"
        );
        assert_eq!(
            json!(command(runtime)),
            expected["command"],
            "{runtime} command"
        );
    }
    let actual = policy();
    let filesystem = actual.filesystem.unwrap();
    let landlock = actual.landlock.unwrap();
    let process = actual.process.unwrap();
    let expected = &reference["policy"];
    assert_eq!(json!(actual.version), expected["Version"]);
    assert_eq!(
        json!(filesystem.read_only),
        expected["Filesystem"]["ReadOnly"]
    );
    assert_eq!(
        json!(filesystem.read_write),
        expected["Filesystem"]["ReadWrite"]
    );
    assert_eq!(
        json!(filesystem.include_workdir),
        expected["Filesystem"]["IncludeWorkdir"]
    );
    assert_eq!(
        json!(landlock.compatibility),
        expected["Landlock"]["Compatibility"]
    );
    assert_eq!(json!(process.run_as_user), expected["Process"]["RunAsUser"]);
    assert_eq!(
        json!(process.run_as_group),
        expected["Process"]["RunAsGroup"]
    );
    assert!(actual.network_policies.is_empty());
}
