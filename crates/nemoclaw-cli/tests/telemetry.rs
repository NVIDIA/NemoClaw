// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The telemetry record as the built CLI sends it, to a local receiver. The
//! commands run against the exit-guard fixture, so `apply` and `destroy` end in
//! failure; a saving `onboard` needs a terminal and is tested in the module.
#![cfg(unix)]

use crate::exit_guards::{Fixture, NetworkGuard};
use serde_json::Value;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// A local receiver that keeps every record posted to it, or, when stalled,
/// accepts connections and never answers.
struct Receiver {
    url: String,
    records: Arc<Mutex<Vec<Value>>>,
}

impl Receiver {
    fn new(stalled: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/v1.1/events/json", listener.local_addr().unwrap());
        let records = Arc::new(Mutex::new(Vec::new()));
        let kept = records.clone();
        std::thread::spawn(move || {
            let mut held = Vec::new();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                if stalled {
                    held.push(stream);
                    continue;
                }
                if let Some(body) = read_body(&mut stream) {
                    kept.lock().unwrap().push(body);
                }
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n");
            }
        });
        Self { url, records }
    }

    fn take(&self) -> Vec<Value> {
        std::mem::take(&mut self.records.lock().unwrap())
    }
}

fn read_body(stream: &mut TcpStream) -> Option<Value> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut request = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        if let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") {
            let head = String::from_utf8_lossy(&request[..end]).to_ascii_lowercase();
            let length: usize = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))?
                .trim()
                .parse()
                .ok()?;
            if request.len() >= end + 4 + length {
                return serde_json::from_slice(&request[end + 4..end + 4 + length]).ok();
            }
        }
        let count = stream.read(&mut buffer).ok()?;
        if count == 0 {
            return None;
        }
        request.extend_from_slice(&buffer[..count]);
    }
}

/// The fixture's command with telemetry on and pointed at `receiver`, its
/// install ID file under the fixture, and no CI variable or test label.
fn sending(fixture: &Fixture, guard: &NetworkGuard, args: &[&str], url: &str) -> Command {
    sending_in(fixture, guard, args, url, "state")
}

/// [`sending`] with the state directory `state` under the fixture.
fn sending_in(
    fixture: &Fixture,
    guard: &NetworkGuard,
    args: &[&str],
    url: &str,
    state: &str,
) -> Command {
    let mut command = fixture.command(guard, args, state);
    command
        .env_remove("NEMOCLAW_DISABLE_TELEMETRY")
        .env_remove("NEMOCLAW_TELEMETRY_TEST_LABEL")
        .env("NEMOCLAW_TELEMETRY_ENDPOINT", url)
        .env("HOME", fixture.root.join("home"))
        .env("XDG_CONFIG_HOME", fixture.root.join("config"));
    for name in nemoclaw_sdk::telemetry::CI_VARIABLES {
        command.env_remove(name);
    }
    command
}

#[test]
fn apply_and_destroy_send_one_record_and_plan_and_export_none() {
    let guard = NetworkGuard::new();
    let fixture = Fixture::new();
    let receiver = Receiver::new(false);
    let mut sent = Vec::new();
    for (args, operation) in [
        (&["apply", "INPUT"][..], Some("apply")),
        (&["destroy"][..], Some("destroy")),
        (&["plan", "INPUT"][..], None),
        (&["plan", "--destroy"][..], None),
        (&["export"][..], None),
    ] {
        let output = sending(&fixture, &guard, args, &receiver.url)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1), "{args:?}");
        guard.assert_no_connection(&format!("{args:?}"));
        let records = receiver.take();
        let Some(operation) = operation else {
            assert!(records.is_empty(), "{args:?}: {records:?}");
            continue;
        };
        assert_eq!(records.len(), 1, "{args:?}");
        assert_eq!(records[0]["eventSchemaVer"], "5.0");
        let record = records[0]["events"][0]["parameters"].clone();
        assert_eq!(record["operation"], operation);
        assert_eq!(record["outcome"], "failed");
        assert_eq!(record["effect"], "other");
        assert_ne!(record["failureStage"], "none");
        assert_eq!(record["testLabel"], "");
        sent.push(record);
    }
    // `apply` read its input; `destroy` found no saved intent. One install ID.
    let (apply, destroy) = (&sent[0], &sent[1]);
    assert_ne!(apply["computeDriver"], "unknown");
    assert_eq!(destroy["computeDriver"], "unknown");
    assert_eq!(
        (&apply["firstRun"], &destroy["firstRun"]),
        (&true.into(), &false.into())
    );
    assert_ne!(apply["installId"], "unknown");
    assert_eq!(destroy["installId"], apply["installId"]);
}

/// Planted in every input the sender can see; the posted body must not hold it.
const SENTINEL: &str = "zqxleak";

/// A deployment that names the sentinel everywhere it can: names, image
/// references, credential and MCP server names, endpoints, and a path-shaped
/// and an address-shaped model.
const LEAKY: &str = r#"
apiVersion: nemoclaw.nvidia.com/v1alpha1
kind: NemoClawConfig
metadata:
  name: zqxleak-config
  uid: d55b73c4-cdd7-48b4-b883-dd7d0e8d37da
spec:
  gateway:
    management: external
    target:
      docker:
        engine: unix:///var/run/zqxleak/docker.sock
    endpoint: https://zqxleak-gateway.example.com:17671
  inferenceProviders:
    zqxleak-provider:
      provider: openai
      endpoint: https://zqxleak.example.com/v1
      credential:
        env: ZQXLEAK_API_KEY
  sandboxes:
    zqxleak-path:
      image:
        ref: registry.zqxleak.example.com/agent@sha256:0000000000000000000000000000000000000000000000000000000000000000
      harness:
        kind: nvidia.fabric.openclaw
      agent:
        name: zqxleak-agent
        mcp:
          servers:
            zqxleak-docs:
              url: https://mcp.zqxleak.example.com
        inference:
          routes:
            - name: zqxleak-route
              providerRef: zqxleak-provider
              overrides:
                model: 10.0.0.5/zqxleak/llama-3-8b
    zqxleak-address:
      image:
        ref: zqxleak-image@sha256:0000000000000000000000000000000000000000000000000000000000000000
      harness:
        kind: nvidia.fabric.openclaw
      agent:
        name: zqxleak-agent-two
        inference:
          routes:
            - name: primary
              providerRef: zqxleak-provider
              overrides:
                model: 10.0.0.5:8000/zqxleak
"#;

#[test]
fn no_input_the_sender_sees_reaches_the_posted_body() {
    let guard = NetworkGuard::new();
    let fixture = Fixture::new();
    let receiver = Receiver::new(false);
    let input = fixture.root.join(format!("{SENTINEL}-input.yaml"));
    std::fs::write(&input, LEAKY).unwrap();
    let (home, config) = (
        fixture.root.join(format!("home-{SENTINEL}")),
        fixture.root.join(format!("config-{SENTINEL}")),
    );
    // A stored last version that is not a version.
    let directory = if cfg!(target_os = "macos") {
        home.join("Library/Application Support/nemoclaw")
    } else {
        config.join("nemoclaw")
    };
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join("telemetry.json"),
        format!(
            r#"{{"installId":"0f8fad5b-d9cb-469f-a165-70867728950e","lastVersion":"/home/{SENTINEL}/notes"}}"#
        ),
    )
    .unwrap();
    let args = ["apply", input.to_str().unwrap()];
    let state = format!("{SENTINEL}-state");
    let output = sending_in(&fixture, &guard, &args, &receiver.url, &state)
        .env("HOME", &home)
        .env("XDG_CONFIG_HOME", &config)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    // The command's own error text named the sentinel, so the sender saw it.
    assert!(String::from_utf8_lossy(&output.stderr).contains(SENTINEL));
    guard.assert_no_connection("leak");
    let records = receiver.take();
    assert_eq!(records.len(), 1);
    let body = serde_json::to_string(&records[0]).unwrap();
    assert!(
        !body.to_ascii_lowercase().contains(SENTINEL),
        "the posted body holds {SENTINEL}: {body}"
    );
    let record = &records[0]["events"][0]["parameters"];
    assert_eq!(record["computeDriver"], "docker", "the input was read");
    assert_eq!(record["previousVersion"], "unknown");
}

#[test]
fn an_apply_stopped_by_sigterm_records_cancelled() {
    let guard = NetworkGuard::new();
    let fixture = Fixture::new();
    let receiver = Receiver::new(false);
    // `-` reads the configuration from standard input, which stays open, so
    // the command waits until the signal stops it. A signal that comes before
    // the command handles signals ends it at once; then wait longer and retry.
    let status = [500, 2000, 8000]
        .into_iter()
        .map(|wait| {
            let mut child = sending(&fixture, &guard, &["apply", "-"], &receiver.url)
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap();
            std::thread::sleep(Duration::from_millis(wait));
            let killed = Command::new("kill")
                .args(["-TERM", &child.id().to_string()])
                .status()
                .unwrap();
            assert!(killed.success());
            child.wait().unwrap()
        })
        .find(|status| status.code().is_some())
        .expect("the command never handled SIGTERM");
    assert_ne!(status.code(), Some(0));
    guard.assert_no_connection("sigterm");
    let records = receiver.take();
    assert_eq!(records.len(), 1, "{status:?}");
    let record = &records[0]["events"][0]["parameters"];
    assert_eq!(record["operation"], "apply");
    assert_eq!(record["outcome"], "cancelled");
}

#[test]
fn a_stalled_receiver_ends_the_command_within_three_seconds_with_the_same_exit_code() {
    let guard = NetworkGuard::new();
    let fixture = Fixture::new();
    let (answering, stalling) = (Receiver::new(false), Receiver::new(true));
    let args = ["apply", "INPUT"];
    let quiet = fixture.command(&guard, &args, "quiet").output().unwrap();
    let started = Instant::now();
    sending(&fixture, &guard, &args, &answering.url)
        .output()
        .unwrap();
    let baseline = started.elapsed();
    let started = Instant::now();
    let stalled = sending(&fixture, &guard, &args, &stalling.url)
        .output()
        .unwrap();
    let elapsed = started.elapsed();
    assert_eq!(stalled.status.code(), quiet.status.code());
    assert_eq!(stalled.stdout, quiet.stdout);
    assert!(
        elapsed < baseline + Duration::from_millis(3500),
        "{elapsed:?} against {baseline:?} with an answering receiver"
    );
    guard.assert_no_connection("stalled receiver");
}
