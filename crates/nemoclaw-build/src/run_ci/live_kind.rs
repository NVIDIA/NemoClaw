// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Run the Kubernetes live tests on a temporary kind cluster, and delete
//! the cluster whatever the outcome.
//!
//! The pinned kind executable is downloaded by checksum. The cluster gets
//! the pinned Agent Sandbox release, as a platform would provide it; the
//! SDK under test installs nothing cluster-wide. The tests verify the native
//! bundle and run its OpenTofu and providers without a Helm executable.

use super::*;

/// Agent Sandbox release the tests run against, as a platform would.
const AGENT_SANDBOX_URL: &str =
    "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v0.5.0/manifest.yaml";
const AGENT_SANDBOX_SHA256: &str =
    "ccfe3649de8b33f0ee0ec635e2c7b40e1c468ad9fde6aac7c7379501327d9c4c";

fn tool_directory(name: &str) -> PathBuf {
    Path::new(".tools").join(name)
}

/// Install a verified kind binary, returning its path.
async fn kind(pins: &Pins, platform: &str) -> Result<PathBuf> {
    let artifact = artifact(pins, platform, "kind")?;
    let directory = tool_directory(&format!("kind-{}", &artifact.sha256[..12]));
    let path = directory.join("kind");
    if !path.is_file() {
        let bytes = download(artifact).await?;
        fs::create_dir_all(&directory)?;
        fs::write(&path, bytes)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o755))?;
        }
    }
    Ok(std::path::absolute(path)?)
}

/// Deletes the cluster when dropped.
struct Cluster {
    kind: PathBuf,
    name: String,
}

impl Drop for Cluster {
    fn drop(&mut self) {
        // Keep a failed run's cluster for inspection when asked to.
        if std::env::var_os("NEMOCLAW_KEEP_KIND_CLUSTER").is_some() {
            eprintln!(
                "Kept kind cluster {}; delete it with: kind delete cluster --name {}",
                self.name, self.name
            );
            return;
        }
        let _ = Command::new(&self.kind)
            .args(["delete", "cluster", "--name", &self.name])
            .stdin(Stdio::null())
            .status();
    }
}

pub(super) async fn run_live_kind(
    pins: &Pins,
    platform: &str,
    configure: &dyn Fn(&mut Command),
    archive: Option<&Path>,
) -> Result<()> {
    if !platform.starts_with("linux_") {
        return Err("the Kubernetes live tests run on Linux only".into());
    }
    let bundle = std::path::absolute(Path::new("dist").join(platform))?;
    if !bundle.join("manifest.json").is_file() {
        return Err("build the bundle first: cargo ci bundle".into());
    }
    let node = pins
        .images
        .get("kindNode")
        .ok_or("versions.json has no kindNode image")?;
    let kind = kind(pins, platform).await?;
    let inputs = tempfile::Builder::new()
        .prefix("nemoclaw-live-kind-")
        .tempdir()?;
    let mut nonce = [0u8; 4];
    getrandom::fill(&mut nonce).map_err(|_| "cannot name the test cluster")?;
    let name = format!("nc-live-{}", nemoclaw_build::hex(&nonce));
    let kubeconfig = inputs.path().join("kubeconfig");
    let cluster = Cluster {
        kind: kind.clone(),
        name: name.clone(),
    };
    run(Command::new(&kind)
        .args([
            "create", "cluster", "--name", &name, "--image", node, "--wait", "180s",
        ])
        .arg("--kubeconfig")
        .arg(&kubeconfig))?;
    // Install Agent Sandbox with the node's own kubectl, as cluster setup.
    let manifest = download(&Artifact {
        url: AGENT_SANDBOX_URL.into(),
        sha256: AGENT_SANDBOX_SHA256.into(),
    })
    .await?;
    let node_container = format!("{name}-control-plane");
    let kubectl = |args: &[&str]| -> Command {
        let mut command = Command::new("docker");
        command
            .args([
                "exec",
                "-i",
                &node_container,
                "kubectl",
                "--kubeconfig",
                "/etc/kubernetes/admin.conf",
            ])
            .args(args);
        command
    };
    let mut apply = kubectl(&["apply", "--server-side", "-f", "-"])
        .stdin(Stdio::piped())
        .spawn()?;
    apply
        .stdin
        .take()
        .ok_or("cannot write the Agent Sandbox manifest")?
        .write_all(&manifest)?;
    if !apply.wait()?.success() {
        return Err("cannot install Agent Sandbox in the test cluster".into());
    }
    run(&mut kubectl(&[
        "-n",
        "agent-sandbox-system",
        "rollout",
        "status",
        "deployment/agent-sandbox-controller",
        "--timeout=300s",
    ]))?;
    run(&mut kubectl(&[
        "wait",
        "--for=condition=Established",
        "crd/sandboxes.agents.x-k8s.io",
        "--timeout=120s",
    ]))?;

    // An agent image from this checkout, by digest, loaded into the node and
    // described by its metadata bundle. Pi is the smaller image but is built
    // only for ARM64; OpenClaw is built for both.
    let (target, harness) = if platform == "linux_arm64" {
        ("pi", "nvidia.fabric.pi")
    } else {
        ("openclaw", "nvidia.fabric.openclaw")
    };
    let docker_platform = format!("linux/{}", platform.trim_start_matches("linux_"));
    let prefix = format!("{name}-agent");
    let tag = format!("{prefix}:{target}");
    let images = ImagesCleanup(tag.clone());
    run(Command::new(std::env::current_exe()?)
        .args(["images", "build", "--platform", &docker_platform, target])
        .env("IMAGE_PREFIX", &prefix))?;
    let id = String::from_utf8(
        Command::new("docker")
            .args(["image", "inspect", "--format", "{{.Id}}", &tag])
            .output()?
            .stdout,
    )?;
    let image = format!("docker.io/library/{prefix}@{}", id.trim());
    let metadata = inputs.path().join("agent.metadata.json");
    nemoclaw_build::images::export_metadata(&tag, &docker_platform, &metadata)?;
    run(Command::new(&kind).args(["load", "docker-image", "--name", &name, &tag]))?;
    // kind loads the image by tag only; name it by digest too, so a sandbox
    // that references the digest finds it on the node instead of pulling.
    run(Command::new("docker").args([
        "exec",
        &node_container,
        "ctr",
        "-n",
        "k8s.io",
        "images",
        "tag",
        &format!("docker.io/library/{tag}"),
        &image,
    ]))?;

    let mut command = match archive {
        Some(archive) => archived(Step::LiveKind, archive, configure)?,
        None => {
            let [args] = Step::LiveKind.cargo_args() else {
                unreachable!("live-kind is one nextest command")
            };
            let mut command = cargo();
            configure(&mut command);
            command.args(*args);
            command
        }
    };
    command
        .env("NEMOCLAW_TEST_KUBECONFIG", &kubeconfig)
        .env("NEMOCLAW_TEST_KUBE_CONTEXT", format!("kind-{name}"))
        .env("NEMOCLAW_TEST_BUNDLE", &bundle)
        .env("NEMOCLAW_TEST_AGENT_IMAGE", &image)
        .env("NEMOCLAW_TEST_AGENT_HARNESS", harness)
        .env("NEMOCLAW_TEST_AGENT_METADATA", &metadata);
    let result = run(&mut command);
    drop(cluster);
    drop(images);
    result
}

/// Removes the agent image this run built.
struct ImagesCleanup(String);

impl Drop for ImagesCleanup {
    fn drop(&mut self) {
        let _ = Command::new("docker")
            .args(["image", "rm", "--force", &self.0])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}
