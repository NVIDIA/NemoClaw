// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{
    Error,
    docker::Engine,
    managed::{RuntimeObservation, Spec},
    services::capacity::CapacityCheck,
};
impl Engine {
    pub async fn check_capacity(
        &self,
        spec: &Spec,
        observed: Option<&RuntimeObservation>,
    ) -> Result<(), Error> {
        self.check_capacity_phase(
            spec,
            observed.map(|runtime| runtime.container_id.as_str()),
            CapacityCheck::Apply {
                starting: observed.is_none_or(|runtime| !runtime.running),
            },
        )
        .await
    }
    pub(crate) async fn check_capacity_phase(
        &self,
        spec: &Spec,
        container_id: Option<&str>,
        phase: CapacityCheck,
    ) -> Result<(), Error> {
        spec.validate()?;
        if self.endpoint() != spec.engine() {
            return Err(Error::Conflict(
                "capacity engine differs from runtime specification",
            ));
        }
        let service = super::configured_service(spec)?;
        {
            let work = async {
                let host = self.host_observer.observe(self).await?;
                let info = self.info().await?;
                let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
                super::hardware_capacity::check_memory(&service, &capacity, phase.starting())?;
                let directory = super::recipes::huggingface::directory(&service);
                let cached = if let Some(container_id) = container_id {
                    self.read_file(
                        container_id,
                        &format!(
                            "/data/{directory}/{}",
                            super::recipes::huggingface::MANIFEST_FILE
                        ),
                        4 << 20,
                    )
                    .await?
                } else {
                    None
                };
                if phase == CapacityCheck::Plan && cached.is_none() {
                    return Ok(());
                }
                let cached = cached
                    .as_deref()
                    .map(|bytes| super::recipes::huggingface::decode_manifest(&service, bytes))
                    .transpose()?;
                let manifest = match &cached {
                    Some(local) => local.snapshot(),
                    None => super::recipes::huggingface::resolve_manifest(&service).await?,
                };
                let mut download = manifest.bytes()?;
                let preparation = service
                    .recipe
                    .as_ref()
                    .map_or(0, |r| r.resources.prepared_bytes);
                if let Some(container_id) = container_id {
                    for (index, file) in manifest.files.into_iter().enumerate() {
                        let base = format!("/data/{directory}/{}", file.name);
                        if let Some(modified) = cached
                            .as_ref()
                            .and_then(|local| local.files[index].modified)
                        {
                            let stat = self.stat_file(container_id, &base).await?.ok_or(
                                Error::Conflict(
                                    "verified model file is missing; retained for inspection",
                                ),
                            )?;
                            super::artifacts::verify_stat(
                                &crate::snapshot::VerifiedFile {
                                    file: file.clone(),
                                    modified,
                                },
                                &stat,
                            )?;
                            download -= file.size;
                            continue;
                        }
                        for suffix in ["", ".nemoclaw-partial"] {
                            if let Some(stat) = self
                                .stat_file(container_id, &format!("{base}{suffix}"))
                                .await?
                            {
                                if !regular_stat(&stat)
                                    || stat.size < 0
                                    || stat.size as u64 > file.size
                                {
                                    return Err(Error::Conflict(
                                        "retained download progress is unobservable or corrupt",
                                    ));
                                }
                                download -= stat.size as u64;
                                break;
                            }
                        }
                    }
                }
                service.check_capacity(&capacity, phase.starting(), download, preparation)
            };
            tokio::time::timeout(std::time::Duration::from_secs(150), work)
                .await
                .map_err(|_| Error::State("host capacity observation timed out"))?
        }
    }
}
pub(crate) fn regular_stat(stat: &bollard::container::PathStatResponse) -> bool {
    const GO_MODE_TYPE: u32 =
        (1 << 31) | (1 << 27) | (1 << 26) | (1 << 25) | (1 << 24) | (1 << 21) | (1 << 19);
    stat.file_mode & GO_MODE_TYPE == 0 && stat.link_target.is_empty()
}
