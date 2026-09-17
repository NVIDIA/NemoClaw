// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::Progress;
use std::time::Duration;

fn duration(elapsed: Duration) -> String {
    if elapsed < Duration::from_secs(1) {
        format!("{}ms", elapsed.as_millis())
    } else {
        format!(
            "{}s",
            format!("{:.3}", elapsed.as_secs_f64())
                .trim_end_matches('0')
                .trim_end_matches('.')
        )
    }
}

pub(crate) fn render(event: Progress, verbose: bool) -> Option<String> {
    match event {
        Progress::Resource {
            resource,
            action,
            status,
            elapsed,
        } => Some(if status == "started" {
            format!("{resource}: {action} {status}")
        } else {
            format!("{resource}: {action} {status} ({})", duration(elapsed))
        }),
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
            Some(if elapsed.as_millis() == 0 {
                label.into()
            } else {
                format!("{label} ({})", duration(elapsed))
            })
        }
        Progress::Completed {
            operation,
            elapsed,
            outcome,
        } if verbose => Some(format!("{operation} {outcome} {}", duration(elapsed))),
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
    fn quick_operations_report_measured_milliseconds() {
        assert_eq!(
            render(
                Progress::Resource {
                    resource: "sandbox",
                    action: "create",
                    status: "complete",
                    elapsed: Duration::from_millis(125)
                },
                false
            )
            .unwrap(),
            "sandbox: create complete (125ms)"
        );
        assert_eq!(
            render(
                Progress::Waiting {
                    operation: "sandbox.ready",
                    elapsed: Duration::ZERO
                },
                false
            )
            .unwrap(),
            "Waiting for sandbox readiness"
        );
        assert_eq!(
            render(
                Progress::Completed {
                    operation: "sandbox.ready",
                    elapsed: Duration::from_millis(250),
                    outcome: nemoclaw_sdk::StepOutcome::Succeeded
                },
                true
            )
            .unwrap(),
            "sandbox.ready succeeded 250ms"
        );
    }

    #[test]
    fn ordinary_progress_describes_resources_and_readiness_but_timings_are_verbose() {
        assert_eq!(
            render(
                Progress::Resource {
                    resource: "sandbox",
                    action: "create",
                    status: "waiting",
                    elapsed: std::time::Duration::from_secs(20)
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
        assert_eq!(render(done, true).unwrap(), "tofu.apply succeeded 1s");
    }
}
