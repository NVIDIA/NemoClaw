// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
mod transport;
use nemoclaw_sdk::{ByteProgress, DownloadPhase, DownloadProgress, Progress};
use std::{
    collections::BTreeMap,
    future::Future,
    sync::Arc,
    time::{Duration, Instant},
};
pub(crate) type Callback = Arc<dyn Fn(Progress) + Send + Sync>;
tokio::task_local! { static CONTEXT: (String, Callback); }

/// Report downloads performed by this future through an in-process callback.
/// The callback should return promptly. Spawned tasks need their own scope.
pub(crate) async fn with_download_progress<T>(
    resource: String,
    callback: Callback,
    operation: impl Future<Output = T>,
) -> T {
    CONTEXT.scope((resource, callback), operation).await
}

/// Connect provider downloads to the endpoint supplied by the SDK, when present.
/// Channel failures never change the operation result.
#[doc(hidden)]
pub(crate) async fn with_provider_download_progress<T>(
    resource: String,
    operation: impl Future<Output = T>,
) -> T {
    let Some(endpoint) = std::env::var_os(transport::ENV) else {
        return operation.await;
    };
    transport::forward(endpoint, resource, operation).await
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

/// The resource a download belongs to, for progress labels.
pub(crate) fn resource_label(kind: &str, row: &crate::Row) -> String {
    #[derive(serde::Deserialize)]
    struct NamedSpec {
        name: String,
    }
    let name = row
        .get("name")
        .or_else(|| row.get("model"))
        .cloned()
        .or_else(|| {
            serde_json::from_str::<NamedSpec>(row.get("spec")?)
                .ok()
                .map(|spec| spec.name)
        })
        .unwrap_or_else(|| "resource".into());
    format!("{kind}.{name}")
}

#[cfg(test)]
mod label_tests {
    use super::*;
    #[test]
    fn download_labels_distinguish_named_specs_and_models() {
        for name in ["first", "second"] {
            let row =
                crate::Row::from([("spec".into(), serde_json::json!({"name":name}).to_string())]);
            assert_eq!(
                resource_label("inference_service", &row),
                format!("inference_service.{name}")
            );
        }
        let row = crate::Row::from([("model".into(), "llama3:latest".into())]);
        assert_eq!(
            resource_label("model_snapshot", &row),
            "model_snapshot.llama3:latest"
        );
    }
}
