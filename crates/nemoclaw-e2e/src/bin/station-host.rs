// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Prepare and finish an owned Station smoke on a persistent Actions runner.

use nemoclaw_sdk::{CancellationToken, Deployment, Outcome, config::Document};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    fs::{File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const EXAMPLE: &str = "examples/gtc-dc/hermes-dgx-station.yaml";
const ENGINE: &str = "unix:///var/run/docker.sock";

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn private_directory(path: &Path) -> Result<()> {
    let mut directory = fs::DirBuilder::new();
    directory.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        directory.mode(0o700);
    }
    directory.create(path)?;
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Station storage must be a directory, not a symlink".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err("Station storage must have mode 0700".into());
        }
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn lock(root: &Path) -> Result<File> {
    private_directory(root)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(root.join("host.lock"))?;
    file.try_lock()
        .map_err(|_| "another Station operation is active")?;
    Ok(file)
}

fn uuid() -> Result<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "cannot generate deployment identity")?;
    bytes[6] = (bytes[6] & 15) | 64;
    bytes[8] = (bytes[8] & 63) | 128;
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

fn immutable(image: &str) -> bool {
    image.split_once("@sha256:").is_some_and(|(name, digest)| {
        !name.is_empty()
            && digest.len() == 64
            && digest.bytes().all(|b| b.is_ascii_hexdigit())
            && digest.bytes().any(|b| b != b'0')
    })
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Recovery {
    uid: String,
    deployment: String,
    configuration_sha256: String,
    candidate_sha: String,
}

fn prepare(
    root: &Path,
    job: &Path,
    source: &[u8],
    gateway: &str,
    agent: &str,
    model: &str,
    candidate: &str,
) -> Result<Recovery> {
    if root.join("pending.json").exists() {
        return Err(
            "Station has unfinished cleanup; recover the recorded job before another smoke".into(),
        );
    }
    if ![gateway, agent, model].into_iter().all(immutable) {
        return Err("Station images must have nonzero immutable digests".into());
    }
    if candidate.len() != 40 || !candidate.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("candidate must be a full Git commit SHA".into());
    }
    let document = Document::parse(source)?;
    let mut value = serde_json::to_value(&document)?;
    let spec = &value["spec"];
    let services = spec["services"]
        .as_object()
        .ok_or("missing model service")?;
    let sandboxes = spec["sandboxes"].as_array().ok_or("missing sandbox")?;
    if services.len() != 1
        || sandboxes.len() != 1
        || spec["gateway"]["management"] != "managed"
        || spec["gateway"]["runtime"]["provider"] != "docker"
        || spec["gateway"]["engine"] != ENGINE
        || sandboxes[0]["harness"]["kind"] != "nvidia.fabric.hermes"
    {
        return Err(
            "Station smoke requires one local Docker vLLM service and Hermes sandbox".into(),
        );
    }
    let (service, model_spec) = services.iter().next().ok_or("missing model service")?;
    if model_spec["kind"] != "vllm"
        || model_spec["hardware"]["profile"] != "dgx-station"
        || model_spec.get("placement").is_some_and(|p| !p.is_null())
    {
        return Err("Station smoke requires the local dgx-station vLLM profile".into());
    }
    let service = service.clone();
    // Candidate image changes may reuse storage. Model, topology and gateway-pin
    // changes get a different deployment; no existing state is rewritten.
    value["metadata"]["uid"] = json!("<owned>");
    value["spec"]["services"][&service]["image"] = json!("<candidate-runtime>");
    value["spec"]["sandboxes"][0]["image"]["ref"] = json!("<candidate-agent>");
    let deployment = hash(&serde_json::to_vec(
        &json!({"document":value,"gateway":gateway}),
    )?);
    let retained = root.join("deployments").join(&deployment);
    private_directory(&retained)?;
    let identity = retained.join("uid");
    let uid = if identity.exists() {
        fs::read_to_string(&identity)?
    } else {
        let uid = uuid()?;
        write_new(&identity, uid.as_bytes())?;
        uid
    };
    value["metadata"]["uid"] = json!(uid);
    value["spec"]["services"][&service]["image"] = json!(model);
    value["spec"]["sandboxes"][0]["image"]["ref"] = json!(agent);
    // Validate the prepared document using the SDK's parser, not a second schema.
    let prepared = Document::parse(serde_json::to_vec(&value)?.as_slice())?.yaml()?;
    let recovery = Recovery {
        uid,
        deployment,
        configuration_sha256: hash(prepared.as_bytes()),
        candidate_sha: candidate.into(),
    };
    write_new(&job.join("prepared.yaml"), prepared.as_bytes())?;
    write_new(&job.join("recovery.json"), &serde_json::to_vec(&recovery)?)?;
    // Record ownership before the smoke can create any deployment resources.
    write_new(&root.join("pending.json"), &serde_json::to_vec(job)?)?;
    Ok(recovery)
}

async fn docker(args: &[&str]) -> Result<String> {
    let output = tokio::time::timeout(
        Duration::from_secs(30),
        tokio::process::Command::new("docker")
            .args(["--host", ENGINE])
            .args(args)
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    if !output.status.success() {
        return Err("Station Docker observation failed".into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn valid_receipt(value: &Value, recovery: &Recovery, state: &Path) -> bool {
    value["schemaVersion"] == 1
        && value["test"] == "station_example_components_are_running"
        && value["deploymentUid"] == recovery.uid
        && value["configurationSha256"] == recovery.configuration_sha256
        && value["stateDirectory"] == json!(state)
        && value["outcome"] == "passed"
        && value["destroy"] == "succeeded"
        && value["components"].as_object().is_some_and(|components| {
            components.len() == 4
                && ["gateway", "model", "sandbox", "supervisor"]
                    .iter()
                    .all(|name| {
                        let c = &value["components"][name];
                        c["running"] == true
                            && c["healthy"] == true
                            && c["id"].as_str().is_some_and(|id| {
                                id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit())
                            })
                    })
        })
}

async fn verify_stopped(uid: &str) -> Result<()> {
    let workspace = format!("nc-{}", &hash(uid.as_bytes())[..16]);
    for filter in [
        format!("label=nemoclaw.nvidia.com/uid={uid}"),
        format!("label=openshell.ai/sandbox-namespace={workspace}-gateway"),
    ] {
        let rows = docker(&["ps", "--all", "--filter", &filter, "--format", "{{json .}}"]).await?;
        for row in rows.lines() {
            let container: Value = serde_json::from_str(row)?;
            // SDK destroy retains this stopped initializer along with storage.
            if container["Names"] != format!("{workspace}-gateway-initialize")
                || container["State"] != "exited"
            {
                return Err(
                    "an owned Station workload remains after SDK destroy; retain recovery state"
                        .into(),
                );
            }
        }
    }
    Ok(())
}

async fn cleanup(root: &Path, job: &Path) -> Result<()> {
    let recovery_path = job.join("recovery.json");
    if !recovery_path.exists() {
        return Ok(());
    } // Preparation did not admit a smoke.
    let recovery: Recovery = serde_json::from_slice(&fs::read(recovery_path)?)?;
    if recovery.deployment.len() != 64
        || !recovery.deployment.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err("invalid Station recovery binding".into());
    }
    let pending: PathBuf = serde_json::from_slice(&fs::read(root.join("pending.json"))?)?;
    if pending != job {
        return Err("another job owns Station recovery".into());
    }
    let state = root
        .join("deployments")
        .join(&recovery.deployment)
        .join("state");
    let outcome: Result<()> = async {
        if state.join("intent.json").exists() {
            let deployment = Deployment::new(&state, &job.join("bundle"));
            let result = tokio::time::timeout(
                Duration::from_secs(8 * 60),
                deployment.destroy(&CancellationToken::new()),
            )
            .await??;
            if result.outcome != Outcome::Destroyed || !result.deferred.is_empty() {
                return Err("Station SDK destroy did not complete".into());
            }
        }
        verify_stopped(&recovery.uid).await
    }
    .await;
    let receipt = fs::read(job.join("smoke-result.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok());
    finish_cleanup(root, job, &recovery, &state, outcome, receipt.as_ref())
}

fn finish_cleanup(
    root: &Path,
    job: &Path,
    recovery: &Recovery,
    state: &Path,
    outcome: Result<()>,
    receipt: Option<&Value>,
) -> Result<()> {
    let passed = receipt.is_some_and(|r| valid_receipt(r, recovery, state));
    let clean = outcome.is_ok();
    let summary = json!({"schemaVersion":1,"candidateSha":recovery.candidate_sha,
        "examplePath":EXAMPLE,"outcome":if passed && clean {"success"} else {"failure"},
        "cleanup":if clean {"succeeded"} else {"failed"},
        "components":if passed {receipt.map(|r|r["components"].clone())} else {None}});
    // Only this whitelist is uploaded; configuration, state and raw logs stay local.
    fs::write(
        job.join("summary.json"),
        serde_json::to_vec_pretty(&summary)?,
    )?;
    outcome?;
    fs::remove_file(root.join("pending.json"))?;
    if !passed {
        return Err(
            "Station smoke did not produce a matching passing receipt; cleanup succeeded".into(),
        );
    }
    Ok(())
}

fn required(name: &str) -> Result<String> {
    env::var(name)
        .ok()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{name} is required").into())
}

async fn execute() -> Result<()> {
    let root = PathBuf::from(required("STATION_ROOT")?);
    let job = PathBuf::from(required("STATION_JOB_DIR")?);
    if !root.is_absolute()
        || !job.is_absolute()
        || job.parent() != Some(root.join("jobs").as_path())
    {
        return Err("Station job must be an absolute child of STATION_ROOT/jobs".into());
    }
    let _lock = lock(&root)?;
    match env::args().nth(1).as_deref() {
        Some("prepare") => {
            if required("STATION_EXAMPLE_PATH")? != EXAMPLE {
                return Err(
                    "only the Hermes DGX Station example is qualified by this smoke".into(),
                );
            }
            private_directory(&job)?;
            let source = fs::read(EXAMPLE)?;
            let pins: Value = serde_json::from_slice(&fs::read("versions.json")?)?;
            let recovery = prepare(
                &root,
                &job,
                &source,
                pins["images"]["gateway"]
                    .as_str()
                    .ok_or("missing gateway pin")?,
                &required("STATION_AGENT_IMAGE")?,
                &required("STATION_MODEL_IMAGE")?,
                &required("GITHUB_SHA")?,
            )?;
            let state = root
                .join("deployments")
                .join(recovery.deployment)
                .join("state");
            let mut output = OpenOptions::new()
                .append(true)
                .open(required("GITHUB_ENV")?)?;
            for (name, path) in [
                ("NEMOCLAW_TEST_BUNDLE", job.join("bundle")),
                ("NEMOCLAW_LIVE_STATION_EXAMPLE", job.join("prepared.yaml")),
                ("NEMOCLAW_LIVE_STATION_RUN", job.join("smoke")),
                ("NEMOCLAW_LIVE_STATION_STATE", state),
                (
                    "NEMOCLAW_LIVE_STATION_RESULT",
                    job.join("smoke-result.json"),
                ),
            ] {
                let value = path.to_str().ok_or("Station paths must be UTF-8")?;
                if value.contains(['\n', '\r']) {
                    return Err("Station paths must not contain newlines".into());
                }
                writeln!(output, "{name}={value}")?;
            }
            Ok(())
        }
        Some("cleanup") => cleanup(&root, &job).await,
        _ => Err("usage: station-host prepare|cleanup".into()),
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    execute().await
}

#[cfg(test)]
mod tests {
    use super::*;
    const SOURCE: &[u8] = include_bytes!("../../../../examples/gtc-dc/hermes-dgx-station.yaml");
    const SHA: &str = "1111111111111111111111111111111111111111";
    fn image(byte: &str) -> String {
        format!("owned@sha256:{}", byte.repeat(64))
    }
    fn job(root: &Path, name: &str) -> PathBuf {
        let path = root.join("jobs").join(name);
        private_directory(&path).unwrap();
        path
    }
    fn ready(root: &Path, path: &Path, pin: &str, agent: &str) -> Recovery {
        prepare(root, path, SOURCE, pin, agent, &image("b"), SHA).unwrap()
    }
    fn state(root: &Path, r: &Recovery) -> PathBuf {
        root.join("deployments").join(&r.deployment).join("state")
    }
    fn receipt(r: &Recovery, state: &Path) -> Value {
        let components: serde_json::Map<String, Value> =
            ["gateway", "model", "sandbox", "supervisor"]
                .into_iter()
                .enumerate()
                .map(|(i, name)| {
                    (
                        name.into(),
                        json!({"id":format!("{:064x}",i+1),"running":true,"healthy":true}),
                    )
                })
                .collect();
        json!({"schemaVersion":1,"test":"station_example_components_are_running",
            "deploymentUid":r.uid,"stateDirectory":state,"configurationSha256":r.configuration_sha256,
            "outcome":"passed","destroy":"succeeded","components":components})
    }

    #[test]
    fn repeated_image_builds_reuse_identity_but_changed_gateway_pins_get_separate_state() {
        let root = tempfile::tempdir().unwrap();
        let first = job(root.path(), "first");
        let a = ready(root.path(), &first, &image("a"), &image("c"));
        let document =
            Document::parse(fs::read(first.join("prepared.yaml")).unwrap().as_slice()).unwrap();
        assert_ne!(
            document.metadata.uid,
            Document::parse(SOURCE).unwrap().metadata.uid
        );
        assert_eq!(document.spec.sandboxes[0].image.ref_, image("c"));
        let result = receipt(&a, &state(root.path(), &a));
        finish_cleanup(
            root.path(),
            &first,
            &a,
            &state(root.path(), &a),
            Ok(()),
            Some(&result),
        )
        .unwrap();
        let second = job(root.path(), "second");
        let b = ready(root.path(), &second, &image("a"), &image("d"));
        assert_eq!((&a.uid, &a.deployment), (&b.uid, &b.deployment));
        assert_ne!(a.configuration_sha256, b.configuration_sha256);
        let result = receipt(&b, &state(root.path(), &b));
        finish_cleanup(
            root.path(),
            &second,
            &b,
            &state(root.path(), &b),
            Ok(()),
            Some(&result),
        )
        .unwrap();
        let c = ready(
            root.path(),
            &job(root.path(), "third"),
            &image("e"),
            &image("d"),
        );
        assert_ne!(c.deployment, a.deployment);
        assert_ne!(c.uid, a.uid);
        assert!(
            root.path()
                .join("deployments")
                .join(a.deployment)
                .join("uid")
                .is_file()
        );
    }

    #[test]
    fn failed_cleanup_blocks_another_apply_and_keeps_recovery_evidence() {
        let root = tempfile::tempdir().unwrap();
        let first = job(root.path(), "failed");
        let r = ready(root.path(), &first, &image("a"), &image("c"));
        let result = receipt(&r, &state(root.path(), &r));
        assert!(
            finish_cleanup(
                root.path(),
                &first,
                &r,
                &state(root.path(), &r),
                Err("destroy failed".into()),
                Some(&result)
            )
            .is_err()
        );
        let blocked = prepare(
            root.path(),
            &job(root.path(), "next"),
            SOURCE,
            &image("a"),
            &image("c"),
            &image("b"),
            SHA,
        );
        assert!(
            blocked
                .err()
                .unwrap()
                .to_string()
                .contains("unfinished cleanup")
        );
        assert!(first.join("recovery.json").exists());
        let summary: Value =
            serde_json::from_slice(&fs::read(first.join("summary.json")).unwrap()).unwrap();
        assert_eq!(summary["outcome"], "failure");
        assert_eq!(summary["cleanup"], "failed");
        assert!(root.path().join("pending.json").exists());
    }

    #[test]
    fn skipped_smoke_is_a_failure_even_after_successful_cleanup() {
        let root = tempfile::tempdir().unwrap();
        let first = job(root.path(), "skipped");
        let r = ready(root.path(), &first, &image("a"), &image("c"));
        assert!(
            finish_cleanup(
                root.path(),
                &first,
                &r,
                &state(root.path(), &r),
                Ok(()),
                None
            )
            .is_err()
        );
        let summary: Value =
            serde_json::from_slice(&fs::read(first.join("summary.json")).unwrap()).unwrap();
        assert_eq!(summary["outcome"], "failure");
        assert_eq!(summary["cleanup"], "succeeded");
        assert!(!root.path().join("pending.json").exists());
        assert!(summary.get("stateDirectory").is_none());
    }

    #[test]
    fn receipts_must_match_this_prepared_job_and_all_four_observations() {
        let root = tempfile::tempdir().unwrap();
        let first = job(root.path(), "receipt");
        let r = ready(root.path(), &first, &image("a"), &image("c"));
        let state = state(root.path(), &r);
        let result = receipt(&r, &state);
        assert!(valid_receipt(&result, &r, &state));
        for (field, value) in [
            ("deploymentUid", json!("other")),
            ("stateDirectory", json!("/elsewhere")),
            ("configurationSha256", json!("other")),
            ("destroy", json!("failed")),
            ("components", json!({})),
        ] {
            let mut bad = result.clone();
            bad[field] = value;
            assert!(!valid_receipt(&bad, &r, &state), "{field}");
        }
        let mut bad = result.clone();
        bad["components"]["model"]["healthy"] = json!(false);
        assert!(!valid_receipt(&bad, &r, &state));
        let mut bad = result;
        bad["components"]["extra"] = json!({});
        assert!(!valid_receipt(&bad, &r, &state));
    }

    #[test]
    fn admission_rejects_placeholder_images_without_recording_a_pending_job() {
        let root = tempfile::tempdir().unwrap();
        let first = job(root.path(), "invalid");
        assert!(
            prepare(
                root.path(),
                &first,
                SOURCE,
                &image("a"),
                &image("0"),
                &image("b"),
                SHA
            )
            .is_err()
        );
        assert!(!root.path().join("pending.json").exists());
        assert!(!first.join("recovery.json").exists());
    }

    #[test]
    fn host_lock_excludes_other_preparation_or_cleanup() {
        let parent = tempfile::tempdir().unwrap();
        let root = parent.path().join("private");
        let held = lock(&root).unwrap();
        assert!(lock(&root).is_err());
        drop(held);
        assert!(lock(&root).is_ok());
    }
}
