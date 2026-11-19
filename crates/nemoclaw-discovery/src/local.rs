// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The engines this machine may run sandboxes on, found from its environment.
use nemoclaw_sdk::{
    config::{ComputeDriver, GATEWAY_ENGINE, validate_engine_endpoint},
    discovery::DiscoveryRequest,
};

/// Where this machine's Docker and Podman engines may listen: Docker where the
/// Docker client would connect, when that is a Unix socket, otherwise its
/// default socket; Podman at the user's socket under `XDG_RUNTIME_DIR`, then
/// the rootful socket. On Windows, the same is true for named pipes: Docker
/// Desktop's default pipe and the default Podman machine's pipe. These are
/// candidates to read, not engines known to exist.
pub fn local_engine_candidates() -> Vec<DiscoveryRequest> {
    local_engine_candidates_in(|name| std::env::var(name).ok(), cfg!(windows))
}

/// The endpoint the Docker client selects: `DOCKER_HOST`, then the context
/// `DOCKER_CONTEXT` names, then the configuration's current context. The
/// default context has no stored endpoint.
fn docker_endpoint(environment: &impl Fn(&str) -> Option<String>, windows: bool) -> Option<String> {
    use sha2::{Digest, Sha256};
    if let Some(host) = environment("DOCKER_HOST").filter(|host| !host.is_empty()) {
        return Some(host);
    }
    let config = environment("DOCKER_CONFIG")
        .map(std::path::PathBuf::from)
        .or_else(|| {
            // The Docker client's home directory is the user's profile on Windows.
            environment(if windows { "USERPROFILE" } else { "HOME" })
                .map(|home| std::path::Path::new(&home).join(".docker"))
        })?;
    let read = |path: std::path::PathBuf| {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    };
    let context = environment("DOCKER_CONTEXT")
        .filter(|context| !context.is_empty())
        .or_else(|| {
            read(config.join("config.json"))?["currentContext"]
                .as_str()
                .map(String::from)
        })
        .filter(|context| context != "default")?;
    // Docker stores a context's metadata under the hex SHA-256 of its name.
    let directory: String = Sha256::digest(context.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    read(
        config
            .join("contexts/meta")
            .join(directory)
            .join("meta.json"),
    )?["Endpoints"]["docker"]["Host"]
        .as_str()
        .map(String::from)
}

/// This machine's engines listen on Unix sockets, or on Windows on named
/// pipes; an SSH engine is another host's.
fn local_engine(endpoint: &str, windows: bool) -> bool {
    endpoint.starts_with(if windows { "npipe://" } else { "unix:///" })
        && validate_engine_endpoint(endpoint).is_ok()
}

fn local_engine_candidates_in(
    environment: impl Fn(&str) -> Option<String>,
    windows: bool,
) -> Vec<DiscoveryRequest> {
    let engine = |engine: String, compute_driver| DiscoveryRequest {
        engine,
        compute_driver,
    };
    let docker = docker_endpoint(&environment, windows)
        .filter(|endpoint| local_engine(endpoint, windows))
        .unwrap_or_else(|| {
            if windows {
                "npipe:////./pipe/docker_engine".into()
            } else {
                GATEWAY_ENGINE.into()
            }
        });
    let mut engines = vec![engine(docker, ComputeDriver::Docker)];
    if windows {
        engines.push(engine(
            "npipe:////./pipe/podman-machine-default".into(),
            ComputeDriver::Podman,
        ));
        return engines;
    }
    if let Some(runtime) = environment("XDG_RUNTIME_DIR") {
        let user = format!("unix://{runtime}/podman/podman.sock");
        if runtime.starts_with('/') && local_engine(&user, false) {
            engines.push(engine(user, ComputeDriver::Podman));
        }
    }
    engines.push(engine(
        "unix:///run/podman/podman.sock".into(),
        ComputeDriver::Podman,
    ));
    engines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engines(variables: &[(&str, &str)]) -> Vec<(String, ComputeDriver)> {
        engines_on(false, variables)
    }

    fn engines_on(windows: bool, variables: &[(&str, &str)]) -> Vec<(String, ComputeDriver)> {
        local_engine_candidates_in(
            |name| {
                variables
                    .iter()
                    .find(|(variable, _)| *variable == name)
                    .map(|(_, value)| (*value).into())
            },
            windows,
        )
        .into_iter()
        .map(|request| (request.engine, request.compute_driver))
        .collect()
    }

    #[test]
    fn windows_lists_docker_desktop_and_the_default_podman_machine_pipes() {
        assert_eq!(
            engines_on(true, &[]),
            [
                (
                    "npipe:////./pipe/docker_engine".into(),
                    ComputeDriver::Docker
                ),
                (
                    "npipe:////./pipe/podman-machine-default".into(),
                    ComputeDriver::Podman
                ),
            ]
        );
    }

    #[test]
    fn windows_uses_the_pipe_the_docker_client_selects() {
        // Docker Desktop's desktop-linux context, under the user's profile.
        let desktop = "npipe:////./pipe/dockerDesktopLinuxEngine";
        let profile = tempfile::tempdir().unwrap();
        let config = docker_config(Some("desktop-linux"), &[("desktop-linux", desktop)]);
        std::fs::rename(config.path(), profile.path().join(".docker")).unwrap();
        let profile = profile.path().to_str().unwrap();
        assert_eq!(engines_on(true, &[("USERPROFILE", profile)])[0].0, desktop);
        let podman = "npipe:////./pipe/podman-machine-default";
        assert_eq!(
            engines_on(true, &[("USERPROFILE", profile), ("DOCKER_HOST", podman)])[0].0,
            podman
        );
        // A Unix socket or a remote engine is not this Windows machine's.
        for other in ["unix:///var/run/docker.sock", "ssh://operator@gpu-box"] {
            assert_eq!(
                engines_on(true, &[("DOCKER_HOST", other)])[0].0,
                "npipe:////./pipe/docker_engine"
            );
        }
    }

    #[test]
    fn docker_honors_a_unix_socket_docker_host_and_otherwise_uses_its_default_socket() {
        assert_eq!(
            engines(&[("DOCKER_HOST", "unix:///home/me/.colima/docker.sock")])[0],
            (
                "unix:///home/me/.colima/docker.sock".into(),
                ComputeDriver::Docker
            )
        );
        for unsupported in [
            "ssh://operator@gpu-box",
            "tcp://127.0.0.1:2375",
            "npipe:////./pipe/docker_engine",
        ] {
            assert_eq!(
                engines(&[("DOCKER_HOST", unsupported)])[0].0,
                GATEWAY_ENGINE
            );
        }
        assert_eq!(engines(&[])[0].0, GATEWAY_ENGINE);
    }

    /// A Docker configuration directory whose `current` context, if any, is
    /// selected, with a context for each `(name, host)`.
    fn docker_config(current: Option<&str>, contexts: &[(&str, &str)]) -> tempfile::TempDir {
        use sha2::{Digest, Sha256};
        let directory = tempfile::tempdir().unwrap();
        if let Some(current) = current {
            std::fs::write(
                directory.path().join("config.json"),
                serde_json::json!({"currentContext": current}).to_string(),
            )
            .unwrap();
        }
        for (name, host) in contexts {
            let meta = directory.path().join("contexts/meta").join(
                Sha256::digest(name.as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>(),
            );
            std::fs::create_dir_all(&meta).unwrap();
            std::fs::write(
                meta.join("meta.json"),
                serde_json::json!({"Name": name, "Endpoints": {"docker": {"Host": host}}})
                    .to_string(),
            )
            .unwrap();
        }
        directory
    }

    fn docker(variables: &[(&str, &str)]) -> String {
        engines(variables)[0].0.clone()
    }

    #[test]
    fn docker_uses_the_current_context_socket_like_the_docker_client() {
        let colima = "unix:///Users/me/.colima/default/docker.sock";
        let config = docker_config(Some("colima"), &[("colima", colima)]);
        let config = config.path().to_str().unwrap();
        assert_eq!(docker(&[("DOCKER_CONFIG", config)]), colima);

        // The configuration directory defaults to ~/.docker.
        let home = tempfile::tempdir().unwrap();
        let in_home = docker_config(Some("colima"), &[("colima", colima)]);
        std::fs::rename(in_home.path(), home.path().join(".docker")).unwrap();
        assert_eq!(docker(&[("HOME", home.path().to_str().unwrap())]), colima);

        // DOCKER_CONTEXT selects over the configured context, and DOCKER_HOST over both.
        let desktop = "unix:///Users/me/.docker/run/docker.sock";
        let both = docker_config(Some("colima"), &[("colima", colima), ("desktop", desktop)]);
        let both = both.path().to_str().unwrap();
        assert_eq!(
            docker(&[("DOCKER_CONFIG", both), ("DOCKER_CONTEXT", "desktop")]),
            desktop
        );
        assert_eq!(
            docker(&[
                ("DOCKER_CONFIG", both),
                ("DOCKER_CONTEXT", "desktop"),
                ("DOCKER_HOST", "unix:///srv/docker.sock")
            ]),
            "unix:///srv/docker.sock"
        );
    }

    #[test]
    fn docker_uses_its_default_socket_when_the_context_is_not_a_local_socket() {
        let remote = docker_config(Some("remote"), &[("remote", "ssh://operator@gpu-box")]);
        let missing = docker_config(Some("gone"), &[]);
        let default = docker_config(Some("default"), &[]);
        for config in [&remote, &missing, &default] {
            assert_eq!(
                docker(&[("DOCKER_CONFIG", config.path().to_str().unwrap())]),
                GATEWAY_ENGINE
            );
        }
    }

    #[test]
    fn podman_is_read_at_the_users_runtime_socket_then_the_rootful_socket() {
        let podman: Vec<_> = engines(&[("XDG_RUNTIME_DIR", "/run/user/501")])
            .into_iter()
            .filter(|(_, driver)| *driver == ComputeDriver::Podman)
            .map(|(endpoint, _)| endpoint)
            .collect();
        assert_eq!(
            podman,
            [
                "unix:///run/user/501/podman/podman.sock",
                "unix:///run/podman/podman.sock"
            ]
        );
        assert_eq!(
            engines(&[("XDG_RUNTIME_DIR", "relative")]).len(),
            2,
            "a relative runtime directory names no socket"
        );
    }
}
