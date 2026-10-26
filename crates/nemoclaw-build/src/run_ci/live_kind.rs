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
        // Keep the cluster for inspection when asked to, whatever the outcome.
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
    images: live_images::Source<'_>,
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
    // described by its metadata bundle.
    let (target, harness) = live_images::agent();
    let prefix = format!("{name}-agent");
    let tag = format!("{prefix}:{target}");
    let metadata = inputs.path().join("agent.metadata.json");
    let cleanup = matches!(images, live_images::Source::Build).then(|| ImagesCleanup(tag.clone()));
    let (id, node_image) = match images {
        live_images::Source::Archive(archive) => (
            load_archived_agent(&kind, &name, archive, inputs.path())?,
            format!("docker.io/library/{}:{target}", live_images::SHARED),
        ),
        live_images::Source::Commit(commit) => {
            pull_pushed_agent(commit, platform, &node_container, &metadata).await?
        }
        live_images::Source::Build => {
            live_images::build_agent(platform, &prefix)?;
            let id = String::from_utf8(
                Command::new("docker")
                    .args(["image", "inspect", "--format", "{{.Id}}", &tag])
                    .output()?
                    .stdout,
            )?;
            nemoclaw_build::images::export_metadata(&tag, &metadata)?;
            run(Command::new(&kind).args(["load", "docker-image", "--name", &name, &tag]))?;
            (id, format!("docker.io/library/{tag}"))
        }
    };
    let image = format!("docker.io/library/{prefix}@{}", id.trim());
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
        &node_image,
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
        .env("NEMOCLAW_TEST_KUBE_RUNTIME", "kubernetes")
        .env("NEMOCLAW_TEST_KIND_NODE", &node_container)
        .env("NEMOCLAW_TEST_BUNDLE", &bundle)
        .env("NEMOCLAW_TEST_AGENT_IMAGE", &image)
        .env("NEMOCLAW_TEST_AGENT_HARNESS", harness)
        .env("NEMOCLAW_TEST_AGENT_METADATA", &metadata)
        // Only the image pull above needs the registry.
        .env_remove(REGISTRY_USERNAME)
        .env_remove(REGISTRY_PASSWORD);
    let result = run(&mut command);
    drop(cluster);
    drop(cleanup);
    result
}

/// The registry credentials a pull of pushed images uses, as for
/// `images export-metadata --registry`.
const REGISTRY_USERNAME: &str = "NEMOCLAW_REGISTRY_USERNAME";
const REGISTRY_PASSWORD: &str = "NEMOCLAW_REGISTRY_PASSWORD";

/// Pull the agent image `commit` pushed for this platform straight into the
/// node, and write its metadata bundle from the registry. A Docker save of a
/// pulled image lacks its config, so neither goes through the host engine.
/// Returns the image's digest and its name on the node.
async fn pull_pushed_agent(
    commit: &str,
    platform: &str,
    node: &str,
    metadata: &Path,
) -> Result<(String, String)> {
    let arch = platform.trim_start_matches("linux_");
    let reference = nemoclaw_build::ci::commit_image(live_images::agent().0, commit, arch);
    let digest = String::from_utf8(
        Command::new("docker")
            .args([
                "buildx",
                "imagetools",
                "inspect",
                &reference,
                "--format",
                "{{.Manifest.Digest}}",
            ])
            .stdin(Stdio::null())
            .output()?
            .stdout,
    )?
    .trim()
    .to_owned();
    if !digest.starts_with("sha256:") {
        return Err(format!("cannot resolve {reference}; sign in to ghcr.io first").into());
    }
    let credentials = std::env::var(REGISTRY_USERNAME)
        .ok()
        .zip(std::env::var(REGISTRY_PASSWORD).ok());
    let bundle = nemoclaw_build::images::registry_metadata(
        &format!("{}@{digest}", nemoclaw_build::ci::COMMIT_IMAGES),
        credentials.clone(),
    )
    .await?;
    nemoclaw_build::images::write_bundle(&bundle, metadata)?;
    // The credentials reach ctr through the environment, not its arguments.
    let mut pull = Command::new("docker");
    pull.arg("exec");
    let script = match &credentials {
        Some((username, password)) => {
            pull.env(
                "NEMOCLAW_PULL_CREDENTIALS",
                format!("{username}:{password}"),
            )
            .args(["-e", "NEMOCLAW_PULL_CREDENTIALS"]);
            r#"exec ctr -n k8s.io images pull --platform "$1" --user "$NEMOCLAW_PULL_CREDENTIALS" "$2" > /dev/null"#
        }
        None => r#"exec ctr -n k8s.io images pull --platform "$1" "$2" > /dev/null"#,
    };
    pull.args([
        node,
        "sh",
        "-c",
        script,
        "sh",
        &format!("linux/{arch}"),
        &reference,
    ])
    .stdin(Stdio::null());
    run(&mut pull)?;
    Ok((digest, reference))
}

/// Import the saved images into the node without a host Docker load or re-export.
fn load_archived_agent(kind: &Path, name: &str, images: &Path, inputs: &Path) -> Result<String> {
    let archive = inputs.join("images.tar");
    run(Command::new("zstd")
        .args(["-d", "-q", "-f", "-o"])
        .arg(&archive)
        .arg(images))?;
    let target = live_images::agent().0;
    let (digest, metadata) = nemoclaw_build::images::archived_image_metadata(
        &archive,
        &format!("docker.io/library/{}:{target}", live_images::SHARED),
    )?;
    fs::write(inputs.join("agent.metadata.json"), metadata)?;
    run(Command::new(kind)
        .args(["load", "image-archive", "--name", name])
        .arg(&archive))?;
    Ok(digest)
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn archived_agent_reaches_kind_without_loading_or_saving_host_images() {
        let root = tempfile::tempdir().unwrap();
        let config = br#"{"os":"linux","architecture":"arm64"}"#;
        let digest =
            |bytes: &[u8]| format!("sha256:{}", nemoclaw_build::hex(&Sha256::digest(bytes)));
        let manifest = serde_json::json!({"schemaVersion": 2, "config": {"digest": digest(config)}, "layers": []}).to_string();
        let id = digest(manifest.as_bytes());
        let index = serde_json::json!({"manifests": [{"digest": id, "annotations": {"io.containerd.image.name": "docker.io/library/nc-live-images:openclaw"}}]}).to_string();
        let mut archive = tar::Builder::new(Vec::new());
        for (path, bytes) in [
            (
                format!("blobs/sha256/{}", &digest(config)[7..]),
                config.as_slice(),
            ),
            (format!("blobs/sha256/{}", &id[7..]), manifest.as_bytes()),
            ("index.json".into(), index.as_bytes()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(bytes.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            archive.append_data(&mut header, path, bytes).unwrap();
        }
        let archive = archive.into_inner().unwrap();
        fs::write(root.path().join("images.tar.zst"), &archive).unwrap();
        // The fake decompressor copies the fixture bytes; the real zstd path is
        // exercised by the live suite. Commands run in a child with its own PATH.
        for (name, script) in [
            (
                "zstd",
                "#!/bin/sh\nif [ \"$3\" = -c ]; then /bin/cat \"$4\"; else /bin/cp \"$6\" \"$5\"; fi\n",
            ),
            (
                "kind",
                "#!/bin/sh\n[ \"$1 $2 $3 $4\" = 'load image-archive --name nc-test' ] || exit 90\n/bin/cp \"$5\" \"$FAKE_ROOT/imported.tar\"\nexit \"${FAKE_KIND_EXIT:-0}\"\n",
            ),
            (
                "docker",
                "#!/bin/sh\nprintf unexpected > \"$FAKE_ROOT/docker-called\"\nexit 91\n",
            ),
        ] {
            let path = root.path().join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        for failure in [false, true] {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "run_ci::live_kind::tests::archive_load_child",
                    "--nocapture",
                ])
                .env("FAKE_ROOT", root.path())
                .env("FAKE_DIGEST", &id)
                .env("FAKE_KIND_EXIT", if failure { "1" } else { "0" })
                .env("PATH", root.path())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(fs::read(root.path().join("imported.tar")).unwrap(), archive);
            assert!(!root.path().join("docker-called").exists());
        }
    }

    #[test]
    fn archive_load_child() {
        let Some(root) = std::env::var_os("FAKE_ROOT") else {
            return;
        };
        let root = PathBuf::from(root);
        let result = load_archived_agent(
            &root.join("kind"),
            "nc-test",
            &root.join("images.tar.zst"),
            &root,
        );
        if std::env::var("FAKE_KIND_EXIT").unwrap() == "1" {
            assert!(result.is_err(), "failed Kind import must fail the step");
        } else {
            assert_eq!(result.unwrap(), std::env::var("FAKE_DIGEST").unwrap());
            let metadata: serde_json::Value =
                serde_json::from_slice(&fs::read(root.join("agent.metadata.json")).unwrap())
                    .unwrap();
            assert_eq!(metadata["schema_version"], 2);
            assert!(metadata["blobs"][std::env::var("FAKE_DIGEST").unwrap()].is_string());
        }
    }
}
