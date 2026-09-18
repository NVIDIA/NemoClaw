// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{ResourceIdentities, StateSnapshot};
use nemoclaw_sdk::{
    docker::Engine,
    managed::{RuntimeObservation, Spec},
    recipes::huggingface,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ReceiptObservation {
    sha256: String,
    mtime: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreparedObservation {
    pub ids: ResourceIdentities,
    pub receipts: BTreeMap<String, ReceiptObservation>,
}

/// A bound inference runtime. Callers choose mutations and assert scenario expectations.
pub struct InferenceRuntime {
    pub engine: Engine,
    spec: Spec,
    id: String,
}

impl InferenceRuntime {
    pub fn connect(directory: &Path) -> Result<Self> {
        let state = StateSnapshot::read(&directory.join("runtime/terraform.tfstate"))?;
        let attributes = state.only("nemoclaw_inference_service")?;
        let spec: Spec = serde_json::from_str(
            attributes["spec"]
                .as_str()
                .ok_or("missing inference specification")?,
        )?;
        let id = attributes["id"]
            .as_str()
            .ok_or("missing inference identity")?
            .to_owned();
        let engine = Engine::connect(&spec.gateway.engine)?;
        Ok(Self { engine, spec, id })
    }

    pub async fn observe(&self) -> Result<RuntimeObservation> {
        self.engine
            .observe_runtime(&self.spec, &self.id)
            .await?
            .ok_or_else(|| "owned inference must remain present".into())
    }

    pub async fn receipts(&self) -> Result<BTreeMap<String, ReceiptObservation>> {
        let observed = self.observe().await?;
        self.engine.verify_artifacts(&observed).await?;
        let service = self
            .spec
            .service
            .as_ref()
            .ok_or("missing inference service")?;
        let recipe = service
            .recipe
            .as_ref()
            .ok_or("missing preparation recipe")?;
        let mut receipts = BTreeMap::new();
        for path in [
            format!(
                "/data/{}/.nemoclaw-complete.json",
                huggingface::directory(service)
            ),
            format!("/data/prepared/{}/complete.json", recipe.key(service)),
        ] {
            let bytes = self
                .engine
                .read_file(&observed.container_id, &path, 1 << 20)
                .await?
                .ok_or("missing artifact receipt")?;
            let stat = self
                .engine
                .stat_file(&observed.container_id, &path)
                .await?
                .ok_or("missing artifact receipt metadata")?;
            receipts.insert(
                path,
                ReceiptObservation {
                    sha256: Sha256::digest(bytes)
                        .iter()
                        .map(|byte| format!("{byte:02x}"))
                        .collect(),
                    mtime: stat.modification_time,
                },
            );
        }
        Ok(receipts)
    }

    /// Exercise the watchdog only on the freshly observed owned container.
    pub async fn signal_watchdog(&self) -> Result<()> {
        let observed = self.observe().await?;
        let mut command = tokio::process::Command::new("docker");
        command.args([
            "--host",
            &self.spec.gateway.engine,
            "kill",
            "--signal",
            "USR1",
            &observed.container_id,
        ]);
        command.kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), command.output()).await??;
        if !output.status.success() {
            return Err("watchdog signal failed".into());
        }
        Ok(())
    }

    pub async fn wait_stopped(&self, timeout: Duration) -> Result<RuntimeObservation> {
        tokio::time::timeout(timeout, async {
            loop {
                let observed = self.observe().await?;
                if !observed.running {
                    return Ok::<_, Box<dyn std::error::Error + Send + Sync>>(observed);
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        })
        .await?
    }
}
