// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The rows of `examples/scenarios.md`, run on the machine at hand. `page`
//! reads the page's table, decides for each row whether this machine has what
//! its Needs column lists, and runs each row that it has: it binds the row's
//! example to this machine, then runs `tests/e2e/hcl/scenarios/lifecycle`
//! through `hcl_live::case`, and destroys the deployment and removes every
//! Docker object labelled with its UID afterward, whatever the outcome. It
//! prints each row's outcome, including why it skipped a row, and fails when a
//! row it ran failed. A row the page cannot express fails the parse, so no row
//! is ever dropped without a message.

use nemoclaw_build::scenarios::{
    CHECKS, Need, PAGE, Row, UNCHANGED_PLAN, harness_id, outcomes, parse,
};
use nemoclaw_sdk::config::Document;
use nemoclaw_test_fixtures::Bundle;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env::var,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The credential variable a stub row's providers read when the example names
/// none.
const STUB_KEY_ENV: &str = "NEMOCLAW_SCENARIO_MODEL_KEY";

/// What the machine lacks of `need`, or none when it has it.
fn lacking(need: &Need, host: &Host) -> Option<String> {
    let (has, wanted) = match need {
        Need::Linux => (host.os == "linux" && !host.wsl, "a Linux host".to_owned()),
        Need::Wsl2 => (host.wsl, "WSL2".to_owned()),
        Need::Arm64 => (host.arch == "aarch64", "an ARM64 host".to_owned()),
        Need::Amd64 => (host.arch == "x86_64", "an AMD64 host".to_owned()),
        Need::Docker => (host.engine.is_some(), "a Docker engine".to_owned()),
        Need::Gpu(name) => (
            host.gpus.iter().any(|gpu| gpu.contains(name.as_str())),
            format!("an NVIDIA GPU named like `{name}`"),
        ),
        Need::Kubernetes => (
            host.env.contains("NEMOCLAW_CLUSTER_KUBECONFIG"),
            "a cluster in NEMOCLAW_CLUSTER_KUBECONFIG".to_owned(),
        ),
        Need::Env(name) => (host.env.contains(name), format!("`${name}` set")),
    };
    (!has).then_some(wanted)
}

/// What this machine has, as the Needs column names it.
struct Host {
    os: &'static str,
    arch: &'static str,
    wsl: bool,
    /// The Docker engine's socket as a `unix://` URL.
    engine: Option<String>,
    gpus: Vec<String>,
    /// The environment variables that have a value.
    env: BTreeSet<String>,
}

impl Host {
    fn detect() -> Host {
        let wsl = fs::read_to_string("/proc/sys/kernel/osrelease")
            .is_ok_and(|release| release.to_lowercase().contains("microsoft"));
        let engine = match var("DOCKER_HOST") {
            Ok(host) if host.starts_with("unix://") => Some(host),
            _ => [
                Some(PathBuf::from("/var/run/docker.sock")),
                var("HOME")
                    .ok()
                    .map(|home| Path::new(&home).join(".docker/run/docker.sock")),
            ]
            .into_iter()
            .flatten()
            .find(|socket| socket.exists())
            .map(|socket| format!("unix://{}", socket.display())),
        };
        let gpus = Command::new("nvidia-smi")
            .args(["--query-gpu=name", "--format=csv,noheader"])
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Host {
            os: std::env::consts::OS,
            arch: std::env::consts::ARCH,
            wsl,
            engine,
            gpus,
            env: std::env::vars()
                .filter(|(_, value)| !value.is_empty())
                .map(|(name, _)| name)
                .collect(),
        }
    }

    /// Why this machine cannot run `row`, or none when it can.
    fn skip_reason(&self, row: &Row) -> Option<String> {
        if !row.on {
            return Some("paused on the page".to_owned());
        }
        let lacking: Vec<_> = row.needs.iter().filter_map(|n| lacking(n, self)).collect();
        (!lacking.is_empty()).then(|| format!("needs {}", lacking.join(", ")))
    }
}

/// What binding an example to this machine needs from it.
struct Inputs<'a> {
    uid: String,
    engine: String,
    subnet: String,
    /// A free port for the gateway, each service, and the stub, in turn.
    ports: &'a mut dyn FnMut() -> Result<u16, String>,
    /// The local image `REPOSITORY:TAG` as a digest reference.
    image: &'a dyn Fn(&str, &str) -> Result<String, String>,
    /// A model already serving on this machine, which a row that is not a
    /// stub row uses in place of the services its example declares.
    running: Option<Running>,
}

/// An OpenAI-compatible model already serving on this machine, which
/// `NEMOCLAW_SCENARIO_MODEL_ENDPOINT` and `NEMOCLAW_SCENARIO_MODEL_NAME` name;
/// its key is in [`RUNNING_KEY_ENV`].
struct Running {
    endpoint: String,
    model: String,
}

/// The variable that holds a running model's key.
const RUNNING_KEY_ENV: &str = "NEMOCLAW_SCENARIO_MODEL_KEY";

/// The row's example bound to this machine, the stub's port, and the
/// credential variables a stub row's providers read.
struct Bound {
    document: Value,
    /// Whether the lifecycle plans the applied deployment again, which it does
    /// unless the deployment serves a model: as the live hardware cases do,
    /// it leaves unchanged reconciliation to the integration tests rather
    /// than hold a GPU for it.
    replans: bool,
    stub_port: u16,
    stub_credentials: BTreeSet<String>,
}

fn bind(row: &Row, mut document: Value, inputs: Inputs<'_>) -> Result<Bound, String> {
    let spec = &mut document["spec"];
    let gateway = &mut spec["gateway"];
    if gateway["management"] != "managed" || !gateway["target"]["docker"].is_object() {
        return Err(format!(
            "the runner deploys only managed Docker gateways; this example's gateway is {} on {}",
            gateway["management"], gateway["target"]
        ));
    }
    let docker = &mut gateway["target"]["docker"];
    docker["port"] = json!((inputs.ports)()?);
    docker["engine"] = json!(inputs.engine);
    docker["networkCIDR"] = json!(inputs.subnet);
    let host = inputs
        .subnet
        .strip_suffix(".0/24")
        .map(|prefix| format!("{prefix}.1"))
        .ok_or("the subnet is not a /24")?;
    let zero = format!("@sha256:{}", "0".repeat(64));
    if let Some(running) = inputs.running.as_ref().filter(|_| !row.stub)
        && let Some(services) = spec.as_object_mut().unwrap().remove("services")
    {
        let served: BTreeSet<&String> = services
            .as_object()
            .into_iter()
            .flat_map(|s| s.keys())
            .collect();
        for provider in spec["inferenceProviders"]
            .as_object_mut()
            .into_iter()
            .flat_map(|p| p.values_mut())
        {
            if provider["serviceRef"]
                .as_str()
                .is_some_and(|name| served.contains(&name.to_owned()))
            {
                *provider = json!({
                    "provider": "openai",
                    "endpoint": running.endpoint,
                    "credential": {"env": RUNNING_KEY_ENV},
                });
            }
        }
        for sandbox in spec["sandboxes"]
            .as_object_mut()
            .into_iter()
            .flat_map(|s| s.values_mut())
        {
            for route in sandbox
                .pointer_mut("/agent/inference/routes")
                .and_then(Value::as_array_mut)
                .into_iter()
                .flatten()
            {
                if route.pointer("/overrides/model").is_some() {
                    route["overrides"]["model"] = json!(running.model);
                }
            }
        }
    }
    if let Some(services) = spec.get_mut("services").and_then(Value::as_object_mut) {
        if row.stub && !services.is_empty() {
            return Err("a stub row cannot replace the models its example serves".into());
        }
        for service in services.values_mut() {
            if service["serving"]["port"].is_u64() {
                service["serving"]["port"] = json!((inputs.ports)()?);
            }
            if let Some(repository) = service["image"]
                .as_str()
                .and_then(|r| r.strip_suffix(&zero))
            {
                service["image"] = json!((inputs.image)(repository, "rust-v1")?);
            }
        }
    }
    for sandbox in spec["sandboxes"]
        .as_object_mut()
        .ok_or("the example has no sandboxes")?
        .values_mut()
    {
        if let Some(repository) = sandbox["image"]["ref"]
            .as_str()
            .and_then(|r| r.strip_suffix(&zero))
        {
            let harness = sandbox["harness"]["kind"].as_str().unwrap_or_default();
            let tag = harness.rsplit('.').next().unwrap_or_default();
            sandbox["image"]["ref"] = json!((inputs.image)(repository, tag)?);
        }
    }
    let stub_port = if row.stub { (inputs.ports)()? } else { 1 };
    let mut stub_credentials = BTreeSet::new();
    if row.stub {
        let endpoint = format!("http://{host}:{stub_port}/v1");
        let mut point = |provider: &mut Value| {
            provider["endpoint"] = json!(endpoint);
            let credential = provider["credential"]["env"]
                .as_str()
                .unwrap_or(STUB_KEY_ENV)
                .to_owned();
            provider["credential"] = json!({ "env": credential });
            stub_credentials.insert(credential);
        };
        if let Some(shared) = spec
            .get_mut("inferenceProviders")
            .and_then(Value::as_object_mut)
        {
            shared.values_mut().for_each(&mut point);
        }
        for sandbox in spec["sandboxes"].as_object_mut().unwrap().values_mut() {
            if let Some(routes) = sandbox
                .pointer_mut("/agent/inference/routes")
                .and_then(Value::as_array_mut)
            {
                routes
                    .iter_mut()
                    .filter(|route| route["provider"].is_object())
                    .for_each(|route| point(&mut route["provider"]));
            }
        }
    }
    document["metadata"]["uid"] = json!(inputs.uid);
    let replans = document["spec"]
        .get("services")
        .and_then(Value::as_object)
        .is_none_or(serde_json::Map::is_empty);
    Ok(Bound {
        document,
        replans,
        stub_port,
        stub_credentials,
    })
}

fn repository_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn docker(engine: &str, args: &[&str]) -> Option<Vec<String>> {
    nemoclaw_build::ci::live::docker_lines(
        Command::new("docker").args(["--host", engine]).args(args),
    )
}

/// `REPOSITORY:TAG` on `engine`, by the digest it was pulled or built with.
/// `NEMOCLAW_SCENARIO_AGENT_REPOSITORY` replaces `nc-fabric`, for agent
/// images built under another `IMAGE_PREFIX` on a shared machine.
fn local_image(engine: &str, repository: &str, tag: &str) -> Result<String, String> {
    let repository = match var("NEMOCLAW_SCENARIO_AGENT_REPOSITORY") {
        Ok(replacement) if repository == "nc-fabric" => replacement,
        _ => repository.to_owned(),
    };
    let name = format!("{repository}:{tag}");
    let id = docker(engine, &["image", "inspect", "--format", "{{.Id}}", &name])
        .and_then(|lines| lines.into_iter().next())
        .ok_or_else(|| {
            format!("no local image {name}: build it first, as the example's README says")
        })?;
    Ok(format!("{repository}@{id}"))
}

/// Destroys the deployment and removes every container, volume, and network
/// labelled with its UID or in its gateway's sandbox namespace: through
/// [`Cleanup::run`], which reports what it could not remove, or when dropped,
/// such as after a panic.
struct Cleanup {
    cli: PathBuf,
    state: PathBuf,
    engine: String,
    uid: String,
    workspace: String,
    done: bool,
}

impl Cleanup {
    /// Fails when destroy fails, when Docker can't list the objects, or when an
    /// object named after the deployment's workspace remains.
    fn run(&mut self) -> Result<(), String> {
        self.done = true;
        let mut problems = Vec::new();
        if self.state.exists() {
            let destroyed = Command::new(&self.cli)
                .args([
                    "destroy",
                    "--output",
                    "json",
                    "--progress",
                    "off",
                    "--state-dir",
                ])
                .arg(&self.state)
                .stdout(std::process::Stdio::null())
                .status()
                .is_ok_and(|status| status.success());
            if !destroyed {
                problems.push("nemoclaw destroy failed".to_owned());
            }
        }
        let owner = format!("label=nemoclaw.nvidia.com/uid={}", self.uid);
        let sandboxes = format!(
            "label=openshell.ai/sandbox-namespace={}-gateway",
            self.workspace
        );
        for filter in [&owner, &sandboxes] {
            for id in docker(
                &self.engine,
                &["container", "ls", "--all", "--quiet", "--filter", filter],
            )
            .unwrap_or_default()
            {
                let _ = docker(
                    &self.engine,
                    &["container", "rm", "--force", "--volumes", &id],
                );
            }
        }
        for kind in ["volume", "network"] {
            for id in docker(&self.engine, &[kind, "ls", "--quiet", "--filter", &owner])
                .unwrap_or_default()
            {
                let _ = docker(&self.engine, &[kind, "rm", &id]);
            }
        }
        let mut left = Vec::new();
        for args in [
            &["container", "ls", "--all", "--format", "{{.Names}}"][..],
            &["volume", "ls", "--format", "{{.Name}}"],
            &["network", "ls", "--format", "{{.Name}}"],
        ] {
            match docker(&self.engine, args) {
                Some(names) => left.extend(
                    names
                        .into_iter()
                        .filter(|name| name.starts_with(&self.workspace)),
                ),
                None => problems.push(format!("cannot list Docker's {}s", args[0])),
            }
        }
        if !left.is_empty() {
            problems.push(format!("left {}; remove them by hand", left.join(", ")));
        }
        if problems.is_empty() {
            Ok(())
        } else {
            Err(format!("cleanup: {}", problems.join("; ")))
        }
    }
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if !self.done
            && let Err(error) = self.run()
        {
            eprintln!("{error}");
        }
    }
}

/// Runs one row and reports each check's outcome.
fn run_row(
    row: &Row,
    host: &Host,
    bundle: &Bundle,
    root: &Path,
) -> Result<BTreeMap<&'static str, &'static str>, String> {
    let engine = host.engine.clone().ok_or("no Docker engine")?;
    let page_dir = repository_root().join(PAGE).parent().unwrap().to_owned();
    let example = page_dir.join(&row.example);
    let text = fs::read_to_string(&example)
        .map_err(|error| format!("cannot read {}: {error}", example.display()))?;
    let document: Value = serde_saphyr::from_str(&text).map_err(|e| e.to_string())?;
    let occupied: Vec<String> = docker(&engine, &["network", "ls", "--quiet"])
        .unwrap_or_default()
        .iter()
        .flat_map(|id| {
            docker(
                &engine,
                &[
                    "network",
                    "inspect",
                    "--format",
                    "{{range .IPAM.Config}}{{.Subnet}} {{end}}",
                    id,
                ],
            )
            .unwrap_or_default()
            .join(" ")
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>()
        })
        .collect();
    let mut taken = BTreeSet::new();
    let mut ports = || loop {
        let port = nemoclaw_build::ci::live::free_port()?;
        if taken.insert(port) {
            return Ok(port);
        }
    };
    let image = |repository: &str, tag: &str| local_image(&engine, repository, tag);
    let bound = bind(
        row,
        document,
        Inputs {
            uid: nemoclaw_build::ci::live::uuid()?,
            engine: engine.clone(),
            subnet: nemoclaw_build::ci::live::free_subnet(&occupied, &[])?,
            ports: &mut ports,
            image: &image,
            running: var("NEMOCLAW_SCENARIO_MODEL_ENDPOINT")
                .ok()
                .map(|endpoint| Running {
                    endpoint,
                    model: var("NEMOCLAW_SCENARIO_MODEL_NAME").unwrap_or_default(),
                }),
        },
    )?;
    let run = root.join(row.ids.join("+"));
    let _ = fs::remove_dir_all(&run);
    let credentials = run.join("work").join("credentials");
    fs::create_dir_all(&credentials).map_err(|e| e.to_string())?;
    let config = run.join("document.yaml");
    fs::write(&config, serde_json::to_vec_pretty(&bound.document).unwrap())
        .map_err(|e| e.to_string())?;
    let parsed = Document::parse(fs::File::open(&config).unwrap())
        .map_err(|error| format!("the bound example does not parse: {error}"))?;
    let key = format!("nc-scenario-key-{}", &parsed.metadata.uid[..8]);
    for name in &bound.stub_credentials {
        fs::write(credentials.join(name), &key).map_err(|e| e.to_string())?;
    }
    let mut cleanup = Cleanup {
        cli: bundle
            .root()
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        state: run.join("deployment"),
        engine: engine.clone(),
        uid: parsed.metadata.uid.to_string(),
        workspace: parsed.workspace(),
        done: false,
    };
    let scenario = json!({
        "stub": row.stub,
        "port": bound.stub_port,
    });
    // The output is kept to read each run block's result, and echoed.
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["hcl_live::case", "--exact", "--ignored", "--nocapture"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("NEMOCLAW_HCL_CASE", row.case_id())
        .env("NEMOCLAW_HCL_TEST_DIRECTORY", "scenarios")
        .env(
            "NEMOCLAW_HCL_SCENARIO",
            if bound.replans {
                "lifecycle"
            } else {
                "lifecycle-model"
            },
        )
        .env("NEMOCLAW_HCL_RUN", &run)
        .env("NEMOCLAW_HCL_DOCUMENT", &config)
        .env("TF_VAR_scenario", scenario.to_string())
        .env("TF_VAR_model_key", &key)
        .env("DOCKER_HOST", &engine)
        .stderr(std::process::Stdio::inherit())
        .output()
        .map_err(|error| format!("cannot run hcl_live::case: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    print!("{stdout}");
    let mut outcomes = outcomes(&stdout);
    // lifecycle-model has no unchanged plan to report.
    if !bound.replans {
        outcomes.insert(UNCHANGED_PLAN, "unrun: the example serves a model");
    }
    // A failed cleanup fails the row even when every check passed.
    cleanup.run()?;
    if !output.status.success() && !outcomes.values().any(|outcome| *outcome == "fail") {
        return Err(format!(
            "hcl_live::case failed although no check did; see its output and {}",
            run.display()
        ));
    }
    Ok(outcomes)
}

#[test]
#[ignore = "live: needs NEMOCLAW_TEST_BUNDLE and, for each row it runs, what the row's Needs column lists"]
fn page() {
    let rows = parse(&fs::read_to_string(repository_root().join(PAGE)).unwrap()).unwrap();
    let selected: Option<BTreeSet<String>> = var("NEMOCLAW_SCENARIOS")
        .ok()
        .map(|ids| ids.split(',').map(|id| id.trim().to_owned()).collect());
    if let Some(selected) = &selected {
        let known: BTreeSet<_> = rows.iter().flat_map(|row| row.ids.clone()).collect();
        let unknown: Vec<_> = selected.difference(&known).collect();
        assert!(unknown.is_empty(), "no such scenarios: {unknown:?}");
    }
    let host = Host::detect();
    let bundle = Bundle::from_env();
    let root = var("NEMOCLAW_SCENARIOS_RUN").map_or_else(
        |_| std::env::temp_dir().join(format!("nemoclaw-scenarios-{}", std::process::id())),
        PathBuf::from,
    );
    // Each deployment's outcome, or each of its run IDs' outcome when its row ran.
    let mut report: Vec<(String, String)> = Vec::new();
    let mut failed = Vec::new();
    for row in &rows {
        let outcome = if selected
            .as_ref()
            .is_some_and(|s| !row.ids.iter().any(|id| s.contains(id)))
        {
            Err("not selected".to_owned())
        } else if let Some(reason) = host.skip_reason(row) {
            Err(format!("skipped: {reason}"))
        } else {
            eprintln!("scenario {}: {}", row.id, row.title);
            run_row(row, &host, &bundle, &root).map_err(|error| format!("FAILED: {error}"))
        };
        for id in &row.ids {
            match &outcome {
                Ok(cases) => {
                    for (check, result) in cases {
                        // A QA test is reported by run ID, such as
                        // STATION-HERMES-005-E2E; another check by name.
                        let run_id = match CHECKS.iter().find(|(name, ..)| name == check) {
                            Some((_, _, Some(suffix))) => format!("{id}-{suffix}"),
                            _ => format!("{id} {check}"),
                        };
                        if *result == "fail" {
                            failed.push(run_id.clone());
                        }
                        report.push((run_id, (*result).to_owned()));
                    }
                }
                Err(reason) => {
                    if reason.starts_with("FAILED") {
                        failed.push(id.clone());
                    }
                    report.push((id.clone(), reason.clone()));
                }
            }
        }
    }
    eprintln!("\nScenarios on this machine ({} {}):", host.os, host.arch);
    for (id, outcome) in &report {
        eprintln!("  {id}: {outcome}");
    }
    assert!(failed.is_empty(), "scenarios failed: {failed:?}");
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str =
        "| On | ID | Scenario | Example | Needs | Model |\n|---|---|---|---|---|---|\n";

    fn host(os: &'static str, arch: &'static str, gpus: &[&str]) -> Host {
        Host {
            os,
            arch,
            wsl: false,
            engine: Some("unix:///var/run/docker.sock".into()),
            gpus: gpus.iter().map(|g| (*g).to_owned()).collect(),
            env: BTreeSet::new(),
        }
    }

    fn rows() -> Vec<Row> {
        parse(&fs::read_to_string(repository_root().join(PAGE)).unwrap()).unwrap()
    }

    fn by_id(id: &str) -> Row {
        rows()
            .into_iter()
            .find(|row| row.ids.iter().any(|known| known == id))
            .unwrap()
    }

    /// The page's row, switched on, so that a decision depends only on its
    /// needs whatever its status on the page.
    fn on(id: &str) -> Row {
        Row {
            on: true,
            ..by_id(id)
        }
    }

    #[test]
    fn every_row_on_the_page_names_an_example_that_exists() {
        let rows = rows();
        assert!(!rows.is_empty());
        for row in rows {
            let example = repository_root().join("examples").join(&row.example);
            assert!(example.is_file(), "{}: no {}", row.id, example.display());
        }
    }

    #[test]
    fn every_row_names_the_harnesses_its_example_deploys() {
        for row in rows() {
            let path = repository_root().join("examples").join(&row.example);
            let document = Document::parse(fs::File::open(&path).unwrap()).unwrap();
            let deployed: BTreeSet<String> = document
                .sandboxes()
                .map(|sandbox| harness_id(document.sandbox_harness(sandbox).unwrap().kind.as_str()))
                .collect();
            let named: BTreeSet<String> = row
                .ids
                .iter()
                .map(|id| id.split_once('-').unwrap().1.to_owned())
                .collect();
            assert_eq!(named, deployed, "{}: {}", row.id, row.example);
        }
    }

    #[test]
    fn an_unknown_platform_fails_the_page_with_its_id() {
        let page = format!("{TABLE}| ✅ | LAPTOP-OPENCLAW | x | [a](a.yaml) | docker | stub |\n");
        let error = parse(&page).unwrap_err();
        assert!(error.contains("`LAPTOP`"), "{error}");
    }

    #[test]
    fn a_deployment_named_by_two_rows_fails_the_page() {
        let page = format!(
            "{TABLE}| ✅ | K8S-OPENCLAW, K8S-HERMES | x | [a](a.yaml) | docker | stub |\n| ✅ | K8S-HERMES | y | [a](a.yaml) | docker | stub |\n"
        );
        assert!(parse(&page).unwrap_err().contains("K8S-HERMES"));
    }

    #[test]
    fn only_a_row_whose_example_serves_no_model_plans_again_unchanged() {
        let stub = by_id("DOCKER-OPENCLAW");
        assert!(bound(&stub, &stub.example).unwrap().replans);
        let served = by_id("SPARK-HERMES");
        assert!(!bound(&served, &served.example).unwrap().replans);
        let running = Running {
            endpoint: "http://172.30.189.1:19110/v1".into(),
            model: "nemotron-3.5-super-vl".into(),
        };
        assert!(
            bound_with(&served, &served.example, Some(running))
                .unwrap()
                .replans
        );
    }

    #[test]
    fn a_table_with_other_columns_fails_the_page() {
        let page =
            "| Scenario | Example | Needs |\n|---|---|---|\n| T-1 x | [a](a.yaml) | docker |\n";
        assert!(parse(page).unwrap_err().contains("columns"));
    }

    #[test]
    fn an_unknown_need_fails_the_page_with_its_name() {
        let page = format!(
            "{TABLE}| ✅ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker, gpus GB10 | stub |\n"
        );
        let error = parse(&page).unwrap_err();
        assert!(
            error.contains("DOCKER-OPENCLAW") && error.contains("`gpus GB10`"),
            "{error}"
        );
    }

    #[test]
    fn an_example_cell_without_a_link_fails_the_page() {
        let page = format!("{TABLE}| ✅ | DOCKER-OPENCLAW | x | a.yaml | docker | stub |\n");
        assert!(parse(&page).unwrap_err().contains("0 examples"));
    }

    #[test]
    fn an_empty_cell_fails_the_page() {
        let page = format!("{TABLE}| ✅ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker |  |\n");
        assert!(parse(&page).unwrap_err().contains("no Model"));
    }

    #[test]
    fn a_repeated_scenario_fails_the_page() {
        let line = "| ✅ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker | stub |\n";
        assert!(
            parse(&format!("{TABLE}{line}{line}"))
                .unwrap_err()
                .contains("twice")
        );
    }

    #[test]
    fn a_laptop_runs_the_stub_row_and_says_why_it_skips_a_spark_row() {
        let mac = host("macos", "aarch64", &[]);
        assert_eq!(mac.skip_reason(&on("DOCKER-OPENCLAW")), None);
        assert_eq!(
            mac.skip_reason(&on("SPARK-HERMES")).unwrap(),
            "needs a Linux host, an NVIDIA GPU named like `GB10`"
        );
    }

    #[test]
    fn a_dgx_spark_runs_its_rows_and_skips_the_station_and_kubernetes_rows() {
        let spark = host("linux", "aarch64", &["NVIDIA GB10"]);
        for id in ["DOCKER-OPENCLAW", "SPARK-HERMES", "SPARK-OPENCLAW"] {
            assert_eq!(spark.skip_reason(&on(id)), None, "{id}");
        }
        assert!(
            spark
                .skip_reason(&on("STATION-HERMES"))
                .unwrap()
                .contains("`GB300`")
        );
        let kubernetes = spark.skip_reason(&on("K8S-HERMES")).unwrap();
        assert!(
            kubernetes.contains("NEMOCLAW_CLUSTER_KUBECONFIG")
                && kubernetes.contains("$NVIDIA_INFERENCE_API_KEY")
        );
    }

    #[test]
    fn a_paused_row_is_skipped_on_a_machine_that_has_its_needs() {
        let page = format!("{TABLE}| ⏸️ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker | stub |\n");
        let row = parse(&page).unwrap().remove(0);
        let mac = host("macos", "aarch64", &[]);
        assert_eq!(mac.skip_reason(&row).unwrap(), "paused on the page");
    }

    #[test]
    fn an_unknown_on_cell_fails_the_page_with_its_row() {
        let page = format!("{TABLE}| on | DOCKER-OPENCLAW | x | [a](a.yaml) | docker | stub |\n");
        let error = parse(&page).unwrap_err();
        assert!(
            error.contains("DOCKER-OPENCLAW") && error.contains("`on`"),
            "{error}"
        );
    }

    /// A digest reference that names the local image it stands for.
    fn fake_image(repository: &str, tag: &str) -> String {
        format!(
            "{repository}@sha256:{:0>64}",
            nemoclaw_build::hex(tag.as_bytes())
        )
    }

    /// `row`'s example bound to fixed inputs; the result must still be a
    /// configuration NemoClaw accepts.
    fn bound(row: &Row, example: &str) -> Result<Bound, String> {
        bound_with(row, example, None)
    }

    fn bound_with(row: &Row, example: &str, running: Option<Running>) -> Result<Bound, String> {
        let document: Value = serde_saphyr::from_str(
            &fs::read_to_string(repository_root().join("examples").join(example)).unwrap(),
        )
        .unwrap();
        let mut next = 20000;
        let mut ports = || {
            next += 1;
            Ok(next)
        };
        let image = |repository: &str, tag: &str| Ok(fake_image(repository, tag));
        bind(
            row,
            document,
            Inputs {
                uid: "0b3f1c52-7d0e-4c6a-9a51-2f6c8e4d7a10".into(),
                engine: "unix:///engine.sock".into(),
                subnet: "172.30.201.0/24".into(),
                ports: &mut ports,
                image: &image,
                running,
            },
        )
        .inspect(|bound| {
            if let Err(error) =
                Document::parse(serde_json::to_vec(&bound.document).unwrap().as_slice())
            {
                panic!("{example} bound does not parse: {error}");
            }
        })
    }

    #[test]
    fn a_stub_row_points_every_provider_at_the_stub_with_the_example_credential() {
        let row = by_id("DOCKER-OPENCLAW");
        let bound = bound(&row, &row.example).unwrap();
        let spec = &bound.document["spec"];
        assert_eq!(
            spec["gateway"]["target"]["docker"],
            json!({"port": 20001, "engine": "unix:///engine.sock", "networkCIDR": "172.30.201.0/24"})
        );
        assert_eq!(bound.stub_port, 20002);
        for provider in spec["inferenceProviders"].as_object().unwrap().values() {
            assert_eq!(provider["endpoint"], "http://172.30.201.1:20002/v1");
        }
        assert_eq!(
            bound.stub_credentials,
            BTreeSet::from(["NVIDIA_API_KEY".to_owned()])
        );
        assert_eq!(
            spec["sandboxes"]["assistant"]["image"]["ref"],
            fake_image("nc-fabric", "openclaw")
        );
    }

    #[test]
    fn a_served_row_keeps_its_model_on_free_ports_and_local_images() {
        let row = by_id("SPARK-HERMES");
        let bound = bound(&row, &row.example).unwrap();
        let service = &bound.document["spec"]["services"]["super"];
        assert_eq!(service["serving"]["port"], 20002);
        assert_eq!(service["image"], fake_image("nc-prototype-vllm", "rust-v1"));
        assert!(bound.stub_credentials.is_empty());
    }

    #[test]
    fn a_stub_row_on_an_example_that_serves_a_model_fails() {
        let row = Row {
            stub: true,
            ..by_id("SPARK-HERMES")
        };
        assert!(bound(&row, &row.example).err().unwrap().contains("serves"));
    }

    #[test]
    fn a_served_row_can_use_a_running_model_in_place_of_its_service() {
        let row = by_id("SPARK-OPENCLAW");
        let running = Running {
            endpoint: "http://172.30.189.1:19110/v1".into(),
            model: "nemotron-3.5-super-vl".into(),
        };
        let bound = bound_with(&row, &row.example, Some(running)).unwrap();
        let spec = &bound.document["spec"];
        assert_eq!(spec.get("services"), None);
        assert_eq!(
            spec["inferenceProviders"]["super"],
            json!({"provider": "openai", "endpoint": "http://172.30.189.1:19110/v1", "credential": {"env": RUNNING_KEY_ENV}})
        );
        let route = &spec["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0];
        assert_eq!(route["overrides"]["model"], "nemotron-3.5-super-vl");
    }

    #[test]
    fn an_external_gateway_fails_to_bind() {
        let row = by_id("DOCKER-OPENCLAW");
        assert!(
            bound(&row, "agents/fabric-openclaw.yaml")
                .err()
                .unwrap()
                .contains("managed Docker")
        );
    }
}
