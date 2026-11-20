// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Exit guards: each command's output and exit code as `run()` produces them
//! today, so a later change to `run()` cannot alter either unnoticed.
//!
//! Every run here sets the HTTP proxy variables to a local listener that a
//! test owns. A client that honours those variables connects to the listener
//! instead of the network, and the test fails on any connection. A client that
//! ignores them is not caught.
//!
//! A successful plan, apply, destroy or export needs a runtime to act on, so
//! these tests pin the paths that end before one: onboarding without a
//! terminal, and failures in text and JSON. Help, version and usage errors end
//! in argument parsing, before the rest of `run()`; other files pin them.

use std::{io::ErrorKind, net::TcpListener, path::Path, process::Command};

/// A local listener that the proxy variables of every run name.
struct NetworkGuard(TcpListener);

impl NetworkGuard {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        Self(listener)
    }

    fn url(&self) -> String {
        format!("http://{}", self.0.local_addr().unwrap())
    }

    /// The connections the listener has received and not yet counted. A
    /// connection that a finished child made waits in the listen queue.
    fn connections(&self) -> usize {
        let mut count = 0;
        loop {
            match self.0.accept() {
                Ok(_) => count += 1,
                Err(error) if error.kind() == ErrorKind::WouldBlock => return count,
                Err(error) => panic!("cannot read the network guard: {error}"),
            }
        }
    }

    fn assert_no_connection(&self, context: &str) {
        assert_eq!(
            self.connections(),
            0,
            "{context}: the command opened a connection through the HTTP proxy"
        );
    }

    /// The CLI with every proxy variable naming this listener and no proxy
    /// exemptions. Standard input is empty unless a test replaces it.
    fn nemoclaw(&self) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_nemoclaw"));
        for name in [
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ] {
            command.env(name, self.url());
        }
        command
            .env_remove("NO_PROXY")
            .env_remove("no_proxy")
            .stdin(std::process::Stdio::null());
        command
    }
}

/// Replaces `root` with `<ROOT>` and the duration after ` · ` with
/// `<DURATION>`, the two parts of a result that change between runs.
fn normalize(text: &[u8], root: &Path) -> String {
    let text = String::from_utf8(text.to_vec())
        .unwrap()
        .replace(root.to_str().unwrap(), "<ROOT>");
    text.split_inclusive('\n')
        .map(|line| match line.find(" · ") {
            Some(index) => format!("{} · <DURATION>\n", &line[..index]),
            None => line.to_owned(),
        })
        .collect()
}

#[test]
fn network_guard_counts_a_connection() {
    let guard = NetworkGuard::new();
    let address = guard.0.local_addr().unwrap();
    drop(std::net::TcpStream::connect(address).unwrap());
    assert_eq!(guard.connections(), 1);
    guard.assert_no_connection("after counting");
}

#[test]
fn onboarding_without_a_terminal_exits_one_with_text_on_stderr() {
    let guard = NetworkGuard::new();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().canonicalize().unwrap();
    let template = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../examples/onboarding/openclaw.yaml")
        .canonicalize()
        .unwrap();
    for (template, input) in [(None, ""), (Some(&template), "Input: <TEMPLATE>\n")] {
        let destination = root.join("authored.yaml");
        let mut command = guard.nemoclaw();
        command.arg("onboard");
        if let Some(template) = template {
            command.arg(template);
        }
        let output = command
            .arg("--output")
            .arg(&destination)
            .arg("--state-dir")
            .arg(root.join("state"))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{template:?}");
        assert!(output.stdout.is_empty(), "{template:?}");
        let mut stderr = normalize(&output.stderr, &root);
        if let Some(template) = template {
            stderr = stderr.replace(template.to_str().unwrap(), "<TEMPLATE>");
        }
        assert_eq!(
            stderr,
            format!(
                "Onboard failed · <DURATION>\n{input}State: <ROOT>/state\n\n\
                 onboarding requires a terminal on stdin and stderr\n"
            ),
            "{template:?}"
        );
        assert!(!destination.exists(), "{template:?}");
        assert!(!root.join("state").exists(), "{template:?}");
        guard.assert_no_connection(&format!("onboard {template:?}"));
    }
}

/// A runtime bundle whose manifest verifies, so a command gets past opening
/// it. Its OpenTofu answers `init`, an empty `plan` and an empty `show`, and
/// fails any other call, so no command can apply or destroy anything.
#[cfg(unix)]
struct Fixture {
    _directory: tempfile::TempDir,
    root: std::path::PathBuf,
}

#[cfg(unix)]
impl Fixture {
    const TOFU: &str = r#"#!/bin/sh
case "$1" in
  init) ;;
  plan) printf '{"type":"version","ui":"1.0"}\n' ;;
  show) printf '{"format_version":"1.0"}\n' ;;
  *) printf 'unexpected command\n' >&2; exit 64 ;;
esac
"#;

    fn new() -> Self {
        use nemoclaw_sdk::{
            bundle::{Manifest, executable, hash_file, required_files},
            compile::OPENTOFU_VERSION,
        };
        let directory = tempfile::tempdir().unwrap();
        // Output names the canonical path; a macOS temporary path is a symbolic link.
        let root = directory.path().canonicalize().unwrap();
        let bundle = root.join("bundle");
        let mut manifest = Manifest {
            version: "0.1.0".into(),
            rust: "1.98.1".into(),
            opentofu: OPENTOFU_VERSION.into(),
            files: Default::default(),
        };
        let tofu = format!("libexec/{}", executable("tofu"));
        for name in required_files(&manifest.version).unwrap() {
            let path = bundle.join(&name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            if name == tofu {
                crate::executable::write_executable(&path, Self::TOFU);
            } else {
                std::fs::write(&path, b"non-executable fixture").unwrap();
            }
            manifest.files.insert(name, hash_file(&path).unwrap());
        }
        std::fs::write(
            bundle.join("manifest.json"),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        std::fs::write(
            root.join("input.yaml"),
            include_str!("../../../examples/openclaw.yaml"),
        )
        .unwrap();
        Self {
            _directory: directory,
            root,
        }
    }

    /// Runs `args`, with `INPUT` replaced by the configuration file, against
    /// this bundle and a state directory of its own, and with progress off.
    fn run(&self, guard: &NetworkGuard, args: &[&str], state: &str) -> std::process::Output {
        use std::io::Write;
        let mut command = guard.nemoclaw();
        for arg in args {
            match *arg {
                "INPUT" => command.arg(self.root.join("input.yaml")),
                other => command.arg(other),
            };
        }
        if matches!(args.first(), Some(&("plan" | "apply"))) {
            command.arg("--non-interactive");
        }
        command
            .args(["--progress", "off", "--bundle"])
            .arg(self.root.join("bundle"))
            .arg("--state-dir")
            .arg(self.root.join(state));
        // `-` reads the configuration from standard input.
        if !args.contains(&"-") {
            return command.output().unwrap();
        }
        let mut child = command
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        child
            .stdin
            .take()
            .unwrap()
            .write_all(include_bytes!("../../../examples/openclaw.yaml"))
            .unwrap();
        child.wait_with_output().unwrap()
    }
}

/// The commands that reach the runtime bundle, as `(arguments, state
/// directory name, text result, JSON result)`. `export` has no JSON output.
#[cfg(unix)]
fn failures() -> Vec<(
    Vec<&'static str>,
    &'static str,
    &'static str,
    Option<serde_json::Value>,
)> {
    use serde_json::json;
    let plan_failure = "plan omitted a required resource";
    let no_state = "destroy requires existing deployment state";
    let unchanged = "No runtime resources changed.";
    vec![
        (
            vec!["plan", "INPUT"],
            "plan-file",
            "Plan failed · <DURATION>\nInput: <ROOT>/input.yaml\nState: <ROOT>/plan-file\n\n\
             plan omitted a required resource\n",
            Some(json!({
                "error": {"message": plan_failure},
                "input": "<ROOT>/input.yaml",
                "operation": "Plan",
                "outcome": "failed",
                "stateDirectory": "<ROOT>/plan-file",
            })),
        ),
        (
            vec!["plan", "-"],
            "plan-stdin",
            "Plan failed · <DURATION>\nInput: -\nState: <ROOT>/plan-stdin\n\n\
             plan omitted a required resource\n",
            Some(json!({
                "error": {"message": plan_failure},
                "input": "-",
                "operation": "Plan",
                "outcome": "failed",
                "stateDirectory": "<ROOT>/plan-stdin",
            })),
        ),
        (
            vec!["plan", "--destroy"],
            "plan-destroy",
            "Destroy plan failed · <DURATION>\nState: <ROOT>/plan-destroy\n\n\
             destroy requires existing deployment state\n",
            Some(json!({
                "error": {"message": no_state},
                "operation": "Destroy plan",
                "outcome": "failed",
                "stateDirectory": "<ROOT>/plan-destroy",
            })),
        ),
        (
            vec!["apply", "INPUT"],
            "apply-file",
            "Apply failed · <DURATION>\nInput: <ROOT>/input.yaml\nState: <ROOT>/apply-file\n\n\
             plan omitted a required resource\n\nNo runtime resources changed.\n",
            Some(json!({
                "error": {"message": plan_failure},
                "input": "<ROOT>/input.yaml",
                "operation": "Apply",
                "outcome": "failed",
                "remainingState": unchanged,
                "stateDirectory": "<ROOT>/apply-file",
            })),
        ),
        (
            vec!["apply", "-"],
            "apply-stdin",
            "Apply failed · <DURATION>\nInput: -\nState: <ROOT>/apply-stdin\n\n\
             plan omitted a required resource\n\nNo runtime resources changed.\n",
            Some(json!({
                "error": {"message": plan_failure},
                "input": "-",
                "operation": "Apply",
                "outcome": "failed",
                "remainingState": unchanged,
                "stateDirectory": "<ROOT>/apply-stdin",
            })),
        ),
        (
            vec!["destroy"],
            "destroy",
            "Destroy failed · <DURATION>\nState: <ROOT>/destroy\n\n\
             destroy requires existing deployment state\n\nNo runtime resources changed.\n",
            Some(json!({
                "error": {"message": no_state},
                "operation": "Destroy",
                "outcome": "failed",
                "remainingState": unchanged,
                "stateDirectory": "<ROOT>/destroy",
            })),
        ),
        (
            vec!["export"],
            "export",
            "Export failed · <DURATION>\nState: <ROOT>/export\n\n\
             no saved deployment configuration; apply a configuration before exporting\n",
            None,
        ),
    ]
}

#[cfg(unix)]
#[test]
fn bundle_failures_exit_one_with_text_on_stderr_only() {
    let guard = NetworkGuard::new();
    let fixture = Fixture::new();
    for (args, state, text, _) in failures() {
        let output = fixture.run(&guard, &args, state);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stdout.is_empty(), "{args:?}");
        assert_eq!(normalize(&output.stderr, &fixture.root), text, "{args:?}");
        guard.assert_no_connection(&format!("{args:?}"));
    }
}

#[cfg(unix)]
#[test]
fn bundle_failures_exit_one_with_one_json_result_on_stdout_only() {
    let guard = NetworkGuard::new();
    let fixture = Fixture::new();
    for (args, state, _, expected) in failures() {
        let Some(expected) = expected else { continue };
        let args: Vec<_> = args.into_iter().chain(["-o", "json"]).collect();
        let output = fixture.run(&guard, &args, state);
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        assert!(output.stderr.is_empty(), "{args:?}");
        let stdout = normalize(&output.stdout, &fixture.root);
        assert!(stdout.ends_with("}\n"), "{args:?}: {stdout:?}");
        let result: serde_json::Value = serde_json::from_str(&stdout).unwrap();
        assert_eq!(result, expected, "{args:?}");
        guard.assert_no_connection(&format!("{args:?}"));
    }
}
