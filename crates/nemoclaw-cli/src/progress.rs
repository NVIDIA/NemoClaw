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
        let output = render(Progress::Download(download.clone()), false).unwrap();
        for value in [&download.resource, &download.artifact] {
            assert!(output.contains(value));
        }
        for value in ["abc", "50%", "50 B", "100 B"] {
            assert!(output.contains(value));
        }
        for total in [None, Some(0)] {
            download.bytes.as_mut().unwrap().total = total;
            let unknown = render(Progress::Download(download.clone()), false).unwrap();
            assert!(unknown.contains("50 B"));
            assert!(!unknown.contains('%'));
        }
        let downloading = render(Progress::Download(download.clone()), false).unwrap();
        download.phase = DownloadPhase::Complete;
        let completed = render(Progress::Download(download.clone()), false).unwrap();
        assert_ne!(
            completed, downloading,
            "completion must be distinguishable from progress"
        );
        assert!(completed.contains(&download.resource) && completed.contains(&download.artifact));
        download.phase = DownloadPhase::Downloading;
        download.layer = None;
        assert!(
            !render(Progress::Download(download), false)
                .unwrap()
                .contains("abc")
        );
    }

    #[test]
    fn quick_operations_preserve_measured_duration_and_outcome() {
        let resource = render(
            Progress::Resource {
                resource: "sandbox",
                action: "create",
                status: "complete",
                elapsed: Duration::from_millis(125),
            },
            false,
        )
        .unwrap();
        for value in ["sandbox", "create", "complete", "125ms"] {
            assert!(resource.contains(value));
        }
        let completed = |outcome| Progress::Completed {
            operation: "sandbox.ready",
            elapsed: Duration::from_millis(250),
            outcome,
        };
        let success = render(completed(nemoclaw_sdk::StepOutcome::Succeeded), true).unwrap();
        assert!(success.contains("sandbox.ready") && success.contains("250ms"));
        assert_ne!(
            success,
            render(completed(nemoclaw_sdk::StepOutcome::Failed), true).unwrap()
        );
    }

    #[test]
    fn resource_waits_are_visible_but_operation_timings_require_verbose_output() {
        let waiting = render(
            Progress::Resource {
                resource: "sandbox",
                action: "create",
                status: "waiting",
                elapsed: Duration::from_secs(20),
            },
            false,
        )
        .unwrap();
        for value in ["sandbox", "waiting", "20s"] {
            assert!(waiting.contains(value));
        }
        for elapsed in [Duration::ZERO, Duration::from_secs(30)] {
            let message = render(
                Progress::Waiting {
                    operation: "runtime.ready",
                    elapsed,
                },
                false,
            )
            .unwrap();
            assert!(!message.is_empty());
            if !elapsed.is_zero() {
                assert!(message.contains("30s"));
            }
        }
        let done = Progress::Completed {
            operation: "tofu.apply",
            elapsed: Duration::from_secs(1),
            outcome: nemoclaw_sdk::StepOutcome::Succeeded,
        };
        assert!(render(done.clone(), false).is_none());
        let verbose = render(done, true).unwrap();
        assert!(verbose.contains("tofu.apply") && verbose.contains("1s"));
    }
}
