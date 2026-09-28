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
        // Forward fixed kind labels and bounded graph identities, never provider
        // messages, physical IDs, outputs, or arbitrary configuration values.
        let kind = value["hook"]["resource"]["resource_type"].as_str();
        let resource = match kind {
            Some("nemoclaw_workspace") => "workspace",
            Some("nemoclaw_sandbox") => "sandbox",
            Some("nemoclaw_sandbox_readiness") => "sandbox readiness",
            Some("nemoclaw_provider") => "provider",
            Some("nemoclaw_provider_profile") => "provider profile",
            Some("nemoclaw_managed_gateway") => "gateway",
            Some("nemoclaw_gateway_storage") => "gateway storage",
            Some("docker_container") => "container",
            Some("docker_image") => "image",
            Some("docker_volume") => "volume",
            Some("docker_network") => "network",
            Some(kind) => {
                let kind = kind.strip_prefix("nemoclaw_").unwrap_or(kind);
                crate::services::resource_label(kind).unwrap_or("resource")
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
        let address = value["hook"]["resource"]["addr"]
            .as_str()
            .filter(|address| safe_address(address, kind.unwrap_or_default()));
        if let Some(address) = address {
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
            address: address.map(str::to_owned),
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

/// Generated graphs use named resources, without user-controlled instance keys.
/// Reject keys, terminal controls, malformed addresses, and oversized identities.
fn safe_address(address: &str, kind: &str) -> bool {
    let address = address.strip_prefix("data.").unwrap_or(address);
    let Some(name) = address
        .strip_prefix(kind)
        .and_then(|rest| rest.strip_prefix('.'))
    else {
        return false;
    };
    fn identifier(value: &str) -> bool {
        value
            .as_bytes()
            .first()
            .is_some_and(|byte| byte.is_ascii_alphabetic() || *byte == b'_')
            && value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    }
    address.len() <= 1024 && identifier(kind) && identifier(name)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn sandbox_observation_waits_remain_visible_without_forwarding_health_details() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let events = received.clone();
        let mut ui = Ui::new(Arc::new(move |event| events.lock().unwrap().push(event)));
        ui.feed(b"{\"type\":\"version\",\"ui\":\"1.0\"}\n");
        let line = serde_json::json!({
            "type":"apply_progress", "@message":"private-health-detail",
            "hook":{"resource":{"resource_type":"nemoclaw_sandbox_readiness", "addr":"data.nemoclaw_sandbox_readiness.private-name"},
                "action":"read", "elapsed_seconds":30}
        }).to_string() + "\n";
        ui.feed(line.as_bytes());
        ui.finish().unwrap();
        assert_eq!(
            *received.lock().unwrap(),
            [Progress::Resource {
                resource: "sandbox readiness",
                address: Some("data.nemoclaw_sandbox_readiness.private-name".into()),
                action: "read",
                status: "waiting",
                elapsed: Duration::from_secs(30)
            }]
        );
    }

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
        assert!(format!("{:?}", events[0]).contains("nemoclaw_provider.fast"));
        assert!(format!("{:?}", events[1]).contains("nemoclaw_provider.smart"));
        assert!(
            matches!(events[2], Progress::Resource { elapsed, .. } if elapsed == std::time::Duration::from_millis(125))
        );
        assert!(
            matches!(events[3], Progress::Resource { elapsed, .. } if elapsed == std::time::Duration::from_millis(250))
        );
    }

    #[test]
    fn native_container_progress_is_visible_without_forwarding_provider_messages() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let events = received.clone();
        let mut ui = Ui::new(Arc::new(move |event| events.lock().unwrap().push(event)));
        ui.feed(b"{\"type\":\"version\",\"ui\":\"1.0\"}\n");
        ui.feed(
            concat!(
                "{\"type\":\"apply_start\",\"@message\":\"secret-sentinel\",",
                "\"hook\":{\"resource\":{\"resource_type\":\"docker_container\",",
                "\"addr\":\"docker_container.inference_qwen\"},\"action\":\"create\"}}\n"
            )
            .as_bytes(),
        );
        ui.finish().unwrap();
        let events = received.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert!(format!("{:?}", events[0]).contains("docker_container.inference_qwen"));
        assert!(!format!("{:?}", events[0]).contains("secret-sentinel"));
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
                address: None,
                action: "create",
                status: "waiting",
                elapsed: std::time::Duration::from_secs(30)
            }]
        );
    }

    #[test]
    fn unsafe_addresses_keep_operation_visible_without_exposing_values() {
        for address in [
            "nemoclaw_sandbox.\u{1b}[31msecret-sentinel",
            "nemoclaw_sandbox.assistant[\"secret-sentinel\"]",
            "secret-sentinel",
            "different_kind.secret-sentinel",
            &format!("nemoclaw_sandbox.{}", "s".repeat(1024)),
        ] {
            let received = Arc::new(Mutex::new(Vec::new()));
            let events = received.clone();
            let mut ui = Ui::new(Arc::new(move |event| events.lock().unwrap().push(event)));
            ui.feed(b"{\"type\":\"version\",\"ui\":\"1.0\"}\n");
            ui.feed(
                serde_json::json!({
                    "type":"apply_errored", "hook": {
                        "resource":{"resource_type":"nemoclaw_sandbox", "addr":address},
                        "action":"create"
                    }
                })
                .to_string()
                .as_bytes(),
            );
            ui.finish().unwrap();
            assert!(matches!(
                received.lock().unwrap().as_slice(),
                [Progress::Resource {
                    address: None,
                    status: "failed",
                    ..
                }]
            ));
            assert!(!format!("{:?}", received.lock().unwrap()).contains("secret-sentinel"));
        }
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
