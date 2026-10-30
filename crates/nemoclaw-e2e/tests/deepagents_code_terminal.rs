// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Deep Agents Code's terminal interface through a managed Docker deployment.
//!
//! Apply enables `interfaces.terminal`; the test opens the launcher Fabric's
//! adapter writes with `openshell sandbox exec --tty`, as a person would, and
//! sends one prompt. OpenShell's access control is the only authentication. A
//! model stand-in without credentials answers each prompt with a reply derived
//! from it, so a reply shows that the prompt reached the endpoint and model
//! the generated configuration names.

use fabric_provider::AgentBridge as _;
use nemoclaw_e2e::state::{runtime_id, sandbox_binding};
use nemoclaw_sdk::{
    CancellationToken, Deployment, InterfaceAccess, OperationResult, Outcome, SignIn,
    config::{Document, Gateway},
};
use openshell_provider::{EnvironmentSecrets, OpenShell};
use serde_json::{Value, json};
use std::{
    io::{Read as _, Write as _},
    process::{Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

fn required(name: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| panic!("{name} is required"))
}

/// One chat completion the stand-in answered: its model and the reply.
#[derive(Clone, Debug)]
struct Answered {
    model: Value,
    reply: String,
}

/// The reply to a prompt that names `token TOKEN`: `REPLY-` and the token in
/// capitals, which the lowercase prompt doesn't contain.
fn reply_to(request: &Value) -> String {
    let last = request["messages"]
        .as_array()
        .and_then(|messages| messages.last())
        .map(Value::to_string)
        .unwrap_or_default();
    last.rsplit_once("token ")
        .map(|(_, rest)| {
            let token: String = rest
                .chars()
                .take_while(char::is_ascii_alphanumeric)
                .collect();
            format!("REPLY-{}", token.to_ascii_uppercase())
        })
        .unwrap_or_else(|| "NO-TOKEN".into())
}

/// Answer one HTTP request as an OpenAI-compatible endpoint: chat
/// completions, streamed or not, and the model list.
async fn answer(mut socket: tokio::net::TcpStream, answered: Arc<Mutex<Vec<Answered>>>) {
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        let Ok(byte) = socket.read_u8().await else {
            return;
        };
        header.push(byte);
        assert!(header.len() < 65536, "request header too large");
    }
    let header = String::from_utf8_lossy(&header).into_owned();
    let line = header.lines().next().unwrap_or_default().to_owned();
    let length: usize = header
        .lines()
        .find_map(|line| {
            let (key, value) = line.split_once(':')?;
            key.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse().ok())?
        })
        .unwrap_or(0);
    assert!(length <= 4 << 20, "request body too large");
    let mut body = vec![0; length];
    socket.read_exact(&mut body).await.unwrap();
    let (content_type, body) = if line.starts_with("POST ") && line.contains("/chat/completions ") {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let reply = reply_to(&request);
        answered.lock().unwrap().push(Answered {
            model: request["model"].clone(),
            reply: reply.clone(),
        });
        let base = json!({"id": "stand-in", "created": 1, "model": request["model"]});
        if request["stream"] == true {
            let mut first = base.clone();
            first["object"] = json!("chat.completion.chunk");
            first["choices"] = json!([{"index": 0, "delta": {"role": "assistant", "content": reply}, "finish_reason": null}]);
            let mut last = base.clone();
            last["object"] = json!("chat.completion.chunk");
            last["choices"] = json!([{"index": 0, "delta": {}, "finish_reason": "stop"}]);
            (
                "text/event-stream",
                format!("data: {first}\n\ndata: {last}\n\ndata: [DONE]\n\n"),
            )
        } else {
            let mut response = base;
            response["object"] = json!("chat.completion");
            response["choices"] = json!([{"index": 0, "message": {"role": "assistant", "content": reply}, "finish_reason": "stop"}]);
            ("application/json", response.to_string())
        }
    } else if line.starts_with("GET ") && line.contains("/models") {
        let models =
            json!({"object": "list", "data": [{"id": "fixture-model", "object": "model"}]});
        ("application/json", models.to_string())
    } else {
        panic!("unexpected model request: {line}");
    };
    let _ = socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )
        .await;
}

/// The default Docker bridge's gateway address: the host, as sandboxes on
/// the engine reach it.
fn bridge_gateway(engine: &str) -> String {
    let output = Command::new("docker")
        .args(["--host", engine, "network", "inspect", "bridge", "--format"])
        .arg("{{range .IPAM.Config}}{{.Gateway}}{{end}}")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "docker network inspect bridge failed"
    );
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

/// The text a terminal shows for `bytes`, without control sequences.
fn visible(bytes: &[u8]) -> String {
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

fn quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

/// A command running in a local pseudo-terminal, whose output is collected.
struct Terminal {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: Arc<Mutex<Vec<u8>>>,
}

impl Terminal {
    /// Run `command` in a 40 by 120 pseudo-terminal that util-linux's
    /// `script` allocates, as an interactive terminal would.
    fn start(command: &str, environment: &[(&str, &str)], home: &std::path::Path) -> Self {
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

    fn mark(&self) -> usize {
        self.output.lock().unwrap().len()
    }

    /// Wait until the terminal shows `text` after `mark`.
    fn wait_for(&self, mark: usize, text: &str, timeout: Duration) {
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

    fn send(&mut self, keys: &str) {
        self.input.write_all(keys.as_bytes()).unwrap();
        self.input.flush().unwrap();
    }

    /// Wait for the command to exit by itself, or kill it.
    fn exited_within(&mut self, timeout: Duration) -> bool {
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

fn token() -> String {
    let mut bytes = [0u8; 6];
    getrandom::fill(&mut bytes).unwrap();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified bundle, the Deep Agents Code image on local Docker, an owned managed-gateway document, the OpenShell CLI and util-linux's script; creates Docker resources and retains gateway storage"]
async fn the_deep_agents_code_terminal_answers_a_prompt_with_the_generated_configuration() {
    let config = required("NEMOCLAW_TEST_TERMINAL_DOCUMENT");
    let bundle = std::path::PathBuf::from(required("NEMOCLAW_TEST_BUNDLE"));
    let openshell = required("NEMOCLAW_TEST_OPENSHELL");
    let mut value: Value =
        serde_saphyr::from_str(&std::fs::read_to_string(&config).unwrap()).unwrap();
    let Gateway::Managed(gateway) = &Document::parse(value.to_string().as_bytes())
        .unwrap()
        .spec
        .gateway
    else {
        panic!("the terminal document must use a managed gateway");
    };
    let engine = gateway.engine.clone();

    // The model stand-in listens where sandboxes on the engine reach the host.
    let answered = Arc::new(Mutex::new(Vec::new()));
    let listener = tokio::net::TcpListener::bind(format!("{}:0", bridge_gateway(&engine)))
        .await
        .unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let server = {
        let answered = answered.clone();
        tokio::spawn(async move {
            loop {
                let (socket, _) = listener.accept().await.unwrap();
                tokio::spawn(answer(socket, answered.clone()));
            }
        })
    };
    let providers = value["spec"]["inferenceProviders"].as_object_mut().unwrap();
    assert_eq!(
        providers.len(),
        1,
        "the document names one inference provider"
    );
    for provider in providers.values_mut() {
        provider["endpoint"] = json!(endpoint);
    }
    let document = Document::parse(value.to_string().as_bytes()).unwrap();
    let sandbox = document.sandboxes().next().unwrap();
    let harness = document.sandbox_harness(sandbox).unwrap();
    assert_eq!(
        harness.kind,
        "nvidia.fabric.langchain.deepagents-code".parse().unwrap()
    );
    assert_eq!(
        harness.settings.as_ref().unwrap()["interfaces"],
        json!({"terminal": {}})
    );
    let inputs = tempfile::tempdir().unwrap();
    let applied_config = inputs.path().join("deployment.yaml");
    // JSON is YAML, so the CLI reads it as the authored document.
    std::fs::write(&applied_config, value.to_string()).unwrap();

    let state = KeepOnFailure(Some(tempfile::tempdir().unwrap()));
    let state_path = state.0.as_ref().unwrap().path().to_owned();
    let apply = Command::new(
        bundle
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
    )
    .args(["apply", "-o", "json", "--progress", "off", "--state-dir"])
    .arg(&state_path)
    .arg(&applied_config)
    .output()
    .unwrap();
    assert!(
        apply.status.success(),
        "apply failed: {}",
        String::from_utf8_lossy(&apply.stderr)
    );
    let applied: OperationResult = serde_json::from_slice(&apply.stdout).unwrap();
    assert_eq!(applied.outcome, Outcome::Succeeded);
    let runtime = runtime_id(&state_path, sandbox.name);

    // An invocation through Fabric uses the runtime's ACP session.
    let client = OpenShell::connect(
        &document.spec.gateway.connection(),
        Arc::new(EnvironmentSecrets),
    )
    .unwrap();
    let binding =
        fabric_provider::fabric_binding(sandbox_binding(&state_path, sandbox.name)).unwrap();
    let invoked = token();
    let result = client
        .invoke_agent(
            &binding,
            &runtime,
            &json!(format!("Reply with token {invoked}")),
        )
        .await
        .unwrap();
    assert_eq!(result["status"], "succeeded", "{result}");
    assert_eq!(
        result["output"]["response"],
        format!("REPLY-{}", invoked.to_ascii_uppercase()),
        "{result}"
    );

    // A person opens the terminal UI with the launcher apply reported, which
    // the adapter wrote for the current runtime.
    let launcher = format!(
        "/sandbox/artifacts/.fabric/deepagents-code/runtimes/{runtime}/interfaces/terminal"
    );
    assert_eq!(
        applied.interfaces,
        [InterfaceAccess {
            sandbox: sandbox.name.into(),
            interface: "terminal".into(),
            port: None,
            token_path: None,
            launcher: Some(launcher.clone()),
            sign_in: SignIn::SandboxExec,
        }]
    );
    let home = tempfile::tempdir().unwrap();
    let gateway_endpoint = document.spec.gateway.connection().endpoint.to_string();
    let workspace = document.workspace();
    let mut terminal = Terminal::start(
        &format!(
            "{} sandbox exec -n {} --tty -- {}",
            quoted(&openshell),
            quoted(sandbox.name),
            quoted(&launcher)
        ),
        &[
            ("OPENSHELL_GATEWAY_ENDPOINT", gateway_endpoint.as_str()),
            ("OPENSHELL_WORKSPACE", workspace.as_str()),
        ],
        home.path(),
    );
    // A new Deep Agents Code home first asks for a name and offers to choose
    // a model. Escape skips both, keeping the generated configuration's model.
    terminal.wait_for(0, "Enter to continue", Duration::from_secs(90));
    terminal.wait_for(0, "openai:fixture-model", Duration::from_secs(10));
    terminal.send("\x1b");
    // A terminal reads Escape followed at once by a key as Alt and that key.
    std::thread::sleep(Duration::from_secs(2));
    let typed = token();
    let mark = terminal.mark();
    terminal.send(&format!("Reply with token {typed}"));
    terminal.wait_for(mark, &typed, Duration::from_secs(10));
    let mark = terminal.mark();
    terminal.send("\r");
    let reply = format!("REPLY-{}", typed.to_ascii_uppercase());
    terminal.wait_for(mark, &reply, Duration::from_secs(90));
    // Ctrl-D quits the terminal UI, ending the session.
    terminal.send("\x04");
    assert!(
        terminal.exited_within(Duration::from_secs(30)),
        "the terminal session did not end after Ctrl-D"
    );
    drop(terminal);
    let terminal_requests: Vec<Answered> = answered
        .lock()
        .unwrap()
        .iter()
        .filter(|request| request.reply == reply)
        .cloned()
        .collect();
    assert!(
        !terminal_requests.is_empty()
            && terminal_requests
                .iter()
                .all(|request| request.model == "fixture-model"),
        "the terminal's prompt must reach the configured model: {terminal_requests:?}"
    );

    let deployment = Deployment::new(&state_path, &bundle);
    let cancel = CancellationToken::new();
    let destroyed = deployment.destroy(&cancel).await.unwrap();
    assert_eq!(destroyed.outcome, Outcome::Destroyed);
    server.abort();
}
