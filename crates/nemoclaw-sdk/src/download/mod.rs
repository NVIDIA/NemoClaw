// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod transport;
use serde::{Deserialize, Serialize};
pub(crate) use transport::{ENV, Listener};
pub(crate) type Callback = std::sync::Arc<dyn Fn(crate::Progress) + Send + Sync>;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadProgress {
    /// Backend resource kind and name (not an OpenTofu graph address).
    pub resource: String,
    /// Requested image reference or model name; never a registry response message.
    pub artifact: String,
    pub layer: Option<String>,
    pub phase: DownloadPhase,
    pub bytes: Option<ByteProgress>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadPhase {
    Starting,
    Downloading,
    Extracting,
    Verifying,
    Complete,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ByteProgress {
    pub completed: u64,
    pub total: Option<u64>,
}

impl DownloadProgress {
    pub fn valid(&self) -> bool {
        fn label(s: &str) -> bool {
            !s.is_empty() && s.len() <= 1024 && !s.chars().any(char::is_control)
        }
        label(&self.resource)
            && label(&self.artifact)
            && self.layer.as_deref().is_none_or(label)
            && self.bytes.is_none_or(|b| {
                b.total
                    .is_none_or(|total| total == 0 || b.completed <= total)
            })
    }
}
