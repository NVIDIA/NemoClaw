// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! OpenClaw's and Hermes's native interfaces through a managed Docker
//! deployment, reached as a person would: with the forward and token commands
//! that apply reports, run through the pinned OpenShell CLI.
//!
//! A model stand-in in this process answers every chat completion with a value
//! unique to the run and records the credential each request carried. It
//! doesn't establish inference or model compatibility.

use futures_util::{SinkExt as _, StreamExt as _};
use nemoclaw_sdk::{OperationResult, Outcome, SignIn, config::Document};
use serde_json::Value;
use std::{
    fs,
    io::{Read as _, Write as _},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::{Message, client::IntoClientRequest as _};

const MODEL_KEY: &str = "NEMOCLAW_TEST_INTERFACES_MODEL_KEY";

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

fn random_hex(bytes: usize) -> String {
    let mut value = vec![0u8; bytes];
    getrandom::fill(&mut value).unwrap();
    value.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// One request the model stand-in received: its method and path, and whether
/// it carried the configured key as a Bearer credential.
#[derive(Debug)]
struct ModelRequest {
    target: String,
    keyed: bool,
}

/// Serve OpenAI-compatible model routes on `port`, on every host address, so
/// sandboxes reach it at the gateway network's host address. Each chat
/// completion answers `reply`, streamed when the request asks.
fn serve_model(port: u16, key: String, reply: String) -> Arc<Mutex<Vec<ModelRequest>>> {
    let listener = std::net::TcpListener::bind(("0.0.0.0", port)).unwrap();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let recorded = requests.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let (recorded, key, reply) = (recorded.clone(), key.clone(), reply.clone());
            std::thread::spawn(move || {
                let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
                let mut buffer = Vec::new();
                let mut chunk = [0u8; 8192];
                let header_end = loop {
                    if let Some(end) = buffer.windows(4).position(|window| window == b"\r\n\r\n") {
                        break end + 4;
                    }
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => return,
                        Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                    }
                };
                let head = String::from_utf8_lossy(&buffer[..header_end]).into_owned();
                let header = |name: &str| {
                    head.lines().find_map(|line| {
                        let (field, value) = line.split_once(':')?;
                        field
                            .eq_ignore_ascii_case(name)
                            .then(|| value.trim().to_owned())
                    })
                };
                let length: usize = header("content-length")
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(0);
                while buffer.len() < header_end + length {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                    }
                }
                let body: Value = serde_json::from_slice(&buffer[header_end..]).unwrap_or_default();
                let target = head
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .rsplit_once(' ')
                    .map(|(target, _)| target.to_owned())
                    .unwrap_or_default();
                recorded.lock().unwrap().push(ModelRequest {
                    target: target.clone(),
                    keyed: header("authorization").as_deref() == Some(&format!("Bearer {key}")),
                });
                let response = if !target.starts_with("POST ") {
                    let models =
                        r#"{"object":"list","data":[{"id":"fixture-model","object":"model"}]}"#;
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{models}",
                        models.len()
                    )
                } else if body["stream"] == true {
                    let chunk = serde_json::json!({"id":"c1","object":"chat.completion.chunk","created":0,"model":"fixture-model",
                        "choices":[{"index":0,"delta":{"role":"assistant","content":reply},"finish_reason":null}]});
                    let last = serde_json::json!({"id":"c1","object":"chat.completion.chunk","created":0,"model":"fixture-model",
                        "choices":[{"index":0,"delta":{},"finish_reason":"stop"}],
                        "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}});
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {chunk}\n\ndata: {last}\n\ndata: [DONE]\n\n"
                    )
                } else {
                    let completion = serde_json::json!({"id":"c1","object":"chat.completion","created":0,"model":"fixture-model",
                        "choices":[{"index":0,"message":{"role":"assistant","content":reply},"finish_reason":"stop"}],
                        "usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})
                    .to_string();
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{completion}",
                        completion.len()
                    )
                };
                let _ = stream.write_all(response.as_bytes());
            });
        }
    });
    requests
}

/// The OpenShell CLI with this deployment's gateway and workspace selected,
/// as the interface guide selects them.
struct OpenShellCli {
    program: PathBuf,
    endpoint: String,
    workspace: String,
}

impl OpenShellCli {
    fn command(&self) -> Command {
        let mut command = Command::new(&self.program);
        command
            .env_remove("OPENSHELL_GATEWAY")
            .env("OPENSHELL_GATEWAY_ENDPOINT", &self.endpoint)
            .env("OPENSHELL_WORKSPACE", &self.workspace)
            .stdin(Stdio::null());
        command
    }

    /// Run `openshell sandbox exec -n SANDBOX --no-tty -- ARGS` and return its
    /// output, which can hold a token: callers must not print it.
    fn exec(&self, sandbox: &str, args: &[&str]) -> String {
        let output = self
            .command()
            .args(["sandbox", "exec", "-n", sandbox, "--no-tty", "--"])
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "openshell sandbox exec in {sandbox} failed"
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    /// The forward command apply reports, to a free local port.
    fn forward(&self, sandbox: &str, port: u16) -> Forward {
        let local = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let child = self
            .command()
            .args([
                "forward",
                "service",
                sandbox,
                "--target-port",
                &port.to_string(),
            ])
            .args(["--local", &format!("127.0.0.1:{local}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let forward = Forward { child, local };
        let deadline = Instant::now() + Duration::from_secs(20);
        while std::net::TcpStream::connect(("127.0.0.1", local)).is_err() {
            assert!(
                Instant::now() < deadline,
                "the forward to {sandbox}:{port} doesn't listen"
            );
            std::thread::sleep(Duration::from_millis(200));
        }
        forward
    }
}

/// A running `openshell forward service`, stopped when dropped.
struct Forward {
    child: Child,
    local: u16,
}

impl Forward {
    fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.local)
    }
}

impl Drop for Forward {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// GET `url`, retrying while the forward's first connection is set up.
async fn get(client: &reqwest::Client, url: &str, headers: &[(&str, &str)]) -> (u16, String) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let mut request = client.get(url);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                return (status, response.text().await.unwrap_or_default());
            }
            Err(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(error) => panic!("GET {url} failed: {error}"),
        }
    }
}

/// The bundled CLI, with the model key in its environment.
fn nemoclaw(bundle: &Path, key: &str, args: &[&str]) -> Output {
    Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(args)
    .env(MODEL_KEY, key)
    .stdin(Stdio::null())
    .output()
    .unwrap()
}

/// Every regular file under `directory`, without following symbolic links.
fn files(directory: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    for entry in fs::read_dir(directory).unwrap().flatten() {
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            found.extend(files(&entry.path()));
        } else if kind.is_file() {
            found.push(entry.path());
        }
    }
    found
}

/// Keeps the state directory when the test fails, so `nemoclaw destroy` can
/// still remove what it created.
struct KeepOnFailure(Option<tempfile::TempDir>);

impl Drop for KeepOnFailure {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Some(state) = self.0.take()
        {
            eprintln!("kept the deployment state at {}", state.keep().display());
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified bundle, the OpenClaw and Hermes images on local Docker, the pinned OpenShell CLI, and an owned managed-gateway document; creates Docker resources and retains gateway storage"]
async fn openclaw_and_hermes_interfaces_work_through_forwards() {
    let config = PathBuf::from(required("NEMOCLAW_TEST_INTERFACES_DOCUMENT"));
    let bundle = PathBuf::from(required("NEMOCLAW_TEST_BUNDLE"));
    let program = PathBuf::from(required("NEMOCLAW_TEST_OPENSHELL"));
    let document = Document::parse(fs::File::open(&config).unwrap()).unwrap();
    let authored = serde_json::to_value(&document).unwrap();
    let endpoint = authored["spec"]["inferenceProviders"]["model"]["endpoint"]
        .as_str()
        .unwrap();
    let model_port: u16 = url::Url::parse(endpoint).unwrap().port().unwrap();
    let key = format!("nc-model-key-{}", random_hex(16));
    let reply = format!("nc-reply-{}", random_hex(8));
    let model = serve_model(model_port, key.clone(), reply.clone());
    let state = KeepOnFailure(Some(tempfile::tempdir().unwrap()));
    let state_path = state.0.as_ref().unwrap().path().to_owned();
    let state_arg = state_path.to_str().unwrap();
    let config_arg = config.to_str().unwrap();

    // Planning rejects an interface the image's adapter doesn't declare,
    // before anything is created.
    let mut rejected = authored.clone();
    rejected["spec"]["sandboxes"]["claw"]["harness"]["settings"]["interfaces"] =
        serde_json::json!({"terminal": {}});
    let scratch = tempfile::tempdir().unwrap();
    let rejected_path = scratch.path().join("rejected.yaml");
    fs::write(&rejected_path, serde_json::to_vec(&rejected).unwrap()).unwrap();
    let scratch_state = scratch.path().join("state");
    let plan = nemoclaw(
        &bundle,
        &key,
        &[
            "plan",
            "--progress",
            "off",
            "--non-interactive",
            "--state-dir",
            scratch_state.to_str().unwrap(),
            rejected_path.to_str().unwrap(),
        ],
    );
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&plan.stdout),
        String::from_utf8_lossy(&plan.stderr)
    );
    assert!(!plan.status.success(), "{text}");
    assert!(
        text.contains("sandbox/claw") && text.contains("harness.settings.interfaces.terminal"),
        "{text}"
    );

    let apply = nemoclaw(
        &bundle,
        &key,
        &[
            "apply",
            "-o",
            "json",
            "--progress",
            "off",
            "--state-dir",
            state_arg,
            config_arg,
        ],
    );
    assert!(
        apply.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&apply.stdout)
    );
    let applied: OperationResult = serde_json::from_slice(&apply.stdout).unwrap();
    assert_eq!(applied.outcome, Outcome::Succeeded);
    let connection = applied
        .connection
        .clone()
        .expect("apply reports its gateway and workspace");
    let reported: Vec<(&str, &str, Option<u16>, SignIn, bool)> = applied
        .interfaces
        .iter()
        .map(|access| {
            (
                access.sandbox.as_str(),
                access.interface.as_str(),
                access.port,
                access.sign_in,
                access.token_path.is_some(),
            )
        })
        .collect();
    assert_eq!(
        reported,
        [
            (
                "claw",
                "dashboard",
                Some(18789),
                SignIn::TokenInUrlFragment,
                true
            ),
            ("hermes", "api", Some(8642), SignIn::BearerToken, true),
            ("hermes", "dashboard", Some(9119), SignIn::None, false),
        ]
    );
    let token_path = |sandbox: &str| {
        applied
            .interfaces
            .iter()
            .find(|access| access.sandbox == sandbox && access.token_path.is_some())
            .and_then(|access| access.token_path.clone())
            .unwrap()
    };
    let cli = OpenShellCli {
        program,
        endpoint: connection.gateway_endpoint.clone(),
        workspace: connection.workspace.clone(),
    };
    // The retrieval commands apply reports; the tokens stay in memory.
    let openclaw_token = cli.exec("claw", &["cat", &token_path("claw")]);
    let api_token = cli.exec("hermes", &["cat", &token_path("hermes")]);
    assert!(openclaw_token.len() >= 32 && api_token.len() >= 32);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .unwrap();

    // OpenClaw: the forwarded Control UI loads, and its configuration, which
    // the UI fetches once signed in, takes the token and refuses anything else.
    let dashboard = cli.forward("claw", 18789);
    let (status, page) = get(&client, &dashboard.url("/"), &[]).await;
    assert_eq!(status, 200);
    assert!(page.contains("<html") || page.contains("<!doctype") || page.contains("<!DOCTYPE"));
    let signed_in = format!("Bearer {openclaw_token}");
    let config_url = dashboard.url("/control-ui-config.json");
    let (status, body) = get(&client, &config_url, &[("Authorization", &signed_in)]).await;
    assert_eq!(status, 200, "the Control UI refused its token");
    assert!(
        serde_json::from_str::<Value>(&body).is_ok_and(|value| value.get("basePath").is_some())
    );
    let wrong = format!("Bearer {}", random_hex(32));
    for headers in [vec![], vec![("Authorization", wrong.as_str())]] {
        let (status, _) = get(&client, &config_url, &headers).await;
        assert_eq!(
            status, 401,
            "the Control UI accepted a missing or wrong token"
        );
    }

    // Hermes's API server takes its token and calls the configured model with
    // the configured key.
    let api = cli.forward("hermes", 8642);
    let bearer = format!("Bearer {api_token}");
    let (status, _) = get(
        &client,
        &api.url("/v1/models"),
        &[("Authorization", &bearer)],
    )
    .await;
    assert_eq!(status, 200, "the API server refused its token");
    for headers in [vec![], vec![("Authorization", wrong.as_str())]] {
        let (status, _) = get(&client, &api.url("/v1/models"), &headers).await;
        assert_eq!(
            status, 401,
            "the API server accepted a missing or wrong token"
        );
    }
    let completion = client
        .post(api.url("/v1/chat/completions"))
        .header("Authorization", &bearer)
        .header("Content-Type", "application/json")
        .body(r#"{"model":"hermes-agent","messages":[{"role":"user","content":"Say hi"}]}"#)
        .send()
        .await
        .unwrap();
    assert_eq!(completion.status().as_u16(), 200);
    let completion: Value = serde_json::from_str(&completion.text().await.unwrap()).unwrap();
    assert_eq!(
        completion["choices"][0]["message"]["content"],
        reply.as_str()
    );

    // Hermes's dashboard has no sign-in: the page carries the session token
    // that its own API calls need.
    let console = cli.forward("hermes", 9119);
    let (status, page) = get(&client, &console.url("/"), &[]).await;
    assert_eq!(status, 200);
    let session = page
        .split_once("__HERMES_SESSION_TOKEN__=\"")
        .and_then(|(_, rest)| rest.split_once('"'))
        .map(|(token, _)| token.to_owned())
        .expect("the dashboard page carries its session token");
    let (status, body) = get(
        &client,
        &console.url("/api/config"),
        &[("X-Hermes-Session-Token", &session)],
    )
    .await;
    assert_eq!(status, 200, "the dashboard refused its session token");
    assert!(serde_json::from_str::<Value>(&body).is_ok());
    let (status, _) = get(&client, &console.url("/api/config"), &[]).await;
    assert_eq!(
        status, 401,
        "the dashboard API answered without its session token"
    );

    // Browser chat runs Hermes's terminal UI over a WebSocket; one message
    // gets the model's reply through the forward.
    let mut request = format!("ws://127.0.0.1:{}/api/pty?token={session}", console.local)
        .into_client_request()
        .unwrap();
    request.headers_mut().insert(
        "Origin",
        format!("http://127.0.0.1:{}", console.local)
            .parse()
            .unwrap(),
    );
    let (mut chat, _) = tokio_tungstenite::connect_async(request).await.unwrap();
    let mut screen = String::new();
    let mut typed: Option<usize> = None;
    let started = Instant::now();
    let mut quiet_since = Instant::now();
    let mut drawn: Option<Instant> = None;
    let answered = loop {
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "browser chat didn't answer"
        );
        match tokio::time::timeout(Duration::from_millis(500), chat.next()).await {
            Ok(Some(Ok(Message::Text(text)))) => {
                screen.push_str(&text);
                quiet_since = Instant::now();
                drawn.get_or_insert_with(Instant::now);
            }
            Ok(Some(Ok(Message::Binary(bytes)))) => {
                screen.push_str(&String::from_utf8_lossy(&bytes));
                quiet_since = Instant::now();
                drawn.get_or_insert_with(Instant::now);
            }
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_)) | None) => break false,
            Err(_) => {}
        }
        match typed {
            Some(at) if screen[at..].contains(reply.as_str()) => break true,
            // Type once the terminal UI has drawn and gone quiet; its title
            // can keep updating, so type after 8 seconds regardless.
            None if drawn.is_some_and(|drawn| {
                quiet_since.elapsed() > Duration::from_secs(2)
                    || drawn.elapsed() > Duration::from_secs(8)
            }) =>
            {
                chat.send(Message::text("Say hi")).await.unwrap();
                tokio::time::sleep(Duration::from_millis(500)).await;
                chat.send(Message::text("\r")).await.unwrap();
                typed = Some(screen.len());
            }
            _ => {}
        }
    };
    assert!(answered, "browser chat closed before answering");
    let _ = chat.close(None).await;

    // Every model request came with the configured key.
    {
        let requests = model.lock().unwrap();
        let completions: Vec<&ModelRequest> = requests
            .iter()
            .filter(|request| {
                request.target.starts_with("POST ") && request.target.contains("/chat/completions")
            })
            .collect();
        assert!(completions.len() >= 2, "{:?}", *requests);
        assert!(
            completions.iter().all(|request| request.keyed),
            "{:?}",
            *requests
        );
    }

    // A failed Hermes child doesn't stop the agent: kill the dashboard, and
    // the provider still finds the runtime running.
    let killed = cli.exec(
        "hermes",
        &[
            "python3",
            "-c",
            "import os, signal\nfor pid in os.listdir('/proc'):\n    try:\n        command = open(f'/proc/{pid}/cmdline', 'rb').read()\n    except (OSError, ValueError):\n        continue\n    if b'hermes_cli.main\\0dashboard' in command:\n        os.kill(int(pid), signal.SIGKILL)\n        print('killed')\n",
        ],
    );
    assert_eq!(killed, "killed");
    drop(console);
    let plan = nemoclaw(
        &bundle,
        &key,
        &[
            "plan",
            "-o",
            "json",
            "--progress",
            "off",
            "--state-dir",
            state_arg,
            config_arg,
        ],
    );
    assert!(
        plan.status.success(),
        "plan failed: {}",
        String::from_utf8_lossy(&plan.stderr)
    );
    let planned: OperationResult = serde_json::from_slice(&plan.stdout).unwrap();
    assert!(planned.changes.is_empty(), "{:?}", planned.changes);
    let (status, _) = get(
        &client,
        &api.url("/v1/models"),
        &[("Authorization", &bearer)],
    )
    .await;
    assert_eq!(status, 200, "the API server stopped with the dashboard");
    drop((dashboard, api));

    // No token reached NemoClaw's output, its state directory, or the YAML.
    let tokens = [&openclaw_token, &api_token, &session];
    let mut outputs = vec![apply.stdout, apply.stderr, plan.stdout, plan.stderr];
    outputs.push(fs::read(&config).unwrap());
    for file in files(&state_path) {
        outputs.push(fs::read(&file).unwrap());
    }
    for (index, output) in outputs.iter().enumerate() {
        for token in tokens {
            assert!(
                !output
                    .windows(token.len())
                    .any(|window| window == token.as_bytes()),
                "output {index} holds an interface token"
            );
        }
    }

    let destroyed = nemoclaw(
        &bundle,
        &key,
        &[
            "destroy",
            "-o",
            "json",
            "--progress",
            "off",
            "--state-dir",
            state_arg,
        ],
    );
    assert!(
        destroyed.status.success(),
        "destroy failed: {}",
        String::from_utf8_lossy(&destroyed.stdout)
    );
}
