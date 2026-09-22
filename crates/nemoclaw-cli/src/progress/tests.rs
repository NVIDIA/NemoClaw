// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use nemoclaw_sdk::{ByteProgress, DownloadProgress};
use ratatui::backend::TestBackend;

fn resource(name: &str, status: &'static str) -> Progress {
    Progress::Resource {
        resource: "sandbox",
        address: Some(format!("nemoclaw_sandbox.{name}")),
        action: "create",
        status,
        elapsed: Duration::ZERO,
    }
}
fn contents(terminal: &Terminal<TestBackend>) -> String {
    terminal
        .backend()
        .buffer()
        .content
        .iter()
        .map(|cell| cell.symbol())
        .collect()
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
fn concurrent_resources_stay_distinct_and_failures_leave_the_active_panel() {
    let now = Instant::now();
    let mut model = Model::default();
    assert!(
        model
            .observe(resource("alpha", "started"), false, now)
            .is_some()
    );
    assert!(
        model
            .observe(resource("beta", "started"), false, now)
            .is_some()
    );
    let mut terminal = Terminal::with_options(
        TestBackend::new(70, 12),
        TerminalOptions {
            viewport: Viewport::Inline(8),
        },
    )
    .unwrap();
    draw(&mut terminal, &model, now, Duration::ZERO).unwrap();
    let text = contents(&terminal);
    assert!(
        text.contains("sandbox/alpha") && text.contains("sandbox/beta"),
        "{text}"
    );
    let failure = model
        .observe(resource("alpha", "failed"), false, now)
        .unwrap();
    assert!(failure.contains("failed"));
    insert_line(&mut terminal, &failure, Palette::default(), Tone::Error).unwrap();
    draw(&mut terminal, &model, now, Duration::ZERO).unwrap();
    assert_eq!(model.active.len(), 1);
    assert!(contents(&terminal).contains("failed"));
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
    assert!(first.contains("50%") && first.contains("50 B / 100 B"));
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
            .contains("finished layer")
    );
    assert!(model.active.is_empty());
}
#[test]
fn narrow_panel_reports_overflow_and_tiny_terminals_are_safe() {
    let now = Instant::now();
    let mut model = Model::default();
    for name in ["alpha", "beta", "gamma", "delta", "epsilon"] {
        model.observe(resource(name, "started"), false, now);
    }
    let mut terminal = Terminal::with_options(
        TestBackend::new(30, 8),
        TerminalOptions {
            viewport: Viewport::Inline(8),
        },
    )
    .unwrap();
    draw(&mut terminal, &model, now, Duration::from_secs(31)).unwrap();
    assert!(contents(&terminal).contains("more active"));
    for (width, height) in [(12, 4), (1, 1), (0, 0), (80, 12)] {
        terminal.backend_mut().resize(width, height);
        draw(&mut terminal, &model, now, Duration::ZERO).unwrap();
    }
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
fn off_and_unused_reporters_finish_without_consuming_input_or_waiting_for_callbacks() {
    for mode in [ProgressMode::Off, ProgressMode::Auto] {
        let mut reporter = Reporter::new(mode, false, "Header".into());
        let callback = reporter.callback();
        reporter.finish();
        callback(Progress::Validating);
        reporter.finish();
    }
}

#[test]
fn event_bursts_update_the_panel_at_most_four_times_per_second_without_delaying_failures() {
    let now = Instant::now();
    let mut next_frame = now;
    let mut model = Model::default();
    model.observe(resource("alpha", "started"), false, now);
    let mut terminal = Terminal::with_options(
        TestBackend::new(80, 12),
        TerminalOptions {
            viewport: Viewport::Inline(8),
        },
    )
    .unwrap();
    draw_due(&mut terminal, &model, now, Duration::ZERO, &mut next_frame).unwrap();
    assert!(contents(&terminal).contains("alpha"));
    model.observe(resource("beta", "started"), false, now);
    for millis in 1..250 {
        draw_due(
            &mut terminal,
            &model,
            now + Duration::from_millis(millis),
            Duration::ZERO,
            &mut next_frame,
        )
        .unwrap();
    }
    assert!(
        !contents(&terminal).contains("beta"),
        "burst must not force extra panel redraws"
    );
    let failure = model
        .observe(resource("alpha", "failed"), false, now)
        .unwrap();
    insert_line(&mut terminal, &failure, Palette::default(), Tone::Error).unwrap();
    assert!(
        contents(&terminal).contains("failed"),
        "failure must remain immediate even between frames"
    );
    draw_due(
        &mut terminal,
        &model,
        now + Duration::from_millis(250),
        Duration::ZERO,
        &mut next_frame,
    )
    .unwrap();
    assert!(
        contents(&terminal).contains("beta"),
        "latest state appears on next frame"
    );
}

#[test]
fn startup_wordmark_remains_above_the_first_progress_frame() {
    let mut terminal = Terminal::with_options(
        TestBackend::new(80, 24),
        TerminalOptions {
            viewport: Viewport::Inline(8),
        },
    )
    .unwrap();
    insert_header(
        &mut terminal,
        "Plan · demo.yaml\nState: state",
        Palette { enabled: true },
    )
    .unwrap();
    draw(
        &mut terminal,
        &Model::default(),
        Instant::now(),
        Duration::ZERO,
    )
    .unwrap();
    let text = contents(&terminal);
    assert!(text.contains("NVIDIA / NemoClaw"), "{text}");
    assert!(text.contains("Plan · demo.yaml"), "{text}");
    assert!(text.contains("State: state"), "{text}");
}
