// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{RuntimeObservation, capacity::regular_stat};
use crate::{
    Error,
    docker::Engine,
    snapshot::{CompletionRecord, VerifiedFile},
};
use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RuntimeStatus {
    pub phase: String,
    pub detail: String,
    pub updated: String,
    pub pid: u32,
}
fn timestamp(value: &str) -> Result<OffsetDateTime, Error> {
    OffsetDateTime::parse(value, &Rfc3339)
        .map_err(|_| Error::State("runtime observation timestamp is incomplete"))
}
impl RuntimeStatus {
    fn initializing() -> Self {
        Self {
            phase: "initializing".into(),
            detail: String::new(),
            updated: String::new(),
            pid: 0,
        }
    }
}
impl Engine {
    pub async fn runtime_status(
        &self,
        observed: &RuntimeObservation,
    ) -> Result<RuntimeStatus, Error> {
        let started = timestamp(&observed.started_at)?;
        let bytes = self
            .read_file(&observed.container_id, "/data/status.json", 128 << 10)
            .await?;
        let Some(bytes) = bytes else {
            let elapsed = OffsetDateTime::now_utc() - started;
            if elapsed >= time::Duration::ZERO && elapsed < time::Duration::seconds(30) {
                return Ok(RuntimeStatus::initializing());
            }
            return Err(Error::State("inference runtime status is unobservable"));
        };
        let status: RuntimeStatus = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("inference runtime status is incomplete"))?;
        if timestamp(&status.updated)? < started {
            return Ok(RuntimeStatus::initializing());
        }
        match status.phase.as_str() {
            "initializing" | "downloading" | "preparing" | "loading" | "ready" | "stopped" => {
                Ok(status)
            }
            _ => Err(Error::State("unknown inference runtime status")),
        }
    }
    /// Verify retained completion records and file metadata without rehashing the model
    /// or starting a container. Only the runtime publishes completion records.
    pub async fn verify_artifacts(&self, observed: &RuntimeObservation) -> Result<(), Error> {
        let work = async {
            let service = observed
                .spec
                .service
                .as_ref()
                .ok_or(Error::State("missing inference specification"))?;
            if service.authentication.is_some() {
                crate::inference_auth::read_key(self, &observed.container_id).await?;
            }
            let model = format!("/data/{}", crate::recipes::huggingface::directory(service));
            let bytes = self
                .read_file(
                    &observed.container_id,
                    &format!("{model}/{}", crate::recipes::huggingface::MANIFEST_FILE),
                    4 << 20,
                )
                .await?
                .ok_or(Error::State("selected model manifest is unobservable"))?;
            let manifest = crate::recipes::huggingface::decode_manifest(service, &bytes)?;
            let bytes = self
                .read_file(
                    &observed.container_id,
                    &format!("{model}/.nemoclaw-complete.json"),
                    1 << 20,
                )
                .await?
                .ok_or(Error::State("complete model snapshot is unobservable"))?;
            let completion: CompletionRecord = serde_json::from_slice(&bytes)
                .map_err(|_| Error::State("invalid model completion record"))?;
            validate_snapshot_manifest(&completion, &manifest)?;
            for file in &completion.files {
                self.verify_artifact_file(&observed.container_id, &model, file)
                    .await?;
            }
            if let Some(recipe) = &service.recipe {
                let key = recipe.key(service);
                let prepared = format!("/data/prepared/{key}");
                let bytes = self
                    .read_file(
                        &observed.container_id,
                        &format!("{prepared}/complete.json"),
                        1 << 20,
                    )
                    .await?
                    .ok_or(Error::State("recipe completion is unobservable"))?;
                let completion: crate::recipes::preparation::CompletionRecord =
                    serde_json::from_slice(&bytes)
                        .map_err(|_| Error::State("invalid recipe completion record"))?;
                crate::recipes::preparation::validate_completion(recipe, &key, &completion)?;
                for file in &completion.files {
                    self.verify_artifact_file(&observed.container_id, &prepared, file)
                        .await?;
                }
                return Ok(());
            }
            Ok(())
        };
        tokio::time::timeout(std::time::Duration::from_secs(30), work)
            .await
            .map_err(|_| Error::State("artifact observation timed out"))?
    }
    async fn verify_artifact_file(
        &self,
        id: &str,
        directory: &str,
        file: &VerifiedFile,
    ) -> Result<(), Error> {
        let stat = self
            .stat_file(id, &format!("{directory}/{}", file.file.name))
            .await?
            .ok_or(Error::State(
                "verified artifact is unobservable; runtime absence is unconfirmed",
            ))?;
        verify_stat(file, &stat)
    }
}
fn validate_snapshot_manifest(
    completion: &CompletionRecord,
    manifest: &crate::snapshot::Manifest,
) -> Result<(), Error> {
    if completion.manifest != manifest.key()
        || completion.files.len() != manifest.files.len()
        || completion
            .files
            .iter()
            .zip(&manifest.files)
            .any(|(actual, expected)| &actual.file != expected)
    {
        return Err(Error::Conflict(
            "model snapshot completion record conflicts with immutable pin",
        ));
    }
    Ok(())
}
fn verify_stat(
    file: &VerifiedFile,
    stat: &bollard::container::PathStatResponse,
) -> Result<(), Error> {
    let modified =
        timestamp(stat.modification_time.as_deref().unwrap_or(""))?.unix_timestamp_nanos();
    if file.file.size == 0
        || file.file.sha256.len() != 64
        || !file
            .file
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        || !regular_stat(stat)
        || stat.size <= 0
        || stat.size as u64 != file.file.size
        || modified != i128::from(file.modified)
    {
        return Err(Error::Conflict(
            "verified artifact changed; retained for inspection",
        ));
    }
    Ok(())
}
#[cfg(all(test, unix))]
#[path = "artifacts_tests.rs"]
mod tests;
