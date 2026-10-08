// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Docker API fixtures prove ordering and custody, not Linux filesystem enforcement.
use super::*;
use crate::docker::fixture::Fixture;
use serde_json::json;
use std::sync::{Arc, Mutex};
const SENTINEL: &str = "test-only-protected-token";

fn live_spec(
    mut spec: InputsSpec,
    nonce: String,
    endpoint: String,
    image: String,
    architecture: String,
) -> InputsSpec {
    spec.setup.image = image;
    spec.workspace = format!("nc-{}", &nonce[..16]);
    spec.service = "input-check".into();
    spec.process.name = format!("{}-container-{}", spec.workspace, spec.service);
    spec.process.owner = format!(
        "{}-{}-{}-{}-{}",
        &nonce[..8],
        &nonce[8..12],
        &nonce[12..16],
        &nonce[16..20],
        &nonce[20..]
    );
    spec.process.generation = nonce;
    let process = spec.process.process.as_mut().unwrap();
    process.engine = endpoint;
    process.architecture = architecture;
    spec
}

#[test]
fn manual_test_resource_identity_matches_the_container_input_contract_on_both_platforms() {
    for architecture in ["arm64", "amd64"] {
        let spec = live_spec(
            serde_json::from_str(&row()["spec"]).unwrap(),
            "d".repeat(32),
            "unix:///var/run/docker.sock".into(),
            format!("inputs@sha256:{}", "b".repeat(64)),
            architecture.into(),
        );
        spec.validate().unwrap();
        assert_eq!(
            spec.process.name,
            format!("{}-container-{}", spec.workspace, spec.service)
        );
        assert_eq!(
            spec.process.process.as_ref().unwrap().architecture,
            architecture
        );
    }
}

/// The missing live contract is Docker hijacked stdin plus the scratch helper's
/// Linux volume ownership/ACL enforcement under the provider's actual caps.
/// Protocol fixtures own ordering/recovery; helper units own path/ACL denial.
/// This opt-in test owns only real delivery, unchanged binding and owned cleanup.
#[tokio::test]
#[ignore = "opt-in Docker integration: creates one owned helper and disposable volume"]
async fn live_container_inputs_deliver_without_restarting_on_unchanged_apply() {
    let endpoint = std::env::var("NEMOCLAW_INPUT_TEST_ENGINE")
        .expect("set NEMOCLAW_INPUT_TEST_ENGINE to an explicit unix:/// engine endpoint");
    let image = std::env::var("NEMOCLAW_INPUT_TEST_IMAGE")
        .expect("set NEMOCLAW_INPUT_TEST_IMAGE to a preloaded repository@sha256: manifest digest");
    let engine = crate::docker::Engine::connect(&endpoint).unwrap();
    let mut desired = row();
    let mut spec: InputsSpec = serde_json::from_str(&desired["spec"]).unwrap();
    spec.setup.image = image;
    spec.setup.validate().unwrap();
    let observed_image = engine.image(&spec.setup.image).await.unwrap().unwrap();
    let mut nonce = [0u8; 16];
    getrandom::fill(&mut nonce).unwrap();
    let nonce: String = nonce.iter().map(|byte| format!("{byte:02x}")).collect();
    let image = spec.setup.image.clone();
    spec = live_spec(
        spec,
        nonce,
        endpoint,
        image,
        observed_image.architecture.unwrap(),
    );
    spec.validate().unwrap();
    desired.insert("spec".into(), serde_json::to_string(&spec).unwrap());
    desired.insert("sandbox_id".into(), "none".into());
    let backend = InputsBackend::new(engine.clone()).with_secrets(Arc::new(TestSecrets(true)));
    // All compatibility and credential checks precede even the test volume.
    backend
        .plan("container_inputs", &desired, None)
        .await
        .unwrap();
    let volume = spec.process.volume();
    assert!(engine.volume(&volume).await.unwrap().is_none());
    assert!(
        engine
            .container(&spec.helper_name())
            .await
            .unwrap()
            .is_none()
    );
    eprintln!(
        "owned integration resources: helper={} volume={volume}",
        spec.helper_name()
    );
    engine
        .api
        .create_volume(bollard::models::VolumeCreateRequest {
            name: Some(volume.clone()),
            driver: Some("local".into()),
            labels: Some(
                [
                    (OWNER_LABEL.into(), spec.process.owner.clone()),
                    (GENERATION_LABEL.into(), spec.process.generation.clone()),
                ]
                .into(),
            ),
            ..Default::default()
        })
        .await
        .unwrap();
    let result: Result<(), ObservationError> = async {
        let mutation = backend.ensure("container_inputs", &desired).await;
        if let Some(error) = mutation.error() {
            return Err(error);
        }
        let complete = mutation.state().ok_or(ObservationError::Incomplete)?;
        if complete.get("complete").map(String::as_str) != Some("true") {
            return Err(ObservationError::Incomplete);
        }
        let bytes = engine
            .read_file(
                &complete["id"],
                "/input-data/credentials/speech",
                MAX_CREDENTIAL_BYTES,
            )
            .await
            .map_err(diagnostic)?
            .ok_or(ObservationError::Incomplete)?;
        if bytes != SENTINEL.as_bytes() {
            return Err(ObservationError::Incomplete);
        }
        let refreshed = backend
            .read("container_inputs", complete, false)
            .await?
            .ok_or(ObservationError::Incomplete)?;
        let second = backend.ensure("container_inputs", &refreshed).await;
        if let Some(error) = second.error() {
            return Err(error);
        }
        if second.state() != Some(complete) {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(())
    }
    .await;
    // No panic assertions until owned cleanup has been attempted. Never force a
    // volume deletion or delete it after an uncertain helper-removal outcome.
    let cleanup = backend.remove("container_inputs", &desired, false).await;
    if cleanup.is_ok() {
        backend.volume(&spec).await.unwrap();
        tokio::time::timeout(
            Duration::from_secs(20),
            engine.api.remove_volume(
                &volume,
                Some(bollard::query_parameters::RemoveVolumeOptions { force: false }),
            ),
        )
        .await
        .expect("volume cleanup deadline")
        .expect("owned volume cleanup");
        assert!(engine.volume(&volume).await.unwrap().is_none());
        assert!(
            engine
                .container(&spec.helper_name())
                .await
                .unwrap()
                .is_none()
        );
    }
    assert!(
        cleanup.is_ok(),
        "helper cleanup failed; retain named resources: {cleanup:?}"
    );
    assert!(
        result.is_ok(),
        "live protected-input delivery failed: {result:?}"
    );
}
struct TestSecrets(bool);
impl nemoclaw_sdk::Secrets for TestSecrets {
    fn resolve(&self, _: &str) -> Result<String, ObservationError> {
        if self.0 {
            Ok(SENTINEL.into())
        } else {
            Err(ObservationError::Authentication)
        }
    }
}
fn row() -> Row {
    let mut value = serde_json::to_value(
        nemoclaw_sdk::config::Document::parse(
            include_bytes!("../../../nemoclaw-sdk/tests/fixtures/config/managed-ollama.yaml")
                .as_slice(),
        )
        .unwrap(),
    )
    .unwrap();
    value["spec"]["services"]["voice"] = json!({
        "kind":"container","image":format!("voice@sha256:{}","a".repeat(64)),"architecture":"arm64",
        "data":{"mountPath":"/var/lib/voiceclaw"},"inputSetup":{"image":format!("inputs@sha256:{}","b".repeat(64))},
        "secrets":{"speech":{"credential":{"env":"SPEECH_KEY"},"targetPath":"/var/lib/voiceclaw/credentials/speech"}}
    });
    let document = nemoclaw_sdk::config::Document::parse(value.to_string().as_bytes()).unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "ollama_service",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    nemoclaw_sdk::compile::targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|t| t.kind == "container_inputs")
        .unwrap()
        .values
}
fn image() -> serde_json::Value {
    json!({"Id":format!("sha256:{}","c".repeat(64)),"Os":"linux","Architecture":"arm64","Config":{"Entrypoint":[nemoclaw_container_inputs::ENTRYPOINT],"Env":["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],"Labels":{nemoclaw_container_inputs::CONTRACT_LABEL:nemoclaw_container_inputs::CONTRACT_VERSION}}})
}

#[test]
fn setup_image_accepts_only_empty_environment_or_docker_default_path_on_both_platforms() {
    let mut spec: InputsSpec = serde_json::from_str(&row()["spec"]).unwrap();
    for architecture in ["arm64", "amd64"] {
        spec.process.process.as_mut().unwrap().architecture = architecture.into();
        for environment in [
            serde_json::Value::Null,
            json!([]),
            json!(["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"]),
        ] {
            let mut observed = image();
            observed["Architecture"] = json!(architecture);
            observed["Config"]["Env"] = environment;
            validate_image(&serde_json::from_value(observed).unwrap(), &spec.process).unwrap();
        }
    }
}

#[tokio::test]
async fn local_connection_payload_delivers_speech_and_descriptor_without_an_openshell_credential() {
    struct SpeechOnly;
    impl nemoclaw_sdk::Secrets for SpeechOnly {
        fn resolve(&self, name: &str) -> Result<String, ObservationError> {
            if name == "NVIDIA_API_KEY" {
                Ok(SENTINEL.into())
            } else {
                Err(ObservationError::Authentication)
            }
        }
    }
    let document = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../nemoclaw-sdk/tests/fixtures/config/container-managed-local.yaml")
            .as_slice(),
    )
    .unwrap();
    let generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "container_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into();
    let mut desired = nemoclaw_sdk::compile::targets(&document, &generations)
        .unwrap()
        .into_iter()
        .find(|target| target.kind == "container_inputs")
        .unwrap()
        .values;
    desired.insert(
        "sandbox_id".into(),
        "11111111-2222-3333-4444-555555555555".into(),
    );
    let fixture =
        Fixture::start(|_| panic!("payload assembly must not contact Docker or the gateway")).await;
    let backend = InputsBackend::new(fixture.engine_for("unix:///var/run/docker.sock"))
        .with_secrets(Arc::new(SpeechOnly));
    let spec = backend.spec(&desired).unwrap();
    let request: Request =
        serde_json::from_slice(&backend.payload(&spec, &desired).unwrap()).unwrap();
    request.validate().unwrap();
    assert_eq!(request.files.len(), 2);
    let speech = request
        .files
        .iter()
        .find(|file| file.role == Role::Credential)
        .unwrap();
    assert_eq!(speech.path, "credentials/speech");
    assert_eq!(speech.content, SENTINEL);
    let descriptor = request
        .files
        .iter()
        .find(|file| file.role == Role::Descriptor)
        .unwrap();
    let descriptor: serde_json::Value = serde_json::from_str(&descriptor.content).unwrap();
    assert_eq!(
        descriptor["gateway"]["endpoint"],
        "http://172.29.230.2:17681"
    );
    assert_eq!(
        descriptor["authentication"],
        json!({"mode":"none","credentialFile":null,"refreshMode":"none"})
    );
    assert!(!descriptor.to_string().contains(SENTINEL));
}

#[test]
fn setup_image_contract_rejects_wrong_platform_entrypoint_label_environment_and_volumes() {
    let spec: InputsSpec = serde_json::from_str(&row()["spec"]).unwrap();
    let valid = image();
    validate_image(
        &serde_json::from_value(valid.clone()).unwrap(),
        &spec.process,
    )
    .unwrap();
    for (pointer, bad) in [
        ("/Id", json!("")),
        ("/Os", json!("windows")),
        ("/Architecture", json!("amd64")),
        ("/Config/Entrypoint", json!(["/bin/sh"])),
        ("/Config/Labels/io.nemoclaw.container-inputs", json!("2")),
        ("/Config/Env", json!(["TOKEN=unexpected-image-content"])),
        ("/Config/Env", json!(["PATH=/tmp"])),
        ("/Config/Env", json!(["LD_PRELOAD=/tmp/injected.so"])),
        (
            "/Config/Env",
            json!([
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "TOKEN=unexpected-image-content"
            ]),
        ),
        (
            "/Config/Env",
            json!([
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
                "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
            ]),
        ),
    ] {
        let mut changed = valid.clone();
        *changed.pointer_mut(pointer).unwrap() = bad;
        assert!(validate_image(&serde_json::from_value(changed).unwrap(), &spec.process).is_err());
    }
    let mut changed = valid;
    changed["Config"]["Volumes"] = json!({"/outside":{}});
    assert!(validate_image(&serde_json::from_value(changed).unwrap(), &spec.process).is_err());
}
#[tokio::test]
async fn protected_input_plan_checks_credentials_and_image_without_mutation() {
    let requests = Arc::new(Mutex::new(vec![]));
    let seen = requests.clone();
    let fixture = Fixture::start(move |request| {
        seen.lock()
            .unwrap()
            .push((request.method.clone(), request.path.clone()));
        assert_eq!(request.method, "GET");
        Some((200, serde_json::to_vec(&image()).unwrap()))
    })
    .await;
    let backend = InputsBackend::new(fixture.engine_for("unix:///var/run/docker.sock"))
        .with_secrets(Arc::new(TestSecrets(true)));
    backend
        .plan("container_inputs", &row(), None)
        .await
        .unwrap();
    assert!(!requests.lock().unwrap().is_empty());
}

#[derive(Default)]
struct State {
    helper: Option<serde_json::Value>,
    files: std::collections::BTreeMap<String, (Vec<u8>, bool)>,
    requests: Vec<(String, String)>,
    creates: usize,
    starts: usize,
    deletes: usize,
    transfers: usize,
    reject_ready: bool,
    fail_publish: bool,
    lose_observation: bool,
    application_running: bool,
    foreign: bool,
}
struct SetupFixture {
    endpoint: String,
    row: Row,
    state: Arc<Mutex<State>>,
    _directory: tempfile::TempDir,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for SetupFixture {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl SetupFixture {
    async fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("engine.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        let endpoint = format!("unix://{}", path.display());
        let mut row = row();
        let mut spec: InputsSpec = serde_json::from_str(&row["spec"]).unwrap();
        spec.process.process.as_mut().unwrap().engine = endpoint.clone();
        row.insert("spec".into(), serde_json::to_string(&spec).unwrap());
        let state = Arc::new(Mutex::new(State::default()));
        let shared = state.clone();
        let started = Arc::new(tokio::sync::Notify::new());
        let task = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let state = shared.clone();
                let spec = spec.clone();
                let started = started.clone();
                connections.spawn(async move {
                    serve_setup(stream, state, spec, started).await;
                });
            }
        });
        Self {
            endpoint,
            row,
            state,
            _directory: directory,
            task,
        }
    }
    fn backend(&self, available: bool) -> InputsBackend {
        InputsBackend::new(crate::docker::Engine::connect(&self.endpoint).unwrap())
            .with_secrets(Arc::new(TestSecrets(available)))
    }
}
fn tar_file(bytes: &[u8], directory: bool, name: &str, spec: &InputsSpec) -> Vec<u8> {
    let (uid, gid) = owner(spec);
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(if directory {
        tar::EntryType::Directory
    } else {
        tar::EntryType::Regular
    });
    header.set_mode(if directory { 0o700 } else { 0o600 });
    header.set_uid(uid as u64);
    header.set_gid(gid as u64);
    header.set_size(bytes.len() as u64);
    header.set_mtime(0);
    header.set_cksum();
    builder.append_data(&mut header, name, bytes).unwrap();
    builder.into_inner().unwrap()
}
async fn serve_setup(
    mut stream: tokio::net::UnixStream,
    state: Arc<Mutex<State>>,
    spec: InputsSpec,
    started: Arc<tokio::sync::Notify>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut header = Vec::new();
    while !header.ends_with(b"\r\n\r\n") {
        match stream.read_u8().await {
            Ok(byte) => header.push(byte),
            Err(_) => return,
        }
        if header.len() > 8192 {
            return;
        }
    }
    let header = String::from_utf8(header).unwrap();
    let first = header
        .lines()
        .next()
        .unwrap()
        .split_whitespace()
        .collect::<Vec<_>>();
    let method = first[0].to_owned();
    let raw = first[1];
    let path = if raw.starts_with("/v1.") {
        format!("/{}", raw.split('/').skip(2).collect::<Vec<_>>().join("/"))
    } else {
        raw.into()
    };
    assert!(!path.contains(SENTINEL));
    state
        .lock()
        .unwrap()
        .requests
        .push((method.clone(), path.clone()));
    if path.contains("/attach?") {
        assert!(path.contains("logs=false"));
        stream.write_all(b"HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n").await.unwrap();
        loop {
            let notified = started.notified();
            if state
                .lock()
                .unwrap()
                .helper
                .as_ref()
                .is_some_and(|v| v["State"]["Running"] == true)
            {
                break;
            }
            notified.await;
        }
        let reject = state.lock().unwrap().reject_ready;
        let ready: &[u8] = if reject { b"denied\n" } else { b"ready\n" };
        let mut frame = vec![1, 0, 0, 0];
        frame.extend_from_slice(&(ready.len() as u32).to_be_bytes());
        frame.extend_from_slice(ready);
        if stream.write_all(&frame).await.is_err() {
            return;
        }
        let mut bytes = Vec::new();
        let _ = stream.read_to_end(&mut bytes).await;
        let mut state = state.lock().unwrap();
        if !bytes.is_empty() {
            assert!(
                !reject,
                "credentials must never cross a rejected admission handshake"
            );
            assert!(
                bytes
                    .windows(SENTINEL.len())
                    .any(|v| v == SENTINEL.as_bytes())
            );
            state.transfers += 1;
            let request = nemoclaw_container_inputs::parse(&bytes).unwrap();
            for input in &request.files {
                let mut prefix = String::new();
                for part in input
                    .path
                    .split('/')
                    .take(input.path.split('/').count() - 1)
                {
                    if !prefix.is_empty() {
                        prefix.push('/');
                    }
                    prefix.push_str(part);
                    state.files.insert(prefix.clone(), (vec![], true));
                }
                state.files.insert(
                    input.path.clone(),
                    (input.content.as_bytes().to_vec(), false),
                );
            }
            state.files.insert("".into(), (vec![], true));
            if !state.fail_publish {
                state
                    .files
                    .insert(MARKER.into(), (request.completion_bytes(), false));
            }
        }
        let exit = if state.fail_publish || reject { 1 } else { 0 };
        let helper = state.helper.as_mut().unwrap();
        helper["State"] = json!({"Running":false,"Status":"exited","ExitCode":exit});
        return;
    }
    let length = header
        .lines()
        .find_map(|line| {
            line.split_once(':')
                .filter(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                .map(|(_, value)| value.trim().parse::<usize>().unwrap())
        })
        .unwrap_or(0);
    let mut body = vec![0; length];
    if stream.read_exact(&mut body).await.is_err() {
        return;
    }
    let route = path.split('?').next().unwrap();
    let (status, body) = {
        let mut state = state.lock().unwrap();
        match (method.as_str(),route) {
            ("GET",route) if route.starts_with("/images/")=>(200,serde_json::to_vec(&image()).unwrap()),
            ("GET",route) if route.starts_with("/volumes/")=>(200,serde_json::to_vec(&json!({"Name":spec.process.volume(),"Driver":"local","Scope":"local","Mountpoint":"/var/lib/docker/volumes/owned/_data","Options":{},"CreatedAt":"created","Labels":{OWNER_LABEL:spec.process.owner,GENERATION_LABEL:spec.process.generation}})).unwrap()),
            ("POST","/containers/create")=>{
                assert!(!String::from_utf8_lossy(&body).contains(SENTINEL));let config:serde_json::Value=serde_json::from_slice(&body).unwrap();
                assert_eq!(config["Env"],json!([]));assert_eq!(config["HostConfig"]["NetworkMode"],"none");assert_eq!(config["HostConfig"]["LogConfig"]["Type"],"none");
                assert_eq!(config["HostConfig"]["Mounts"][0]["VolumeOptions"]["NoCopy"],true);
                state.creates+=1;let id=format!("helper-{}",state.creates);
                let mut observed_config = config.clone();
                observed_config["Env"] = image()["Config"]["Env"].clone();
                state.helper=Some(json!({"Id":id,"Name":format!("/{}",spec.helper_name()),"Image":image()["Id"],"Config":observed_config,"HostConfig":config["HostConfig"],"Mounts":[{"Type":"volume","Name":spec.process.volume(),"Destination":ROOT,"RW":true}],"State":{"Running":false,"Status":"created","ExitCode":0}}));
                (201,serde_json::to_vec(&json!({"Id":id,"Warnings":[]})).unwrap())
            }
            ("POST",route) if route.ends_with("/start")=>{state.starts+=1;state.helper.as_mut().unwrap()["State"]=json!({"Running":true,"Status":"running","ExitCode":0});started.notify_waiters();(204,vec![])},
            ("GET",route) if route.ends_with("/archive")=>{
                let query=url::form_urlencoded::parse(path.split_once('?').unwrap().1.as_bytes()).find(|(k,_)|k=="path").unwrap().1.into_owned();
                let name=query.strip_prefix(ROOT).unwrap().trim_start_matches('/');
                match state.files.get(name){Some((bytes,directory))=>(200,tar_file(bytes,*directory,if name.is_empty(){"input-data"}else{name},&spec)),None=>(404,b"{}".to_vec())}
            }
            ("GET",route) if route.ends_with("/json")=>{
                if route.contains("helper-")||route.contains(&spec.helper_name()) {
                    if state.lose_observation&&state.helper.as_ref().is_some_and(|v|v["State"]["Status"]=="exited") {state.lose_observation=false;(503,b"{}".to_vec())}
                    else if let Some(helper)=&state.helper {let mut helper=helper.clone();if state.foreign{helper["Config"]["Labels"][OWNER_LABEL]=json!("foreign");}(200,serde_json::to_vec(&helper).unwrap())}
                    else{(404,b"{}".to_vec())}
                }else if state.application_running{(200,serde_json::to_vec(&json!({"Config":{"Labels":{OWNER_LABEL:spec.process.owner,GENERATION_LABEL:spec.process.generation}},"State":{"Running":true}})).unwrap())}
                else{(404,b"{}".to_vec())}
            }
            ("DELETE",_)=>{state.deletes+=1;state.helper=None;(204,vec![])},
            _=>panic!("unexpected setup API operation {method} {route}"),
        }
    };
    let response = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.write_all(&body).await;
}
#[tokio::test]
async fn image_update_plan_checks_the_existing_helpers_prior_spec_without_mutation() {
    let fixture = SetupFixture::new().await;
    let backend = fixture.backend(true);
    let first = backend.ensure("container_inputs", &fixture.row).await;
    assert!(first.error().is_none());
    let prior = first.state().unwrap();
    let mut desired = fixture.row.clone();
    let mut spec: InputsSpec = serde_json::from_str(&desired["spec"]).unwrap();
    spec.process.process.as_mut().unwrap().image = format!("voiceclaw@sha256:{}", "e".repeat(64));
    desired.insert("spec".into(), serde_json::to_string(&spec).unwrap());
    let requests = fixture.state.lock().unwrap().requests.len();
    backend
        .plan("container_inputs", &desired, Some(prior))
        .await
        .unwrap();
    {
        let state = fixture.state.lock().unwrap();
        assert!(
            state.requests[requests..]
                .iter()
                .all(|(method, _)| method == "GET")
        );
        assert_eq!(
            (state.creates, state.starts, state.transfers, state.deletes),
            (1, 1, 1, 0)
        );
        assert!(state.files.contains_key("credentials/speech"));
    }
    fixture.state.lock().unwrap().foreign = true;
    assert!(
        backend
            .plan("container_inputs", &desired, Some(prior))
            .await
            .is_err()
    );
    let files = {
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            (state.creates, state.starts, state.transfers, state.deletes),
            (1, 1, 1, 0)
        );
        assert!(state.helper.is_some());
        assert!(state.files.contains_key("credentials/speech"));
        state.files.clone()
    };
    fixture.state.lock().unwrap().foreign = false;
    backend
        .remove("container_inputs", prior, false)
        .await
        .unwrap();
    let replacement = backend.ensure("container_inputs", &desired).await;
    assert!(replacement.error().is_none(), "{:?}", replacement.error());
    assert_eq!(replacement.state().unwrap()["complete"], "true");
    assert_ne!(replacement.state().unwrap()["id"], prior["id"]);
    let state = fixture.state.lock().unwrap();
    assert_eq!(
        (state.creates, state.starts, state.transfers, state.deletes),
        (2, 2, 2, 1)
    );
    assert_eq!(state.files, files);
    assert!(
        state
            .requests
            .iter()
            .filter(|(method, _)| method == "DELETE")
            .all(|(_, path)| path.starts_with("/containers/"))
    );
}

#[tokio::test]
async fn setup_transfers_only_after_admission_and_unchanged_apply_does_not_restart_or_rewrite() {
    let fixture = SetupFixture::new().await;
    let backend = fixture.backend(true);
    let mutation = backend.ensure("container_inputs", &fixture.row).await;
    assert!(
        mutation.error().is_none(),
        "setup failed: {:?}; requests: {:?}",
        mutation.error(),
        fixture.state.lock().unwrap().requests
    );
    let row = mutation.state().unwrap().clone();
    assert_eq!(row["complete"], "true");
    assert!(!serde_json::to_string(&row).unwrap().contains(SENTINEL));
    let read = backend
        .read("container_inputs", &row, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(read, row);
    let again = backend.ensure("container_inputs", &row).await;
    assert!(again.error().is_none());
    assert_eq!(again.state().unwrap(), &row);
    {
        let state = fixture.state.lock().unwrap();
        assert_eq!((state.creates, state.starts, state.transfers), (1, 1, 1));
    }
    backend
        .remove("container_inputs", &row, true)
        .await
        .unwrap();
    let state = fixture.state.lock().unwrap();
    assert_eq!(state.deletes, 1);
    assert!(state.files.contains_key("credentials/speech"));
    assert!(
        state
            .requests
            .iter()
            .filter(|(m, _)| m == "DELETE")
            .all(|(_, p)| p.starts_with("/containers/"))
    );
}
#[tokio::test]
async fn setup_rejects_unexpected_container_environment_without_restart_transfer_or_cleanup() {
    let fixture = SetupFixture::new().await;
    let backend = fixture.backend(true);
    let first = backend.ensure("container_inputs", &fixture.row).await;
    assert!(first.error().is_none());
    let row = first.state().unwrap();
    for environment in [
        json!(["PATH=/tmp"]),
        json!(["LD_PRELOAD=/tmp/injected.so"]),
        json!([
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "TOKEN=unexpected-image-content"
        ]),
        json!([
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
        ]),
    ] {
        fixture.state.lock().unwrap().helper.as_mut().unwrap()["Config"]["Env"] = environment;
        assert!(backend.read("container_inputs", row, false).await.is_err());
        assert!(
            backend
                .ensure("container_inputs", row)
                .await
                .error()
                .is_some()
        );
        assert!(backend.remove("container_inputs", row, true).await.is_err());
        let state = fixture.state.lock().unwrap();
        assert_eq!(
            (state.creates, state.starts, state.transfers, state.deletes),
            (1, 1, 1, 0)
        );
        assert!(state.helper.is_some());
        assert!(state.files.contains_key("credentials/speech"));
    }
}

#[tokio::test]
async fn rejected_admission_and_missing_credentials_never_transfer_secret_bytes() {
    for missing in [false, true] {
        let fixture = SetupFixture::new().await;
        fixture.state.lock().unwrap().reject_ready = true;
        let mutation = fixture
            .backend(!missing)
            .ensure("container_inputs", &fixture.row)
            .await;
        assert!(mutation.error().is_some());
        let state = fixture.state.lock().unwrap();
        assert_eq!(state.transfers, 0);
        if missing {
            assert_eq!(state.creates, 0);
            assert!(state.requests.is_empty());
        }
    }
}
#[tokio::test]
async fn interrupted_delivery_retains_binding_and_explicit_retry_reconciles_completion() {
    let fixture = SetupFixture::new().await;
    fixture.state.lock().unwrap().lose_observation = true;
    let backend = fixture.backend(true);
    let mutation = backend.ensure("container_inputs", &fixture.row).await;
    assert!(mutation.error().is_some());
    let partial = mutation.state().unwrap().clone();
    assert_eq!(partial["complete"], "false");
    let actual = backend
        .read("container_inputs", &partial, false)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(actual["complete"], "true");
    let again = backend.ensure("container_inputs", &partial).await;
    assert!(again.error().is_none());
    assert_eq!(again.state().unwrap()["id"], partial["id"]);
    let state = fixture.state.lock().unwrap();
    assert_eq!((state.creates, state.starts, state.transfers), (1, 1, 1));
}
#[tokio::test]
async fn failed_setup_retries_only_when_stopped_and_never_adopts_a_foreign_binding() {
    let fixture = SetupFixture::new().await;
    fixture.state.lock().unwrap().fail_publish = true;
    let backend = fixture.backend(true);
    let first = backend.ensure("container_inputs", &fixture.row).await;
    assert!(first.error().is_some());
    let partial = first.state().unwrap().clone();
    fixture.state.lock().unwrap().foreign = true;
    let denied = backend.ensure("container_inputs", &partial).await;
    assert!(denied.error().is_some());
    {
        let mut state = fixture.state.lock().unwrap();
        assert_eq!(state.creates, 1);
        state.foreign = false;
        state.fail_publish = false;
        state.application_running = true;
    }
    let denied = backend.ensure("container_inputs", &partial).await;
    assert!(denied.error().is_some());
    assert_eq!(fixture.state.lock().unwrap().creates, 1);
    fixture.state.lock().unwrap().application_running = false;
    let recovered = backend.ensure("container_inputs", &partial).await;
    assert!(recovered.error().is_none());
    assert_ne!(recovered.state().unwrap()["id"], partial["id"]);
    let state = fixture.state.lock().unwrap();
    assert_eq!((state.creates, state.starts, state.transfers), (2, 2, 2));
}
