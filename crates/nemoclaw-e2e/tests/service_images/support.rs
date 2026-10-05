// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_e2e::{http_fixture as docker, openshell::Fixture};
use nemoclaw_sdk::{
    CancellationToken, Deployment,
    config::Document,
    fabric_catalog::{FabricAdapter, FabricCatalog},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub fn docker_output(args: &[&str], input: &[u8]) -> Value {
    let mut child = Command::new("docker")
        .args(["--host", "unix:///var/run/docker.sock"])
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let collect = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            pipe.read_to_end(&mut bytes).unwrap();
            bytes
        })
    };
    let stdout = collect(Box::new(child.stdout.take().unwrap()));
    let stderr = collect(Box::new(child.stderr.take().unwrap()));
    child.stdin.take().unwrap().write_all(input).unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(90);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            child.wait().unwrap();
            let _ = stdout.join();
            let error = stderr.join().unwrap();
            panic!(
                "docker {args:?} timed out: {}",
                String::from_utf8_lossy(&error)
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    json!({"code":status.code().unwrap_or(-1),"stdout":stdout.join().unwrap(),"stderr":stderr.join().unwrap()})
}
fn bytes(value: &Value, key: &str) -> Vec<u8> {
    serde_json::from_value(value[key].clone()).unwrap()
}
pub fn docker(args: &[&str]) -> Vec<u8> {
    let result = docker_output(args, &[]);
    assert_eq!(
        result["code"],
        0,
        "docker {args:?}: {}",
        String::from_utf8_lossy(&bytes(&result, "stderr"))
    );
    bytes(&result, "stdout")
}
fn inspect(kind: &str, name: &str) -> Value {
    serde_json::from_slice::<Value>(&docker(&[kind, "inspect", name])).unwrap()[0].clone()
}

fn assert_absent(kind: &str, name: &str) {
    let result = docker_output(&[kind, "inspect", name], &[]);
    assert_ne!(result["code"], 0, "{kind} {name} still exists");
    let error = String::from_utf8(bytes(&result, "stderr")).unwrap();
    assert!(
        error.contains("No such container") || error.contains("No such object"),
        "absence was not confirmed: {error}"
    );
}

/// Reapply through the selected SDK instance, including an explicitly reopened one.
pub async fn assert_apply_unchanged(
    deployment: &Deployment,
    document: &Document,
    cancel: &CancellationToken,
) {
    let result = deployment.apply(document, cancel).await.unwrap();
    assert!(
        result.changes.is_empty(),
        "reapply changed resources: {:?}",
        result.changes
    );
}

pub fn with_upstream_model_digest(document: &Document, digest: &str) -> Document {
    let mut value = serde_json::to_value(document).unwrap();
    value["spec"]["services"]["shared"]["upstream"]["model"]["digest"] = json!(digest);
    Document::parse(value.to_string().as_bytes()).unwrap()
}

pub struct Scenario {
    pub state: tempfile::TempDir,
    pub bundle: PathBuf,
    pub gateway: Fixture,
    pub agents: Arc<ImageAgents>,
    pub uid: String,
    proxy_image: String,
    upstream: String,
    endpoint: String,
    _metadata: docker::Fixture,
    requests: Arc<Mutex<Vec<String>>>,
    allow_inference: Arc<AtomicBool>,
    servers: tokio::task::JoinSet<()>,
}

impl Scenario {
    pub async fn start() -> Self {
        let state = tempfile::tempdir().unwrap();
        let hash: String = Sha256::digest(state.path().to_string_lossy().as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        let uid = format!(
            "{}-{}-{}-{}-{}",
            &hash[..8],
            &hash[8..12],
            &hash[12..16],
            &hash[16..20],
            &hash[20..32]
        );
        let bundle =
            PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").expect("verified bundle"));
        let image =
            std::env::var("NEMOCLAW_TEST_AGENT_IMAGE").expect("explicit digest-pinned agent image");
        assert!(image.contains("@sha256:"));
        let profile: Value = serde_json::from_slice(
            &fs::read(std::env::var_os("NEMOCLAW_TEST_AGENT_PROFILE").expect("agent profile JSON"))
                .unwrap(),
        )
        .unwrap();
        let proxy_image = std::env::var("NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE")
            .expect("explicit digest-pinned proxy image");
        assert!(proxy_image.contains("@sha256:"));
        let installed = inspect("image", &image);
        let mut catalog = if installed["Config"]["Labels"]["io.nemoclaw.fabric.reference"]
            == "dummy"
        {
            // The dummy intentionally ships no catalog. This protocol fixture
            // supplies an explicit test descriptor, never production discovery.
            let mut catalog = nemoclaw_e2e::image_runtime::catalog();
            catalog.adapters = vec![FabricAdapter {
                provenance: json!([{"source":"explicit_local","path":"/fixture/dummy.json","root":"/fixture"}]),
                descriptor: json!({"contract_version":"fabric.adapter/v1alpha2","adapter_id":"org.nemoclaw.dummy","adapter_kind":"python","runner":{"module":"dummy_backend"},
                    "settings_schema":{"type":"object","properties":{"reply":{"type":"string"}},"additionalProperties":false},
                    "config":{"accepts":["models","models.base_url"]},"extension_schemas":{"model":{"type":"object","properties":{"api":{"enum":["openai-completions"]},"settings":{"type":"object"}},"additionalProperties":false}}}),
            }];
            catalog.targets.clear();
            catalog.runtime_files.clear();
            catalog.runtime.as_mut().unwrap().binaries = [(
                "org.nemoclaw.dummy".into(),
                vec!["/opt/fabric/bin/python".into()],
            )]
            .into();
            catalog
        } else {
            FabricCatalog::from_json(
                installed["Config"]["Labels"]["io.nemoclaw.fabric.catalog"]
                    .as_str()
                    .expect("installed catalog"),
            )
            .unwrap()
        };
        catalog.bridge = Some(
            serde_json::from_str(
                installed["Config"]["Labels"]["io.nemoclaw.fabric.bridge"]
                    .as_str()
                    .unwrap(),
            )
            .unwrap(),
        );
        let mut metadata = installed;
        metadata["Config"]["Labels"]["io.nemoclaw.fabric.catalog"] =
            json!(serde_json::to_string(&catalog).unwrap());
        let metadata_server = docker::Fixture::start(move |request| {
            assert_eq!(request.method, "GET", "discovery must not mutate the engine");
            let value = if request.path == "/info" { json!({"ID":"image-fixture","Architecture":metadata["Architecture"],"OSType":"linux","ServerVersion":"28.0"}) } else {
                assert!(request.path.starts_with("/images/") && request.path.ends_with("/json"));
                metadata.clone()
            };
            Some((200, serde_json::to_vec(&value).unwrap()))
        }).await;
        let requests = Arc::new(Mutex::new(vec![]));
        let allow_inference = Arc::new(AtomicBool::new(false));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream = format!("http://{}/v1", listener.local_addr().unwrap());
        let mut servers = tokio::task::JoinSet::new();
        servers.spawn(super::model_server::serve(
            listener,
            requests.clone(),
            allow_inference.clone(),
            None,
            profile["expected_reply"].as_str().unwrap().to_owned(),
        ));
        let bridge = inspect("network", "bridge");
        let bind = bridge["IPAM"]["Config"][0]["Gateway"].as_str().unwrap();
        let port = std::net::TcpListener::bind(format!("{bind}:0"))
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let agents = Arc::new(ImageAgents {
            image,
            profile,
            prefix: format!("nc-service-test-{}", &hash[..12]),
            names: Mutex::new(vec![]),
        });
        let gateway = Fixture::start().await;
        gateway.state.lock().unwrap().sandbox_execution = Some(agents.clone());
        Self {
            state,
            bundle,
            gateway,
            agents,
            uid,
            proxy_image,
            upstream,
            endpoint: format!("http://{bind}:{port}/v1"),
            _metadata: metadata_server,
            requests,
            allow_inference,
            servers,
        }
    }
    pub async fn managed_model_endpoint(&mut self, engine: PathBuf) -> String {
        let network = inspect("network", "bridge");
        let bind = network["IPAM"]["Config"][0]["Gateway"].as_str().unwrap();
        let listener = tokio::net::TcpListener::bind(format!("{bind}:0"))
            .await
            .unwrap();
        let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
        self.servers.spawn(super::model_server::serve(
            listener,
            self.requests.clone(),
            self.allow_inference.clone(),
            Some(engine),
            self.agents.profile["expected_reply"]
                .as_str()
                .unwrap()
                .to_owned(),
        ));
        self.endpoint = endpoint.clone();
        endpoint
    }
    pub async fn proxy_document(&self, count: usize) -> Document {
        let mut value: Value = serde_saphyr::from_str(include_str!(
            "../../../nemoclaw-sdk/tests/fixtures/config/local.yaml"
        ))
        .unwrap();
        value["metadata"]["uid"] = json!(self.uid);
        value["spec"]["gateway"] = json!({"management":"external","endpoint":self.gateway.endpoint,"engine":self._metadata.endpoint});
        value["spec"]["inferenceProviders"] = json!([{"name":"local","provider":"openai","api":"openai-completions","serviceRef":"shared"}]);
        value["spec"]["services"] = json!({"shared":{"kind":"ollamaProxy","engine":"unix:///var/run/docker.sock","image":self.proxy_image,"imagePullPolicy":"Never","endpoint":self.endpoint,"upstream":{"endpoint":self.upstream,"model":{"name":"llama3:fixture","digest":"a".repeat(64)}}}});
        let mut sandbox = value["spec"]["sandboxes"][0].clone();
        sandbox["image"]["ref"] = json!(self.agents.image);
        sandbox["harness"] = self.agents.profile["harness"].clone();
        sandbox["agent"]["inference"]["routes"][0]["overrides"]["model"] = json!("llama3:fixture");
        value["spec"]["sandboxes"] = json!(
            (0..count)
                .map(|index| {
                    let mut item = sandbox.clone();
                    item["name"] = json!(format!("assistant-{index}"));
                    item
                })
                .collect::<Vec<_>>()
        );
        Document::parse(value.to_string().as_bytes()).unwrap()
    }
    pub fn service_name(&self, document: &Document) -> String {
        format!("{}-ollama-proxy-shared", document.workspace())
    }
    pub fn service_identity(&self, document: &Document) -> Value {
        let name = self.service_name(document);
        let container = inspect("container", &name);
        let volume = inspect("volume", &format!("{name}-auth"));
        json!({"container":container["Id"],"volume_created":volume["CreatedAt"],"volume_labels":volume["Labels"]})
    }
    pub fn agent_identity(&self, name: &str) -> Value {
        inspect("container", &self.agents.name(name))["Id"].clone()
    }
    pub fn assert_no_resources(&self) {
        assert!(self.gateway.state.lock().unwrap().sandboxes.is_empty());
        assert!(self.agents.names.lock().unwrap().is_empty());
        let filter = format!("label=nemoclaw.nvidia.com/uid={}", self.uid);
        assert!(docker(&["container", "ls", "--all", "-q", "--filter", &filter]).is_empty());
        assert!(docker(&["volume", "ls", "-q", "--filter", &filter]).is_empty());
    }
    pub fn assert_agent_absent(&self, name: &str) {
        assert_absent("container", &self.agents.name(name));
    }
    pub fn assert_agent_responds(&self, name: &str) {
        let before = self.requests.lock().unwrap().len();
        self.allow_inference.store(true, Ordering::SeqCst);
        let result = docker_output(
            &[
                "exec",
                "-i",
                &self.agents.name(name),
                "fabric-agent",
                "invoke",
                "--agent",
                "main",
                "--input",
                "-",
            ],
            self.agents.profile["invocation"].to_string().as_bytes(),
        );
        self.allow_inference.store(false, Ordering::SeqCst);
        if self.agents.profile["expects_inference"] == true {
            assert!(
                self.requests.lock().unwrap()[before..]
                    .iter()
                    .any(|line| line.starts_with("POST /v1/chat/completions ")),
                "native agent never used the configured service"
            );
        }
        assert_eq!(
            result["code"],
            0,
            "{}",
            String::from_utf8_lossy(&bytes(&result, "stdout"))
        );
        let response: Value = serde_json::from_slice(&bytes(&result, "stdout")).unwrap();
        assert_eq!(response["status"], "succeeded");
        assert_eq!(response["result"]["fabric_result"]["status"], "succeeded");
        assert!(
            response["result"]["fabric_result"]["output"]
                .to_string()
                .contains(self.agents.profile["expected_reply"].as_str().unwrap())
        );
    }
    pub fn assert_agent_service_access(&self, name: &str) {
        // The dummy does not perform inference. Exercise the actual deployed
        // model connection from each container, using its applied configuration
        // and gateway-injected credential, without teaching the mock to infer.
        let script = r#"import json,os,subprocess,sys,urllib.request
reply=json.loads(subprocess.check_output(['fabric-agent','check','--agent','main']))
model=reply['result']['applied_config']['models']['default']
assert model['base_url']==sys.argv[1], 'wrong shared endpoint'
headers={}
if model['api_key_env']!='NEMOCLAW_ANONYMOUS_API_KEY':
 key=os.environ[model['api_key_env']]
 assert key, 'missing injected credential'
 headers={'Authorization':'Bearer '+key}
request=urllib.request.Request(model['base_url'].rstrip('/')+'/models',headers=headers)
with urllib.request.urlopen(request,timeout=5) as response:
 data=json.load(response)
assert any(item['id']==model['model'] for item in data['data']), 'configured model unavailable'
"#;
        let result = docker_output(
            &[
                "exec",
                &self.agents.name(name),
                "/opt/fabric/bin/python",
                "-c",
                script,
                &self.endpoint,
            ],
            &[],
        );
        assert_eq!(
            result["code"],
            0,
            "service access failed: {}",
            String::from_utf8_lossy(&bytes(&result, "stderr"))
        );
    }
    pub fn assert_shared_service(&self, document: &Document, count: usize) {
        let state = self.gateway.state.lock().unwrap();
        assert_eq!(state.sandboxes.len(), count);
        let selected: Vec<_> = state
            .sandboxes
            .values()
            .map(|sandbox| sandbox.spec.as_ref().unwrap().providers.clone())
            .collect();
        assert!(!selected[0].is_empty());
        assert!(selected.iter().all(|providers| providers == &selected[0]));
        assert_eq!(
            state.providers.len(),
            1,
            "one service registration shared by consumers"
        );
        let service = inspect("container", &self.service_name(document));
        assert_eq!(service["State"]["Running"], true);
    }
    pub fn export(&self) -> Document {
        let output = Command::new(self.bundle.join("bin/nemoclaw"))
            .args(["export", "--state-dir"])
            .arg(self.state.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        Document::parse(output.stdout.as_slice()).unwrap()
    }
    pub fn destroy(&self) {
        let output = Command::new(self.bundle.join("bin/nemoclaw"))
            .args(["destroy", "--state-dir"])
            .arg(self.state.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    pub fn assert_service_destroyed_with_credentials_retained(&self, document: &Document) {
        let name = self.service_name(document);
        assert_absent("container", &name);
        assert_eq!(
            inspect("volume", &format!("{name}-auth"))["Labels"]["nemoclaw.nvidia.com/uid"],
            self.uid
        );
    }
    pub async fn assert_external_server_alive(&self) {
        assert!(!self.servers.is_empty());
        let address = self
            .upstream
            .strip_prefix("http://")
            .unwrap()
            .strip_suffix("/v1")
            .unwrap();
        let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
        socket
            .write_all(b"GET /api/tags HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
            .await
            .unwrap();
        let mut response = vec![];
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            socket.read_to_end(&mut response),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(response.starts_with(b"HTTP/1.1 200 OK\r\n"));
        assert!(String::from_utf8_lossy(&response).contains("llama3:fixture"));
        assert!(!self.requests.lock().unwrap().is_empty());
    }
}
impl Drop for Scenario {
    fn drop(&mut self) {
        // The document's workspace algorithm is owned by the SDK. Use retained
        // state labels rather than guessing names when cleaning partial apply.
        for kind in ["container", "volume"] {
            let filter = format!("label=nemoclaw.nvidia.com/uid={}", self.uid);
            let mut args = vec![kind, "ls", "-q", "--filter", &filter];
            if kind == "container" {
                args.push("--all");
            }
            let listed = docker_output(&args, &[]);
            if listed["code"] == 0 {
                for id in String::from_utf8_lossy(&bytes(&listed, "stdout")).lines() {
                    let args = if kind == "container" {
                        vec![kind, "rm", "--force", id]
                    } else {
                        vec![kind, "rm", id]
                    };
                    let _ = docker_output(&args, &[]);
                }
            }
        }
    }
}
pub struct ImageAgents {
    pub image: String,
    pub profile: Value,
    prefix: String,
    names: Mutex<Vec<String>>,
}
impl ImageAgents {
    pub fn name(&self, name: &str) -> String {
        format!("{}-{name}", self.prefix)
    }
}
impl Drop for ImageAgents {
    fn drop(&mut self) {
        for name in self.names.lock().unwrap().iter() {
            let _ = docker_output(&["rm", "--force", name], &[]);
        }
    }
}

impl nemoclaw_e2e::openshell::SandboxExecution for ImageAgents {
    fn create(
        &self,
        sandbox: &openshell_core::proto::Sandbox,
        credentials: &std::collections::HashMap<String, String>,
    ) -> Result<(), tonic::Status> {
        let metadata = sandbox.metadata.as_ref().unwrap();
        let name = self.name(&metadata.name);
        self.names.lock().unwrap().push(name.clone());
        let spec = sandbox.spec.as_ref().unwrap();
        let mut args = vec![
            "run".to_owned(),
            "-d".into(),
            "--name".into(),
            name.clone(),
            "--label".into(),
            format!("org.nemoclaw.test={}", self.prefix),
            "--network".into(),
            "bridge".into(),
            "--read-only".into(),
            "--tmpfs".into(),
            "/sandbox:rw,uid=1000,gid=1000,mode=0700".into(),
            "--tmpfs".into(),
            "/tmp:rw,mode=1777".into(),
        ];
        for (key, value) in spec.environment.iter().chain(credentials) {
            args.extend(["-e".into(), format!("{key}={value}")]);
        }
        args.extend([
            "--entrypoint".into(),
            spec.command[0].clone(),
            self.image.clone(),
        ]);
        args.extend(spec.command[1..].iter().cloned());
        let result = docker_output(&args.iter().map(String::as_str).collect::<Vec<_>>(), &[]);
        if result["code"] != 0 {
            return Err(tonic::Status::internal(
                String::from_utf8_lossy(&bytes(&result, "stderr")).into_owned(),
            ));
        }
        let ready = docker_output(
            &[
                "exec",
                &name,
                "/opt/fabric/bin/python",
                "-c",
                "import os,time; deadline=time.monotonic()+15\nwhile not os.path.exists('/sandbox/fabric.sock'):\n assert time.monotonic()<deadline, 'host socket unavailable'\n time.sleep(.05)",
            ],
            &[],
        );
        if ready["code"] != 0 {
            return Err(tonic::Status::internal("image host did not start"));
        }
        Ok(())
    }
    fn delete(&self, sandbox: &openshell_core::proto::Sandbox) -> Result<(), tonic::Status> {
        let name = self.name(&sandbox.metadata.as_ref().unwrap().name);
        let result = docker_output(&["rm", "--force", &name], &[]);
        if result["code"] != 0 {
            return Err(tonic::Status::internal("owned image removal failed"));
        }
        Ok(())
    }
    fn exec(
        &self,
        request: &openshell_core::proto::ExecSandboxRequest,
    ) -> Result<std::process::Output, tonic::Status> {
        use std::os::unix::process::ExitStatusExt;
        let mut args = vec!["exec".to_owned(), "-i".into()];
        for (key, value) in &request.environment {
            args.extend(["-e".into(), format!("{key}={value}")]);
        }
        args.push(self.name(&request.sandbox));
        args.extend(request.command.clone());
        let result = docker_output(
            &args.iter().map(String::as_str).collect::<Vec<_>>(),
            &request.stdin,
        );
        Ok(std::process::Output {
            status: std::process::ExitStatus::from_raw(
                (result["code"].as_i64().unwrap() as i32) << 8,
            ),
            stdout: bytes(&result, "stdout"),
            stderr: bytes(&result, "stderr"),
        })
    }
}
