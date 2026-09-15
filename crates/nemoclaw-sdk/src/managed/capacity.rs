// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{RuntimeObservation, Spec};
use crate::{Error, docker::Engine};
impl Engine {
    pub async fn check_capacity(
        &self,
        spec: &Spec,
        observed: Option<&RuntimeObservation>,
    ) -> Result<(), Error> {
        spec.validate()?;
        if self.endpoint() != spec.gateway.engine {
            return Err(Error::Conflict(
                "capacity engine differs from runtime specification",
            ));
        }
        let service = spec
            .service
            .as_ref()
            .ok_or(Error::Conflict("capacity requires an inference service"))?;
        {
            let work = async {
                let host = self.host_observer.observe(self).await?;
                let info = self.info().await?;
                let capacity = host.for_engine(info.id.as_deref().unwrap_or(""))?;
                let generic = service.backend == crate::recipes::huggingface::BACKEND;
                let directory = if generic {
                    crate::recipes::huggingface::directory(service)
                } else {
                    format!("models/{}", service.model.revision)
                };
                let manifest = if generic {
                    let cached = if let Some(observed) = observed {
                        self.read_file(
                            &observed.container_id,
                            &format!(
                                "/data/{directory}/{}",
                                crate::recipes::huggingface::MANIFEST_FILE
                            ),
                            4 << 20,
                        )
                        .await?
                    } else {
                        None
                    };
                    match cached {
                        Some(bytes) => {
                            crate::recipes::huggingface::decode_manifest(service, &bytes)?
                        }
                        None => crate::recipes::huggingface::resolve_manifest(service).await?,
                    }
                } else {
                    crate::recipes::qwen38::model_manifest()
                };
                let mut download = manifest.bytes()?;
                let mut preparation = if generic {
                    0
                } else {
                    crate::recipes::qwen38::PREPARED_BYTES
                };
                if let Some(observed) = observed {
                    for file in manifest.files {
                        let base = format!("/data/{directory}/{}", file.name);
                        for suffix in ["", ".nemoclaw-partial"] {
                            if let Some(stat) = self
                                .stat_file(&observed.container_id, &format!("{base}{suffix}"))
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
                    if !generic {
                        let path = format!(
                            "/data/prepared/{}/{}",
                            crate::recipes::qwen38::preparation_key(),
                            crate::recipes::qwen38::PREPARED_FILE
                        );
                        if let Some(stat) = self.stat_file(&observed.container_id, &path).await? {
                            if !regular_stat(&stat)
                                || stat.size <= 0
                                || stat.size as u64 > preparation
                            {
                                return Err(Error::Conflict(
                                    "retained preparation progress is unobservable or corrupt",
                                ));
                            }
                            preparation -= stat.size as u64;
                        }
                    }
                }
                service.check_capacity(
                    &capacity,
                    observed.is_none_or(|observed| !observed.running),
                    download,
                    preparation,
                )
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
