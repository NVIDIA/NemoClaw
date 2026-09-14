// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::supervisor::{self, Monitors};
use nemoclaw_sdk::{
    CancellationToken, Error,
    config::Service,
    snapshot,
    spark::{self, PreparationAction, PreparationRunner},
};
use process_wrap::tokio::{CommandWrap, KillOnDrop, ProcessGroup};
use std::{fs, io::Write, path::Path, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
const ROOT: &str = "/data";
const PREPARER: &str = "/opt/nemoclaw/source/recipe/files/build_ple_packed_table.py";
const VERIFIER: &str = "/opt/nemoclaw/source/verify_packed.py";
pub(crate) fn report(phase: &str, detail: &str, pid: u32) -> Result<(), Error> {
    let updated = time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| Error::State("cannot timestamp runtime status"))?;
    let value = serde_json::json!({"phase":phase,"detail":detail,"updated":updated,"pid":pid});
    let mut file = tempfile::NamedTempFile::new_in(ROOT)
        .map_err(|_| Error::State("cannot write runtime status"))?;
    file.write_all(&serde_json::to_vec(&value).expect("status JSON"))
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| Error::State("cannot sync runtime status"))?;
    file.persist(Path::new(ROOT).join("status.json"))
        .map_err(|_| Error::State("cannot commit runtime status"))?;
    fs::File::open(ROOT)
        .and_then(|f| f.sync_all())
        .map_err(|_| Error::State("cannot sync runtime status directory"))?;
    eprintln!("{phase}: {detail}");
    Ok(())
}
struct PackagedTools;
#[async_trait::async_trait]
impl PreparationRunner for PackagedTools {
    async fn run(
        &self,
        action: PreparationAction,
        model: &Path,
        directory: &Path,
        cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        let (script, digest) = match action {
            PreparationAction::Prepare => (PREPARER, spark::PREPARER_SHA256.to_owned()),
            PreparationAction::Verify => (VERIFIER, spark::verifier_sha256()),
        };
        if nemoclaw_sdk::bundle::hash_file(Path::new(script))? != digest {
            return Err(Error::Conflict(
                "packaged preparation tool does not match its pin",
            ));
        }
        let mut command = CommandWrap::with_new("python3", |cmd| {
            cmd.args(["-u", script])
                .arg(model)
                .arg(directory)
                .stdin(Stdio::null())
                .stderr(Stdio::inherit());
            if action == PreparationAction::Verify {
                cmd.stdout(Stdio::piped());
            } else {
                cmd.stdout(Stdio::inherit());
            }
        });
        command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
        let mut child = command
            .spawn()
            .map_err(|_| Error::State("cannot start packaged preparation tool"))?;
        let mut stdout = child.stdout().take();
        let collect = async {
            let mut bytes = Vec::new();
            if let Some(pipe) = stdout.as_mut() {
                pipe.take((1 << 20) + 1)
                    .read_to_end(&mut bytes)
                    .await
                    .map_err(|_| Error::State("cannot read verifier output"))?;
            }
            if bytes.len() > 1 << 20 {
                return Err(Error::State("verifier output exceeds limit"));
            }
            Ok(bytes)
        };
        let result = tokio::select! {
            ()=cancel.cancelled()=>Err(Error::Cancelled),
            result=async {
                let (status,bytes)=tokio::try_join!(async {child.wait().await.map_err(|_|Error::State("cannot wait for packaged preparation tool"))},collect)?;
                if !status.success() {return Err(Error::Conflict("packed PLE tool failed; staged data retained"));}
                Ok(bytes)
            }=>result
        };
        supervisor::terminate(child.as_mut()).await;
        result
    }
}
pub(crate) async fn run(
    spec: &Service,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    use std::os::unix::fs::OpenOptionsExt;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(Path::new(ROOT).join("runtime.lock"))
        .map_err(|_| Error::State("cannot open persistent runtime lock"))?;
    lock.try_lock().map_err(|_| {
        Error::Conflict("persistent storage already has a writer or locking failed")
    })?;
    let result = run_owned(spec, cancel, trip).await;
    if let Err(error) = &result {
        // Only the holder of the persistent writer lock may publish status.
        let _ = report("stopped", &error.to_string(), 0);
    }
    result
}
async fn run_owned(
    spec: &Service,
    cancel: &CancellationToken,
    trip: &CancellationToken,
) -> Result<(), Error> {
    let manifest = spark::model_manifest();
    let model = Path::new(ROOT).join("models").join(&manifest.revision);
    report("downloading", "verifying exact model snapshot", 0)?;
    let client = snapshot::Client::new()?;
    let progress = |file: &str| {
        let _ = report("downloading", file, 0);
    };
    tokio::time::timeout(
        Duration::from_secs(8 * 3600),
        client.ensure(&model, &manifest, cancel, &progress),
    )
    .await
    .map_err(|_| {
        Error::Conflict("model download exceeded eight-hour budget; partial data retained")
    })??;
    report("preparing", "building and verifying packed PLE", 0)?;
    let prepared = Path::new(ROOT).join("prepared");
    spark::prepare(&prepared, &model, &PackagedTools, cancel).await?;
    if trip.is_cancelled() {
        return Err(Error::Conflict(
            "memory protection tripped by operator; explicit apply required",
        ));
    }
    let capacity = supervisor::memory()?;
    if capacity.available < spec.gpu_bytes()? + 20 * spark::GIB
        || spec.gpu_bytes()? + spec.memory.host_reserve_gib as u64 * spark::GIB > capacity.total
    {
        return Err(Error::Conflict(
            "memory headroom changed during preparation; service was not started",
        ));
    }
    let gpu = tokio::process::Command::new("nvidia-smi")
        .args(["--query-compute-apps=pid", "--format=csv,noheader,nounits"])
        .kill_on_drop(true)
        .output();
    let gpu = tokio::select! {()=cancel.cancelled()=>return Err(Error::Cancelled),result=tokio::time::timeout(Duration::from_secs(15),gpu)=>result.map_err(|_|Error::State("GPU availability observation timed out"))?.map_err(|_|Error::State("GPU availability is unobservable"))?};
    if !gpu.status.success() || !String::from_utf8_lossy(&gpu.stdout).trim().is_empty() {
        return Err(Error::Conflict(
            "GPU availability changed after preparation; service was not started",
        ));
    }
    let args = spec.arguments(
        model
            .to_str()
            .ok_or(Error::State("invalid model storage path"))?,
        capacity.total,
    )?;
    let mut command = CommandWrap::with_new("python3", |cmd| {
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
        cmd.envs([
            ("HF_HUB_OFFLINE", "1"),
            ("TRANSFORMERS_OFFLINE", "1"),
            ("VLLM_USE_V2_MODEL_RUNNER", "1"),
            ("VLLM_PLE_CPU_OFFLOAD", "1"),
            ("VLLM_PLE_OFFLOAD_STEP_TIMEOUT", "300"),
            (
                "VLLM_MTP_DRAFT_VOCAB",
                "/opt/nemoclaw/source/recipe/files/draft_vocab_en_code_47k.txt",
            ),
            ("HF_HOME", "/data/huggingface"),
            ("VLLM_CACHE_ROOT", "/data/vllm-cache"),
        ]);
        cmd.env(
            "VLLM_PLE_PACKED_TABLE_DIR",
            prepared.join(spark::preparation_key()),
        );
    });
    command.wrap(KillOnDrop).wrap(ProcessGroup::leader());
    let mut child = command
        .spawn()
        .map_err(|_| Error::State("inference process could not start"))?;
    if let Err(error) = report(
        "loading",
        "waiting for inference readiness",
        child.id().unwrap_or(0),
    ) {
        supervisor::terminate(child.as_mut()).await;
        return Err(error);
    }
    let (samples_tx, samples) = tokio::sync::mpsc::channel(1);
    let sampler = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            if samples_tx.send(supervisor::memory()).await.is_err() {
                break;
            }
        }
    });
    let (ready_tx, ready) = tokio::sync::mpsc::channel(1);
    let port = spec.serving.port;
    let health = tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .no_proxy()
            .timeout(Duration::from_secs(1))
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .map_err(|_| Error::State("cannot initialize readiness transport"))?;
        loop {
            if client
                .get(format!("http://127.0.0.1:{port}/health"))
                .send()
                .await
                .is_ok_and(|r| r.status() == reqwest::StatusCode::OK)
            {
                let _ = ready_tx.send(true).await;
                break;
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
        Ok::<(), Error>(())
    });
    let result = supervisor::supervise(
        spec,
        child.as_mut(),
        Monitors {
            samples,
            ready,
            trip: trip.clone(),
            report: &report,
        },
        cancel,
    )
    .await;
    sampler.abort();
    health.abort();
    result
}
