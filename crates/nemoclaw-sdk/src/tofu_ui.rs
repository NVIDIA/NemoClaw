// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded adapter for OpenTofu's versioned, newline-delimited UI protocol.
use crate::Progress;
use serde_json::Value;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub(crate) struct Ui {
    line: Vec<u8>,
    version: bool,
    invalid: bool,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
    started: BTreeMap<(String, bool), OffsetDateTime>,
}
impl Ui {
    pub(crate) fn new(progress: Arc<dyn Fn(Progress) + Send + Sync>) -> Self {
        Self {
            line: Vec::new(),
            version: false,
            invalid: false,
            progress,
            started: BTreeMap::new(),
        }
    }
    pub(crate) fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes {
            if self.invalid {
                return;
            }
            if byte == b'\n' {
                self.message();
                self.line.clear();
            } else if self.line.len() < 1024 * 1024 {
                self.line.push(byte);
            } else {
                self.invalid = true;
            }
        }
    }
    fn message(&mut self) {
        let Ok(value) = serde_json::from_slice::<Value>(&self.line) else {
            self.invalid = true;
            return;
        };
        if !self.version {
            self.version = value["type"] == "version"
                && value["ui"]
                    .as_str()
                    .is_some_and(|v| v.split('.').next() == Some("1"));
            self.invalid = !self.version;
            return;
        }
        let status = match value["type"].as_str() {
            Some("apply_start" | "refresh_start") => "started",
            Some("apply_progress") => "waiting",
            Some("apply_complete" | "refresh_complete") => "complete",
            Some("apply_errored") => "failed",
            _ => return,
        };
        // Only fixed labels cross the progress boundary. IDs, provider messages,
        // outputs, and arbitrary configuration values can contain credentials.
        let kind = value["hook"]["resource"]["resource_type"].as_str();
        let resource = match kind {
            Some("nemoclaw_workspace") => "workspace",
            Some("nemoclaw_sandbox") => "sandbox",
            Some("nemoclaw_provider") => "provider",
            Some("nemoclaw_provider_profile") => "provider profile",
            Some("nemoclaw_managed_gateway") => "gateway",
            Some(kind) => {
                let kind = kind.strip_prefix("nemoclaw_").unwrap_or(kind);
                let Some(label) = crate::services::resource_label(kind) else {
                    return;
                };
                label
            }
            None => return,
        };
        let action = if value["type"]
            .as_str()
            .is_some_and(|v| v.starts_with("refresh_"))
        {
            "refresh"
        } else {
            match value["hook"]["action"].as_str() {
                Some("create") => "create",
                Some("read") => "read",
                Some("update") => "update",
                Some("replace") => "replace",
                Some("delete") => "delete",
                Some("noop") => "noop",
                _ => return,
            }
        };
        let mut elapsed =
            Duration::from_secs(value["hook"]["elapsed_seconds"].as_u64().unwrap_or(0));
        if let Some(address) = value["hook"]["resource"]["addr"].as_str() {
            let key = (address.to_owned(), action == "refresh");
            let timestamp = value["@timestamp"]
                .as_str()
                .and_then(|t| OffsetDateTime::parse(t, &Rfc3339).ok());
            if status == "started" {
                if let Some(timestamp) = timestamp
                    && self.started.len() < 1024
                {
                    self.started.insert(key, timestamp);
                }
            } else {
                if let Some(started) = self.started.get(&key)
                    && let Some(timestamp) = timestamp
                    && let Ok(measured) = Duration::try_from(timestamp - *started)
                {
                    elapsed = measured;
                }
                if matches!(status, "complete" | "failed") {
                    self.started.remove(&key);
                }
            }
        }
        (self.progress)(Progress::Resource {
            resource,
            action,
            status,
            elapsed,
        });
    }
    pub(crate) fn finish(mut self) -> std::io::Result<()> {
        if !self.line.is_empty() && !self.invalid {
            self.message();
        }
        if self.invalid || !self.version {
            return Err(std::io::Error::other(
                "invalid or unsupported OpenTofu UI stream",
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn resource_timings_use_timestamps_and_keep_concurrent_addresses_separate() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let events = received.clone();
        let mut ui = Ui::new(Arc::new(move |event| events.lock().unwrap().push(event)));
        ui.feed(b"{\"type\":\"version\",\"ui\":\"1.0\"}\n");
        for (kind, address, timestamp) in [
            (
                "apply_start",
                "nemoclaw_provider.fast",
                "2026-09-17T00:00:00.000Z",
            ),
            (
                "apply_start",
                "nemoclaw_provider.smart",
                "2026-09-17T00:00:00.100Z",
            ),
            (
                "apply_complete",
                "nemoclaw_provider.fast",
                "2026-09-17T00:00:00.125Z",
            ),
            (
                "apply_complete",
                "nemoclaw_provider.smart",
                "2026-09-17T00:00:00.350Z",
            ),
        ] {
            let mut line = serde_json::json!({"type":kind, "@timestamp":timestamp, "hook":{"resource":{"resource_type":"nemoclaw_provider", "addr":address}, "action":"create", "elapsed_seconds":0}}).to_string();
            line.push('\n');
            ui.feed(line.as_bytes());
        }
        ui.finish().unwrap();
        let events = received.lock().unwrap();
        assert!(
            matches!(events[2], Progress::Resource { elapsed, .. } if elapsed == std::time::Duration::from_millis(125))
        );
        assert!(
            matches!(events[3], Progress::Resource { elapsed, .. } if elapsed == std::time::Duration::from_millis(250))
        );
    }

    #[test]
    fn fragmented_events_ignore_unknown_fields_and_never_forward_values() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let events = received.clone();
        let mut ui = Ui::new(Arc::new(move |event| events.lock().unwrap().push(event)));
        let stream = concat!(
            "{\"type\":\"version\",\"ui\":\"1.99\"}\n",
            "{\"type\":\"future_event\",\"@message\":\"secret-sentinel\"}\n",
            "{\"type\":\"outputs\",\"outputs\":{\"secret\":\"secret-sentinel\"}}\n",
            "{\"type\":\"apply_progress\",\"@message\":\"secret-sentinel\",\"hook\":{\"resource\":{\"resource_type\":\"nemoclaw_sandbox\",\"addr\":\"secret-sentinel\"},\"action\":\"create\",\"elapsed_seconds\":30}}"
        );
        for chunk in stream.as_bytes().chunks(7) {
            ui.feed(chunk);
        }
        ui.finish().unwrap();
        assert_eq!(
            *received.lock().unwrap(),
            [Progress::Resource {
                resource: "sandbox",
                action: "create",
                status: "waiting",
                elapsed: std::time::Duration::from_secs(30)
            }]
        );
    }
    #[test]
    fn rejects_unsupported_missing_malformed_and_oversized_streams() {
        for input in [
            b"".as_slice(),
            b"{\"type\":\"version\",\"ui\":\"2.0\"}\n",
            b"not json\n",
            b"{\"type\":\"apply_start\"}\n",
            &vec![b'x'; 1024 * 1024 + 1],
        ] {
            let mut ui = Ui::new(Arc::new(|_| panic!("invalid stream emitted progress")));
            ui.feed(input);
            assert!(ui.finish().is_err());
        }
    }
}
