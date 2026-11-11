// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The device requests the bundled Docker provider sends for the `gpus`
//! values the SDK writes for `container.gpuDevices`.

use crate::replacement_cleanup::{Scenario, current, read};
use serde_json::json;

fn container(gpus: &str) -> String {
    format!(
        "resource \"docker_container\" \"service\" {{\n  name  = \"service\"\n  image = \"runtime@sha256:{}\"\n  gpus  = \"{gpus}\"\n}}\n",
        "a".repeat(64)
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH fixture"]
async fn one_named_gpu_reaches_docker_and_a_device_list_does_not() {
    const UUID: &str = "GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3";
    for (gpus, device_ids, count) in [
        (format!("device={UUID}"), json!([UUID]), 0),
        ("device=1".to_owned(), json!(["1"]), 0),
        // Docker provider v4.6.0 splits the value on commas, so it reads the
        // second ID as a count, which Docker refuses beside device IDs. The
        // SDK refuses several devices instead of writing this value.
        ("device=0,1".to_owned(), json!(["0"]), 1),
    ] {
        let s = Scenario::with(&container(&gpus));
        s.tofu(&["apply", "-input=false", "-auto-approve", "-no-color"]);
        let engine = read(s.root(), "engine.json");
        let requests = &engine["container"]["HostConfig"]["DeviceRequests"];
        assert_eq!(
            requests.as_array().map(Vec::len),
            Some(1),
            "{gpus}: {requests}"
        );
        assert_eq!(requests[0]["DeviceIDs"], device_ids, "{gpus}: {requests}");
        assert_eq!(requests[0]["Count"], count, "{gpus}: {requests}");
        assert_eq!(
            requests[0]["Capabilities"],
            json!([["gpu"]]),
            "{gpus}: {requests}"
        );
        if count == 0 {
            // The provider reads the request back as the configured value.
            let changes = s.plan();
            assert_eq!(
                current(&changes)["change"]["actions"],
                json!(["no-op"]),
                "{gpus}"
            );
        }
    }
}
