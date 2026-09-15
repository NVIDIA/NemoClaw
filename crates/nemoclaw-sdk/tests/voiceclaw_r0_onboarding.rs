// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#![cfg(unix)]

use std::{fs, os::unix::fs::PermissionsExt, path::Path, sync::Arc, time::Duration};

use async_trait::async_trait;
use nemoclaw_sdk::{
    Binding, CancellationToken,
    voice::{
        AccessGrant, Bootstrap, Clock, CloseReason, PROFILE, ProbeResult, ServerConfig,
        TargetProbe, VoiceServer,
    },
};
use time::OffsetDateTime;

struct LiveClock;

impl Clock for LiveClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

struct ReadyProbe;

#[async_trait]
impl TargetProbe for ReadyProbe {
    async fn probe(&self, _: &Binding) -> ProbeResult {
        ProbeResult::Ready
    }
}

fn bootstrap(directory: &Path, body: &str) -> Bootstrap {
    let bin = directory.join("bin");
    fs::create_dir(&bin).unwrap();
    let executable = bin.join("voiceclaw-nemoclaw-r0");
    fs::write(&executable, body).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    Bootstrap::new(directory).unwrap()
}

fn grant() -> AccessGrant {
    AccessGrant::new(
        "test-only-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "opaque-target",
        Binding::new("deployment/voice", "generation", "native-id").unwrap(),
        OffsetDateTime::now_utc(),
        Duration::from_secs(900),
    )
    .unwrap()
}

#[tokio::test]
async fn invokes_exact_prepare_then_connect_with_descriptor_credential() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let bootstrap = bootstrap(
        root.path(),
        r#"#!/bin/sh
set -eu
stage="$1"; shift
result=""
endpoint=""; target=""; fd=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile) [ "$2" = "nemoclaw-voice-r0/1" ]; shift 2 ;;
    --result-file) result="$2"; shift 2 ;;
    --endpoint) endpoint="$2"; shift 2 ;;
    --target-ref) target="$2"; shift 2 ;;
    --credential-fd) fd="$2"; shift 2 ;;
    *) exit 7 ;;
  esac
done
if [ "$stage" = prepare ]; then
  umask 077
  printf '{"profile":"nemoclaw-voice-r0/1","status":"prepared"}' > "$result"
elif [ "$stage" = connect ]; then
  [ "$endpoint" = "http://127.0.0.1:3456/r0/connect" ]
  [ "$target" = "opaque-target" ]
  [ "$fd" = 3 ]
  IFS= read -r credential <&3
  ! IFS= read -r unexpected
  [ "$credential" = "test-only-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" ]
  umask 077
  printf '{"profile":"nemoclaw-voice-r0/1","status":"ready","targetRef":"opaque-target","clientInstructions":"Read protected client access."}' > "$result"
else
  exit 8
fi
"#,
    );
    let cancel = CancellationToken::new();
    bootstrap.prepare(state.path(), &cancel).await.unwrap();
    let ready = bootstrap
        .connect(
            state.path(),
            "http://127.0.0.1:3456/r0/connect",
            &grant(),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(ready.client_instructions, "Read protected client access.");
    assert!(fs::read_dir(state.path()).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .contains("credential")
    }));
}

#[tokio::test]
async fn rejects_insecure_malformed_or_secret_bearing_results() {
    for payload in [
        r#"{"profile":"wrong","status":"prepared"}"#,
        r#"{"profile":"nemoclaw-voice-r0/1","status":"prepared","extra":true}"#,
    ] {
        let root = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let script = format!(
            "#!/bin/sh\nset -eu\nshift\nwhile [ \"$1\" != --result-file ]; do shift; done\numask 077\nprintf '%s' '{}' > \"$2\"\n",
            payload
        );
        let bootstrap = bootstrap(root.path(), &script);
        assert!(
            bootstrap
                .prepare(state.path(), &CancellationToken::new())
                .await
                .is_err()
        );
    }
}

#[test]
fn bootstrap_requires_an_absolute_regular_executable() {
    assert!(Bootstrap::new(Path::new("relative")).is_err());
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("bin")).unwrap();
    std::os::unix::fs::symlink("/bin/true", root.path().join("bin/voiceclaw-nemoclaw-r0")).unwrap();
    assert!(Bootstrap::new(root.path()).is_err());
    assert_eq!(PROFILE, "nemoclaw-voice-r0/1");
}

#[tokio::test]
async fn bootstrap_authenticates_to_server_and_owns_stream_after_launcher_exit() {
    let root = tempfile::tempdir().unwrap();
    let state = tempfile::tempdir().unwrap();
    let bootstrap = bootstrap(
        root.path(),
        r#"#!/usr/bin/env python3
import http.client, json, os, sys, urllib.parse
args = sys.argv[1:]
stage = args.pop(0)
values = {args[i]: args[i + 1] for i in range(0, len(args), 2)}
result = values['--result-file']
if stage == 'prepare':
    payload = {'profile': values['--profile'], 'status': 'prepared'}
else:
    credential = os.fdopen(int(values['--credential-fd'])).readline().strip()
    url = urllib.parse.urlparse(values['--endpoint'])
    connection = http.client.HTTPConnection(url.hostname, url.port, timeout=2)
    connection.request('POST', url.path,
        json.dumps({'profile': values['--profile'], 'targetRef': values['--target-ref']}),
        {'Authorization': 'Bearer ' + credential, 'Content-Type': 'application/json',
         'Accept': 'application/x-ndjson'})
    response = connection.getresponse()
    assert response.status == 200
    assert json.loads(response.readline())['type'] == 'ready'
    payload = {'profile': values['--profile'], 'status': 'ready',
               'targetRef': values['--target-ref'],
               'clientInstructions': 'Use protected test access.'}
temporary = result + '.tmp'
descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(descriptor, 'w') as output:
    json.dump(payload, output)
os.replace(temporary, result)
if stage == 'connect':
    child = os.fork()
    if child == 0:
        import time
        time.sleep(0.15)
        response.close()
        connection.close()
        os._exit(0)
"#,
    );
    let grant = grant();
    let server = VoiceServer::bind(
        "127.0.0.1:0".parse().unwrap(),
        &grant,
        Arc::new(ReadyProbe),
        Arc::new(LiveClock),
        ServerConfig {
            heartbeat_interval: Duration::from_millis(25),
            probe_interval: Duration::from_millis(25),
            probe_timeout: Duration::from_millis(20),
        },
    )
    .await
    .unwrap();
    let cancel = CancellationToken::new();
    bootstrap.prepare(state.path(), &cancel).await.unwrap();
    let ready = bootstrap
        .connect(state.path(), server.endpoint(), &grant, &cancel)
        .await
        .unwrap();
    assert_eq!(ready.client_instructions, "Use protected test access.");
    assert_eq!(
        server.wait_for_run(&cancel).await.unwrap(),
        CloseReason::ClientDisconnected
    );
}
