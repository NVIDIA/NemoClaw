// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A local pseudo-terminal for live tests that drive a terminal UI as a person
//! would: util-linux's `script` allocates it, and the test reads what the
//! terminal shows without its control sequences.

use std::{
    io::{Read as _, Write as _},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// The text a terminal shows for `bytes`, without control sequences.
pub fn visible(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut shown = String::new();
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            shown.push(c);
            continue;
        }
        match chars.next() {
            // A control sequence ends with a byte from @ to ~.
            Some('[') => {
                for c in chars.by_ref() {
                    if ('@'..='~').contains(&c) {
                        break;
                    }
                }
            }
            // A string ends with BEL or ESC \.
            Some(']' | 'P' | '_' | '^') => {
                while let Some(c) = chars.next() {
                    if c == '\x07' {
                        break;
                    }
                    if c == '\x1b' {
                        chars.next();
                        break;
                    }
                }
            }
            Some('(' | ')') => {
                chars.next();
            }
            _ => {}
        }
    }
    shown
}

pub fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A command running in a local pseudo-terminal, whose output is collected.
pub struct Terminal {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: Arc<Mutex<Vec<u8>>>,
}

impl Terminal {
    /// Run `command` in a 40 by 120 pseudo-terminal that util-linux's
    /// `script` allocates, as an interactive terminal would.
    pub fn start(command: &str, environment: &[(&str, &str)], home: &std::path::Path) -> Self {
        let mut child = Command::new("script")
            .args(["--quiet", "--flush", "--return", "--command"])
            .arg(format!("stty rows 40 cols 120 && exec {command}"))
            .arg("/dev/null")
            .env_remove("OPENSHELL_GATEWAY")
            .env("HOME", home)
            .env("XDG_CONFIG_HOME", home.join(".config"))
            .envs(environment.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("the terminal test needs util-linux's script");
        let output = Arc::new(Mutex::new(Vec::new()));
        let mut stdout = child.stdout.take().unwrap();
        let collected = output.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 65536];
            while let Ok(read) = stdout.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                collected.lock().unwrap().extend_from_slice(&buffer[..read]);
            }
        });
        let input = child.stdin.take().unwrap();
        Self {
            child,
            input,
            output,
        }
    }

    pub fn mark(&self) -> usize {
        self.output.lock().unwrap().len()
    }

    /// Wait until the terminal shows `text` after `mark`.
    pub fn wait_for(&self, mark: usize, text: &str, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let shown = visible(&self.output.lock().unwrap()[mark..]);
            if shown.contains(text) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "the terminal did not show {text:?} within {timeout:?}; it last showed:\n{}",
                shown
                    .chars()
                    .rev()
                    .take(3000)
                    .collect::<Vec<_>>()
                    .into_iter()
                    .rev()
                    .collect::<String>()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    }

    pub fn send(&mut self, keys: &str) {
        self.input.write_all(keys.as_bytes()).unwrap();
        self.input.flush().unwrap();
    }

    /// Wait for the command to exit by itself, or kill it.
    pub fn exited_within(&mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if self.child.try_wait().unwrap().is_some() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        false
    }
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_text_drops_control_sequences_and_strings() {
        let shown = visible(
            b"\x1b[?1049h\x1b[2J\x1b[1;1H\x1b[38;5;12mopenai:fixture-model\x1b[0m \x1b]0;dcode\x07ready\x1b]8;;https://x\x1b\\link\x1b(B!",
        );
        assert_eq!(shown, "openai:fixture-model readylink!");
    }

    #[test]
    fn visible_text_keeps_split_utf8_box_drawing() {
        assert_eq!(
            visible("\u{250c}\u{2500}\x1b[K\u{2510}".as_bytes()),
            "\u{250c}\u{2500}\u{2510}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn quoted_values_survive_the_shell() {
        let value = "/sandbox/it's here/terminal";
        let output = Command::new("sh")
            .args(["-c", &format!("printf %s {}", quoted(value))])
            .output()
            .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), value);
    }
}
