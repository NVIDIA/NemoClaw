// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::Progress;

pub(crate) fn render(event: Progress, verbose: bool) -> Option<String> {
    match event {
        Progress::Resource {
            resource,
            action,
            status,
            elapsed_seconds,
        } => Some(format!(
            "{resource}: {action} {status} ({elapsed_seconds}s)"
        )),
        Progress::Waiting { operation, elapsed } => {
            let label = match operation {
                "tofu.init" => "Initializing infrastructure",
                "tofu.plan" => "Planning infrastructure changes",
                "tofu.apply" => "Applying infrastructure changes",
                "runtime.ready" => "Waiting for gateway and inference readiness",
                "sandbox.ready" => "Waiting for sandbox readiness",
                "fabric.health" => "Checking hosted Fabric health",
                _ if verbose => operation,
                _ => return None,
            };
            Some(format!("{label} ({}s)", elapsed.as_secs()))
        }
        Progress::Completed {
            operation,
            elapsed,
            outcome,
        } if verbose => Some(format!(
            "{operation} {outcome} {:.3}s",
            elapsed.as_secs_f64()
        )),
        Progress::Preflight => Some("Checking deployment prerequisites".into()),
        Progress::Exporting => Some("Reading deployed configuration".into()),
        Progress::Destroying => Some("Destroying owned workloads".into()),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    #[test]
    fn ordinary_progress_describes_resources_and_readiness_but_timings_are_verbose() {
        assert_eq!(
            render(
                Progress::Resource {
                    resource: "sandbox",
                    action: "create",
                    status: "waiting",
                    elapsed_seconds: 20
                },
                false
            )
            .unwrap(),
            "sandbox: create waiting (20s)"
        );
        assert_eq!(
            render(
                Progress::Waiting {
                    operation: "runtime.ready",
                    elapsed: Duration::from_secs(30)
                },
                false
            )
            .unwrap(),
            "Waiting for gateway and inference readiness (30s)"
        );
        let done = Progress::Completed {
            operation: "tofu.apply",
            elapsed: Duration::from_secs(1),
            outcome: nemoclaw_sdk::StepOutcome::Succeeded,
        };
        assert!(render(done, false).is_none());
        assert_eq!(render(done, true).unwrap(), "tofu.apply succeeded 1.000s");
    }
}
