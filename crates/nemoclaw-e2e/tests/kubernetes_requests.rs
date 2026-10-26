// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Requests to the agents of the shared Kind flow, answered by a fixed stub.
//!
//! The test places the stub in its own namespace, as a platform places a
//! model server, and the agents reach it through its Service. It answers
//! every chat completion request with one streamed reply, so no model runs.
//! Fabric reports no runtime status (NVIDIA/NeMo-Fabric#420): a runtime that
//! stops is found at its next invocation. An answer from the runtime ID the
//! first apply recorded therefore shows that this runtime still runs. The
//! reply does not establish inference or model compatibility.
use super::*;
use fabric_provider::AgentBridge as _;
use nemoclaw_e2e::state::successful_invocation;
use nemoclaw_sdk::{backend::Row, kubernetes::Connection};

/// The stub's Service name and port.
const SERVICE: &str = "model";
const PORT: u16 = 8000;
/// The agents' endpoint path on the stub. OpenClaw and Pi post each request
/// to `<endpoint>/chat/completions`.
const BASE_PATH: &str = "/v1";
/// How long a request round may take; a working round takes a few seconds.
/// Fabric's bridge waits up to 330 s for one request, and nextest stops a
/// live-kind test after 240 s, so the flow abandons a slower request to reach
/// destroy. Fabric keeps running an abandoned request and handles the agent's
/// next command, including destroy's stop, only after it ends; the test cannot
/// bound that wait.
const ROUND: Duration = Duration::from_secs(30);
/// What each agent is asked: plain text, which Pi requires, and the stub
/// ignores the request.
const PROMPT: &str = "Reply to this NemoClaw live test.";

/// A stub model server in its own namespace.
pub(super) struct Stub {
    pub namespace: String,
    /// The text of every reply, unique to the run.
    pub reply: String,
}

impl Stub {
    /// A stub to run in `namespace`, with a new reply.
    pub fn new(namespace: String) -> Self {
        Self {
            namespace,
            reply: format!("nemoclaw-stub-{}", random_hex(8)),
        }
    }

    /// Create the stub's namespace and start the stub in it, without waiting
    /// for its pod.
    pub async fn place(&self, client: &kube::Client) {
        let objects = objects(&self.namespace, &self.reply);
        Api::<Namespace>::all(client.clone())
            .create(
                &kube::api::PostParams::default(),
                &serde_json::from_value(json!({"metadata": {"name": self.namespace}})).unwrap(),
            )
            .await
            .expect("cannot create the stub model's namespace");
        for object in objects {
            create(client, object).await;
        }
    }

    /// The agents' inference endpoint: the stub's Service by its cluster DNS
    /// name, as a user names a model server they run in the cluster.
    pub fn endpoint(&self) -> String {
        format!(
            "http://{SERVICE}.{}.svc.cluster.local:{PORT}{BASE_PATH}",
            self.namespace
        )
    }

    /// Wait at most 60 s for the stub's pod to be ready.
    pub async fn ready(&self, client: &kube::Client) -> Result<(), String> {
        use k8s_openapi::api::apps::v1::Deployment as KubeDeployment;
        let deployments = Api::<KubeDeployment>::namespaced(client.clone(), &self.namespace);
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        loop {
            let ready = deployments
                .get(SERVICE)
                .await
                .ok()
                .and_then(|deployment| deployment.status?.ready_replicas)
                .unwrap_or(0);
            if ready > 0 {
                return Ok(());
            }
            if std::time::Instant::now() >= deadline {
                return Err(format!(
                    "the stub model in {} was not ready within 60 s",
                    self.namespace
                ));
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }

    /// Delete the stub's namespace without waiting for it to go.
    pub async fn remove(&self, client: &kube::Client) {
        let _ = Api::<Namespace>::all(client.clone())
            .delete(&self.namespace, &Default::default())
            .await;
    }
}

/// The image the development issuer runs, from the repository's pins.
fn image() -> String {
    let pins: Value = serde_json::from_str(include_str!("../../../versions.json")).unwrap();
    pins["images"]["developmentIssuer"]
        .as_str()
        .expect("versions.json pins the development issuer's image")
        .to_owned()
}

/// The stream every request gets: one OpenAI chat completion of `reply`, in
/// the chunks Fabric's own Pi tests serve.
fn stream(reply: &str) -> String {
    let chunk = |delta: Value, finish: Value| {
        let chunk = json!({
            "id": "chatcmpl-nemoclaw-stub",
            "object": "chat.completion.chunk",
            "created": 0,
            "model": "fixture-model",
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
        });
        format!("data: {chunk}\n\n")
    };
    [
        chunk(json!({"role": "assistant"}), Value::Null),
        chunk(json!({"content": reply}), Value::Null),
        chunk(json!({}), json!("stop")),
        "data: [DONE]\n\n".into(),
    ]
    .concat()
}

/// The nginx configuration that answers every chat completion request with
/// `reply`. nginx's static handler refuses POST, so `return` answers, and
/// discards the request body. Its text is a single-quoted string in which
/// nginx expands variables and backslash escapes; the stream holds no `$`,
/// `'` or `\`, and its line breaks are written as `\n`.
fn configuration(reply: &str) -> String {
    let text = stream(reply).replace('\n', "\\n");
    format!(
        r#"worker_processes 1;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;
events {{ worker_connections 1024; }}
http {{
    access_log /dev/stdout;
    client_body_temp_path /tmp/client_temp;
    proxy_temp_path /tmp/proxy_temp;
    fastcgi_temp_path /tmp/fastcgi_temp;
    uwsgi_temp_path /tmp/uwsgi_temp;
    scgi_temp_path /tmp/scgi_temp;
    server {{
        listen {PORT};
        location = {BASE_PATH}/chat/completions {{
            default_type text/event-stream;
            return 200 '{text}';
        }}
        location / {{ return 404; }}
    }}
}}
"#
    )
}

/// The stub's ConfigMap, Service and Deployment, in creation order. The pod
/// runs like the development issuer's: unprivileged, with a read-only root
/// filesystem.
fn objects(namespace: &str, reply: &str) -> Vec<Value> {
    let metadata = json!({"name": SERVICE, "namespace": namespace});
    let selector = json!({"app.kubernetes.io/name": "nemoclaw-test-model"});
    vec![
        json!({"apiVersion": "v1", "kind": "ConfigMap", "metadata": metadata,
               "data": {"default.conf": configuration(reply)}}),
        json!({"apiVersion": "v1", "kind": "Service", "metadata": metadata, "spec": {
            "selector": selector, "ports": [{"port": PORT, "targetPort": PORT, "protocol": "TCP"}],
        }}),
        json!({"apiVersion": "apps/v1", "kind": "Deployment", "metadata": metadata, "spec": {
            "replicas": 1,
            "selector": {"matchLabels": selector},
            "template": {"metadata": {"labels": selector}, "spec": {
                "automountServiceAccountToken": false,
                "securityContext": {"runAsNonRoot": true, "seccompProfile": {"type": "RuntimeDefault"}},
                "containers": [{
                    "name": "model",
                    "image": image(),
                    "imagePullPolicy": "IfNotPresent",
                    // Skip the image's entrypoint scripts, which edit its configuration.
                    "command": ["nginx", "-c", "/etc/nginx/conf.d/default.conf", "-g", "daemon off;"],
                    "ports": [{"containerPort": PORT}],
                    "readinessProbe": {"tcpSocket": {"port": PORT}, "periodSeconds": 1},
                    "resources": {
                        "requests": {"cpu": "10m", "memory": "16Mi"},
                        "limits": {"cpu": "100m", "memory": "64Mi"},
                    },
                    "securityContext": {
                        "readOnlyRootFilesystem": true,
                        "allowPrivilegeEscalation": false,
                        "capabilities": {"drop": ["ALL"]},
                    },
                    "volumeMounts": [
                        {"name": "configuration", "mountPath": "/etc/nginx/conf.d", "readOnly": true},
                        {"name": "scratch", "mountPath": "/tmp"},
                    ],
                }],
                "volumes": [
                    {"name": "configuration", "configMap": {"name": SERVICE}},
                    {"name": "scratch", "emptyDir": {"sizeLimit": "16Mi"}},
                ],
            }},
        }}),
    ]
}

/// An agent a request round invokes: its sandbox's binding and its runtime
/// ID, both as the first apply recorded them.
pub(super) struct Agent {
    pub sandbox: String,
    pub name: String,
    pub binding: Row,
    pub runtime: String,
}

/// What became of one agent's request in a round.
#[derive(Debug)]
pub(super) enum Answer {
    /// Fabric's bridge returned this run result.
    Ran(Value),
    /// No result, for this reason.
    Failed(String),
    /// The round ended first. Fabric may still be running the request.
    Abandoned,
}

/// Connect to the managed gateway that `binding` records, as the SDK's
/// providers do. The connection holds the port-forward.
async fn gateway(
    operations: &Operations,
    binding: &Row,
) -> Result<(Connection, OpenShell), String> {
    let spec: Spec = binding
        .get("gateway_kubernetes")
        .and_then(|spec| serde_json::from_str(spec).ok())
        .ok_or("the binding names no managed Kubernetes gateway")?;
    let connection = operations
        .connect(&spec)
        .await
        .map_err(|error| format!("cannot connect to the gateway: {error}"))?;
    let client = gateway_client(&connection, connection.environment())
        .map_err(|error| format!("cannot connect to the gateway: {error}"))?;
    Ok((connection, client))
}

/// Send the prompt to every agent at once through Fabric's bridge, and return
/// each agent's answer in the order of `agents`. An agent whose request in
/// the `earlier` round was abandoned is not asked again, because a second
/// request would wait behind the first.
pub(super) async fn round(
    operations: &Operations,
    agents: &[Agent],
    earlier: &[Answer],
) -> Vec<Answer> {
    let deadline = tokio::time::Instant::now() + ROUND;
    let mut answers: Vec<Option<Answer>> = (0..agents.len())
        .map(|index| {
            matches!(earlier.get(index), Some(Answer::Abandoned)).then(|| {
                Answer::Failed("not sent: Fabric may still be running the abandoned request".into())
            })
        })
        .collect();
    let mut abandoned = false;
    if answers.iter().any(Option::is_none) {
        match tokio::time::timeout_at(deadline, gateway(operations, &agents[0].binding)).await {
            Err(_) => {
                for answer in answers.iter_mut().filter(|answer| answer.is_none()) {
                    *answer = Some(Answer::Failed("connecting to the gateway timed out".into()));
                }
            }
            Ok(Err(error)) => {
                for answer in answers.iter_mut().filter(|answer| answer.is_none()) {
                    *answer = Some(Answer::Failed(error.clone()));
                }
            }
            Ok(Ok((_connection, client))) => {
                let mut requests = tokio::task::JoinSet::new();
                for (index, agent) in agents.iter().enumerate() {
                    if answers[index].is_some() {
                        continue;
                    }
                    let client = client.clone();
                    let binding = agent.binding.clone();
                    let runtime = agent.runtime.clone();
                    requests.spawn(async move {
                        let answer = match fabric_provider::fabric_binding(binding) {
                            Ok(binding) => client
                                .invoke_agent(&binding, &runtime, &json!(PROMPT))
                                .await
                                .map_or_else(
                                    |error| Answer::Failed(format!("the request failed: {error}")),
                                    Answer::Ran,
                                ),
                            Err(error) => {
                                Answer::Failed(format!("the binding is unusable: {error}"))
                            }
                        };
                        (index, answer)
                    });
                }
                loop {
                    match tokio::time::timeout_at(deadline, requests.join_next()).await {
                        Ok(Some(Ok((index, answer)))) => answers[index] = Some(answer),
                        Ok(Some(Err(_))) => {}
                        Ok(None) => break,
                        Err(_) => {
                            abandoned = true;
                            break;
                        }
                    }
                }
            }
        }
    }
    answers
        .into_iter()
        .map(|answer| {
            answer.unwrap_or_else(|| {
                if abandoned {
                    Answer::Abandoned
                } else {
                    Answer::Failed("the request ended without a result".into())
                }
            })
        })
        .collect()
}

/// Why `answer` does not show that `agent`'s runtime from the first apply
/// still runs and answered with the stub's `reply`.
fn problem(agent: &Agent, answer: &Answer, reply: &str) -> Option<String> {
    let result = match answer {
        Answer::Failed(reason) => return Some(reason.clone()),
        Answer::Abandoned => return Some(format!("no answer within {} s", ROUND.as_secs())),
        Answer::Ran(result) => result,
    };
    if result["runtime_id"] != agent.runtime.as_str() {
        return Some(format!(
            "runtime {} answered, not the first apply's {}",
            result["runtime_id"], agent.runtime
        ));
    }
    if result["agent_name"] != agent.name.as_str() {
        return Some(format!(
            "agent {} answered, not {}",
            result["agent_name"], agent.name
        ));
    }
    if !successful_invocation(&serde_json::to_vec(result).unwrap()) {
        return Some(format!(
            "the run did not succeed: status {}, error {}",
            result["status"], result["error"]
        ));
    }
    if !result["output"].to_string().contains(reply) {
        return Some("the output does not hold the stub's reply".into());
    }
    None
}

/// What is wrong with each agent's answer in `round`, naming its sandbox and
/// the round. `answers` are in the order of `agents`.
pub(super) fn problems(
    round: &str,
    agents: &[Agent],
    answers: &[Answer],
    reply: &str,
) -> Vec<String> {
    agents
        .iter()
        .zip(answers)
        .filter_map(|(agent, answer)| {
            let problem = problem(agent, answer, reply)?;
            Some(format!("sandbox {} {round}: {problem}", agent.sandbox))
        })
        .collect()
}

fn agent(sandbox: &str) -> Agent {
    Agent {
        sandbox: sandbox.into(),
        name: format!("{sandbox}-agent"),
        binding: Row::new(),
        runtime: format!("{sandbox}-runtime"),
    }
}

fn answered(agent: &Agent, reply: &str) -> Value {
    json!({
        "agent_name": agent.name,
        "runtime_id": agent.runtime,
        "status": "succeeded",
        "output": {"response": reply},
        "error": null,
    })
}

#[test]
fn each_agent_must_answer_from_the_first_runtime_with_the_reply() {
    let reply = "nemoclaw-stub-0123abcd";
    let agents = [agent("assistant"), agent("researcher")];
    let answers = |researcher: Answer| [Answer::Ran(answered(&agents[0], reply)), researcher];
    let good = answered(&agents[1], reply);
    assert_eq!(
        problems(
            "after the reapply",
            &agents,
            &answers(Answer::Ran(good.clone())),
            reply
        ),
        Vec::<String>::new()
    );
    let mut other_runtime = good.clone();
    other_runtime["runtime_id"] = json!("another-runtime");
    let mut other_agent = good.clone();
    other_agent["agent_name"] = json!("assistant-agent");
    let mut failed = good.clone();
    failed["status"] = json!("failed");
    failed["error"] = json!({"code": "pi_model_error", "message": "unreachable"});
    let mut other_reply = good.clone();
    other_reply["output"] = json!({"response": "nemoclaw-stub-ffff"});
    for (defect, answer) in [
        ("another runtime", Answer::Ran(other_runtime)),
        ("another agent", Answer::Ran(other_agent)),
        ("a failed run", Answer::Ran(failed)),
        ("another reply", Answer::Ran(other_reply)),
        ("no result", Answer::Failed("runtime_unavailable".into())),
        ("no answer in time", Answer::Abandoned),
    ] {
        let found = problems("after the reapply", &agents, &answers(answer), reply);
        assert_eq!(found.len(), 1, "{defect}: {found:?}");
        assert!(
            found[0].starts_with("sandbox researcher after the reapply: "),
            "{defect}: {found:?}"
        );
    }
}

#[tokio::test]
async fn an_agent_whose_earlier_request_was_abandoned_is_not_asked_again() {
    let operations = Operations {
        client: nemoclaw_sdk::kubernetes::client(kube::Config::new(
            "http://127.0.0.1:9".parse().unwrap(),
        ))
        .unwrap(),
        server: "http://127.0.0.1:9".into(),
        state: PathBuf::new(),
        openshift_wait: Duration::ZERO,
    };
    let agents = [agent("assistant"), agent("researcher")];
    let answers = round(
        &operations,
        &agents,
        &[Answer::Ran(Value::Null), Answer::Abandoned],
    )
    .await;
    // The test bindings name no gateway, so a request that is sent fails
    // before it connects.
    assert!(
        matches!(&answers[..], [Answer::Failed(sent), Answer::Failed(skipped)]
            if sent.contains("no managed Kubernetes gateway") && skipped.starts_with("not sent")),
        "{answers:?}"
    );
}
