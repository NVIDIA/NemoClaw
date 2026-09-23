// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Replay the real backend's PTY bytes through an independent terminal emulator.
//! Checkpoints synchronize resizing and assertions without wall-clock sleeps.
//! Short prior lines avoid relying on emulator-specific reflow of old scrollback.

use super::*;
use std::{
    fs::File,
    io::{Read, Write},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
};

fn text(screen: &vt100::Screen) -> String {
    screen
        .contents()
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
}

const CHECKPOINT: &[u8] = b"\x1b]777;checkpoint\x07";

fn checkpoint() {
    let mut output = io::stderr();
    output.write_all(CHECKPOINT).unwrap();
    output.flush().unwrap();
    io::stdin().read_exact(&mut [0]).unwrap();
}

struct Session {
    child: Child,
    control: File,
    chunks: mpsc::Receiver<Vec<u8>>,
    pending: Vec<u8>,
    parser: vt100::Parser,
}

impl Session {
    fn start(test: &str, mode: &str, rows: u16) -> Self {
        let pty = nix::pty::openpty(
            Some(&nix::pty::Winsize {
                ws_row: rows,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            }),
            None,
        )
        .unwrap();
        let mut master = File::from(pty.master);
        let control = master.try_clone().unwrap();
        let (sender, chunks) = mpsc::channel();
        thread::spawn(move || {
            let mut bytes = [0; 4096];
            while let Ok(count) = master.read(&mut bytes) {
                if count == 0 || sender.send(bytes[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", test, "--nocapture"])
            .env("NEMOCLAW_TEST_INLINE_SCREEN", mode)
            .env("TERM", "xterm-256color")
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::from(File::from(pty.slave)))
            .spawn()
            .unwrap();
        Self {
            child,
            control,
            chunks,
            pending: Vec::new(),
            parser: vt100::Parser::new(rows, 80, 100),
        }
    }

    fn screen(&mut self) -> String {
        loop {
            if let Some(end) = self
                .pending
                .windows(CHECKPOINT.len())
                .position(|bytes| bytes == CHECKPOINT)
            {
                self.parser.process(&self.pending[..end]);
                self.pending.drain(..end + CHECKPOINT.len());
                return text(self.parser.screen());
            }
            self.pending.extend(
                self.chunks
                    .recv_timeout(Duration::from_secs(10))
                    .expect("child must reach the next screen checkpoint"),
            );
        }
    }

    fn resume(&mut self) {
        self.child.stdin.as_mut().unwrap().write_all(b"x").unwrap();
    }

    fn resize(&mut self, rows: u16, columns: u16) {
        rustix::termios::tcsetwinsize(
            &self.control,
            rustix::termios::Winsize {
                ws_row: rows,
                ws_col: columns,
                ws_xpixel: 0,
                ws_ypixel: 0,
            },
        )
        .unwrap();
        self.parser.screen_mut().set_size(rows, columns);
        self.resume();
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        // Also reap a child blocked at a checkpoint when an assertion fails.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn real_backend_preserves_shell_unicode_and_milestones_across_resizes() {
    if std::env::var("NEMOCLAW_TEST_INLINE_SCREEN").as_deref() == Ok("resize") {
        eprint!("Previous shell output\r\n$ nemoclaw apply\r\n");
        let mut display = Inline::new("Apply · 配置.yaml\nState: state").unwrap();
        let lines = vec!["sandbox/配置: create started · elapsed <1s".into()];
        let now = Instant::now();
        display.prepare(&lines, now).unwrap();
        display.draw(&lines, now, Duration::ZERO).unwrap();
        checkpoint();
        for seconds in 1..=3 {
            let time = now + Duration::from_secs(seconds);
            display.prepare(&lines, time).unwrap();
            display
                .draw(&lines, time, Duration::from_secs(seconds))
                .unwrap();
            checkpoint();
        }
        display
            .insert(&Milestone {
                text: "sandbox/配置: complete".into(),
                tone: Tone::Success,
                durable: true,
            })
            .unwrap();
        // Finish between capped frames, immediately after inserting a milestone.
        drop(display);
        eprint!("Apply complete\r\n$ ");
        checkpoint();
        return;
    }
    let mut session = Session::start(
        "progress::inline::tests::real_backend_preserves_shell_unicode_and_milestones_across_resizes",
        "resize",
        40,
    );
    for (index, width) in [80, 32, 80, 24].into_iter().enumerate() {
        if index > 0 {
            session.resize(40, width);
        }
        let screen = session.screen();
        assert!(
            screen.starts_with("Previous shell output\n$ nemoclaw apply\nNVIDIA / NemoClaw"),
            "{screen}"
        );
        assert!(screen.contains("Apply · 配置.yaml"), "{screen}");
        assert!(screen.contains("sandbox/配置:"), "{screen}");
        assert!(screen.contains("Elapsed:"), "{screen}");
        assert!(!session.parser.screen().alternate_screen());
    }
    session.resume();
    let screen = session.screen();
    assert!(
        screen.contains("✓ sandbox/配置: complete\nApply complete\n$"),
        "{screen}"
    );
    assert!(
        !screen.contains("Elapsed:") && !screen.contains("started"),
        "{screen}"
    );
    assert!(!session.parser.screen().hide_cursor());
    session.resume();
    assert!(session.child.wait().unwrap().success());
}

#[test]
fn real_backend_keeps_completed_milestones_in_scrollback() {
    if std::env::var("NEMOCLAW_TEST_INLINE_SCREEN").as_deref() == Ok("scroll") {
        eprint!("Previous shell output\r\n");
        let mut display = Inline::new("Apply · demo.yaml").unwrap();
        for number in 0..20 {
            display
                .insert(&Milestone {
                    text: format!("sandbox/{number}: complete"),
                    tone: Tone::Success,
                    durable: true,
                })
                .unwrap();
        }
        drop(display);
        eprint!("Apply complete\r\n$ ");
        checkpoint();
        return;
    }
    let mut session = Session::start(
        "progress::inline::tests::real_backend_keeps_completed_milestones_in_scrollback",
        "scroll",
        8,
    );
    let screen = session.screen();
    assert!(
        screen.contains("sandbox/19: complete\nApply complete\n$"),
        "{screen}"
    );
    session.parser.screen_mut().set_scrollback(100);
    let history = text(session.parser.screen());
    assert!(
        history.starts_with("Previous shell output\nNVIDIA / NemoClaw"),
        "{history}"
    );
    assert!(history.contains("sandbox/0: complete"), "{history}");
    session.resume();
    assert!(session.child.wait().unwrap().success());
}
