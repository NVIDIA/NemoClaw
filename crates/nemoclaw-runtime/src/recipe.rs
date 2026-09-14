// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{runtime::report, supervisor};
use nemoclaw_sdk::{
    CancellationToken, Error,
    recipes::{Recipe, qwen38 as spark},
    snapshot,
};
use process_wrap::tokio::{CommandWrap, KillOnDrop, ProcessGroup};
use spark::{PreparationAction, PreparationRunner};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::io::AsyncReadExt;
const PREPARER: &str = "/opt/nemoclaw/source/recipe/files/build_ple_packed_table.py";
const VERIFIER: &str = "/opt/nemoclaw/source/verify_packed.py";
pub(crate) struct PreparedModel {
    pub model: PathBuf,
    pub environment: std::collections::BTreeMap<&'static str, std::ffi::OsString>,
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
pub(crate) async fn prepare(
    recipe: Recipe,
    root: &Path,
    cancel: &CancellationToken,
) -> Result<PreparedModel, Error> {
    match recipe {
        Recipe::Qwen38V1 => prepare_qwen38(recipe, root, cancel).await,
    }
}
async fn prepare_qwen38(
    recipe: Recipe,
    root: &Path,
    cancel: &CancellationToken,
) -> Result<PreparedModel, Error> {
    let manifest = recipe.manifest();
    let model = root.join("models").join(&manifest.revision);
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
    let prepared = root.join("prepared");
    spark::prepare(&prepared, &model, &PackagedTools, cancel).await?;
    let mut environment: std::collections::BTreeMap<&'static str, std::ffi::OsString> = [
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
    ]
    .into_iter()
    .map(|(key, value)| (key, value.into()))
    .collect();
    environment.insert(
        "VLLM_PLE_PACKED_TABLE_DIR",
        prepared.join(recipe.preparation_key()).into_os_string(),
    );
    Ok(PreparedModel { model, environment })
}
