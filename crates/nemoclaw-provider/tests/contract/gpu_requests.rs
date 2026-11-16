// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The device requests the bundled Docker provider sends for the `gpus`
//! values and `device_requests` blocks the SDK writes for
//! `container.gpuDevices`.

use crate::replacement_cleanup::{Scenario, current, read};
use serde_json::json;

fn container(gpus: &str) -> String {
    format!(
        "resource \"docker_container\" \"service\" {{\n  name  = \"service\"\n  image = \"runtime@sha256:{}\"\n  gpus  = \"{gpus}\"\n}}\n",
        "a".repeat(64)
    )
}

/// A container with the device request block the SDK writes for several GPUs.
fn container_with_devices(ids: &[&str]) -> String {
    format!(
        "resource \"docker_container\" \"service\" {{\n  name  = \"service\"\n  image = \"runtime@sha256:{}\"\n  device_requests {{\n    driver       = \"nvidia\"\n    device_ids   = {}\n    capabilities = [\"gpu\"]\n  }}\n}}\n",
        "a".repeat(64),
        json!(ids)
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
        // SDK writes a `device_requests` block for several devices instead.
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated SSH fixture"]
async fn a_device_list_reaches_docker_as_one_nvidia_request_and_changes_replace_the_container() {
    const UUID: &str = "GPU-79b44e99-d10d-a381-8cd6-5ccb073eaea3";
    let one = container("device=0");
    let s = Scenario::with(&one);
    s.tofu(&["apply", "-input=false", "-auto-approve", "-no-color"]);
    let mut body = one;
    for ids in [vec!["0", UUID], vec!["0", "1", "2"]] {
        // Docker can't move a container to other GPUs, so adding a GPU to one
        // or changing a list replaces the container.
        let next = container_with_devices(&ids);
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
        assert_eq!(
            requests.as_array().map(Vec::len),
            Some(1),
            "{ids:?}: {requests}"
        );
        assert_eq!(requests[0]["Driver"], "nvidia", "{ids:?}: {requests}");
        // The block's `device_ids` is a set, so Docker receives the IDs in
        // the provider's order.
        let mut received: Vec<&str> = requests[0]["DeviceIDs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|id| id.as_str().unwrap())
            .collect();
        received.sort_unstable();
        let mut expected = ids.clone();
        expected.sort_unstable();
        assert_eq!(received, expected, "{requests}");
        assert_eq!(requests[0]["Count"], 0, "{ids:?}: {requests}");
        assert_eq!(
            requests[0]["Capabilities"],
            json!([["gpu"]]),
            "{ids:?}: {requests}"
        );
        // The provider reads the request back as the configured block.
        let changes = s.plan();
        assert_eq!(
            current(&changes)["change"]["actions"],
            json!(["no-op"]),
            "{ids:?}"
        );
    }
}
