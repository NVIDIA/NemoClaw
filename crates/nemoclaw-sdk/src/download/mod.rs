// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Transient download progress. Results still travel through the normal operation response.
mod transport;
use crate::Progress;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};
pub(crate) use transport::Listener;

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

pub(crate) type Callback = Arc<dyn Fn(Progress) + Send + Sync>;
tokio::task_local! { static CONTEXT: (String, Callback); }

/// Report downloads performed by this future through an in-process callback.
/// The callback should return promptly. Spawned tasks need their own scope.
pub async fn with_download_progress<T>(
    resource: String,
    callback: Callback,
    operation: impl Future<Output = T>,
) -> T {
    CONTEXT.scope((resource, callback), operation).await
}

/// Connect provider downloads to the endpoint supplied by the SDK, when present.
/// Channel failures never change the operation result.
#[doc(hidden)]
pub async fn with_provider_download_progress<T>(
    resource: String,
    operation: impl Future<Output = T>,
) -> T {
    let Some(endpoint) = std::env::var_os(transport::ENV) else {
        return operation.await;
    };
    transport::forward(endpoint, resource, operation).await
}

impl DownloadProgress {
    fn valid(&self) -> bool {
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

pub(crate) struct Reporter {
    context: Option<(String, Callback)>,
    artifact: String,
    sent: BTreeMap<Option<String>, (DownloadPhase, Instant)>,
}
impl Reporter {
    pub(crate) fn new(artifact: &str) -> Self {
        let mut reporter = Self {
            context: CONTEXT.try_with(Clone::clone).ok(),
            artifact: artifact.into(),
            sent: BTreeMap::new(),
        };
        reporter.report(None, DownloadPhase::Starting, None);
        reporter
    }
    pub(crate) fn report(
        &mut self,
        layer: Option<String>,
        phase: DownloadPhase,
        bytes: Option<ByteProgress>,
    ) {
        let Some((resource, callback)) = &self.context else {
            return;
        };
        // Bound retained layer identities and limit repeated updates to once a second.
        if self.sent.get(&layer).is_some_and(|(previous, at)| {
            *previous == phase && at.elapsed() < Duration::from_secs(1)
        }) {
            return;
        }
        if self.sent.len() >= 128 && !self.sent.contains_key(&layer) {
            return;
        }
        let event = DownloadProgress {
            resource: resource.clone(),
            artifact: self.artifact.clone(),
            layer: layer.clone(),
            phase,
            bytes,
        };
        if event.valid() {
            self.sent.insert(layer, (phase, Instant::now()));
            callback(Progress::Download(event));
        }
    }
    pub(crate) fn complete(&mut self) {
        self.report(None, DownloadPhase::Complete, None);
    }
}

/// Only expose digest-like layer IDs, never arbitrary server-provided text.
pub(crate) fn layer_id(value: Option<&str>) -> Option<String> {
    value
        .filter(|s| {
            !s.is_empty()
                && s.len() <= 128
                && s.strip_prefix("sha256:")
                    .unwrap_or(s)
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit())
        })
        .map(str::to_owned)
}
