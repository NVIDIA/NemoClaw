// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::inline::{clear_panel, draw, draw_due, insert_header, insert_line, panel_height};
use super::*;
use crate::style::{Palette, Tone};
use nemoclaw_sdk::StepOutcome;
use ratatui::{Terminal, TerminalOptions, Viewport, backend::Backend};

use ratatui::backend::TestBackend;

pub(super) fn resource(name: &str, status: &'static str) -> Progress {
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
    draw(
        &mut terminal,
        &model.lines(now),
        Palette::default(),
        Duration::ZERO,
    )
    .unwrap();
    let text = contents(&terminal);
    assert!(
        text.contains("sandbox/alpha") && text.contains("sandbox/beta"),
        "{text}"
    );
    let failure = model
        .observe(resource("alpha", "failed"), false, now)
        .unwrap();
    assert!(failure.text.contains("failed"));
    insert_line(
        &mut terminal,
        &failure.text,
        Palette::default(),
        Tone::Error,
    )
    .unwrap();
    draw(
        &mut terminal,
        &model.lines(now),
        Palette::default(),
        Duration::ZERO,
    )
    .unwrap();
    assert_eq!(model.lines(now).len(), 1);
    assert!(contents(&terminal).contains("failed"));
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
    draw(
        &mut terminal,
        &model.lines(now),
        Palette::default(),
        Duration::from_secs(31),
    )
    .unwrap();
    assert!(contents(&terminal).contains("more active"));
    for (width, height) in [(12, 4), (1, 1), (0, 0), (80, 12)] {
        terminal.backend_mut().resize(width, height);
        draw(
            &mut terminal,
            &model.lines(now),
            Palette::default(),
            Duration::ZERO,
        )
        .unwrap();
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
    draw_due(
        &mut terminal,
        &model.lines(now),
        Palette::default(),
        now,
        Duration::ZERO,
        &mut next_frame,
    )
    .unwrap();
    assert!(contents(&terminal).contains("alpha"));
    model.observe(resource("beta", "started"), false, now);
    for millis in 1..250 {
        draw_due(
            &mut terminal,
            &model.lines(now),
            Palette::default(),
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
    insert_line(
        &mut terminal,
        &failure.text,
        Palette::default(),
        Tone::Error,
    )
    .unwrap();
    assert!(
        contents(&terminal).contains("failed"),
        "failure must remain immediate even between frames"
    );
    draw_due(
        &mut terminal,
        &model.lines(now),
        Palette::default(),
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
        false,
    )
    .unwrap();
    draw(&mut terminal, &[], Palette::default(), Duration::ZERO).unwrap();
    let text = contents(&terminal);
    assert!(text.contains("NVIDIA / NemoClaw"), "{text}");
    assert!(text.contains("Plan · demo.yaml"), "{text}");
    assert!(text.contains("State: state"), "{text}");
}

#[test]
fn panel_grows_for_active_work_and_cleanup_places_results_next_to_milestones() {
    let now = Instant::now();
    let mut model = Model::default();
    assert_eq!(panel_height(&model.lines(now), 80, 24), 1);
    model.observe(resource("alpha", "started"), false, now);
    assert_eq!(panel_height(&model.lines(now), 80, 24), 2);
    model.observe(resource("beta", "started"), false, now);
    assert_eq!(panel_height(&model.lines(now), 80, 24), 3);
    assert!(panel_height(&model.lines(now), 20, 24) > 3);
    model.observe(resource("alpha", "complete"), false, now);
    model.observe(resource("beta", "complete"), false, now);
    assert_eq!(panel_height(&model.lines(now), 80, 24), 1);

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
        eprint!("Previous shell output\r\n$ nemoclaw apply 配置.yaml\r\n");
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
            let mut terminal = vt100::Parser::new(30, columns, 100);
            terminal.process(transcript.as_bytes());
            let screen = terminal.screen().contents();
            assert!(screen.contains("Previous shell output"), "{screen}");
            assert!(screen.contains("配置.yaml"), "{screen}");
            assert!(screen.contains("create complete"), "{screen}");
            assert!(screen.contains(&format!("Apply {scenario}")), "{screen}");
            assert!(!screen.contains("Elapsed:"), "stale panel: {screen}");
            assert!(!terminal.screen().hide_cursor());

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
