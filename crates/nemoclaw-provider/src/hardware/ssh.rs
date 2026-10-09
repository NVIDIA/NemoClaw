// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::{HostObservation, HostObserver};
use crate::ObservationError;
use crate::{Error, docker::Engine};

/// Fixed, read-only collection on the SSH execution host. It needs only a
/// POSIX shell, `uname`, `stat`, `head`, `docker`, and `nvidia-smi`: no
/// interpreter and no user-supplied hooks. A marker line precedes each
/// command's output, and the provider parses and validates it.
const COLLECT: &str = r#"set -eu
section() { printf '\n==nemoclaw:%s==\n' "$1"; }
section os; uname -s
section machine; uname -m
section context; docker context inspect --format '{{.Endpoints.docker.Host}}'
section docker_host; printf '%s\n' "${DOCKER_HOST-}"
section info; docker info --format '{{json .}}'
root=$(docker info --format '{{.DockerRootDir}}')
case $root in /*) ;; *) exit 1 ;; esac
section disk; stat -f -c '%a %S' -- "$root"
section memory; head -c 65537 /proc/meminfo
section gpu; nvidia-smi --query-gpu=name,driver_version --format=csv,noheader,nounits
section compute_capability; nvidia-smi --query-gpu=compute_cap --format=csv,noheader,nounits
section gpu_memory; nvidia-smi --query-gpu=memory.total,memory.free --format=csv,noheader,nounits
section processes; nvidia-smi --query-compute-apps=pid --format=csv,noheader,nounits
"#;

const MARKER: &str = "\n==nemoclaw:";
const SECTIONS: [&str; 11] = [
    "os",
    "machine",
    "context",
    "docker_host",
    "info",
    "disk",
    "memory",
    "gpu",
    "compute_capability",
    "gpu_memory",
    "processes",
];

/// Fixed, read-only collector for a Linux host with a local Docker daemon.
pub struct SshHost;
#[async_trait::async_trait]
impl HostObserver for SshHost {
    async fn observe(&self, engine: &Engine) -> Result<HostObservation, Error> {
        if !engine.endpoint().starts_with("ssh://") {
            return Err(Error::Conflict(
                "SSH host observation requires an SSH engine",
            ));
        }
        {
            use std::{process::Stdio, time::Duration};
            let script = format!("'{}'", COLLECT.replace('\'', "'\\''"));
            let result = tokio::time::timeout(
                Duration::from_secs(60),
                crate::docker::ssh_command(engine.endpoint())
                    .args(["sh", "-c", &script])
                    .stdin(Stdio::null())
                    .stderr(Stdio::null())
                    .output(),
            )
            .await
            .map_err(|_| ObservationError::Transport)?
            .map_err(|_| ObservationError::Transport)?;
            if !result.status.success() || result.stdout.len() > 128 * 1024 {
                return Err(ObservationError::Transport.into());
            }
            decode(&result.stdout)
        }
    }
}

/// Each known section exactly once, after nothing but the first marker.
fn sections(text: &str) -> Option<std::collections::BTreeMap<&str, &str>> {
    let mut parts = text.split(MARKER);
    if !parts.next()?.is_empty() {
        return None;
    }
    let mut found = std::collections::BTreeMap::new();
    for part in parts {
        let (name, content) = part.split_once("==\n")?;
        if !SECTIONS.contains(&name) || found.insert(name, content).is_some() {
            return None;
        }
    }
    Some(found)
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Info {
    #[serde(rename = "ID")]
    id: String,
    #[serde(rename = "OSType")]
    os_type: String,
    architecture: String,
    docker_root_dir: String,
}

fn architecture(name: &str) -> Option<&'static str> {
    match name {
        "arm64" | "aarch64" => Some("arm64"),
        "amd64" | "x86_64" => Some("amd64"),
        _ => None,
    }
}

fn decode(bytes: &[u8]) -> Result<HostObservation, Error> {
    let incomplete = || Error::from(ObservationError::Incomplete);
    let unsupported =
        || Error::Conflict("remote inference requires a Linux ARM64 or AMD64 Docker host");
    let text = std::str::from_utf8(bytes).map_err(|_| incomplete())?;
    let found = sections(text).ok_or_else(incomplete)?;
    let get = |name: &str| found.get(name).copied().ok_or_else(incomplete);
    if get("os")?.trim() != "Linux" {
        return Err(unsupported());
    }
    let info: Info = serde_json::from_str(get("info")?).map_err(|_| incomplete())?;
    if info.id.is_empty() || !info.docker_root_dir.starts_with('/') {
        return Err(incomplete());
    }
    let Some(daemon_architecture) =
        architecture(&info.architecture).filter(|_| info.os_type == "linux")
    else {
        return Err(unsupported());
    };
    if architecture(get("machine")?.trim()) != Some(daemon_architecture) {
        return Err(Error::Conflict(
            "the SSH host's Docker daemon reports a different architecture than that host",
        ));
    }
    let local = |endpoint: &str| endpoint.starts_with("unix:///");
    let docker_host = get("docker_host")?.trim();
    if !local(get("context")?.trim()) || !(docker_host.is_empty() || local(docker_host)) {
        return Err(Error::Conflict(
            "the SSH host's Docker daemon must run on that host",
        ));
    }
    let mut disk = get("disk")?.split_whitespace().map(str::parse::<u64>);
    let disk_free = match (disk.next(), disk.next(), disk.next()) {
        (Some(Ok(free)), Some(Ok(block)), None) => {
            free.checked_mul(block).ok_or_else(incomplete)?
        }
        _ => return Err(incomplete()),
    };
    let memory = get("memory")?;
    if memory.len() > 65536 {
        return Err(incomplete());
    }
    let mut capacity = super::read_memory(memory.as_bytes())?;
    capacity.architecture = daemon_architecture.into();
    super::nvidia::apply_observations(
        &mut capacity,
        get("gpu")?,
        get("processes")?,
        get("compute_capability")?,
        get("gpu_memory")?,
    )?;
    capacity.disk_free = disk_free;
    Ok(HostObservation {
        engine_id: info.id,
        capacity,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn push(text: &mut String, name: &str, content: Option<String>) {
        if let Some(content) = content {
            text.push_str(&format!("{MARKER}{name}==\n{content}"));
        }
    }

    /// The collector's output for a host described by `value`. A field that
    /// is absent, or not a string, omits its section.
    fn output(value: &Value) -> Vec<u8> {
        let field = |name: &str| value.get(name).and_then(Value::as_str).map(str::to_owned);
        let machine = field("architecture");
        let mut info =
            json!({"OSType": "linux", "Architecture": machine, "DockerRootDir": "/var/lib/docker"});
        if let Some(daemon) = field("daemon") {
            info["ID"] = json!(daemon);
        }
        let mut text = String::new();
        push(&mut text, "os", Some("Linux\n".into()));
        push(
            &mut text,
            "machine",
            machine.map(|machine| format!("{machine}\n")),
        );
        push(
            &mut text,
            "context",
            Some("unix:///var/run/docker.sock\n".into()),
        );
        push(&mut text, "docker_host", Some("\n".into()));
        push(&mut text, "info", Some(format!("{info}\n")));
        let disk = value.get("disk_free").and_then(Value::as_u64);
        push(&mut text, "disk", disk.map(|free| format!("{free} 1\n")));
        for name in [
            "memory",
            "gpu",
            "compute_capability",
            "gpu_memory",
            "processes",
        ] {
            push(&mut text, name, field(name));
        }
        text.into_bytes()
    }

    fn decode(value: &Value) -> Result<HostObservation, Error> {
        super::decode(&output(value))
    }

    fn spark() -> Value {
        json!({
            "daemon":"remote", "architecture":"aarch64",
            "memory":"MemTotal: 128000000 kB\nMemAvailable: 96000000 kB\nMemFree: 64000000 kB\n",
            "gpu":"NVIDIA GB10, 580.0\n", "processes":"", "disk_free":1000000000000_u64,
            "compute_capability":"12.1\n", "gpu_memory":"[N/A], [N/A]\n"
        })
    }

    #[test]
    fn unified_memory_requires_observed_compute_capability_independently_of_vram() {
        let mut value = spark();
        let observation = decode(&value).unwrap();
        assert_eq!(observation.capacity.architecture, "arm64");
        assert_eq!(observation.capacity.compute_capability, 121);
        assert!(observation.capacity.gpu_memory.is_none());
        value["gpu_memory"] = "1024, 512\n".into();
        let observation = decode(&value).unwrap();
        assert_eq!(
            observation.capacity.gpu_memory,
            Some(super::super::GpuMemory {
                total: super::super::GIB,
                free: super::super::GIB / 2,
            })
        );
        value["compute_capability"] = "12.0\n".into();
        let observation = decode(&value).unwrap();
        assert_eq!(observation.capacity.compute_capability, 120);
        for invalid in ["", "[N/A]", "12.10", "12", "12.1\n12.1", "unknown"] {
            value["compute_capability"] = invalid.into();
            assert!(decode(&value).is_err(), "{invalid}");
        }
        value.as_object_mut().unwrap().remove("compute_capability");
        assert!(decode(&value).is_err());
    }

    #[test]
    fn arm64_blackwell_requires_observed_hbm_instead_of_host_ram() {
        let mut value = json!({"daemon":"remote", "architecture":"aarch64", "memory":"MemTotal: 496000000 kB\nMemAvailable: 396000000 kB\nMemFree: 320000000 kB\n", "gpu":"NVIDIA GB300, 610.0\n", "processes":"", "disk_free":1000000000000_u64, "gpu_memory":"245760, 204800\n", "compute_capability":"10.3\n"});
        let capacity = decode(&value).unwrap().capacity;
        assert_eq!(capacity.gpu_memory.unwrap().total, 240 * super::super::GIB);
        value["gpu_memory"] = "[N/A], [N/A]\n".into();
        assert!(decode(&value).unwrap().capacity.gpu_memory.is_none());
        for missing in [Value::Null, json!("[N/A], [N/A], 10.3")] {
            value["gpu_memory"] = missing;
            assert!(decode(&value).is_err());
        }
    }

    #[test]
    fn amd64_measurements_require_dedicated_gpu_memory_and_compute_capability() {
        let mut value = json!({"daemon":"remote", "architecture":"x86_64", "memory":"MemTotal: 256000000 kB\nMemAvailable: 196000000 kB\nMemFree: 64000000 kB\n", "gpu":"NVIDIA H100, 580.0\n", "processes":"", "disk_free":1000000000000_u64, "compute_capability":"9.0\n"});
        assert!(decode(&value).is_err());
        value["gpu_memory"] = "98304, 90112\n".into();
        let capacity = decode(&value).unwrap().for_engine("remote").unwrap();
        assert_eq!(capacity.architecture, "amd64");
        assert_eq!(capacity.gpu_memory.unwrap().total, 96 * super::super::GIB);
        value["gpu_memory"] = "[N/A], [N/A], 9.0".into();
        assert!(decode(&value).is_err());
    }

    #[test]
    fn remote_measurements_require_complete_host_data_and_matching_daemon() {
        let value = spark();
        assert!(decode(&value).unwrap().for_engine("different").is_err());
        assert!(
            decode(&value)
                .unwrap()
                .for_engine("remote")
                .unwrap()
                .disk_free
                > 0
        );
        for field in [
            "daemon",
            "memory",
            "gpu",
            "disk_free",
            "processes",
            "compute_capability",
            "gpu_memory",
        ] {
            let mut incomplete = value.clone();
            incomplete.as_object_mut().unwrap().remove(field);
            assert!(decode(&incomplete).is_err(), "{field}");
        }
        assert!(super::decode(b"{").is_err());
    }

    #[test]
    fn collection_rejects_other_systems_remote_daemons_and_ambiguous_output() {
        let valid = String::from_utf8(output(&spark())).unwrap();
        assert!(super::decode(valid.as_bytes()).is_ok());
        for changed in [
            valid.replace("os==\nLinux", "os==\nDarwin"),
            valid.replace("machine==\naarch64", "machine==\nx86_64"),
            valid.replace("unix:///var/run/docker.sock", "tcp://10.0.0.8:2375"),
            valid.replace("docker_host==\n\n", "docker_host==\nssh://elsewhere\n"),
            valid.replace("/var/lib/docker", "relative"),
            format!("{valid}{MARKER}gpu==\nNVIDIA GB10, 580.0\n"),
            format!("{valid}{MARKER}unexpected==\n"),
            format!("noise{valid}"),
        ] {
            assert!(super::decode(changed.as_bytes()).is_err(), "{changed}");
        }
    }

    /// Run the shipped script with fake `docker` and `nvidia-smi` on PATH, and
    /// the real `uname`, `stat`, and `/proc/meminfo` of this Linux host.
    #[cfg(target_os = "linux")]
    #[test]
    fn collector_script_queries_compute_and_memory_and_parses_on_linux() {
        use std::{fs, os::unix::fs::PermissionsExt, process::Command};
        let root = tempfile::tempdir().unwrap();
        let bin = root.path().join("bin");
        let docker_root = root.path().join("docker-root");
        let calls = root.path().join("calls");
        fs::create_dir(&bin).unwrap();
        fs::create_dir(&docker_root).unwrap();
        let info = json!({"ID": "fixture", "OSType": "linux",
            "Architecture": std::env::consts::ARCH, "DockerRootDir": docker_root});
        let fakes = [
            ("docker", format!(
                "case \"$1 $2\" in\n'context inspect') echo unix:///var/run/docker.sock ;;\n'info --format') if [ \"$3\" = '{{{{json .}}}}' ]; then echo '{info}'; else echo '{root}'; fi ;;\n*) exit 2 ;;\nesac\n",
                root = docker_root.display()
            )),
            ("nvidia-smi", "[ \"$2\" = --format=csv,noheader,nounits ] || exit 2\ncase \"$1\" in\n--query-gpu=name,driver_version) echo 'NVIDIA GB10, 580.0' ;;\n--query-gpu=compute_cap) echo 12.1 ;;\n--query-gpu=memory.total,memory.free) echo '[N/A], [N/A]' ;;\n--query-compute-apps=pid) ;;\n*) exit 2 ;;\nesac\n".into()),
        ];
        for (name, body) in fakes {
            let path = bin.join(name);
            fs::write(
                &path,
                format!(
                    "#!/bin/sh\nprintf '%s\\n' \"{name} $*\" >> '{}'\n{body}",
                    calls.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
        let result = Command::new("sh")
            .args(["-c", COLLECT])
            .env("PATH", path)
            .env_remove("DOCKER_HOST")
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let observation = super::decode(&result.stdout).unwrap();
        assert_eq!(observation.engine_id, "fixture");
        assert_eq!(observation.capacity.compute_capability, 121);
        assert!(observation.capacity.gpu_memory.is_none());
        assert!(observation.capacity.total > 0 && observation.capacity.disk_free > 0);
        let calls = fs::read_to_string(calls).unwrap();
        for query in [
            "--query-gpu=name,driver_version",
            "--query-gpu=compute_cap",
            "--query-gpu=memory.total,memory.free",
            "--query-compute-apps=pid",
        ] {
            assert!(
                calls.contains(&format!("nvidia-smi {query} --format=csv,noheader,nounits")),
                "{calls}"
            );
        }
    }
}
