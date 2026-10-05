// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Prepare owned images and inputs for the Docker live tests, run them, and
//! remove only what this run created.

use super::*;
use nemoclaw_build::ci::live::{self, GatewayInputs};

const ENGINE: &str = "unix:///var/run/docker.sock";
const UID_LABEL: &str = "nemoclaw.nvidia.com/uid";

fn docker() -> Command {
    let mut command = Command::new("docker");
    command.stdin(Stdio::null());
    command
}

fn docker_output(args: &[&str]) -> Result<String> {
    let output = docker().args(args).stderr(Stdio::inherit()).output()?;
    if !output.status.success() {
        return Err(format!("docker {} failed", args.join(" ")).into());
    }
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

/// `repository@sha256:...` for a local image, as the tests require.
fn by_digest(repository: &str, tag: &str) -> Result<String> {
    let id = docker_output(&[
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        &format!("{repository}:{tag}"),
    ])?;
    Ok(format!("{repository}@{id}"))
}

fn ollama_base() -> Result<String> {
    let dockerfile = fs::read_to_string("runtimes/ollama/Dockerfile")?;
    dockerfile
        .lines()
        .find_map(|line| line.strip_prefix("FROM "))
        .map(|image| image.trim().to_owned())
        .ok_or_else(|| "runtimes/ollama/Dockerfile has no base image".into())
}

/// Everything this run creates, removed on drop whatever the outcome.
struct Owned {
    images: Vec<String>,
    uids: Vec<String>,
}

impl Drop for Owned {
    fn drop(&mut self) {
        for image in &self.images {
            let _ = docker()
                .args(["image", "rm", "--force", image])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        // Gateway tests retain storage by design. Remove only resources that
        // carry one of this run's fresh deployment UUIDs.
        for uid in &self.uids {
            let filter = format!("label={UID_LABEL}={uid}");
            for (list, remove) in [
                (
                    ["ps", "--all", "--quiet", "--filter"],
                    &["rm", "--force"][..],
                ),
                (
                    ["volume", "ls", "--quiet", "--filter"],
                    &["volume", "rm"][..],
                ),
                (
                    ["network", "ls", "--quiet", "--filter"],
                    &["network", "rm"][..],
                ),
            ] {
                let Ok(found) = docker_output(&[&list[..], &[filter.as_str()]].concat()) else {
                    continue;
                };
                for id in found.lines().filter(|id| !id.is_empty()) {
                    let _ = docker()
                        .args(remove)
                        .arg(id)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status();
                }
            }
        }
    }
}

/// Pull pinned images, build the agent and proxy images, write owned gateway
/// documents, and return the environment the live-docker profile reads.
fn prepare(
    pins: &Pins,
    platform: &str,
    bundle: &Path,
    inputs: &Path,
    owned: &mut Owned,
) -> Result<Vec<(String, String)>> {
    if !platform.starts_with("linux_") {
        return Err("the Docker live tests run on Linux only".into());
    }
    docker_output(&["version", "--format", "{{.Server.Version}}"])
        .map_err(|_| "the Docker live tests need a running local Docker engine")?;
    let mut pulls: Vec<String> = ["gateway", "supervisor", "sandboxRuntime"]
        .iter()
        .map(|name| {
            pins.images
                .get(*name)
                .cloned()
                .ok_or_else(|| format!("versions.json has no {name} image"))
        })
        .collect::<std::result::Result<_, _>>()?;
    pulls.push(ollama_base()?);
    for image in &pulls {
        docker_output(&["pull", "--quiet", image])?;
    }

    let mut nonce = [0u8; 6];
    getrandom::fill(&mut nonce).map_err(|_| "cannot name the live-test images")?;
    let prefix = format!("nc-live-{}", nemoclaw_build::hex(&nonce));
    let docker_platform = format!("linux/{}", platform.trim_start_matches("linux_"));
    // Every test needs python3, sha256sum and node. Pi has them and is the
    // smaller image, but is built only for ARM64; OpenClaw is built for both.
    let (target, harness) = if platform == "linux_arm64" {
        ("pi", "nvidia.fabric.pi")
    } else {
        ("openclaw", "nvidia.fabric.openclaw")
    };
    owned.images.push(format!("{prefix}:{target}"));
    let status = Command::new(std::env::current_exe()?)
        .args(["images", "build", "--platform", &docker_platform, target])
        .env("IMAGE_PREFIX", &prefix)
        .stdin(Stdio::null())
        .status()?;
    if !status.success() {
        return Err(format!("cannot build the {target} agent image").into());
    }
    let agent = by_digest(&prefix, target)?;
    // Two proxy images with distinct digests, for the image-change check.
    for variant in ["a", "b"] {
        let tag = format!("{prefix}:proxy-{variant}");
        owned.images.push(tag.clone());
        run(docker()
            .args(["buildx", "build", "--load", "--quiet"])
            .args(["-f", "image/ollama-proxy/Dockerfile", "--target", "runtime"])
            .args(["--label", &format!("org.nemoclaw.test=proxy-{variant}")])
            .args(["--tag", &tag, "."]))?;
    }

    let used: Vec<String> = docker_output(&["network", "ls", "--quiet"])?
        .lines()
        .filter_map(|id| {
            docker_output(&[
                "network",
                "inspect",
                "--format",
                "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
                id,
            ])
            .ok()
        })
        .flat_map(|subnets| {
            subnets
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .collect();
    let mut subnets = Vec::new();
    let mut document = |name: &str| -> Result<PathBuf> {
        let uid = live::uuid()?;
        let subnet = live::free_subnet(&used, &subnets)?;
        subnets.push(subnet.clone());
        let path = inputs.join(format!("{name}.yaml"));
        fs::write(
            &path,
            live::gateway_document(&GatewayInputs {
                name,
                uid: &uid,
                port: live::free_port()?,
                subnet: &subnet,
                image: &agent,
                harness,
            }),
        )?;
        owned.uids.push(uid);
        Ok(path)
    };
    // Each gateway test refuses resources from an earlier run, so each gets
    // fresh documents: recovery, an isolation pair, and profile revisions.
    let recovery = document("live-recovery")?;
    let first = document("live-isolation-a")?;
    let second = document("live-isolation-b")?;
    let profiles = document("live-profiles")?;
    let path = |path: &Path| path.display().to_string();
    Ok(vec![
        ("NEMOCLAW_TEST_BUNDLE".into(), path(bundle)),
        ("NEMOCLAW_TEST_OLLAMA_CACHE".into(), "1".into()),
        ("NEMOCLAW_TEST_RUNTIME_IMAGE".into(), "1".into()),
        ("NEMOCLAW_TEST_CACHE_ENGINE".into(), ENGINE.into()),
        ("NEMOCLAW_TEST_CACHE_IMAGE".into(), agent.clone()),
        (
            "NEMOCLAW_TEST_OLLAMA_PROXY_IMAGE".into(),
            by_digest(&prefix, "proxy-a")?,
        ),
        (
            "NEMOCLAW_TEST_OLLAMA_PROXY_REPLACEMENT_IMAGE".into(),
            by_digest(&prefix, "proxy-b")?,
        ),
        (
            "NEMOCLAW_TEST_GATEWAY_STATE".into(),
            path(&inputs.join("recovery-state")),
        ),
        ("NEMOCLAW_TEST_GATEWAY_SANDBOX_IMAGE".into(), agent),
        (
            "NEMOCLAW_TEST_SECOND_GATEWAY_DOCUMENT".into(),
            path(&second),
        ),
    ]
    .into_iter()
    .chain([(
        GATEWAY_DOCUMENTS.into(),
        [path(&recovery), path(&first), path(&profiles)].join("\n"),
    )])
    .collect())
}

/// Internal: the three gateway documents, in [`GATEWAY_TESTS`] order.
const GATEWAY_DOCUMENTS: &str = "NEMOCLAW_LIVE_DOCKER_GATEWAY_DOCUMENTS";

/// Gateway tests all read NEMOCLAW_TEST_GATEWAY_DOCUMENT and each refuses
/// another test's resources, so each runs alone with its own document.
const GATEWAY_TESTS: [&str; 3] = [
    "managed_gateway_plan_apply_noop_destroy_and_recovery_use_real_opentofu",
    "pinned_docker_gateways_reach_ready_without_interfering_with_other_sandboxes",
    "imported_profile_revisions_survive_repeated_reads_and_gateway_restart",
];

pub(super) fn run_live_docker(
    pins: &Pins,
    platform: &str,
    configure: &dyn Fn(&mut Command),
) -> Result<()> {
    let bundle = std::path::absolute(Path::new("dist").join(platform))?;
    if !bundle.join("manifest.json").is_file() {
        return Err("build the bundle first: cargo ci bundle".into());
    }
    let inputs = tempfile::Builder::new()
        .prefix("nemoclaw-live-docker-")
        .tempdir()?;
    let mut owned = Owned {
        images: Vec::new(),
        uids: Vec::new(),
    };
    let environment = prepare(pins, platform, &bundle, inputs.path(), &mut owned)?;
    let documents: Vec<String> = environment
        .iter()
        .find(|(key, _)| key == GATEWAY_DOCUMENTS)
        .map(|(_, value)| value.lines().map(str::to_owned).collect())
        .unwrap_or_default();
    let shared: Vec<_> = environment
        .iter()
        .filter(|(key, _)| key != GATEWAY_DOCUMENTS)
        .collect();
    let [args] = Step::LiveDocker.cargo_args() else {
        unreachable!("live-docker is one nextest command")
    };
    let nextest = |filter: &str, document: Option<&str>| -> Result<()> {
        let mut command = cargo();
        configure(&mut command);
        command
            .args(*args)
            .args(["-E", filter])
            .envs(shared.iter().map(|(key, value)| (key, value)));
        if let Some(document) = document {
            command.env("NEMOCLAW_TEST_GATEWAY_DOCUMENT", document);
        }
        run(&mut command)
    };
    let gateway = GATEWAY_TESTS
        .iter()
        .map(|name| format!("test({name})"))
        .collect::<Vec<_>>()
        .join(" | ");
    // `-E` narrows the profile's default filter rather than replacing it.
    nextest(&format!("not ({gateway})"), None)?;
    for (name, document) in GATEWAY_TESTS.iter().zip(&documents) {
        nextest(&format!("test({name})"), Some(document))?;
    }
    Ok(())
}
