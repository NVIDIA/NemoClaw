// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A simulated `ssh` for E2E tests: isolated Docker engine state and fixed
//! host measurements, kept in the directory named by `NEMOCLAW_TEST_REMOTE`.
//!
//! Tests install this executable as `bin/ssh` on `PATH`. Each invocation
//! either prints a capacity observation or answers one Docker API request
//! read from stdin, as `docker system dial-stdio` would.

use serde_json::{Map, Value, json};
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::{Duration, Instant},
};

fn read_json(path: &Path) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}

fn write_json(path: &Path, value: &Value) {
    fs::write(path, value.to_string()).unwrap();
}

fn flag(control: &Value, name: &str) -> bool {
    control.get(name).and_then(Value::as_bool).unwrap_or(false)
}

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let value = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (index, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if index <= chunk.len() {
                out.push(ALPHABET[(value >> shift & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%'
            && let Some(hex) = text.get(index + 1..index + 3)
            && let Ok(byte) = u8::from_str_radix(hex, 16)
        {
            out.push(byte);
            index += 3;
            continue;
        }
        out.push(if bytes[index] == b'+' {
            b' '
        } else {
            bytes[index]
        });
        index += 1;
    }
    String::from_utf8(out).unwrap()
}

fn query_value(query: &str, name: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (percent_decode(key) == name).then(|| percent_decode(value))
    })
}

/// A single-entry tar archive, as Docker's archive endpoint returns.
fn tar_entry(name: &str, data: &[u8]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_ustar();
    header.set_size(data.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, name, data).unwrap();
    builder.into_inner().unwrap()
}

/// The provider's fixed collection script: marked sections of host output.
fn capacity(root: &Path, control: &Value) -> ExitCode {
    if flag(control, "capacity_failure") {
        return ExitCode::from(1);
    }
    let mut reads = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root.join("capacity_reads"))
        .unwrap();
    writeln!(reads, "read").unwrap();
    let total = control["total_capacity_gib"].as_u64().unwrap_or(128) * 1024 * 1024;
    let memory = if flag(control, "low_capacity") {
        format!("MemTotal: {total} kB\nMemAvailable: 1048576 kB\nMemFree: 1048576 kB\n")
    } else {
        format!("MemTotal: {total} kB\nMemAvailable: 125829120 kB\nMemFree: 115343360 kB\n")
    };
    let info = json!({
        "ID": control.get("daemon").cloned().unwrap_or(json!("remote-engine")),
        "OSType": "linux", "Architecture": "aarch64",
        "DockerRootDir": "/srv/nemoclaw-fixture/docker",
    });
    let mut output = String::new();
    for (name, content) in [
        ("os", "Linux\n".to_owned()),
        ("machine", "aarch64\n".into()),
        ("context", "unix:///var/run/docker.sock\n".into()),
        ("docker_host", "\n".into()),
        ("info", format!("{info}\n")),
        ("disk", format!("{} 1\n", 1u64 << 40)),
        ("memory", memory),
        ("gpu", "NVIDIA GB10, 580.0\n".into()),
        ("compute_capability", "12.1\n".into()),
        ("gpu_memory", "[N/A], [N/A]\n".into()),
        ("processes", String::new()),
    ] {
        output.push_str(&format!("\n==nemoclaw:{name}==\n{content}"));
    }
    print!("{output}");
    ExitCode::SUCCESS
}

struct Request {
    method: String,
    path: String,
    query: String,
    body: Vec<u8>,
}

fn read_request() -> Request {
    let mut stream = BufReader::new(std::io::stdin().lock());
    let mut line = String::new();
    stream.read_line(&mut line).unwrap();
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap().to_owned();
    let target = parts.next().unwrap().to_owned();
    let mut length = 0;
    loop {
        let mut header = String::new();
        stream.read_line(&mut header).unwrap();
        let header = header.trim();
        if header.is_empty() {
            break;
        }
        if let Some((key, value)) = header.split_once(':')
            && key.trim().eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse().unwrap();
        }
    }
    let mut body = vec![0; length];
    stream.read_exact(&mut body).unwrap();
    let (path, query) = target.split_once('?').unwrap_or((&target, ""));
    let mut path = percent_decode(path);
    if path.starts_with("/v1.") {
        path = format!("/{}", path.splitn(3, '/').nth(2).unwrap_or(""));
    }
    Request {
        method,
        path,
        query: query.to_owned(),
        body,
    }
}

fn container_slot(state: &Value, path: &str) -> Option<&'static str> {
    let name = path
        .strip_prefix("/containers/")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("");
    ["container", "deposed_container"].into_iter().find(|slot| {
        state[*slot].is_object()
            && (state[*slot]["Id"] == name
                || state[*slot]["Name"]
                    .as_str()
                    .map(|n| n.trim_start_matches('/'))
                    == Some(name))
    })
}

/// Hold the engine lock for the duration of one request.
fn locked(root: &Path) -> File {
    let lock = File::create(root.join("lock")).unwrap();
    lock.lock().unwrap();
    lock
}

fn increment(state: &mut Value, key: &str) {
    state[key] = json!(state[key].as_u64().unwrap_or(0) + 1);
}

enum Body {
    Json(Value),
    Raw(Vec<u8>),
    Absent,
}

fn answer(
    root: &Path,
    control: &mut Value,
    request: &Request,
) -> (u16, Body, Vec<(String, String)>) {
    let (method, path) = (request.method.as_str(), request.path.as_str());
    let mut state = read_json(&root.join("engine.json"));
    let fixture = read_json(&root.join("fixture.json"));
    let mut extra = Vec::new();
    let slot = container_slot(&state, path);
    let image_refs = fixture.get("image_refs").cloned().unwrap_or(json!([]));
    let missing = flag(&state, "image_missing");
    let (code, body) = match (method, path) {
        ("HEAD" | "GET", "/_ping") => {
            extra.extend([
                ("API-Version".into(), "1.47".into()),
                ("OSType".into(), "linux".into()),
                ("Docker-Experimental".into(), "false".into()),
            ]);
            (
                200,
                Body::Raw(if method == "HEAD" {
                    Vec::new()
                } else {
                    b"OK".to_vec()
                }),
            )
        }
        ("GET", "/version") => (
            200,
            Body::Json(json!({
            "Version": "27.5.1", "ApiVersion": "1.47", "MinAPIVersion": "1.24", "Os": "linux",
            "Arch": "arm64", "KernelVersion": "fixture", "GoVersion": "go1.23"})),
        ),
        ("GET", "/info") => (
            200,
            Body::Json(json!({
            "ID": control.get("daemon").cloned().unwrap_or(json!("remote-engine")),
            "DockerRootDir": "/srv/nemoclaw-fixture/docker", "OSType": "linux",
            "Architecture": "aarch64", "ServerVersion": "27.5.1"})),
        ),
        ("GET", "/images/json") => (
            200,
            Body::Json(if missing {
                json!([])
            } else {
                json!([{"Id": fixture["image"]["Id"], "RepoTags": image_refs, "RepoDigests": image_refs,
                "Created": 1, "Size": 1, "Labels": fixture["image"]["Config"]["Labels"]}])
            }),
        ),
        ("GET", p) if p.starts_with("/images/") => {
            if missing {
                (200, Body::Absent)
            } else {
                let mut image = fixture["image"].clone();
                image["RepoTags"] = image_refs.clone();
                image["RepoDigests"] = image_refs;
                (200, Body::Json(image))
            }
        }
        ("POST", "/images/create") => {
            increment(&mut state, "pulls");
            increment(&mut state, "effects");
            if flag(control, "pull_failure") {
                (
                    200,
                    Body::Json(json!({"errorDetail": {"message": "registry unavailable"}})),
                )
            } else {
                state["image_missing"] = json!(false);
                (
                    200,
                    Body::Json(json!({"status": "Downloading", "id": "abcdef",
                    "progressDetail": {"current": 50, "total": 100}})),
                )
            }
        }
        ("GET", p) if p.starts_with("/volumes/") => {
            let key = if p.ends_with("-auth") {
                "auth_volume"
            } else {
                "volume"
            };
            (
                200,
                state
                    .get(key)
                    .filter(|v| !v.is_null())
                    .cloned()
                    .map_or(Body::Absent, Body::Json),
            )
        }
        ("GET", "/networks") => (
            200,
            Body::Json(match state.get("network").filter(|v| !v.is_null()) {
                Some(network) => json!([network]),
                None => json!([]),
            }),
        ),
        ("GET", p) if p.starts_with("/networks/") => (
            200,
            state
                .get("network")
                .filter(|v| !v.is_null())
                .cloned()
                .map_or(Body::Absent, Body::Json),
        ),
        (_, p) if p.ends_with("/archive") => {
            archive(root, control, &fixture, method, &request.query, &mut extra)
        }
        ("GET", "/containers/json") => {
            let containers: Vec<Value> = ["container", "deposed_container"]
                .iter()
                .filter_map(|slot| state.get(*slot).filter(|v| v.is_object()))
                .map(|container| {
                    let running = container["State"]["Running"].as_bool().unwrap_or(false);
                    json!({"Id": container["Id"], "Names": [container["Name"]],
                        "Image": container["Config"]["Image"], "ImageID": container["Image"],
                        "Labels": container["Config"].get("Labels").cloned().unwrap_or(json!({})),
                        "State": if running { "running" } else { "exited" },
                        "Status": if running { "Up" } else { "Exited" }, "Created": 1})
                })
                .collect();
            (200, Body::Json(Value::Array(containers)))
        }
        ("GET", p) if p.starts_with("/containers/") => match slot {
            Some(slot) => {
                let mut container = state[slot].clone();
                let running = container["State"]["Running"].as_bool().unwrap_or(false);
                container["State"]["Status"] = json!(if running { "running" } else { "exited" });
                if !running {
                    // Docker keeps requested ports in HostConfig while stopped,
                    // but the active NetworkSettings port map is empty.
                    container["NetworkSettings"]["Ports"] = json!({});
                }
                (200, Body::Json(container))
            }
            None => (200, Body::Absent),
        },
        ("POST", "/volumes/create") => {
            let mut volume: Value = serde_json::from_slice(&request.body).unwrap();
            for (key, value) in [
                ("Driver", json!("local")),
                ("Scope", json!("local")),
                ("Options", json!({})),
                (
                    "Mountpoint",
                    json!("/srv/nemoclaw-fixture/docker/volumes/fixture/_data"),
                ),
                ("CreatedAt", json!("2026-09-15T00:00:00Z")),
            ] {
                volume[key] = value;
            }
            let key = if volume["Name"].as_str().unwrap_or("").ends_with("-auth") {
                "auth_volume"
            } else {
                "volume"
            };
            state[key] = volume.clone();
            increment(&mut state, "effects");
            (200, Body::Json(volume))
        }
        ("POST", "/networks/create") if flag(control, "network_create_failure") => (
            500,
            Body::Json(json!({"message": "intentional protocol fixture network creation failure"})),
        ),
        ("POST", "/networks/create") => {
            let request: Value = serde_json::from_slice(&request.body).unwrap();
            let mut network = request.clone();
            let mut ipam = request.get("IPAM").cloned().unwrap_or(json!({}));
            ipam["Driver"] = json!("default");
            for (key, value) in [
                ("Id", json!("remote-network")),
                ("Internal", json!(false)),
                ("EnableIPv6", json!(false)),
                ("Scope", json!("local")),
                ("Containers", json!({})),
                (
                    "Options",
                    request
                        .get("Options")
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(json!({})),
                ),
                ("IPAM", ipam),
            ] {
                network[key] = value;
            }
            state["network"] = network;
            increment(&mut state, "effects");
            (
                200,
                Body::Json(json!({"Id": "remote-network", "Warning": ""})),
            )
        }
        ("POST", "/containers/create") if flag(control, "create_failure") => (
            500,
            Body::Json(
                json!({"message": "intentional protocol fixture container creation failure"}),
            ),
        ),
        ("POST", "/containers/create") => create(&mut state, &fixture, request),
        ("POST", p) if p.ends_with("/start") => {
            let slot = slot.unwrap();
            state[slot]["State"]["Running"] = json!(true);
            state[slot]["State"]["Status"] = json!("running");
            increment(&mut state, "effects");
            (204, Body::Raw(Vec::new()))
        }
        ("POST", p)
            if p.ends_with("/stop")
                && slot == Some("deposed_container")
                && flag(control, "cleanup_failure") =>
        {
            (
                500,
                Body::Json(json!({"message": "intentional replacement cleanup failure"})),
            )
        }
        ("POST", p) if p.ends_with("/stop") => {
            let slot = slot.unwrap();
            state[slot]["State"]["Running"] = json!(false);
            state[slot]["State"]["Status"] = json!("exited");
            increment(&mut state, "effects");
            (204, Body::Raw(Vec::new()))
        }
        ("POST", p) if p.ends_with("/wait") => {
            let container = slot.map(|slot| &state[slot]);
            if container.is_some_and(|c| c["State"]["Running"].as_bool().unwrap_or(false)) {
                (
                    500,
                    Body::Json(json!({"message": "fixture wait timed out before stop"})),
                )
            } else {
                let code = container
                    .and_then(|c| c["State"]["ExitCode"].as_i64())
                    .unwrap_or(0);
                (200, Body::Json(json!({"StatusCode": code, "Error": null})))
            }
        }
        ("DELETE", p) if p.starts_with("/networks/") => {
            state["network"] = Value::Null;
            increment(&mut state, "effects");
            (204, Body::Raw(Vec::new()))
        }
        ("DELETE", p) if p.starts_with("/containers/") => match slot {
            Some(slot) => {
                state[slot] = Value::Null;
                increment(&mut state, "effects");
                (204, Body::Raw(Vec::new()))
            }
            None => (200, Body::Absent),
        },
        _ => panic!("unexpected Docker request: {method} {path}"),
    };
    write_json(&root.join("engine.json"), &state);
    (code, body, extra)
}

fn archive(
    root: &Path,
    control: &mut Value,
    fixture: &Value,
    method: &str,
    query: &str,
    extra: &mut Vec<(String, String)>,
) -> (u16, Body) {
    let name = query_value(query, "path").unwrap();
    if name.ends_with(".nemoclaw-partial") {
        return (404, Body::Raw(Vec::new()));
    }
    if method == "HEAD" {
        let mut item = fixture["stats"].get(&name).cloned();
        if name == "/data/inference-key"
            && let Some(object) = control.as_object_mut()
            && object.remove("defer_key_once").and_then(|v| v.as_bool()) == Some(true)
        {
            write_json(&root.join("control.json"), control);
            item = None;
        }
        return match item {
            None => (404, Body::Raw(Vec::new())),
            Some(item) => {
                extra.push((
                    "X-Docker-Container-Path-Stat".into(),
                    base64(item.to_string().as_bytes()),
                ));
                (200, Body::Raw(Vec::new()))
            }
        };
    }
    let Some(mut item) = fixture["files"].get(&name).cloned() else {
        return (404, Body::Raw(Vec::new()));
    };
    if name == "/data/status.json" && flag(control, "startup_failure") {
        item["phase"] = json!("stopped");
        item["detail"] = json!("intentional protocol fixture startup failure");
    }
    let data = match item.get("raw").and_then(Value::as_str) {
        Some(raw) => raw.as_bytes().to_vec(),
        None => item.to_string().into_bytes(),
    };
    let file = Path::new(&name).file_name().unwrap().to_str().unwrap();
    let archive = tar_entry(file, &data);
    // Header, padded data, and the two end-of-archive blocks.
    let length = (data.len().div_ceil(512) + 3) * 512;
    (
        200,
        Body::Raw(archive[..length.min(archive.len())].to_vec()),
    )
}

fn create(state: &mut Value, fixture: &Value, request: &Request) -> (u16, Body) {
    let mut config: Value = serde_json::from_slice(&request.body).unwrap();
    let host = config["HostConfig"].as_object_mut().unwrap();
    host.entry("RestartPolicy")
        .or_insert(json!({"Name": "no", "MaximumRetryCount": 0}));
    host.entry("LogConfig")
        .or_insert(json!({"Type": "json-file", "Config": {}}));
    let object = config.as_object_mut().unwrap();
    object
        .entry("Hostname")
        .or_insert(json!("remote-container"));
    object.entry("WorkingDir").or_insert(json!(""));
    object.entry("User").or_insert(json!(""));
    let creates = state["creates"].as_u64().unwrap_or(0);
    let id = if creates == 0 {
        "remote-container".to_owned()
    } else {
        format!("remote-container-{}", creates + 1)
    };
    let mounts: Vec<Value> = config["HostConfig"]["Mounts"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|mount| {
            json!({"Type": mount["Type"], "Name": mount["Source"], "Destination": mount["Target"],
            "RW": !mount["ReadOnly"].as_bool().unwrap_or(false)})
        })
        .collect();
    let mut networks = Map::new();
    networks.insert(
        state["network"]["Name"].as_str().unwrap().to_owned(),
        json!({"NetworkID": "remote-network", "IPAddress": "172.30.119.2", "Gateway": "172.30.119.1",
            "IPPrefixLen": 24, "Aliases": [], "Links": []}),
    );
    state["container"] = json!({
        "Id": id, "Name": format!("/{}", query_value(&request.query, "name").unwrap()),
        "Image": fixture["image"]["Id"], "Config": config.clone(), "HostConfig": config["HostConfig"],
        "State": {"Running": false, "Status": "created", "StartedAt": "2026-09-15T00:00:00Z", "ExitCode": 0},
        "NetworkSettings": {"Ports": config["HostConfig"].get("PortBindings").cloned().unwrap_or(json!({})),
            "Networks": networks},
        "Mounts": mounts,
    });
    increment(state, "effects");
    increment(state, "creates");
    (201, Body::Json(json!({"Id": id, "Warnings": []})))
}

/// The fixture's state directory: NEMOCLAW_TEST_REMOTE, or the path that
/// [`nemoclaw_e2e::install_ssh_simulator`] records beside this executable for
/// callers that do not pass the environment on.
fn root() -> PathBuf {
    if let Some(root) = std::env::var_os("NEMOCLAW_TEST_REMOTE") {
        return root.into();
    }
    let recorded = std::env::current_exe()
        .unwrap()
        .with_file_name(nemoclaw_e2e::SSH_SIMULATOR_ROOT);
    PathBuf::from(
        fs::read_to_string(&recorded)
            .unwrap_or_else(|_| panic!("set NEMOCLAW_TEST_REMOTE or write {}", recorded.display()))
            .trim_end(),
    )
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // Where Unix sockets are missing, fake image engines are reached through
    // the shared relay, which this simulator shadows on PATH.
    if let Some(address) = nemoclaw_test_fixtures::ssh::fixture_engine(&args) {
        return nemoclaw_test_fixtures::ssh::relay(address);
    }
    let root = root();
    let mut control = read_json(&root.join("control.json"));
    if flag(&control, "transport_failure") {
        return ExitCode::from(255);
    }
    if args.iter().any(|arg| arg.contains("==nemoclaw:")) {
        return capacity(&root, &control);
    }
    let dial = args.ends_with(&["docker".into(), "system".into(), "dial-stdio".into()])
        || args.last().map(String::as_str) == Some("docker system dial-stdio");
    assert!(dial, "unexpected SSH command: {args:?}");
    let request = read_request();
    if request.method == "POST" && request.path.ends_with("/wait") {
        // Docker wait completes after stop or removal. Do not hold the lock
        // while another SSH connection performs that operation.
        let deadline = Instant::now() + Duration::from_secs(30);
        while Instant::now() < deadline {
            let running = {
                let _lock = locked(&root);
                let snapshot = read_json(&root.join("engine.json"));
                container_slot(&snapshot, &request.path).is_some_and(|slot| {
                    snapshot[slot]["State"]["Running"]
                        .as_bool()
                        .unwrap_or(false)
                })
            };
            if !running {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
    let (code, body, extra) = {
        let _lock = locked(&root);
        answer(&root, &mut control, &request)
    };
    let (code, body) = match body {
        Body::Absent => (404, json!({"message": "absent"}).to_string().into_bytes()),
        Body::Json(value) => (code, value.to_string().into_bytes()),
        Body::Raw(bytes) => (code, bytes),
    };
    let mut response = format!(
        "HTTP/1.1 {code} Fixture\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (key, value) in extra {
        response.push_str(&format!("{key}: {value}\r\n"));
    }
    response.push_str("\r\n");
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(response.as_bytes()).unwrap();
    stdout.write_all(&body).unwrap();
    stdout.flush().unwrap();
    ExitCode::SUCCESS
}
