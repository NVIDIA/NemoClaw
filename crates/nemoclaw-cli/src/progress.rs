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

fn byte_count(bytes: u64) -> String {
    for (unit, divisor) in [("GiB", 1_u64 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)] {
        if bytes >= divisor {
            return format!("{:.1} {unit}", bytes as f64 / divisor as f64);
        }
    }
    format!("{bytes} B")
}

pub(crate) fn render(event: Progress, verbose: bool) -> Option<String> {
    match event {
        Progress::Download(event) => {
            use nemoclaw_sdk::DownloadPhase;
            let phase = match event.phase {
                DownloadPhase::Starting => "starting download of",
                DownloadPhase::Downloading => "downloading",
                DownloadPhase::Extracting => "extracting",
                DownloadPhase::Verifying => "verifying",
                DownloadPhase::Complete if event.layer.is_none() => "downloaded",
                DownloadPhase::Complete => "finished layer of",
            };
            let mut text = format!("{}: {phase} {}", event.resource, event.artifact);
            if let Some(layer) = event.layer {
                text.push_str(&format!(" [{layer}]"));
            }
            if let Some(bytes) = event.bytes {
                if let Some(total) = bytes
                    .total
                    .filter(|total| *total > 0 && bytes.completed <= *total)
                {
                    let percent = u128::from(bytes.completed) * 100 / u128::from(total);
                    text.push_str(&format!(
                        " {percent}% ({} / {})",
                        byte_count(bytes.completed),
                        byte_count(total)
                    ));
                } else {
                    text.push_str(&format!(" {}", byte_count(bytes.completed)));
                }
            }
            Some(text)
        }
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
        Progress::Validating => Some("Checking deployment configuration".into()),
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
    fn downloads_show_layer_percentages_and_handle_unknown_totals() {
        use nemoclaw_sdk::{ByteProgress, DownloadPhase, DownloadProgress};
        let mut download = DownloadProgress {
            resource: "model_snapshot.chat".into(),
            artifact: "llama3:latest".into(),
            layer: Some("sha256:abc".into()),
            phase: DownloadPhase::Downloading,
            bytes: Some(ByteProgress {
                completed: 50,
                total: Some(100),
            }),
        };
        assert_eq!(
            render(Progress::Download(download.clone()), false).unwrap(),
            "model_snapshot.chat: downloading llama3:latest [sha256:abc] 50% (50 B / 100 B)"
        );
        download.bytes.as_mut().unwrap().total = Some(0);
        assert_eq!(
            render(Progress::Download(download.clone()), false).unwrap(),
            "model_snapshot.chat: downloading llama3:latest [sha256:abc] 50 B"
        );
        download.layer = None;
        download.phase = DownloadPhase::Complete;
        download.bytes = None;
        assert_eq!(
            render(Progress::Download(download), false).unwrap(),
            "model_snapshot.chat: downloaded llama3:latest"
        );
    }

    #[test]
    fn validation_progress_describes_configuration_checks() {
        assert_eq!(
            render(Progress::Validating, false).as_deref(),
            Some("Checking deployment configuration")
        );
    }

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
        assert!(render(done.clone(), false).is_none());
        assert_eq!(render(done, true).unwrap(), "tofu.apply succeeded 1s");
    }
}
