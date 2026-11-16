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

const UUID: &str = "GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH fixture"]
async fn named_gpus_reach_docker_as_one_request_and_read_back_unchanged() {
    for (gpus, device_ids) in [
        (format!("device={UUID}"), json!([UUID])),
        ("device=1".to_owned(), json!(["1"])),
        (format!("device=1,{UUID}"), json!(["1", UUID])),
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
        assert_eq!(requests[0]["Count"], 0, "{gpus}: {requests}");
        assert_eq!(
            requests[0]["Capabilities"],
            json!([["gpu"]]),
            "{gpus}: {requests}"
        );
        let changes = s.plan();
        assert_eq!(
            current(&changes)["change"]["actions"],
            json!(["no-op"]),
            "{gpus}"
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH fixture"]
async fn changing_the_gpu_list_replaces_the_container() {
    let one = container("device=0");
    let s = Scenario::with(&one);
    s.tofu(&["apply", "-input=false", "-auto-approve", "-no-color"]);
    let mut body = one;
    for ids in [vec!["0", UUID], vec!["2", "0", "1"]] {
        // Docker can't move a container to other GPUs, so adding a GPU to one
        // or changing a list replaces the container.
        let next = container(&format!("device={}", ids.join(",")));
        s.reconfigure(&body, &next);
        body = next;
        let changes = s.plan();
        assert_eq!(
            current(&changes)["change"]["actions"],
            json!(["delete", "create"]),
            "{ids:?}"
        );
        s.tofu(&["apply", "-input=false", "-auto-approve", "-no-color"]);
        let engine = read(s.root(), "engine.json");
        let requests = &engine["container"]["HostConfig"]["DeviceRequests"];
        assert_eq!(requests[0]["DeviceIDs"], json!(ids), "{ids:?}: {requests}");
        let changes = s.plan();
        assert_eq!(
            current(&changes)["change"]["actions"],
            json!(["no-op"]),
            "{ids:?}"
        );
    }
}
