// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Build the live suites' images, or share them: `ci live-images` builds a
//! platform's images once and saves them, and each live step loads that
//! archive under its own names instead of building.

use super::*;

/// The repository the shared archive names its images under.
pub(super) const SHARED: &str = "nc-live-images";
/// Where `ci live-images` writes the shared archive.
const ARCHIVE: &str = ".build/ci/live-images.tar.zst";

fn docker() -> Command {
    let mut command = Command::new("docker");
    command.stdin(Stdio::null());
    command
}

/// The agent image a platform's live tests run, and its Fabric harness. Pi is
/// the smaller image but is built only for ARM64. AMD64 runs Deep Agents until
/// OpenClaw can start in an OpenShell sandbox again (#13372).
pub(super) fn agent(platform: &str) -> (&'static str, &'static str) {
    if platform == "linux_arm64" {
        ("pi", "nvidia.fabric.pi")
    } else {
        ("deepagents", "nvidia.fabric.langchain.deepagents")
    }
}

/// The platform's agent image, the reference dummy, then the two proxy images.
pub(super) fn names(platform: &str) -> [&'static str; 4] {
    [agent(platform).0, DUMMY, "proxy-a", "proxy-b"]
}

/// The platform's archive images that `used` does not name.
fn unused(platform: &str, used: &[&str]) -> Vec<&'static str> {
    names(platform)
        .into_iter()
        .filter(|name| !used.contains(name))
        .collect()
}

/// The reference agent image, which reports native health without Fabric.
pub(super) const DUMMY: &str = "dummy";

/// Build the platform's agent image as `PREFIX:TARGET`.
pub(super) fn build_agent(platform: &str, prefix: &str) -> Result<()> {
    build_image(platform, prefix, agent(platform).0)
}

/// Build the reference dummy agent image as `PREFIX:dummy`.
pub(super) fn build_dummy(platform: &str, prefix: &str) -> Result<()> {
    build_image(platform, prefix, DUMMY)
}

fn build_image(platform: &str, prefix: &str, target: &str) -> Result<()> {
    timed_build(&format!("{prefix}:{target}"), || {
        let docker_platform = format!("linux/{}", platform.trim_start_matches("linux_"));
        let status = Command::new(std::env::current_exe()?)
            .args(["images", "build", "--platform", &docker_platform, target])
            .env("IMAGE_PREFIX", prefix)
            .stdin(Stdio::null())
            .status()?;
        if !status.success() {
            return Err(format!("cannot build the {target} agent image").into());
        }
        Ok(())
    })
}

fn timed_build(tag: &str, build: impl FnOnce() -> Result<()>) -> Result<()> {
    eprintln!("Building live image {tag}");
    let start = Instant::now();
    let result = build();
    let seconds = start.elapsed().as_secs_f64();
    if result.is_ok() {
        eprintln!("Built live image {tag} in {seconds:.1}s");
    } else {
        eprintln!("Failed to build live image {tag} after {seconds:.1}s");
    }
    result
}

/// Two proxy images with distinct digests, for the image-change check.
pub(super) fn build_proxies(prefix: &str) -> Result<()> {
    for variant in ["a", "b"] {
        let tag = format!("{prefix}:proxy-{variant}");
        timed_build(&tag, || {
            run(docker()
                .args(["buildx", "build", "--load", "--progress", "plain"])
                .args(["-f", "image/ollama-proxy/Dockerfile", "--target", "runtime"])
                .args(["--label", &format!("org.nemoclaw.test=proxy-{variant}")])
                .args(["--tag", &tag, "."]))
        })?;
    }
    Ok(())
}

/// Build the platform's images under the shared names and save them to [`ARCHIVE`].
pub(super) fn build(platform: &str) -> Result<()> {
    if !platform.starts_with("linux_") {
        return Err("the live images are built on Linux only".into());
    }
    build_agent(platform, SHARED)?;
    build_dummy(platform, SHARED)?;
    build_proxies(SHARED)?;
    let tags = names(platform).map(|name| format!("{SHARED}:{name}"));
    fs::create_dir_all(".build/ci")?;
    let start = Instant::now();
    // ctr needs the fully qualified names that Docker stores internally.
    let export_tags = tags
        .each_ref()
        .map(|tag| format!("docker.io/library/{tag}"));
    let saved = save(&export_tags, Path::new(ARCHIVE));
    if saved.is_ok()
        && let Ok(metadata) = fs::metadata(ARCHIVE)
    {
        eprintln!(
            "Saved live images: {} bytes in {:.1}s",
            metadata.len(),
            start.elapsed().as_secs_f64()
        );
    }
    let cleanup = Instant::now();
    // The archive holds them; the local names would only take space.
    for tag in &tags {
        let _ = docker()
            .args(["image", "rm", tag])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    eprintln!(
        "Live image cleanup took {:.1}s",
        cleanup.elapsed().as_secs_f64()
    );
    saved
}

// Baseline for the native comparison test, not a production export path.
#[cfg(all(test, unix))]
fn save_with_docker(tags: &[String], archive: &Path) -> Result<()> {
    let mut save = docker()
        .arg("save")
        .args(tags)
        .stdout(Stdio::piped())
        .spawn()?;
    let images = save.stdout.take().ok_or("cannot read the saved images")?;
    let compressed = Command::new("zstd")
        .args(["-T0", "-3", "-q", "-f", "-o"])
        .arg(archive)
        .stdin(images)
        .status()
        .map_err(|_| "saving the live images needs the zstd command")?;
    let saved = save.wait()?;
    if !saved.success() || !compressed.success() {
        return Err("cannot save the live images".into());
    }
    Ok(())
}

/// Export directly to a file: piping ctr's small writes loses much of the gain.
/// Requires local Docker and passwordless access to ctr.
fn save(tags: &[String], archive: &Path) -> Result<()> {
    let info = docker()
        .args(["info", "--format", "{{json .Containerd}}"])
        .stderr(Stdio::inherit())
        .output()?;
    if !info.status.success() {
        return Err("cannot inspect Docker's containerd connection".into());
    }
    let connection: serde_json::Value = serde_json::from_slice(&info.stdout)?;
    let address = connection["Address"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Docker did not report its containerd address; live-images requires local Docker with the containerd image store")?;
    let namespace = connection["Namespaces"]["Containers"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or("Docker did not report its containerd namespace; live-images requires local Docker with the containerd image store")?;
    // ctr runs as root. A new path inside a private directory also works with
    // Linux's protected_regular restriction on user-owned files in /tmp.
    let directory = tempfile::tempdir()?;
    let tar = directory.path().join("images.tar");
    let start = Instant::now();
    run(Command::new("sudo")
        .args([
            "-n",
            "ctr",
            "--address",
            address,
            "--namespace",
            namespace,
            "images",
            "export",
            "--all-platforms",
        ])
        .arg(&tar)
        .args(tags))?;
    eprintln!(
        "Exported live images with containerd in {:.1}s",
        start.elapsed().as_secs_f64()
    );
    let start = Instant::now();
    run(Command::new("zstd")
        .args(["-T0", "-3", "-q", "-f", "-o"])
        .arg(archive)
        .arg(&tar))?;
    eprintln!(
        "Compressed live images in {:.1}s",
        start.elapsed().as_secs_f64()
    );
    Ok(())
}

/// Load the shared images from `archive` and name each of `names` as
/// `PREFIX:NAME`, recording each new name in `owned` before the next, so the
/// caller removes whatever this run created.
pub(super) fn load(
    archive: &Path,
    prefix: &str,
    platform: &str,
    names: &[&str],
    owned: &mut Vec<String>,
) -> Result<()> {
    let mut unpack = Command::new("zstd")
        .args(["-d", "-c", "-q"])
        .arg(archive)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "loading the live images needs the zstd command")?;
    let images = unpack.stdout.take().ok_or("cannot read the live images")?;
    let loaded = Command::new("docker")
        .arg("load")
        .stdin(images)
        .stdout(Stdio::null())
        .status()?;
    if !unpack.wait()?.success() || !loaded.success() {
        return Err(format!("cannot load the live images from {}", archive.display()).into());
    }
    for name in names {
        let shared = format!("{SHARED}:{name}");
        let tag = format!("{prefix}:{name}");
        run(docker().args(["tag", &shared, &tag]))?;
        owned.push(tag);
        // Removing the shared name keeps the image, which the new name holds.
        let _ = docker()
            .args(["image", "rm", &shared])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    // The archive holds every live image for the platform; drop the shared
    // names of those this step does not use, and nothing else.
    for name in unused(platform, names) {
        let _ = docker()
            .args(["image", "rm", &format!("{SHARED}:{name}")])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    Ok(())
}

/// An image derived from the reference image, as a downstream build would
/// make one: the base plus one executable. Docker's default builder sees
/// local images, which a container builder doesn't.
pub(super) const DERIVED: &str = "dummy-derived";
pub(super) fn build_derived(prefix: &str) -> Result<()> {
    let context = std::env::temp_dir().join(format!("nemoclaw-derived-{}", std::process::id()));
    std::fs::create_dir_all(&context)?;
    std::fs::write(
        context.join("Dockerfile"),
        format!(
            "FROM {prefix}:{DUMMY}\nCOPY --chmod=755 nemoclaw-derived-check /usr/local/bin/nemoclaw-derived-check\n"
        ),
    )?;
    std::fs::write(
        context.join("nemoclaw-derived-check"),
        "#!/bin/sh\necho derived-image-ok\n",
    )?;
    let status = Command::new("docker")
        .args([
            "buildx",
            "build",
            "--builder",
            "default",
            "--load",
            "--quiet",
            "--tag",
        ])
        .arg(format!("{prefix}:{DERIVED}"))
        .arg(&context)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .status();
    let _ = std::fs::remove_dir_all(&context);
    if !status?.success() {
        return Err("cannot build the derived reference image".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_step_drops_only_the_platform_archive_images_it_does_not_name() {
        let target = agent("linux_amd64").0;
        assert_eq!(
            unused("linux_amd64", &[target]),
            [DUMMY, "proxy-a", "proxy-b"]
        );
        assert!(unused("linux_amd64", &names("linux_amd64")).is_empty());
    }
}

#[cfg(all(test, unix))]
mod export_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn exercise(failure: &str) {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("out")).unwrap();
        fs::write(root.path().join("fixture"), b"complete image archive").unwrap();
        for (name, script) in [
            (
                "docker",
                r#"#!/bin/sh
case "$1" in
  info)
    [ "$EXPORT_FAILURE" = info ] && exit 1
    printf '%s\n' '{"Address":"/test/containerd.sock","Namespaces":{"Containers":"test-images"}}' ;;
  *) exit 92 ;;
esac
"#,
            ),
            (
                "sudo",
                r#"#!/bin/sh
[ "$1 $2 $3 $4 $5 $6 $7 $8 $9" = '-n ctr --address /test/containerd.sock --namespace test-images images export --all-platforms' ] || exit 93
shift 9
destination=$1
shift
[ "$*" = 'docker.io/library/nc-test:agent docker.io/library/nc-test:proxy' ] || exit 94
printf called > "$EXPORT_ROOT/containerd-called"
/bin/cp "$EXPORT_ROOT/fixture" "$destination"
[ "$EXPORT_FAILURE" != export ]
"#,
            ),
            (
                "zstd",
                r#"#!/bin/sh
while [ "$1" != -o ]; do shift; done
shift
destination=$1
shift
if [ "$#" = 0 ]; then /bin/cat > "$destination"; else /bin/cat "$1" > "$destination"; fi
[ "$EXPORT_FAILURE" != compression ]
"#,
            ),
        ] {
            let path = root.path().join(name);
            fs::write(&path, script).unwrap();
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "run_ci::live_images::export_tests::export_child",
                "--nocapture",
            ])
            .env("EXPORT_ROOT", root.path())
            .env("EXPORT_FAILURE", failure)
            .env("PATH", root.path())
            .env("TMPDIR", root.path().join("out"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        if failure.is_empty() {
            assert_eq!(
                fs::read(root.path().join("out/images.tar.zst")).unwrap(),
                b"complete image archive"
            );
        }
        assert_eq!(
            root.path().join("containerd-called").exists(),
            failure != "info"
        );
        assert!(
            fs::read_dir(root.path().join("out"))
                .unwrap()
                .all(|entry| entry.unwrap().file_name() == "images.tar.zst")
        );
    }

    #[test]
    fn containerd_export_preserves_bytes_without_docker_save() {
        exercise("");
    }

    #[test]
    fn containerd_failures_are_reported_and_temporary_archives_removed() {
        for failure in ["info", "export", "compression"] {
            exercise(failure);
        }
    }

    /// Read-only comparison using caller-selected local images. No tags are changed.
    #[test]
    #[ignore = "needs local containerd Docker, sudo -n ctr, zstd, and NEMOCLAW_EXPORT_TEST_IMAGES"]
    fn native_exporters_preserve_image_metadata_and_blobs() {
        let tags: Vec<String> = std::env::var("NEMOCLAW_EXPORT_TEST_IMAGES")
            .expect("set space-separated, fully qualified local image tags")
            .split_whitespace()
            .map(str::to_owned)
            .collect();
        assert!(!tags.is_empty());
        let root = tempfile::tempdir().unwrap();
        let platform = format!(
            "linux/{}",
            host_platform().unwrap().trim_start_matches("linux_")
        );
        let mut baseline = None;
        type Save = fn(&[String], &Path) -> Result<()>;
        for (name, exporter) in [
            ("docker", save_with_docker as Save),
            ("containerd", save as Save),
        ] {
            let archive = root.path().join(format!("{name}.tar.zst"));
            let start = Instant::now();
            exporter(&tags, &archive).unwrap();
            eprintln!(
                "{name}: {:.2}s, {} bytes",
                start.elapsed().as_secs_f64(),
                fs::metadata(&archive).unwrap().len()
            );
            let tar = root.path().join(format!("{name}.tar"));
            run(Command::new("zstd")
                .args(["-d", "-q", "-o"])
                .arg(&tar)
                .arg(&archive))
            .unwrap();
            let metadata: Vec<_> = tags
                .iter()
                .map(|tag| {
                    nemoclaw_build::images::archived_image_metadata(&tar, tag, &platform).unwrap()
                })
                .collect();
            let mut blobs = std::collections::BTreeMap::new();
            let mut archive = tar::Archive::new(fs::File::open(&tar).unwrap());
            for entry in archive.entries().unwrap() {
                use std::io::Read as _;
                let mut entry = entry.unwrap();
                let path = entry.path().unwrap().into_owned();
                if !entry.header().entry_type().is_file() || !path.starts_with("blobs/sha256") {
                    continue;
                }
                let mut hash = Sha256::new();
                let mut buffer = [0; 65536];
                loop {
                    let read = entry.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    hash.update(&buffer[..read]);
                }
                blobs.insert(path, hash.finalize());
            }
            let contents = (metadata, blobs);
            if let Some(baseline) = &baseline {
                assert_eq!(&contents, baseline);
            } else {
                baseline = Some(contents);
            }
        }
    }

    #[test]
    fn export_child() {
        let Some(root) = std::env::var_os("EXPORT_ROOT") else {
            return;
        };
        let result = save(
            &[
                "docker.io/library/nc-test:agent".into(),
                "docker.io/library/nc-test:proxy".into(),
            ],
            &PathBuf::from(root).join("out/images.tar.zst"),
        );
        if std::env::var("EXPORT_FAILURE").unwrap().is_empty() {
            result.unwrap();
        } else {
            assert!(result.is_err(), "failed export must fail the step");
        }
    }
}
