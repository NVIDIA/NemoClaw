// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_provider::openshell::OpenShell;
use nemoclaw_sdk::{backend::Backend, config::Document};
use std::{collections::BTreeMap, sync::Arc};

async fn sandbox() -> (Fixture, OpenShell, nemoclaw_sdk::backend::Row) {
    sandbox_with_runtime(None).await
}

async fn sandbox_with_runtime(
    runtime: Option<nemoclaw_sdk::image_runtime::RuntimeBinding>,
) -> (Fixture, OpenShell, nemoclaw_sdk::backend::Row) {
    let fixture = Fixture::start().await;
    let mut doc = Document::parse(
        include_str!("../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    *doc.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let client = OpenShell::connect(
        &doc.spec.gateway,
        Arc::new(nemoclaw_sdk::EnvironmentSecrets),
    )
    .unwrap();
    let generations = ["workspace", "provider", "sandbox"]
        .into_iter()
        .map(|k| (k.into(), format!("{k}-generation")))
        .collect::<BTreeMap<_, _>>();
    let mut targets = nemoclaw_e2e::image_runtime::targets(&doc, &generations).unwrap();
    if let Some(runtime) = runtime {
        targets
            .iter_mut()
            .find(|target| target.kind == "sandbox")
            .unwrap()
            .values
            .insert(
                "runtime_json".into(),
                serde_json::to_string(&runtime).unwrap(),
            );
    }
    for target in targets.iter().filter(|target| {
        matches!(
            target.kind.as_str(),
            "workspace" | "provider_profile" | "provider"
        )
    }) {
        let result = client.ensure(&target.kind, &target.values).await;
        assert!(result.error().is_none(), "{:?}", result.error());
    }
    let target = targets
        .iter()
        .find(|target| target.kind == "sandbox")
        .unwrap();
    let mutation = client.ensure("sandbox", &target.values).await;
    assert!(mutation.error().is_none(), "{:?}", mutation.error());
    let binding = mutation.into_parts().0.unwrap();
    (fixture, client, binding)
}

#[tokio::test]
async fn unsupported_health_retains_the_snapshot_but_does_not_complete_apply() {
    let (fixture, client, binding) = sandbox().await;
    fixture.state.lock().unwrap().health_report = Some(serde_json::json!({
        "supported": false, "report": null, "reason_code": "fabric_health_unsupported"
    }));
    let health = client.health(&binding).await.unwrap();
    assert!(!health.supported);
    assert!(!health.allows_apply_completion());
    let snapshot = client.agent_snapshot(&binding).await.unwrap();
    assert_eq!(snapshot.runtime_state, "stopped");
    assert_eq!(snapshot.generation.as_deref(), Some("fixture:0"));
    assert!(snapshot.applied_config.is_none());
    let native_report = serde_json::json!({"adapter_owned": {"evidence": [1, 2, 3]}});
    fixture.state.lock().unwrap().health_report = Some(serde_json::json!({
        "supported": true, "report": native_report, "reason_code": null
    }));
    let health = client.health(&binding).await.unwrap();
    assert!(health.allows_apply_completion());
    assert_eq!(health.report, Some(native_report.clone()));
    fixture.state.lock().unwrap().health_report = Some(serde_json::json!({
        "supported": true, "report": native_report, "reason_code": "unknown"
    }));
    let health = client.health(&binding).await.unwrap();
    assert!(!health.allows_apply_completion());
    assert_eq!(health.report, Some(native_report));
    let large_report = serde_json::json!({"data":"x".repeat(2 * 1024 * 1024)});
    fixture.state.lock().unwrap().health_report = Some(serde_json::json!({
        "supported": true, "report": large_report, "reason_code": null
    }));
    assert_eq!(
        client.health(&binding).await.unwrap().report,
        Some(large_report)
    );
    fixture.state.lock().unwrap().exec_response = Some(vec![b'x'; 4 * 1024 * 1024 + 1]);
    assert!(client.health(&binding).await.is_err());
    for output in [
        b"".as_slice(),
        b"PRIVATE_SENTINEL",
        br#"{"status":"succeeded"}"#,
    ] {
        fixture.state.lock().unwrap().exec_response = Some(output.to_vec());
        let error = client.health(&binding).await.unwrap_err();
        assert!(!error.to_string().contains("PRIVATE_SENTINEL"));
        assert!(client.agent_snapshot(&binding).await.is_err());
    }
    let state = fixture.state.lock().unwrap();
    assert!(state.exec_calls.iter().all(|command| {
        command[0] == "/usr/local/bin/fabric-agent"
            && command[1] == "check"
            && !command
                .iter()
                .any(|arg| arg == "--config" || arg == "invoke")
    }));
}

#[tokio::test]
async fn explicit_invocation_cleans_files_and_never_replays_uncertain_work() {
    let (fixture, client, binding) = sandbox().await;
    let input = serde_json::json!({"prompt":"PRIVATE_REQUEST_SENTINEL"});
    for response in [
        b"truncated".to_vec(),
        serde_json::to_vec(&serde_json::json!({"operation":"invoke","status":"succeeded","changed":null,"result":{"runtime_id":"fixture-runtime","fabric_result":{"status":"failed"}},"error":null})).unwrap().into_iter().chain(*b"\n").collect(),
    ] {
        fixture.state.lock().unwrap().exec_response = Some(response);
        let before = fixture.state.lock().unwrap().exec_calls.len();
        let error = client.invoke_agent(&binding, &input).await.unwrap_err();
        assert!(!error.to_string().contains("PRIVATE_REQUEST_SENTINEL"));
        let state = fixture.state.lock().unwrap();
        assert!(state.staged_files.is_empty());
        let calls = &state.exec_calls[before..];
        assert_eq!(calls.iter().filter(|args| args.get(1).is_some_and(|arg| arg == "invoke")).count(), 1);
        assert!(!calls.iter().flatten().any(|arg| arg.contains("PRIVATE_REQUEST_SENTINEL")));
    }
    fixture.state.lock().unwrap().exec_exit = 1;
    let before = fixture.state.lock().unwrap().exec_calls.len();
    assert!(client.invoke_agent(&binding, &input).await.is_err());
    let state = fixture.state.lock().unwrap();
    assert!(
        state.staged_files.is_empty(),
        "partial stage failure must clean its file"
    );
    assert!(
        !state.exec_calls[before..]
            .iter()
            .any(|args| args.get(1).is_some_and(|arg| arg == "invoke"))
    );
}

#[tokio::test]
async fn fixture_generations_are_scoped_to_each_sandbox_host() {
    let (fixture, client, first) = sandbox().await;
    let mut desired = first.clone();
    desired.remove("id");
    desired.insert("name".into(), "second".into());
    desired.insert("agent_name".into(), "second".into());
    let created = client.ensure("sandbox", &desired).await;
    assert!(created.error().is_none(), "{:?}", created.error());
    let second = created.into_parts().0.unwrap();
    let first_generation = client
        .agent_snapshot(&first)
        .await
        .unwrap()
        .generation
        .unwrap();
    let second_generation = client
        .agent_snapshot(&second)
        .await
        .unwrap()
        .generation
        .unwrap();
    for (binding, generation) in [(&first, first_generation), (&second, second_generation)] {
        let path = format!("/sandbox/{}.json", binding["agent_name"]);
        fixture.state.lock().unwrap().staged_files.insert(
            path.clone(),
            serde_json::to_vec(&serde_json::json!({"metadata":{"name":binding["agent_name"]}}))
                .unwrap(),
        );
        let (exit, output) = client
            .exec_bound(
                binding,
                [
                    "/usr/local/bin/fabric-agent",
                    "configure",
                    "--agent",
                    &binding["agent_name"],
                    "--config",
                    &path,
                    "--expected-generation",
                    &generation,
                ]
                .map(String::from)
                .to_vec(),
                Default::default(),
                20,
            )
            .await
            .unwrap();
        assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&output));
    }
    assert_eq!(fixture.state.lock().unwrap().fabric_configurations.len(), 2);
    let second_before = client.agent_snapshot(&second).await.unwrap();
    let first_generation = client
        .agent_snapshot(&first)
        .await
        .unwrap()
        .generation
        .unwrap();
    for (operation, generation) in [
        ("prepare", first_generation),
        ("configure", "fixture:2".into()),
    ] {
        let (exit, output) = client
            .exec_bound(
                &first,
                [
                    "/usr/local/bin/fabric-agent",
                    operation,
                    "--agent",
                    &first["agent_name"],
                    "--config",
                    &format!("/sandbox/{}.json", first["agent_name"]),
                    "--expected-generation",
                    &generation,
                ]
                .map(String::from)
                .to_vec(),
                Default::default(),
                20,
            )
            .await
            .unwrap();
        assert_eq!(exit, 0, "{}", String::from_utf8_lossy(&output));
        let second_after = client.agent_snapshot(&second).await.unwrap();
        assert_eq!(second_after.generation, second_before.generation);
        assert_eq!(second_after.runtime_state, "running");
        assert_eq!(second_after.runtime_id, second_before.runtime_id);
        assert_eq!(second_after.applied_config, second_before.applied_config);
    }
}

#[tokio::test]
async fn fixture_confirmed_stop_clears_the_reported_configuration_association() {
    let (fixture, client, binding) = sandbox().await;
    {
        let mut state = fixture.state.lock().unwrap();
        state.fabric_configurations.insert(
            binding["id"].clone(),
            serde_json::json!({"metadata":{"name":binding["agent_name"]}}),
        );
        state.fabric_stopped.insert(binding["id"].clone());
    }
    let snapshot = client.agent_snapshot(&binding).await.unwrap();
    assert_eq!(snapshot.runtime_state, "stopped");
    assert!(snapshot.runtime_id.is_none());
    assert!(snapshot.applied_config.is_none());
}

#[tokio::test]
async fn relocated_image_owns_bridge_commands_environment_and_staged_files() {
    let mut runtime = nemoclaw_e2e::image_runtime::binding("fixture");
    runtime.runtime.command = ["/srv/python3.99", "-I", "/srv/bridge.py"]
        .map(String::from)
        .to_vec();
    runtime
        .runtime
        .environment
        .insert("ADAPTER_PYTHON".into(), "/srv/python3.99".into());
    runtime
        .runtime
        .environment
        .insert("HOME".into(), "/work".into());
    runtime
        .runtime
        .environment
        .insert("TMPDIR".into(), "/work/tmp".into());
    runtime
        .runtime
        .environment
        .insert("PATH".into(), "/srv".into());
    runtime
        .runtime
        .policy
        .filesystem_policy
        .as_mut()
        .unwrap()
        .read_write = Some(vec!["/work".into()]);
    let (fixture, client, mut binding) = sandbox_with_runtime(Some(runtime.clone())).await;
    let name = binding["agent_name"].clone();
    binding.insert(
        "config_json".into(),
        serde_json::json!({"metadata":{"name":name}}).to_string(),
    );
    let result = client.configure_agent(&binding).await;
    let calls = fixture.state.lock().unwrap().exec_calls.clone();
    assert_eq!(
        calls[0],
        runtime.command("check", &["--agent", &name, "--live"])
    );
    result.unwrap();
    assert_eq!(calls.len(), 4);
    assert_eq!(calls[1][0], "/srv/python3.99");
    let path = &calls[1][3];
    assert!(path.starts_with("/work/.nemoclaw-"));
    assert_eq!(
        calls[2],
        runtime.command(
            "configure",
            &[
                "--agent",
                &name,
                "--config",
                path,
                "--expected-generation",
                "fixture:0"
            ]
        )
    );
    assert_eq!(calls[3][0], "/srv/python3.99");
    assert_eq!(calls[3].last(), Some(path));
    {
        let state = fixture.state.lock().unwrap();
        assert!(state.staged_files.is_empty());
        assert!(
            state
                .exec_environments
                .iter()
                .all(|environment| *environment == runtime.environment(&name).into_iter().collect())
        );
    }
    let mut substituted = runtime.clone();
    substituted.runtime.command = vec!["/srv/substituted".into()];
    for encoded in [
        None,
        Some("{}".into()),
        Some(serde_json::to_string(&substituted).unwrap()),
    ] {
        let mut invalid = binding.clone();
        invalid.remove("runtime_json");
        if let Some(encoded) = encoded {
            invalid.insert("runtime_json".into(), encoded);
        }
        assert!(
            client
                .invoke_agent(&invalid, &serde_json::json!({"prompt":"hello"}))
                .await
                .is_err()
        );
    }
    assert_eq!(fixture.state.lock().unwrap().exec_calls.len(), calls.len());
    let snapshot = client.agent_snapshot(&binding).await.unwrap();
    assert_eq!(snapshot.generation.as_deref(), Some("fixture:1"));
    assert_eq!(snapshot.runtime_state, "running");
    assert!(
        snapshot
            .runtime_id
            .as_deref()
            .is_some_and(|id| !id.is_empty())
    );
}

#[tokio::test]
async fn staging_uses_writable_tmpdir_when_home_has_only_read_access() {
    let mut runtime = nemoclaw_e2e::image_runtime::binding("fixture");
    runtime
        .runtime
        .environment
        .insert("HOME".into(), "/read-only".into());
    runtime
        .runtime
        .environment
        .insert("TMPDIR".into(), "/work//./tmp/".into());
    let filesystem = runtime.runtime.policy.filesystem_policy.as_mut().unwrap();
    filesystem
        .read_only
        .get_or_insert_default()
        .push("/read-only".into());
    filesystem.read_write = Some(vec!["/work/.".into()]);
    let (fixture, client, mut binding) = sandbox_with_runtime(Some(runtime)).await;
    binding.insert(
        "config_json".into(),
        serde_json::json!({
            "metadata":{"name":binding["agent_name"]}
        })
        .to_string(),
    );
    client.configure_agent(&binding).await.unwrap();
    let state = fixture.state.lock().unwrap();
    let calls = &state.exec_calls;
    assert_eq!(calls.len(), 4);
    let path = &calls[1][3];
    assert!(path.starts_with("/work//./tmp/.nemoclaw-"), "{path}");
    assert!(calls[2].windows(2).any(|args| args == ["--config", path]));
    assert_eq!(calls[3].last(), Some(path));
    assert!(state.staged_files.is_empty());
}

#[tokio::test]
async fn staging_refuses_ungranted_directories_before_executing_commands() {
    for home in [
        "/read-only",
        "/work-other",
        "/work/../elsewhere",
        "work",
        r"C:\work",
    ] {
        let mut runtime = nemoclaw_e2e::image_runtime::binding("fixture");
        runtime
            .runtime
            .environment
            .insert("HOME".into(), home.into());
        runtime
            .runtime
            .environment
            .insert("TMPDIR".into(), "/read-only".into());
        let filesystem = runtime.runtime.policy.filesystem_policy.as_mut().unwrap();
        filesystem
            .read_only
            .get_or_insert_default()
            .push("/read-only".into());
        filesystem.read_write = Some(vec!["/work".into()]);
        let (fixture, client, binding) = sandbox_with_runtime(Some(runtime)).await;
        let result = client
            .invoke_agent(&binding, &serde_json::json!({"prompt":"hello"}))
            .await;
        assert!(
            matches!(
                result,
                Err(nemoclaw_sdk::Error::Conflict(
                    "image does not advertise a writable Fabric input directory"
                ))
            ),
            "{home:?}: {result:?}"
        );
        let state = fixture.state.lock().unwrap();
        assert!(state.exec_calls.is_empty(), "{home:?}");
        assert!(state.staged_files.is_empty());
    }
}
