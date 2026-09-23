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
fn panel_grows_for_active_work_and_cleanup_places_results_next_to_milestones() {
    let now = Instant::now();
    let mut model = Model::default();
    assert_eq!(panel_height(&model, now, 80, 24), 1);
    model.observe(resource("alpha", "started"), false, now);
    assert_eq!(panel_height(&model, now, 80, 24), 2);
    model.observe(resource("beta", "started"), false, now);
    assert_eq!(panel_height(&model, now, 80, 24), 3);
    assert!(panel_height(&model, now, 20, 24) > 3);
    model.observe(resource("alpha", "complete"), false, now);
    model.observe(resource("beta", "complete"), false, now);
    assert_eq!(panel_height(&model, now, 80, 24), 1);

    let mut backend = TestBackend::new(80, 24);
    backend.set_cursor_position((0, 5)).unwrap();
    let mut terminal = Terminal::with_options(
        backend,
        TerminalOptions {
            viewport: Viewport::Inline(3),
        },
    )
    .unwrap();
    insert_line(
        &mut terminal,
        "sandbox/alpha: create complete",
        Palette::default(),
        Tone::Success,
    )
    .unwrap();
    // Finish before the next throttled draw, as happens with fast completions.
    clear_panel(&mut terminal).unwrap();
    let result_row = terminal.backend_mut().get_cursor_position().unwrap().y;
    let previous_row: String = (0..80)
        .map(|x| terminal.backend().buffer()[(x, result_row - 1)].symbol())
        .collect();
    assert!(
        previous_row.contains("sandbox/alpha: create complete"),
        "{previous_row}"
    );
}

#[test]
fn interactive_starts_stay_transient_while_plain_output_and_failures_remain_durable() {
    let start = resource("alpha", "started");
    assert!(render(start.clone(), false).unwrap().contains("started"));
    assert!(!durable_event(&start));
    for status in ["complete", "failed", "errored"] {
        assert!(durable_event(&resource("alpha", status)));
    }
    let mut model = Model::default();
    model.observe(Progress::Planning, false, Instant::now());
    assert_eq!(model.lines(Instant::now()), ["Planning deployment"]);
}

/// Process fixture for visual replay as well as the automated stream assertions below.
/// These are simulated SDK events; no deployment or runtime resources are created.
#[cfg(unix)]
#[test]
fn partial_failure_and_interruption_preserve_completed_milestones() {
    use std::{
        fs::File,
        io::Read,
        process::{Command, Stdio},
    };
    const SCENARIO: &str = "NEMOCLAW_TEST_PROGRESS_SCENARIO";
    if let Ok(scenario) = std::env::var(SCENARIO) {
        use clap::Parser;
        let cli = crate::args::Cli::parse_from(["nemoclaw", "apply", "配置.yaml"]);
        let context = crate::formatting::RenderContext::new(&cli);
        let mut reporter = Reporter::new(ProgressMode::Auto, false, context.header());
        let send = reporter.callback();
        let pause = Duration::from_millis(
            std::env::var("NEMOCLAW_TEST_PROGRESS_DELAY_MS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(20),
        );
        send(Progress::Applying);
        send(resource("alpha", "started"));
        thread::sleep(pause);
        send(resource("alpha", "complete"));
        send(resource("beta", "started"));
        thread::sleep(pause);
        if scenario == "failed" {
            send(resource("beta", "failed"));
        }
        send(Progress::Completed {
            operation: "tofu.apply",
            elapsed: pause * 2,
            outcome: if scenario == "failed" {
                StepOutcome::Failed
            } else {
                StepOutcome::Cancelled
            },
        });
        reporter.finish();
        let error: Box<dyn std::error::Error> = if scenario == "failed" {
            Box::new(io::Error::other(
                "Fixture: sandbox/beta startup failed after sandbox/alpha completed.",
            ))
        } else {
            Box::new(nemoclaw_sdk::Error::Cancelled)
        };
        eprint!(
            "{}",
            crate::formatting::render_error(
                error.as_ref(),
                crate::args::OutputFormat::Text,
                &context
            )
        );
        return;
    }
    for columns in [32, 80] {
        for scenario in ["failed", "interrupted"] {
            let pty = nix::pty::openpty(
                Some(&nix::pty::Winsize {
                    ws_row: 30,
                    ws_col: columns,
                    ws_xpixel: 0,
                    ws_ypixel: 0,
                }),
                None,
            )
            .unwrap();
            let reader = thread::spawn(move || {
                let mut source = File::from(pty.master);
                let mut bytes = Vec::new();
                let mut chunk = [0; 4096];
                while let Ok(count) = source.read(&mut chunk) {
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                }
                String::from_utf8(bytes).unwrap()
            });
            let output = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "progress::tests::partial_failure_and_interruption_preserve_completed_milestones", "--nocapture"])
                .env(SCENARIO, scenario).env("TERM", "xterm-256color").env("NO_COLOR", "1")
                .stdin(Stdio::null()).stderr(Stdio::from(File::from(pty.slave))).output().unwrap();
            let transcript = reader.join().unwrap();
            assert!(output.status.success(), "{transcript}");
            assert!(transcript.contains("alpha"), "{transcript}");
            // Repainting continuation cells inserts cursor moves/spaces inside this filename.
            assert!(transcript.contains("配置.yaml"), "{transcript}");
            assert!(transcript.contains("create complete"), "{transcript}");
            assert!(
                transcript.contains(&format!("Apply {scenario}")),
                "{transcript}"
            );
            assert!(
                transcript.contains("preserve the deployment state"),
                "{transcript}"
            );
            assert!(!transcript.contains("Apply complete"), "{transcript}");
            assert!(!transcript.contains("\x1b[2J") && !transcript.contains("\x1b[6n"));
        }
    }
}
