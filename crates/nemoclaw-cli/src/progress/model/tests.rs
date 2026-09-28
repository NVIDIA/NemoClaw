// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::progress::tests::resource;
use nemoclaw_sdk::ByteProgress;

fn render(event: Progress, verbose: bool) -> Option<String> {
    Model::default()
        .observe(event, verbose, Instant::now())
        .map(|milestone| milestone.text)
}

#[test]
fn long_waits_are_readable_and_external_labels_cannot_control_the_terminal() {
    let waiting = render(
        Progress::Waiting {
            operation: "runtime.ready",
            elapsed: Duration::from_secs(650),
        },
        false,
    )
    .unwrap();
    assert!(waiting.contains("10m 50s"), "{waiting}");
    let output = render(
        Progress::Download(DownloadProgress {
            resource: "image\x1b[2J".into(),
            artifact: "model\nforged".into(),
            layer: None,
            phase: DownloadPhase::Starting,
            bytes: None,
        }),
        false,
    )
    .unwrap();
    assert!(
        !output.contains('\x1b') && !output.contains('\n'),
        "{output:?}"
    );
}

#[test]
fn downloads_preserve_measured_totals_without_flooding_logs() {
    let now = Instant::now();
    let mut model = Model::default();
    let mut download = DownloadProgress {
        resource: "image.chat".into(),
        artifact: "model".into(),
        layer: Some("sha256:abc".into()),
        phase: DownloadPhase::Downloading,
        bytes: Some(ByteProgress {
            completed: 50,
            total: Some(100),
        }),
    };
    let first = model
        .observe(Progress::Download(download.clone()), false, now)
        .unwrap();
    assert!(first.text.contains("50%") && first.text.contains("50 B / 100 B"));
    download.bytes.as_mut().unwrap().completed = 60;
    assert!(
        model
            .observe(Progress::Download(download.clone()), false, now)
            .is_none()
    );
    assert!(model.lines(now)[0].contains("60%"));
    download.bytes.as_mut().unwrap().total = None;
    assert!(
        !render(Progress::Download(download.clone()), false)
            .unwrap()
            .contains('%')
    );
    download.phase = DownloadPhase::Complete;
    assert!(
        model
            .observe(Progress::Download(download), false, now)
            .unwrap()
            .text
            .contains("finished layer")
    );
    assert!(model.lines(now).is_empty());
}

#[test]
fn completion_preserves_actual_failure_and_cancellation_without_verbose_mode() {
    for (outcome, expected) in [
        (StepOutcome::Succeeded, "complete"),
        (StepOutcome::Failed, "failed"),
        (StepOutcome::Cancelled, "cancelled"),
    ] {
        let output = render(
            Progress::Completed {
                operation: "runtime.ready",
                elapsed: Duration::from_millis(125),
                outcome,
            },
            false,
        )
        .unwrap();
        assert!(output.contains(expected));
    }
}

#[test]
fn default_progress_hides_known_supporting_reads_but_preserves_failures_and_unknown_resources() {
    for address in [
        "data.docker_image.image_abcd",
        "data.nemoclaw_gateway_capabilities.current",
        "nemoclaw_provider_profile.inference_hosted",
    ] {
        let event = Progress::Resource {
            resource: "resource",
            address: Some(address.into()),
            action: "read",
            status: "complete",
            elapsed: Duration::ZERO,
        };
        assert!(render(event.clone(), false).is_none(), "{address}");
        assert!(render(event, true).unwrap().contains(address));
        let failure = Progress::Resource {
            resource: "resource",
            address: Some(address.into()),
            action: "read",
            status: "failed",
            elapsed: Duration::ZERO,
        };
        assert!(render(failure, false).unwrap().contains("failed"));
    }
    assert!(
        render(
            Progress::Resource {
                resource: "resource",
                address: Some("future_resource.unknown".into()),
                action: "read",
                status: "complete",
                elapsed: Duration::ZERO
            },
            false
        )
        .unwrap()
        .contains("future_resource.unknown")
    );
    assert!(
        render(
            Progress::Completed {
                operation: "tofu.init",
                elapsed: Duration::ZERO,
                outcome: StepOutcome::Succeeded
            },
            false
        )
        .is_none()
    );
}

#[test]
fn interactive_starts_stay_transient_while_plain_output_and_failures_remain_durable() {
    let start = resource("alpha", "started");
    assert!(render(start.clone(), false).unwrap().contains("started"));
    assert!(
        !Model::default()
            .observe(start, false, Instant::now())
            .unwrap()
            .durable
    );
    for status in ["complete", "failed", "errored"] {
        assert!(
            Model::default()
                .observe(resource("alpha", status), false, Instant::now())
                .unwrap()
                .durable
        );
    }
    let mut model = Model::default();
    model.observe(Progress::Planning, false, Instant::now());
    assert_eq!(model.lines(Instant::now()), ["Planning deployment"]);
}

#[test]
fn concurrent_download_labels_with_separators_do_not_alias() {
    let now = Instant::now();
    let mut model = Model::default();
    let download = |resource: &str, artifact: &str, phase| {
        Progress::Download(DownloadProgress {
            resource: resource.into(),
            artifact: artifact.into(),
            layer: None,
            phase,
            bytes: None,
        })
    };
    model.observe(
        download("image:a", "b", DownloadPhase::Downloading),
        false,
        now,
    );
    model.observe(
        download("image", "a:b", DownloadPhase::Downloading),
        false,
        now,
    );
    assert_eq!(
        model.lines(now).len(),
        2,
        "distinct downloads must both remain visible"
    );
    model.observe(
        download("image:a", "b", DownloadPhase::Complete),
        false,
        now,
    );
    let lines = model.lines(now);
    assert_eq!(lines.len(), 1);
    assert!(lines[0].contains("image: downloading a:b"), "{lines:?}");
}

#[test]
fn graph_completion_settles_resources_and_downloads_but_preserves_other_waits() {
    for outcome in [
        StepOutcome::Succeeded,
        StepOutcome::Failed,
        StepOutcome::Cancelled,
    ] {
        let mut model = Model::default();
        let now = Instant::now();
        model.observe(resource("alpha", "started"), false, now);
        model.observe(
            Progress::Waiting {
                operation: "runtime.ready",
                elapsed: Duration::ZERO,
            },
            false,
            now,
        );
        model.observe(
            Progress::Download(DownloadProgress {
                resource: "image".into(),
                artifact: "model".into(),
                layer: None,
                phase: DownloadPhase::Downloading,
                bytes: None,
            }),
            false,
            now,
        );
        let milestone = model.observe(
            Progress::Completed {
                operation: "tofu.apply",
                elapsed: Duration::from_secs(2),
                outcome,
            },
            false,
            now,
        );
        assert_eq!(
            model.lines(now),
            ["Waiting for gateway and inference readiness · elapsed <1s"]
        );
        match outcome {
            StepOutcome::Succeeded => assert!(milestone.is_none()),
            StepOutcome::Failed => {
                let milestone = milestone.unwrap();
                assert!(milestone.durable && matches!(milestone.tone, Tone::Error));
                assert!(milestone.text.contains("failed"));
            }
            StepOutcome::Cancelled => {
                let milestone = milestone.unwrap();
                assert!(milestone.durable && matches!(milestone.tone, Tone::Warning));
                assert!(milestone.text.contains("cancelled"));
            }
        }
    }
}
