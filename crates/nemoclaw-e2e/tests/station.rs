// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment, OperationResult, Outcome,
    config::{ComputeDriver, Document, Gateway},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

fn path(name: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var_os(name).expect(name));
    assert!(path.is_absolute(), "{name} must be absolute");
    path
}

fn running(state: &Value) -> bool {
    state["Running"] == true
        && state["Status"] == "running"
        && state["Paused"] == false
        && state["Restarting"] == false
        && (state.get("Health").is_none() || state["Health"]["Status"] == "healthy")
}

fn finish(
    observed: Result<Value>,
    cleanup: Result<OperationResult>,
    file: &Path,
    document: &Document,
    configuration: &[u8],
    state: &Path,
) -> Result<()> {
    let components = observed?;
    let cleanup = cleanup?;
    if cleanup.outcome != Outcome::Destroyed || !cleanup.deferred.is_empty() {
        return Err("destroy did not complete".into());
    }
    let configuration_sha256: String = Sha256::digest(configuration)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    fs::write(
        file,
        json!({
            "schemaVersion":1,"test":"station_example_components_are_running",
            "deploymentUid":document.metadata.uid,"stateDirectory":state,
            "configurationSha256":configuration_sha256,
            "outcome":"passed","destroy":"succeeded","components":components
        })
        .to_string(),
    )?;
    Ok(())
}

async fn docker(engine: &str, args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("docker")
            .args(["--host", engine])
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    if !output.status.success() {
        return Err("Docker observation failed".into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

async fn components(document: &Document, state: &Path, engine: &str) -> Result<Value> {
    let state: Value = serde_json::from_slice(&fs::read(state.join("terraform.tfstate"))?)?;
    let resources = state["resources"]
        .as_array()
        .ok_or("missing deployment resources")?;
    let binding = |kind: &str, name: &str| -> Result<&str> {
        resources
            .iter()
            .find(|r| r["mode"] == "managed" && r["type"] == kind && r["name"] == name)
            .and_then(|r| r["instances"][0]["attributes"]["id"].as_str())
            .ok_or_else(|| format!("missing {kind}.{name}").into())
    };
    let service = document
        .spec
        .services
        .keys()
        .next()
        .ok_or("missing model service")?;
    let mut containers = vec![
        (
            "gateway",
            binding("docker_container", "managed_gateway_runtime")?.to_owned(),
        ),
        (
            "model",
            binding(
                "docker_container",
                &format!("inference_service_inference_{service}"),
            )?
            .to_owned(),
        ),
    ];
    let sandbox = binding("openshell_sandbox", &document.spec.sandboxes[0].name)?;
    for role in ["sandbox", "supervisor"] {
        let ids = docker(
            engine,
            &[
                "ps",
                "--all",
                "--quiet",
                "--no-trunc",
                "--filter",
                "label=openshell.ai/managed-by=openshell",
                "--filter",
                &format!("label=openshell.ai/sandbox-id={sandbox}"),
                "--filter",
                &format!("label=openshell.ai/isolation-role={role}"),
            ],
        )
        .await?;
        let ids: Vec<_> = ids.lines().collect();
        if ids.len() != 1 {
            return Err(format!("expected one owned {role} container").into());
        }
        containers.push((role, ids[0].to_owned()));
    }
    let mut observations = serde_json::Map::new();
    for (role, id) in containers {
        let state = docker(
            engine,
            &[
                "inspect",
                "--type",
                "container",
                "--format",
                "{{json .State}}",
                &id,
            ],
        )
        .await?;
        if !running(&serde_json::from_str(&state)?) {
            return Err(format!("component {id} is not running and healthy").into());
        }
        observations.insert(role.into(), json!({"id":id,"running":true,"healthy":true}));
    }
    Ok(observations.into())
}

async fn settle_operation<T>(
    operation: impl std::future::Future<Output = Result<T>>,
    cancel: &CancellationToken,
    stop: impl std::future::Future<Output = &'static str>,
) -> Result<T> {
    tokio::pin!(operation);
    tokio::select! {
        result = &mut operation => result,
        reason = stop => {
            cancel.cancel();
            // Let SDK cancellation settle before teardown starts.
            let _ = operation.await;
            Err(reason.into())
        }
    }
}

async fn interrupted() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut terminate = signal(SignalKind::terminate()).expect("SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

#[tokio::test]
#[ignore = "requires an owned ARM64 Station YAML with real image digests, verified bundle, and unused private run directory; destroys workloads and retains storage"]
async fn station_example_components_are_running() -> Result<()> {
    assert_eq!(
        (std::env::consts::OS, std::env::consts::ARCH),
        ("linux", "aarch64")
    );
    // Hold the host lock across apply, observations and teardown. Preparation
    // and recovery use the same lock, including between SDK operations.
    let host_lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path("STATION_ROOT").join("host.lock"))?;
    host_lock
        .try_lock()
        .map_err(|_| "another Station operation is active")?;
    let configuration = fs::read(path("NEMOCLAW_LIVE_STATION_EXAMPLE"))?;
    let document = Document::parse(configuration.as_slice())?;
    let state = path("NEMOCLAW_LIVE_STATION_STATE");
    let receipt = path("NEMOCLAW_LIVE_STATION_RESULT");
    let Gateway::Managed(gateway) = &document.spec.gateway else {
        panic!("requires a managed gateway");
    };
    assert_eq!(gateway.runtime.provider, ComputeDriver::Docker);
    assert_eq!(
        (document.spec.services.len(), document.spec.sandboxes.len()),
        (1, 1)
    );
    let run = path("NEMOCLAW_LIVE_STATION_RUN");
    let directory = &mut fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(&run)?;
    let deployment = Deployment::new(&state, &path("NEMOCLAW_TEST_BUNDLE"));
    let cancel = CancellationToken::new();
    let operation = async {
        let applied = deployment.apply(&document, &cancel).await?;
        if applied.outcome != Outcome::Succeeded || !applied.deferred.is_empty() {
            return Err("apply did not complete".into());
        }
        components(&document, &state, &gateway.engine).await
    };
    let stop = async {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(95 * 60)) => "Station smoke deadline exceeded",
            _ = interrupted() => "Station smoke interrupted",
        }
    };
    let result = settle_operation(operation, &cancel, stop).await;
    // The always-run workflow cleanup retries with the retained bundle if this
    // process is killed before cooperative cancellation/teardown can finish.
    let cleanup = tokio::time::timeout(
        Duration::from_secs(8 * 60),
        deployment.destroy(&CancellationToken::new()),
    )
    .await
    .map_err(|_| "Station cleanup deadline exceeded")?;
    if let Err(error) = &cleanup {
        eprintln!("Workload cleanup failed: {error}");
    }
    finish(
        result,
        cleanup.map_err(Into::into),
        &receipt,
        &document,
        &configuration,
        &state,
    )
}

#[test]
fn writes_the_receipt_after_successful_observation_and_destroy() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("result.json");
    let state = directory.path().join("retained-state");
    let document =
        Document::parse(&include_bytes!("../../../examples/gtc-dc/hermes-dgx-station.yaml")[..])?;
    let components: Value = ["gateway", "model", "sandbox", "supervisor"]
        .into_iter()
        .enumerate()
        .map(|(i, role)| {
            (
                role.to_owned(),
                json!({"id":format!("{:064x}",i+1),"running":true,"healthy":true}),
            )
        })
        .collect();
    let cleanup = serde_json::from_value(json!({"outcome":"destroyed","changes":[]}))?;
    finish(
        Ok(components.clone()),
        Ok(cleanup),
        &file,
        &document,
        b"abc",
        &state,
    )?;
    let receipt: Value = serde_json::from_slice(&fs::read(file)?)?;
    assert_eq!(
        receipt,
        json!({
            "schemaVersion":1,"test":"station_example_components_are_running",
            "deploymentUid":document.metadata.uid,"stateDirectory":state,
            "configurationSha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            "outcome":"passed","destroy":"succeeded","components":components
        })
    );
    Ok(())
}

#[test]
fn failed_observation_or_cleanup_never_writes_a_passing_receipt() -> Result<()> {
    let directory = tempfile::tempdir()?;
    let file = directory.path().join("result.json");
    let state = directory.path().join("retained-state");
    let document =
        Document::parse(&include_bytes!("../../../examples/gtc-dc/hermes-dgx-station.yaml")[..])?;
    let destroyed: OperationResult =
        serde_json::from_value(json!({"outcome":"destroyed","changes":[]}))?;
    let mut incomplete = destroyed.clone();
    incomplete.outcome = Outcome::Succeeded;
    let mut deferred = destroyed.clone();
    deferred.deferred.push("workload teardown".into());
    for (observed, cleanup) in [
        (Err("component observation failed".into()), Ok(destroyed)),
        (Ok(Value::Null), Err("destroy failed".into())),
        (Ok(Value::Null), Ok(incomplete)),
        (Ok(Value::Null), Ok(deferred)),
    ] {
        assert!(finish(observed, cleanup, &file, &document, b"abc", &state).is_err());
        assert!(!file.exists());
    }
    Ok(())
}

#[test]
fn rejects_stopped_paused_restarting_and_unhealthy_components() {
    let state = serde_json::json!({"Running": true, "Status": "running", "Paused": false, "Restarting": false});
    assert!(running(&state));
    for (field, value) in [
        ("Running", serde_json::json!(false)),
        ("Status", serde_json::json!("exited")),
        ("Paused", serde_json::json!(true)),
        ("Restarting", serde_json::json!(true)),
        ("Health", serde_json::json!({"Status":"unhealthy"})),
        ("Health", serde_json::json!({"Status":"starting"})),
    ] {
        let mut invalid = state.clone();
        invalid[field] = value;
        assert!(!running(&invalid), "{field}");
    }
    let mut healthy = state;
    healthy["Health"] = serde_json::json!({"Status":"healthy"});
    assert!(running(&healthy));
}

#[tokio::test]
async fn interrupted_operation_settles_before_cleanup_can_start() {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    };
    let cancel = CancellationToken::new();
    let settled = Arc::new(AtomicBool::new(false));
    let operation = async {
        cancel.cancelled().await;
        settled.store(true, Ordering::SeqCst);
        Ok(())
    };
    let result = settle_operation(operation, &cancel, std::future::ready("interrupted")).await;
    assert_eq!(result.unwrap_err().to_string(), "interrupted");
    assert!(cancel.is_cancelled());
    assert!(settled.load(Ordering::SeqCst));
}

#[tokio::test]
async fn completed_operation_preserves_its_result_without_cancellation() {
    let cancel = CancellationToken::new();
    let result =
        settle_operation(std::future::ready(Ok(42)), &cancel, std::future::pending()).await;
    assert_eq!(result.unwrap(), 42);
    assert!(!cancel.is_cancelled());
}
