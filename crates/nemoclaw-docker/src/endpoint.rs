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
/// Unix socket's own path, or `/var/run/docker.sock` in the Linux VM behind a
/// named pipe or a macOS client's forwarded socket. `None` for an engine on
/// another host.
///
/// Docker Desktop serves its engine at `/var/run/docker.sock` in its VM. A
/// Podman machine links `/run/docker.sock`, which `/var/run` reaches, to the
/// API socket of its rootful or rootless mode, which its pipe and its macOS
/// socket forward to. On macOS, Colima and Rancher Desktop forward the VM's
/// `/var/run/docker.sock` too; see [`macos_vm_engine`].
pub fn engine_socket(endpoint: &str) -> Option<&str> {
    const VM_SOCKET: &str = "/var/run/docker.sock";
    validate_engine_endpoint(endpoint).ok()?;
    if endpoint.starts_with("npipe://") {
        return Some(VM_SOCKET);
    }
    let path = endpoint.strip_prefix("unix://")?;
    Some(if cfg!(target_os = "macos") && macos_vm_engine(path) {
        VM_SOCKET
    } else {
        path
    })
}

/// Whether a macOS client's socket is the forwarded end of an engine that
/// serves `/var/run/docker.sock` in its Linux VM, at the socket its engine
/// places by default:
///
/// - Docker Desktop: `~/.docker/run/docker.sock`
///   (<https://docs.docker.com/desktop/setup/install/mac-permission-requirements/>);
///   containers bind its engine as `/var/run/docker.sock`
///   (<https://docs.docker.com/enterprise/security/hardened-desktop/enhanced-container-isolation/>).
/// - Colima: `docker.sock` in a profile's directory, or before 0.4.0 in the
///   configuration directory, `~/.colima` or `$XDG_CONFIG_HOME/colima`; it
///   forwards the VM's `/var/run/docker.sock`
///   (<https://github.com/abiosoft/colima/blob/main/environment/vm/lima/yaml.go>).
/// - Rancher Desktop: `~/.rd/docker.sock`, forwarding the VM's
///   `/var/run/docker.sock`
///   (<https://docs.rancherdesktop.io/how-to-guides/using-testcontainers>).
/// - A Podman machine: `$TMPDIR/podman/NAME-api.sock`
///   (<https://github.com/containers/podman/blob/main/pkg/machine/vmconfigs/sockets.go>).
///
/// Another socket keeps its path: `/var/run/docker.sock` is already that path,
/// and an engine at another socket, such as a Lima instance's or one under
/// `COLIMA_HOME`, can't be told from its address.
fn macos_vm_engine(path: &str) -> bool {
    let mut parts = path.rsplit('/');
    let (file, parent, grandparent) = (parts.next(), parts.next(), parts.next());
    let colima = |dir: Option<&str>| matches!(dir, Some(".colima" | "colima"));
    match (file, parent) {
        (Some("docker.sock"), Some(".rd")) => true,
        (Some("docker.sock"), Some("run")) => grandparent == Some(".docker"),
        (Some("docker.sock"), parent) => colima(parent) || colima(grandparent),
        (Some(name), Some("podman")) => name.ends_with("-api.sock"),
        _ => false,
    }
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
