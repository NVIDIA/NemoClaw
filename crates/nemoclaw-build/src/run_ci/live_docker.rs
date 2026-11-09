// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Prepare owned images and inputs for the Docker live tests, run them, and
//! remove only what this run created.

use super::*;
use nemoclaw_build::ci::live::{self, GatewayInputs};

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

/// Where the pinned OpenShell CLI is installed, by its archive's checksum.
/// Where the pinned OpenShell CLI is installed, by its archive's checksum.
fn openshell_path(pins: &Pins, platform: &str) -> Result<PathBuf> {
    let artifact = artifact(pins, platform, "openshell")?;
    Ok(std::path::absolute(
        Path::new(".tools")
            .join(format!("openshell-{}", &artifact.sha256[..12]))
            .join("openshell"),
    )?)
}

/// Install the pinned OpenShell CLI, verified by checksum, unless it is there.
/// The interface case forwards services and reads tokens with it.
pub(super) async fn install_openshell(pins: &Pins, platform: &str) -> Result<()> {
    let path = openshell_path(pins, platform)?;
    if !path.is_file() {
        let bytes = download(artifact(pins, platform, "openshell")?).await?;
        let directory = path.parent().ok_or("the OpenShell CLI has no directory")?;
        ci::install_openshell(&bytes, directory)?;
    }
    Ok(())
}

fn ollama_base() -> Result<String> {
    let dockerfile = fs::read_to_string("image/ollama/Dockerfile")?;
    dockerfile
        .lines()
        .find_map(|line| line.strip_prefix("FROM "))
        .map(|image| image.trim().to_owned())
        .ok_or_else(|| "image/ollama/Dockerfile has no base image".into())
}

/// The images this run builds and the deployment UUIDs its documents own.
struct Owned {
    images: Vec<String>,
    uids: Vec<String>,
}

impl Owned {
    /// Remove what this run's deployments retain, then the images it built.
    fn remove(&mut self) -> Result<()> {
        let removed = remove_retained(docker, &std::mem::take(&mut self.uids));
        for image in self.images.drain(..) {
            let _ = docker()
                .args(["image", "rm", "--force", &image])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        removed
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        // Covers a run that stopped before calling `remove`.
        if let Err(error) = self.remove() {
            eprintln!("{error}");
        }
    }
}

/// OpenShell's Docker driver labels each sandbox's containers and volumes
/// with its `sandbox_label`, which NemoClaw sets to the gateway's name.
const SANDBOX_NAMESPACE_LABEL: &str = "openshell.ai/sandbox-namespace";

/// Selects the OpenShell sandbox objects of a deployment's managed gateway,
/// named after its workspace.
fn sandbox_filter(uid: &str) -> String {
    let digest = nemoclaw_build::hex(&Sha256::digest(uid.as_bytes()));
    let workspace = format!("nc-{}", &digest[..16]);
    format!("label={SANDBOX_NAMESPACE_LABEL}={workspace}-gateway")
}

/// Object kinds in removal order: Docker refuses to remove a volume or
/// network that a container still uses.
const RETAINED: [(&str, &[&str], &[&str]); 3] = [
    (
        "container",
        &["container", "ls", "--all", "--quiet", "--filter"],
        &["container", "rm", "--force"],
    ),
    (
        "volume",
        &["volume", "ls", "--quiet", "--filter"],
        &["volume", "rm"],
    ),
    (
        "network",
        &["network", "ls", "--quiet", "--filter"],
        &["network", "rm"],
    ),
];

/// Remove each UID's labelled objects and its gateway's sandbox objects, then
/// fail naming any sandbox object OpenShell left and anything that remains.
fn remove_retained(docker: impl Fn() -> Command, uids: &[String]) -> Result<()> {
    let list = |args: &[&str], filter: &str| -> Option<Vec<String>> {
        let output = docker()
            .args(args)
            .arg(filter)
            .stderr(Stdio::inherit())
            .output()
            .ok()?;
        output.status.success().then(|| {
            String::from_utf8_lossy(&output.stdout)
                .lines()
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
                .collect()
        })
    };
    let mut problems = Vec::new();
    for uid in uids {
        let sandbox = sandbox_filter(uid);
        let owner = format!("label={UID_LABEL}={uid}");
        for (kind, ls, _) in RETAINED {
            problems.extend(
                list(ls, &sandbox)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|id| format!("{kind} {id} left in the sandbox namespace")),
            );
        }
        for (_, ls, rm) in RETAINED {
            for filter in [&sandbox, &owner] {
                for id in list(ls, filter).unwrap_or_default() {
                    let _ = docker().args(rm).arg(&id).stdout(Stdio::null()).status();
                }
            }
        }
        for (kind, ls, _) in RETAINED {
            for filter in [&sandbox, &owner] {
                match list(ls, filter) {
                    Some(ids) => problems.extend(
                        ids.into_iter()
                            .map(|id| format!("{kind} {id} remains after removal")),
                    ),
                    None => problems.push(format!("cannot list {kind}s with {filter}")),
                }
            }
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(format!("live Docker cleanup failed: {}", problems.join(", ")).into())
    }
}

/// Pull pinned images, build or load the agent and proxy images, write owned
/// gateway documents, and return the environment the live-docker profile reads.
fn prepare(
    pins: &Pins,
    platform: &str,
    bundle: &Path,
    inputs: &Path,
    images: live_images::Source<'_>,
    cases: &[String],
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
    // Every test needs python3, sha256sum and node, which both agent images have.
    let (target, harness) = live_images::agent();
    let names = live_images::names();
    match images {
        live_images::Source::Archive(archive) => {
            live_images::load(archive, &prefix, &names, &mut owned.images)?
        }
        live_images::Source::Commit(commit) => {
            live_images::pull(commit, platform, &prefix, &mut owned.images)?
        }
        live_images::Source::Build => {
            owned
                .images
                .extend(names.map(|name| format!("{prefix}:{name}")));
            live_images::build_agent(platform, &prefix)?;
            live_images::build_hermes(platform, &prefix)?;
            live_images::build_dummy(platform, &prefix)?;
        }
    }
    let agent = by_digest(&prefix, target)?;
    let hermes = by_digest(&prefix, live_images::HERMES)?;
    // The lifecycle runs an image derived from the reference image, so it
    // also checks that derived images deploy.
    live_images::build_derived(&prefix)?;
    owned
        .images
        .push(format!("{prefix}:{}", live_images::DERIVED));
    let dummy = by_digest(&prefix, live_images::DERIVED)?;

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
    let mut document_for = |name: &str,
                            image: &str,
                            harness: &str,
                            settings: Option<&serde_json::Map<String, serde_json::Value>>|
     -> Result<PathBuf> {
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
                image,
                harness,
                settings,
            }),
        )?;
        owned.uids.push(uid);
        Ok(path)
    };
    let mut document = |name: &str| document_for(name, &agent, harness, None);
    // Each gateway test refuses resources from an earlier run, so each gets
    // fresh documents: an isolation pair and profile revisions.
    let first = document("live-isolation-a")?;
    let second = document("live-isolation-b")?;
    let profiles = document("live-profiles")?;
    // The interface case's agents reach a stub model at the gateway network's
    // host address; the stub answers only requests with this run's key.
    let mut key = [0u8; 16];
    getrandom::fill(&mut key).map_err(|_| "cannot make the stub model's key")?;
    let model_key = format!("nc-model-key-{}", nemoclaw_build::hex(&key));
    let path = |path: &Path| path.display().to_string();
    // Each HCL E2E case is bound to this run like the documents above.
    let mut bound = Vec::new();
    for case in cases {
        let uid = live::uuid()?;
        let subnet = live::free_subnet(&used, &subnets)?;
        subnets.push(subnet.clone());
        let template = fs::read_to_string(
            Path::new(nemoclaw_build::hcl_cases::DOCUMENTS).join(format!("{case}.yaml")),
        )?;
        let endpoint = format!("http://127.0.0.1:{}", live::free_port()?);
        let document = match case.as_str() {
            // The dummy reports native health, so its whole HCL E2E lifecycle
            // completes.
            DUMMY_CASE => dummy_case(&template, &uid, &endpoint, &subnet, &dummy)?,
            INTERFACES_CASE => {
                let host = subnet
                    .strip_suffix(".0/24")
                    .map(|prefix| format!("{prefix}.1"))
                    .ok_or("a gateway subnet is a /24")?;
                let model = (host.as_str(), live::free_port()?);
                interfaces_case(&template, &uid, &endpoint, &subnet, model, &agent, &hermes)?
            }
            other => {
                return Err(format!(
                    "live-docker cannot bind the {other} case to its run; add its binding to run_ci/live_docker.rs"
                )
                .into());
            }
        };
        let file = inputs.join(format!("{case}.yaml"));
        fs::write(&file, document)?;
        owned.uids.push(uid);
        bound.push(format!("{case}\t{}", path(&file)));
    }
    Ok(vec![
        ("NEMOCLAW_TEST_BUNDLE".into(), path(bundle)),
        ("NEMOCLAW_TEST_RUNTIME_IMAGE".into(), "1".into()),
        ("NEMOCLAW_TEST_GATEWAY_SANDBOX_IMAGE".into(), agent),
        (
            "NEMOCLAW_TEST_SECOND_GATEWAY_DOCUMENT".into(),
            path(&second),
        ),
        (
            "NEMOCLAW_TEST_OPENSHELL".into(),
            path(&openshell_path(pins, platform)?),
        ),
        (
            "NEMOCLAW_TEST_INTERFACES_MODEL_KEY".into(),
            model_key.clone(),
        ),
        // The interface case's stub model reads the key as a root variable.
        ("TF_VAR_model_key".into(), model_key),
    ]
    .into_iter()
    .chain([
        (
            GATEWAY_DOCUMENTS.into(),
            [path(&first), path(&profiles)].join("\n"),
        ),
        (HCL_CASES.into(), bound.join("\n")),
    ])
    .collect())
}

/// The reference image's case, which this suite binds to the derived image.
const DUMMY_CASE: &str = "docker-dummy";

/// The dummy case bound to one run's UID, gateway endpoint, subnet, and image,
/// and a workspace volume named for the UID, so runs never share one.
fn dummy_case(
    template: &str,
    uid: &str,
    endpoint: &str,
    subnet: &str,
    image: &str,
) -> Result<String> {
    let zero = format!("nc-live-dummy@sha256:{}", "0".repeat(64));
    Ok(live::bind_case(
        template,
        &[
            ("0b3f1c52-7d0e-4c6a-9a51-2f6c8e4d7a10", uid),
            ("http://127.0.0.1:17697", endpoint),
            ("172.30.122.0/24", subnet),
            (&zero, image),
            (
                "source: hcl-dummy-workspace",
                &format!("source: hcl-dummy-workspace-{uid}"),
            ),
        ],
    )?)
}

/// The case whose agents reach this suite's stub model.
const INTERFACES_CASE: &str = "docker-openclaw-hermes-interfaces";

/// The interface case bound to one run's UID, gateway endpoint, subnet, stub
/// model address and port, which its model provider and a grant name,
/// OpenClaw and Hermes images, and skills volumes named for the UID, so runs
/// never share one.
fn interfaces_case(
    template: &str,
    uid: &str,
    endpoint: &str,
    subnet: &str,
    (model_host, model_port): (&str, u16),
    openclaw: &str,
    hermes: &str,
) -> Result<String> {
    let zero = "0".repeat(64);
    let model_port = model_port.to_string();
    Ok(live::bind_case(
        template,
        &[
            // The stub's address and port come first: bind_case replaces
            // every occurrence, and a later value, such as the UID, could
            // contain the template's port.
            ("172.30.123.1", model_host),
            ("17699", &model_port),
            ("9d4c1f2e-6b3a-4c8d-a5e7-2f1b0c9d8e76", uid),
            ("http://127.0.0.1:17698", endpoint),
            ("172.30.123.0/24", subnet),
            (&format!("nc-fabric@sha256:{zero}"), openclaw),
            (&format!("nc-fabric-hermes@sha256:{zero}"), hermes),
            (
                "source: hcl-interfaces-",
                &format!("source: hcl-interfaces-{uid}-"),
            ),
        ],
    )?)
}

/// Internal: each HCL E2E case and its bound document, separated by a tab;
/// `hcl_live::case` runs one case per nextest command.
const HCL_CASES: &str = "NEMOCLAW_LIVE_DOCKER_HCL_CASES";

/// Internal: the two gateway documents, in [`GATEWAY_TESTS`] order.
const GATEWAY_DOCUMENTS: &str = "NEMOCLAW_LIVE_DOCKER_GATEWAY_DOCUMENTS";

/// Gateway tests all read NEMOCLAW_TEST_GATEWAY_DOCUMENT and each refuses
/// another test's resources, so each runs alone with its own document.
const GATEWAY_TESTS: [&str; 2] = [
    "pinned_docker_gateways_reach_ready_without_interfering_with_other_sandboxes",
    "imported_profile_revisions_survive_repeated_reads_and_gateway_restart",
];

pub(super) fn run_live_docker(
    pins: &Pins,
    platform: &str,
    configure: &dyn Fn(&mut Command),
    archive: Option<&Path>,
    images: live_images::Source<'_>,
    hcl_cases: Option<&[String]>,
) -> Result<()> {
    let bundle = std::path::absolute(Path::new("dist").join(platform))?;
    if !bundle.join("manifest.json").is_file() {
        return Err("build the bundle first: cargo ci bundle".into());
    }
    let cases = nemoclaw_build::hcl_cases::on(
        Path::new("."),
        nemoclaw_build::hcl_cases::Runner::LiveDocker,
        hcl_cases,
    )?;
    let inputs = tempfile::Builder::new()
        .prefix("nemoclaw-live-docker-")
        .tempdir()?;
    let mut owned = Owned {
        images: Vec::new(),
        uids: Vec::new(),
    };
    let environment = prepare(
        pins,
        platform,
        &bundle,
        inputs.path(),
        images,
        &cases,
        &mut owned,
    )?;
    let documents: Vec<String> = environment
        .iter()
        .find(|(key, _)| key == GATEWAY_DOCUMENTS)
        .map(|(_, value)| value.lines().map(str::to_owned).collect())
        .unwrap_or_default();
    let cases: Vec<(String, String)> = environment
        .iter()
        .find(|(key, _)| key == HCL_CASES)
        .map(|(_, value)| {
            value
                .lines()
                .filter_map(|line| line.split_once('\t'))
                .map(|(case, document)| (case.to_owned(), document.to_owned()))
                .collect()
        })
        .unwrap_or_default();
    let shared: Vec<_> = environment
        .iter()
        .filter(|(key, _)| key != GATEWAY_DOCUMENTS && key != HCL_CASES)
        .collect();
    let [args] = Step::LiveDocker.cargo_args() else {
        unreachable!("live-docker is one nextest command")
    };
    // Each nextest command rewrites the profile's JUnit report; keep each one,
    // so the step reports and uploads all of its tests.
    let Some((profile, file)) = Step::LiveDocker.junit() else {
        unreachable!("live-docker writes a JUnit report")
    };
    let junit = Path::new("target").join("nextest").join(profile).join(file);
    let mut reports = Vec::new();
    let mut nextest = |filter: &str, extra: &[(&str, String)]| -> Result<()> {
        let mut command = match archive {
            Some(archive) => archived(Step::LiveDocker, archive, configure)?,
            None => {
                let mut command = cargo();
                configure(&mut command);
                command.args(*args);
                command
            }
        };
        command
            .args(["-E", filter])
            .envs(shared.iter().map(|(key, value)| (key, value)));
        command.envs(extra.iter().map(|(key, value)| (key, value)));
        // A command that writes no report must not repeat the previous one.
        let _ = fs::remove_file(&junit);
        let result = run(&mut command);
        if let Ok(xml) = fs::read_to_string(&junit) {
            reports.push(xml);
        }
        result
    };
    let gateway = GATEWAY_TESTS
        .iter()
        .map(|name| format!("test({name})"))
        .collect::<Vec<_>>()
        .join(" | ");
    let result: Result<()> = (|| {
        // `-E` narrows the profile's default filter rather than replacing it.
        nextest(&format!("not ({gateway} | test(=hcl_live::case))"), &[])?;
        for (name, document) in GATEWAY_TESTS.iter().zip(&documents) {
            nextest(
                &format!("test({name})"),
                &[("NEMOCLAW_TEST_GATEWAY_DOCUMENT", document.clone())],
            )?;
        }
        // `hcl_live::case` runs the case its environment names, one per command.
        for (case, document) in &cases {
            let run = Path::new(document).with_file_name(format!("hcl-{case}"));
            nextest(
                "test(=hcl_live::case)",
                &[
                    ("NEMOCLAW_HCL_CASE", case.clone()),
                    ("NEMOCLAW_HCL_DOCUMENT", document.clone()),
                    ("NEMOCLAW_HCL_RUN", run.display().to_string()),
                ],
            )?;
        }
        Ok(())
    })();
    if !reports.is_empty() {
        let joined = ci::timing::join_consecutive(&reports)
            .and_then(|xml| fs::write(&junit, xml).map_err(|error| error.to_string()));
        if let Err(error) = joined {
            eprintln!("cannot join the live-docker JUnit reports: {error}");
        }
    }
    result?;
    owned.remove()
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn the_dummy_case_binds_its_identity_gateway_and_image() {
        let template = include_str!("../../../nemoclaw-e2e/cases/docker-dummy.yaml");
        let bound = super::dummy_case(
            template,
            "u-1",
            "http://127.0.0.1:1",
            "172.30.9.0/24",
            "i@1",
        )
        .unwrap();
        for line in [
            "  uid: u-1",
            "    networkCIDR: 172.30.9.0/24",
            "        ref: i@1",
            "              source: hcl-dummy-workspace-u-1",
        ] {
            assert!(bound.lines().any(|bound| bound == line), "{line}");
        }
        assert!(nemoclaw_build::ci::live::bind_case("uid: x", &[("y", "z")]).is_err());
    }

    #[test]
    fn the_interfaces_case_binds_its_gateway_model_and_images() {
        let template =
            include_str!("../../../nemoclaw-e2e/cases/docker-openclaw-hermes-interfaces.yaml");
        let bound = super::interfaces_case(
            template,
            "u-1",
            "http://127.0.0.1:1",
            "172.30.9.0/24",
            ("172.30.9.1", 2),
            "o@1",
            "h@1",
        )
        .unwrap();
        for line in [
            "  uid: u-1",
            "    networkCIDR: 172.30.9.0/24",
            "      endpoint: http://172.30.9.1:2/v1",
            "        ref: o@1",
            "        ref: h@1",
            // The claw sandbox's grant names the stub's address too.
            "              - host: 172.30.9.1",
            "                port: 2",
            "                  - 172.30.9.1/32",
        ] {
            assert!(bound.lines().any(|bound| bound == line), "{line}");
        }
    }

    use super::*;

    /// A Docker CLI over `kind id key=value [running]` lines. Like Docker, it
    /// needs `--all` for stopped containers and `--force` for running ones.
    /// Unlike Docker, it refuses volume and network removal while any container
    /// remains. It cannot remove `stuck` IDs or list `unlistable` kinds.
    fn fake_docker(
        directory: &Path,
        resources: &str,
        stuck: &str,
        unlistable: &str,
    ) -> impl Fn() -> Command {
        fs::write(directory.join("resources"), resources).unwrap();
        fs::write(directory.join("stuck"), stuck).unwrap();
        fs::write(directory.join("unlistable"), unlistable).unwrap();
        let script = directory.join("docker");
        fs::write(
            &script,
            r#"cd "$(dirname "$0")" || exit 1
for last; do :; done
case " $* " in *" --all "*) all=1 ;; *) all= ;; esac
case " $* " in *" --force "*) force=1 ;; *) force= ;; esac
case "$1 $2" in
"container ls" | "volume ls" | "network ls")
    grep -qx "$1" unlistable && exit 1
    awk -v kind="$1" -v label="${last#label=}" -v all="$all" \
        '$1 == kind && $3 == label && (all || kind != "container" || $4 == "running") { print $2 }' \
        resources ;;
"container rm" | "volume rm" | "network rm")
    grep -qx "$last" stuck && exit 1
    [ "$1" = container ] || ! grep -q '^container ' resources || exit 1
    [ -n "$force" ] || ! grep -qx "container $last .* running" resources || exit 1
    grep -v "^$1 $last " resources > remaining
    mv remaining resources ;;
*) exit 2 ;;
esac
"#,
        )
        .unwrap();
        // Executing a file just written races the forks of parallel tests.
        move || {
            let mut command = Command::new("sh");
            command.arg(&script).stdin(Stdio::null());
            command
        }
    }

    #[cfg(feature = "sdk")]
    #[test]
    fn the_sandbox_filter_uses_the_sdk_workspace() {
        let uid = live::uuid().unwrap();
        let document = live::gateway_document(&GatewayInputs {
            name: "live-gateway",
            uid: &uid,
            port: 17950,
            subnet: "172.30.202.0/24",
            image: &format!("nc-live@sha256:{}", "a".repeat(64)),
            harness: "nvidia.fabric.pi",
            settings: None,
        });
        let workspace = nemoclaw_sdk::config::Document::parse(document.as_bytes())
            .unwrap()
            .workspace();
        assert_eq!(
            sandbox_filter(&uid),
            format!("label={SANDBOX_NAMESPACE_LABEL}={workspace}-gateway")
        );
    }

    #[test]
    fn each_uid_loses_its_labelled_objects() {
        let directory = tempfile::tempdir().unwrap();
        let resources = format!(
            "network n1 {UID_LABEL}=a\nvolume v1 {UID_LABEL}=a\ncontainer c1 {UID_LABEL}=a\n\
             volume v2 {UID_LABEL}=b\nvolume kept {UID_LABEL}=other\n"
        );
        let docker = fake_docker(directory.path(), &resources, "", "");
        remove_retained(&docker, &["a".into(), "b".into()]).unwrap();
        assert_eq!(
            fs::read_to_string(directory.path().join("resources")).unwrap(),
            format!("volume kept {UID_LABEL}=other\n")
        );
    }

    #[test]
    fn sandbox_leftovers_fail_the_run_and_are_removed() {
        let directory = tempfile::tempdir().unwrap();
        let sandbox = sandbox_filter("a").replacen("label=", "", 1);
        let resources = format!(
            "volume v1 {UID_LABEL}=a\nvolume s1 {sandbox}\ncontainer s2 {sandbox} running\n\
             volume kept {UID_LABEL}=other\n"
        );
        let docker = fake_docker(directory.path(), &resources, "", "");
        let error = remove_retained(&docker, &["a".into()])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("container s2 left in the sandbox namespace"),
            "{error}"
        );
        assert!(
            error.contains("volume s1 left in the sandbox namespace"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(directory.path().join("resources")).unwrap(),
            format!("volume kept {UID_LABEL}=other\n")
        );
    }

    #[test]
    fn an_object_that_survives_removal_fails_naming_it() {
        let directory = tempfile::tempdir().unwrap();
        let resources = format!("container c1 {UID_LABEL}=a\nnetwork n1 {UID_LABEL}=a\n");
        let docker = fake_docker(directory.path(), &resources, "n1\n", "");
        let error = remove_retained(&docker, &["a".into()])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("network n1 remains after removal"),
            "{error}"
        );
        assert!(!error.contains("c1"), "{error}");
    }

    #[test]
    fn a_kind_that_cannot_be_listed_fails_instead_of_passing() {
        let directory = tempfile::tempdir().unwrap();
        let docker = fake_docker(directory.path(), "", "", "volume\n");
        let error = remove_retained(&docker, &["a".into()])
            .unwrap_err()
            .to_string();
        assert!(
            error.contains(&format!("cannot list volumes with label={UID_LABEL}=a")),
            "{error}"
        );
    }
}
