// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! An apply that OpenTofu completes succeeds when OpenTofu's final `outputs`
//! message is longer than the 1 MiB the UI adapter reads of a line. That
//! message carries every root output's value; in a recorded run, discovery
//! took about 8.9 KB per OpenClaw sandbox, passing 1 MiB at about 118. The SDK
//! reads discovery from the saved plan, never from that message. Scripted
//! OpenTofu prints it.

#![cfg(unix)]

use crate::scripted_tofu::{Scripted, placeholder_generations, plan_json};
use nemoclaw_sdk::{CancellationToken, compile, config::Document};
use serde_json::json;

/// OpenTofu's final `outputs` message, one line, with a discovery value of
/// `bytes` bytes.
fn outputs_message(bytes: usize) -> String {
    let message = json!({
        "@level": "info",
        "@message": "Outputs: 1",
        "@module": "tofu.ui",
        "@timestamp": "2026-11-16T00:00:00.000000Z",
        "outputs": {"discovery": {"sensitive": false, "type": "string", "value": "x".repeat(bytes)}},
        "type": "outputs"
    });
    format!("{message}\n")
}

#[tokio::test]
async fn an_apply_succeeds_when_opentofu_reports_more_than_a_mebibyte_of_outputs() {
    let scripted = Scripted::new();
    let document = Document::parse(
        serde_json::to_vec(&crate::support::fixture("local.yaml"))
            .unwrap()
            .as_slice(),
    )
    .unwrap();
    let targets = compile::targets(&document, &placeholder_generations()).unwrap();
    scripted.set("root.apply.plan", plan_json(&targets, "create"));
    // 256 sandboxes printed about 2.2 MiB in the recorded run.
    scripted.set("root.outputs", outputs_message(2 * 1024 * 1024));

    scripted
        .deployment(&scripted.path("unused-kubeconfig"))
        .apply(&document, &CancellationToken::new())
        .await
        .expect("an apply that OpenTofu completed with a long outputs message");
}
