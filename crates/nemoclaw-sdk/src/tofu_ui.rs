// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Bounded adapter for OpenTofu's versioned, newline-delimited UI protocol.
use crate::Progress;
use serde_json::Value;
use std::sync::Arc;

pub(crate) struct Ui {
    line: Vec<u8>,
    version: bool,
    invalid: bool,
    progress: Arc<dyn Fn(Progress) + Send + Sync>,
}
impl Ui {
    pub(crate) fn new(progress: Arc<dyn Fn(Progress) + Send + Sync>) -> Self {
        Self {
            line: Vec::new(),
            version: false,
            invalid: false,
            progress,
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
        let resource = match value["hook"]["resource"]["resource_type"].as_str() {
            Some("nemoclaw_workspace") => "workspace",
            Some("nemoclaw_sandbox") => "sandbox",
            Some("nemoclaw_provider") => "provider",
            Some("nemoclaw_provider_profile") => "provider profile",
            Some("nemoclaw_managed_gateway") => "gateway",
            Some("nemoclaw_inference_service") => "inference service",
            _ => return,
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
        (self.progress)(Progress::Resource {
            resource,
            action,
            status,
            elapsed_seconds: value["hook"]["elapsed_seconds"].as_u64().unwrap_or(0),
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
                elapsed_seconds: 30
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
