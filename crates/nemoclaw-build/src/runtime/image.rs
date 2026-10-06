// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use crate::{Result, run};
use nemoclaw_build::RuntimeArtifact;
use serde::Deserialize;
use std::{fs, path::Path, process::Command};

pub(super) fn require_containerd(docker: &Path) -> Result<()> {
    let output = Command::new(docker)
        .args(["info", "--format", "{{json .DriverStatus}}"])
        .output()?;
    let status = serde_json::from_slice::<Vec<[String; 2]>>(&output.stdout);
    if !output.status.success()
        || !status.is_ok_and(|rows| {
            rows.iter()
                .any(|row| row[0] == "driver-type" && row[1] == "io.containerd.snapshotter.v1")
        })
    {
        return Err("runtime image builds require a reachable Docker daemon using the containerd image store; check docker info and docs/build.md before building".into());
    }
    Ok(())
}

pub(super) fn export_and_load(
    docker: &Path,
    recipe: &RuntimeArtifact,
    context: &Path,
    archive: &Path,
) -> Result<String> {
    let metadata =
        tempfile::NamedTempFile::new_in(archive.parent().ok_or("archive directory missing")?)?;
    run(Command::new(docker)
        .args(["buildx", "build", "--provenance=false"])
        .arg("--label")
        .arg(format!(
            "{}={}",
            nemoclaw_runtime::SPEC_VERSION_LABEL,
            nemoclaw_runtime::SPEC_VERSION
        ))
        .arg(format!("--platform={}", recipe.platform.replace('_', "/")))
        .arg("--output")
        .arg(format!(
            "type=oci,dest={},rewrite-timestamp=true",
            archive.display()
        ))
        .arg("--metadata-file")
        .arg(metadata.path())
        .arg("--build-arg")
        .arg(format!("SOURCE_DATE_EPOCH={}", recipe.source_date_epoch))
        .args(["-t", &recipe.image])
        .arg(context))?;
    let metadata: serde_json::Value = serde_json::from_slice(&fs::read(metadata.path())?)?;
    let digest = metadata["containerimage.digest"]
        .as_str()
        .ok_or("build output has no image digest")?;
    if !digest.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    }) {
        return Err("build output has an invalid image digest".into());
    }
    run(Command::new(docker).args(["load", "-i"]).arg(archive))?;
    let loaded = inspect(docker, &recipe.image)?;
    let reference = loaded
        .repo_digests
        .iter()
        .find(|reference| reference.ends_with(&format!("@{digest}")))
        .ok_or("loaded runtime image does not retain the exported manifest digest")?;
    let pinned = inspect(docker, reference)?;
    if loaded.id.is_empty()
        || loaded.id != pinned.id
        || format!("{}_{}", pinned.os, pinned.architecture) != recipe.platform
    {
        return Err(
            "loaded runtime image does not match the exported identity and platform".into(),
        );
    }
    if pinned
        .config
        .labels
        .get(nemoclaw_runtime::SPEC_VERSION_LABEL)
        .map(String::as_str)
        != Some(nemoclaw_runtime::SPEC_VERSION)
    {
        return Err("loaded runtime image lacks the required runtime specification label; rebuild the image".into());
    }
    Ok(reference.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Image {
    id: String,
    repo_digests: Vec<String>,
    os: String,
    architecture: String,
    #[serde(default)]
    config: ImageConfig,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ImageConfig {
    #[serde(default)]
    labels: std::collections::BTreeMap<String, String>,
}
fn inspect(docker: &Path, reference: &str) -> Result<Image> {
    let output = Command::new(docker)
        .args(["image", "inspect", "--format", "{{json .}}", reference])
        .output()?;
    if !output.status.success() {
        return Err("cannot inspect the loaded runtime image by its immutable reference".into());
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    #[test]
    #[ignore = "requires explicit NEMOCLAW_TEST_RUNTIME_IMAGE=1 and Docker with containerd; builds and removes one owned scratch image"]
    fn runtime_archive_loads_with_its_exported_digest() {
        assert_eq!(
            std::env::var("NEMOCLAW_TEST_RUNTIME_IMAGE").as_deref(),
            Ok("1")
        );
        let docker = Path::new("docker");
        require_containerd(docker).unwrap();
        let root = tempfile::tempdir().unwrap();
        let name = format!(
            "nemoclaw-runtime-test-{}",
            root.path()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .trim_start_matches('.')
                .to_lowercase()
        );
        let image = format!("{name}:test");
        fs::write(
            root.path().join("Dockerfile"),
            "FROM scratch\nCOPY payload /payload\n",
        )
        .unwrap();
        fs::write(root.path().join("payload"), &name).unwrap();
        let recipe = RuntimeArtifact::parse(
            &serde_json::to_vec(&serde_json::json!({
                "name":name,"image":image,"platform":nemoclaw_build::native_runtime_platform().unwrap(),
                "sourceDateEpoch":1789516800_u64,"files":["Dockerfile"],"downloads":{}
            }))
            .unwrap(),
        )
        .unwrap();
        let result = export_and_load(
            docker,
            &recipe,
            root.path(),
            &root.path().join("runtime.tar"),
        );
        let cleanup = Command::new(docker)
            .args(["image", "rm", &image])
            .output()
            .unwrap();
        let reference = result.unwrap();
        assert!(
            cleanup.status.success(),
            "{}",
            String::from_utf8_lossy(&cleanup.stderr)
        );
        assert!(reference.starts_with(&format!("{name}@sha256:")));
    }
}

#[cfg(all(test, unix))]
mod fixture_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A `docker` executable that re-runs this test binary as the fake below.
    /// The test harness writes its own lines to stdout, so the fake leaves its
    /// answer in a file and its exit status in another, and this wrapper
    /// relays both.
    fn fake_docker(root: &Path) -> std::path::PathBuf {
        let docker = root.join("docker");
        fs::write(
            &docker,
            format!(
                "#!/bin/sh\nrm -f {out} {code}\nNEMOCLAW_BUILD_FAKE_DOCKER={root} {test} --exact runtime::image::fixture_tests::fake_docker_entry --quiet -- \"$@\" >/dev/null 2>&1\n[ -f {out} ] && cat {out}\nexit \"$(cat {code})\"\n",
                root = shell_quote(root.to_str().unwrap()),
                out = shell_quote(root.join("answer").to_str().unwrap()),
                code = shell_quote(root.join("status").to_str().unwrap()),
                test = shell_quote(std::env::current_exe().unwrap().to_str().unwrap()),
            ),
        )
        .unwrap();
        fs::set_permissions(&docker, fs::Permissions::from_mode(0o700)).unwrap();
        docker
    }

    fn shell_quote(text: &str) -> String {
        format!("'{}'", text.replace('\'', "'\\''"))
    }

    /// Records each call and answers build, load, and inspect from fixture
    /// files, failing where `failure` says. Does nothing in ordinary runs.
    #[test]
    fn fake_docker_entry() {
        let Some(root) = std::env::var_os("NEMOCLAW_BUILD_FAKE_DOCKER") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let args: Vec<String> = std::env::args()
            .skip_while(|arg| arg != "--")
            .skip(1)
            .collect();
        let mut calls = fs::read_to_string(root.join("calls")).unwrap_or_default();
        calls.push_str(&args.join(" "));
        calls.push('\n');
        fs::write(root.join("calls"), calls).unwrap();
        let failure = fs::read_to_string(root.join("failure")).unwrap();
        let exit = |code: u8| fs::write(root.join("status"), code.to_string()).unwrap();
        let status = match args[0].as_str() {
            "buildx" if failure == "build" => 1,
            "buildx" => {
                let at = args
                    .iter()
                    .position(|arg| arg == "--metadata-file")
                    .unwrap();
                let metadata = if failure == "metadata" {
                    "{}".to_owned()
                } else {
                    fs::read_to_string(root.join("metadata.json")).unwrap()
                };
                fs::write(&args[at + 1], metadata).unwrap();
                0
            }
            "load" if failure == "load" => 1,
            "load" => 0,
            "image" => {
                let reference = &args[4];
                let answer = if reference == "fixture:test" && failure == "digest" {
                    Some(
                        r#"{"Id":"image","RepoDigests":[],"Os":"linux","Architecture":"arm64"}"#
                            .to_owned(),
                    )
                } else if reference == "fixture:test" {
                    Some(fs::read_to_string(root.join("tag.json")).unwrap())
                } else if reference.starts_with("fixture@sha256:") {
                    Some(fs::read_to_string(root.join("digest.json")).unwrap())
                } else {
                    None
                };
                match answer {
                    Some(answer) => {
                        fs::write(root.join("answer"), answer).unwrap();
                        0
                    }
                    None => 2,
                }
            }
            _ => 2,
        };
        exit(status);
    }

    #[test]
    fn runtime_load_requires_the_exported_digest_and_platform() {
        for failure in [
            "",
            "build",
            "metadata",
            "load",
            "digest",
            "identity",
            "platform",
            "missing_version",
            "wrong_version",
        ] {
            let root = tempfile::tempdir().unwrap();
            let docker = fake_docker(root.path());
            fs::write(root.path().join("failure"), failure).unwrap();
            let digest = format!("sha256:{}", "a".repeat(64));
            let reference = format!("fixture@{digest}");
            fs::write(
                root.path().join("metadata.json"),
                serde_json::json!({"containerimage.digest":digest}).to_string(),
            )
            .unwrap();
            let loaded = serde_json::json!({"Id":"image", "RepoDigests":[reference], "Os":"linux", "Architecture":"arm64", "Config":{"Labels":{"org.nemoclaw.runtime.spec":"v1"}}});
            let mut pinned = loaded.clone();
            if failure == "identity" {
                pinned["Id"] = serde_json::json!("other");
            }
            if failure == "platform" {
                pinned["Architecture"] = serde_json::json!("amd64");
            }
            if failure == "missing_version" {
                pinned["Config"]["Labels"] = serde_json::json!({});
            }
            if failure == "wrong_version" {
                pinned["Config"]["Labels"]["org.nemoclaw.runtime.spec"] = serde_json::json!("v0");
            }
            fs::write(root.path().join("tag.json"), loaded.to_string()).unwrap();
            fs::write(root.path().join("digest.json"), pinned.to_string()).unwrap();
            let recipe = RuntimeArtifact::parse(
                &serde_json::to_vec(&serde_json::json!({
                    "name":"fixture", "image":"fixture:test", "platform":"linux_arm64",
                    "sourceDateEpoch":1234, "files":["Dockerfile"], "downloads":{}
                }))
                .unwrap(),
            )
            .unwrap();
            let result = export_and_load(
                &docker,
                &recipe,
                root.path(),
                &root.path().join("runtime.tar"),
            );
            if failure.is_empty() {
                assert_eq!(result.unwrap(), reference);
                let calls = fs::read_to_string(root.path().join("calls")).unwrap();
                assert!(calls.contains("type=oci,"));
                assert!(calls.contains("--label org.nemoclaw.runtime.spec=v1"));
                assert!(calls.contains(&format!(
                    "image inspect --format {{{{json .}}}} {reference}"
                )));
            } else {
                assert!(result.is_err(), "{failure}");
                if matches!(failure, "build" | "metadata") {
                    assert!(
                        !fs::read_to_string(root.path().join("calls"))
                            .unwrap()
                            .contains("load -i")
                    );
                }
            }
        }
    }
}
