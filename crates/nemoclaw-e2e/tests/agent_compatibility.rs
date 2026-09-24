// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::openshell::{command, environment, policy, policy_matches};

#[test]
fn fabric_launch_preserves_caller_identity_without_selecting_or_invoking_an_adapter() {
    let launch = command("fabric");
    assert_eq!(launch.last().map(String::as_str), Some("serve"));
    assert!(
        !launch
            .iter()
            .any(|arg| matches!(arg.as_str(), "invoke" | "probe" | "--message"))
    );
    for name in ["researcher", "writer"] {
        let env = environment(name, "fabric");
        assert_eq!(env["NEMOCLAW_AGENT_NAME"], name);
        assert_eq!(env["NEMOCLAW_ANONYMOUS_API_KEY"], "unused");
        for secret in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NVIDIA_API_KEY"] {
            assert!(!env.contains_key(secret));
        }
        assert!(!env.contains_key("NEMOCLAW_FABRIC_HARNESS"));
        assert!(!env.contains_key("MSWEA_COST_TRACKING"));
    }
    assert!(command("").is_empty());
    assert!(environment("main", "").is_empty());
}

#[test]
fn default_policy_denies_undeclared_egress_and_keeps_programs_read_only() {
    let policy = policy();
    assert_eq!(policy.version, 1);
    assert_eq!(
        policy.landlock.as_ref().unwrap().compatibility,
        "best_effort"
    );
    assert!(policy.network_policies.is_empty());
    assert!(policy.network_middlewares.is_empty());
    let process = policy.process.unwrap();
    assert_eq!(process.run_as_user, "1000");
    assert_eq!(process.run_as_group, "1000");
    let filesystem = policy.filesystem.unwrap();
    assert!(!filesystem.include_workdir);
    assert!(filesystem.read_write.iter().any(|path| path == "/sandbox"));
    for protected in ["/usr", "/etc", "/opt"] {
        assert!(
            filesystem
                .read_only
                .iter()
                .any(|grant| std::path::Path::new(protected).starts_with(grant))
        );
        assert!(
            !filesystem
                .read_write
                .iter()
                .any(|grant| std::path::Path::new(protected).starts_with(grant)
                    || std::path::Path::new(grant).starts_with(protected)),
            "writable program directory: {protected}"
        );
    }
}

#[test]
fn policy_observation_ignores_grant_order_but_rejects_permission_changes() {
    let mut observed = policy();
    let filesystem = observed.filesystem.as_mut().unwrap();
    filesystem.read_only.reverse();
    filesystem.read_write.reverse();
    assert!(policy_matches(&observed));
    let mut broader = observed.clone();
    broader
        .filesystem
        .as_mut()
        .unwrap()
        .read_write
        .push("/".into());
    assert!(!policy_matches(&broader));
    let mut root = observed.clone();
    root.process.as_mut().unwrap().run_as_user = "0".into();
    assert!(!policy_matches(&root));
    observed
        .network_policies
        .insert("unexpected-egress".into(), Default::default());
    assert!(!policy_matches(&observed));
}
