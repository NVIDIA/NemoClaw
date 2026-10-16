// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{deploy, spec};
use nemoclaw_sdk::ObservationError;
use serde_json::json;

#[tokio::test]
async fn unchanged_apply_preserves_running_and_pending_pods_and_saved_bindings() {
    for backend in ["vllm", "ollama"] {
        let spec = spec(backend, backend == "vllm");
        let (deployed, first) = deploy(&spec).await;
        for phase in ["Running", "Pending"] {
            let (objects, directory, operations) = deployed.restore();
            let mut pod = objects.get("v1", "Pod", "agents", &spec.name).unwrap();
            pod["status"] = json!({"phase": phase});
            objects.insert(pod);
            let before = objects.0.lock().unwrap().clone();
            let receipt = directory
                .path()
                .join("services")
                .join(&spec.name)
                .join("receipt.json");
            let saved = std::fs::read(&receipt).unwrap();

            for _ in 0..2 {
                let result = operations.ensure(&spec, first.id.as_deref()).await;
                if phase == "Running" {
                    // The fake has no runtime status evidence. The final readiness
                    // observation must preserve the existing workload and binding.
                    assert_eq!(result, Err(ObservationError::Incomplete));
                } else {
                    let result = result.unwrap();
                    assert_eq!(result.id, first.id);
                    assert_eq!(result.running, Some(false));
                }
                assert_eq!(*objects.0.lock().unwrap(), before, "{backend} {phase}");
                assert_eq!(std::fs::read(&receipt).unwrap(), saved, "{backend} {phase}");
            }
        }
    }
}
