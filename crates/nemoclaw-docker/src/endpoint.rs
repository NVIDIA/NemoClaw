// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_backend::ConfigError;

/// Validate an engine address without opening a platform-specific transport.
pub fn validate_engine_endpoint(endpoint: &str) -> Result<(), ConfigError> {
    if endpoint.starts_with("ssh://") {
        return validate_ssh(endpoint);
    }
    let invalid = || {
        ConfigError::new(
            "an engine endpoint must be an explicit Unix socket, a named pipe on this machine, or SSH",
        )
    };
    // Docker Desktop and Podman name their Windows pipes like docker_engine
    // and podman-machine-default; a pipe on another machine is not local.
    if let Some(name) = endpoint.strip_prefix("npipe:////./pipe/") {
        return (!name.is_empty()
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)))
        .then_some(())
        .ok_or_else(invalid);
    }
    if !endpoint.starts_with("unix:///") || endpoint.contains(['\0', '?', '#']) {
        return Err(invalid());
    }
    Ok(())
}

/// The path at which a container on a local engine reaches that engine: a
/// Unix socket's own path, or for a named pipe `/var/run/docker.sock` in the
/// Linux VM behind the pipe. Docker Desktop serves its engine there, and a
/// Podman machine links it to the API socket of its rootful or rootless mode,
/// which its pipe forwards to. `None` for an engine on another host.
pub fn engine_socket(endpoint: &str) -> Option<&str> {
    validate_engine_endpoint(endpoint).ok()?;
    if endpoint.starts_with("npipe://") {
        return Some("/var/run/docker.sock");
    }
    endpoint.strip_prefix("unix://")
}

fn validate_ssh(endpoint: &str) -> Result<(), ConfigError> {
    let invalid = || {
        ConfigError::new(
            "SSH engine requires ssh://[user@]host[:port] without passwords, paths or options",
        )
    };
    let url = url::Url::parse(endpoint).map_err(|_| invalid())?;
    let safe_name = |name: &str| {
        !name.starts_with('-')
            && name
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    };
    if endpoint
        .bytes()
        .any(|c| c.is_ascii_whitespace() || c.is_ascii_control() || c == b'%')
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.path().is_empty()
        || !safe_name(url.username())
        || url
            .host_str()
            .is_none_or(|host| !safe_name(host) || host.is_empty())
        || url.port() == Some(0)
    {
        return Err(invalid());
    }
    Ok(())
}
