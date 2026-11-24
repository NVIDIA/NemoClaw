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

use nemoclaw_sdk::config::Document;
use nemoclaw_test_fixtures::Bundle;
use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    env::var,
    fs,
    path::{Path, PathBuf},
    process::Command,
};

/// The page, relative to the repository root.
const PAGE: &str = "examples/scenarios.md";
/// The columns, in order, that every table on the page has.
const HEADER: [&str; 8] = [
    "On", "ID", "Scenario", "Example", "Needs", "Model", "Ask", "Expect",
];
/// The On cell that lets a row run, and the one that pauses it.
const ON: &str = "✅";
const PAUSED: &str = "⏸";
/// The reply the stub model gives, which `lifecycle` configures.
const STUB_REPLY: &str = "nemoclaw-stub-reply";
/// The credential variable a stub row's providers read when the example names
/// none.
const STUB_KEY_ENV: &str = "NEMOCLAW_SCENARIO_MODEL_KEY";

/// The platforms of the QA team's run IDs (`PLATFORM-HARNESS-NNN`), and
/// DOCKER for any host with a Docker engine, which their plan does not name.
const PLATFORMS: [&str; 5] = ["SPARK", "STATION", "RTXSPARKWSL2", "K8S", "DOCKER"];

/// The HARNESS part of a deployment ID for a harness kind, such as HERMES for
/// `nvidia.fabric.hermes`.
fn harness_id(kind: &str) -> String {
    kind.rsplit('.').next().unwrap_or_default().to_uppercase()
}

/// A deployment ID, `PLATFORM-HARNESS`, as the QA team's run IDs start.
fn deployment_id(text: &str) -> Result<String, String> {
    let (platform, harness) = text
        .split_once('-')
        .ok_or_else(|| format!("names `{text}`, not PLATFORM-HARNESS"))?;
    if !PLATFORMS.contains(&platform) {
        return Err(format!(
            "names the platform `{platform}`: use one of {}",
            PLATFORMS.join(", ")
        ));
    }
    if harness.is_empty() || !harness.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(format!(
            "names the harness `{harness}`: use capital letters"
        ));
    }
    Ok(text.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Row {
    /// The deployment IDs, joined, which name the row in output.
    id: String,
    /// One deployment ID for each harness the example deploys.
    ids: Vec<String>,
    title: String,
    /// Whether the page lets the row run, by its On cell; a paused row never runs.
    on: bool,
    /// The example, relative to the page's directory.
    example: String,
    needs: Vec<Need>,
    /// Whether the runner serves the stub model in place of every endpoint.
    stub: bool,
    ask: String,
    /// The one word the reply must be, or none when any text passes.
    expect: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Need {
    Linux,
    Wsl2,
    Arm64,
    Amd64,
    Docker,
    Gpu(String),
    Kubernetes,
    Env(String),
}

impl Need {
    fn parse(text: &str) -> Result<Need, String> {
        Ok(match text {
            "linux" => Need::Linux,
            "wsl2" => Need::Wsl2,
            "arm64" => Need::Arm64,
            "amd64" => Need::Amd64,
            "docker" => Need::Docker,
            "kubernetes" => Need::Kubernetes,
            _ => {
                if let Some(name) = text.strip_prefix("gpu ").map(str::trim)
                    && !name.is_empty()
                {
                    Need::Gpu(name.to_owned())
                } else if let Some(name) = text.strip_prefix('$')
                    && !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                {
                    Need::Env(name.to_owned())
                } else {
                    return Err(format!(
                        "unknown need `{text}`: use linux, wsl2, arm64, amd64, docker, kubernetes, `gpu NAME`, or `$NAME`"
                    ));
                }
            }
        })
    }

    /// What the machine lacks, or none when it has this.
    fn lacking(&self, host: &Host) -> Option<String> {
        let (has, wanted) = match self {
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
        let lacking: Vec<_> = row.needs.iter().filter_map(|n| n.lacking(self)).collect();
        (!lacking.is_empty()).then(|| format!("needs {}", lacking.join(", ")))
    }
}

/// A table cell's text and the targets of its links.
type Cell = (String, Vec<String>);

/// Every row of every table on `page`. A table with other columns, an empty
/// cell, an unknown need, an Example cell without exactly one link, or a
/// repeated scenario fails, so that no row is dropped without a message.
fn parse(page: &str) -> Result<Vec<Row>, String> {
    let mut tables: Vec<Vec<Vec<Cell>>> = Vec::new();
    let mut cell: Option<Cell> = None;
    for event in Parser::new_ext(page, Options::ENABLE_TABLES) {
        match event {
            Event::Start(Tag::Table(_)) => tables.push(Vec::new()),
            Event::Start(Tag::TableHead | Tag::TableRow) => {
                tables.last_mut().unwrap().push(Vec::new());
            }
            Event::Start(Tag::TableCell) => cell = Some((String::new(), Vec::new())),
            Event::End(TagEnd::TableCell) => {
                let (text, links) = cell.take().unwrap();
                let row = tables.last_mut().unwrap().last_mut().unwrap();
                row.push((text.trim().to_owned(), links));
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                if let Some((_, links)) = cell.as_mut() {
                    links.push(dest_url.into_string());
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((cell, _)) = cell.as_mut() {
                    cell.push_str(&text);
                }
            }
            _ => {}
        }
    }
    if tables.is_empty() {
        return Err("the page has no table".into());
    }
    let mut rows = Vec::new();
    let mut ids = BTreeSet::new();
    for table in tables {
        let mut lines = table.into_iter();
        let header: Vec<_> = lines.next().unwrap_or_default();
        let header: Vec<&str> = header.iter().map(|(text, _)| text.as_str()).collect();
        if header != HEADER {
            return Err(format!("a table's columns are {header:?}, not {HEADER:?}"));
        }
        for cells in lines {
            let row = row(&cells).map_err(|error| {
                format!(
                    "the row `{}` {error}",
                    cells
                        .get(HEADER.iter().position(|c| *c == "ID").unwrap())
                        .map_or("", |c| &c.0)
                )
            })?;
            for id in &row.ids {
                if !ids.insert(id.clone()) {
                    return Err(format!("the deployment {id} appears twice"));
                }
            }
            rows.push(row);
        }
    }
    Ok(rows)
}

fn row(cells: &[Cell]) -> Result<Row, String> {
    let column = |name: &str| {
        let index = HEADER.iter().position(|c| *c == name).unwrap();
        let (text, links) = &cells[index];
        if text.is_empty() {
            Err(format!("has no {name}"))
        } else {
            Ok((text.as_str(), links))
        }
    };
    let ids: Vec<String> = column("ID")?
        .0
        .split(',')
        .map(|id| deployment_id(id.trim()))
        .collect::<Result<_, _>>()?;
    let (title, _) = column("Scenario")?;
    // The emoji may carry the emoji-presentation selector.
    let on = match column("On")?.0.trim_end_matches('\u{fe0f}') {
        ON => true,
        PAUSED => false,
        other => {
            return Err(format!(
                "has `{other}` in On: write {ON} or {PAUSED}\u{fe0f}"
            ));
        }
    };
    let example = match column("Example")?.1.as_slice() {
        [link] => link.clone(),
        links => return Err(format!("links {} examples, not one", links.len())),
    };
    let needs = column("Needs")?
        .0
        .split(',')
        .map(|need| Need::parse(need.trim()))
        .collect::<Result<_, _>>()?;
    let expect = match column("Expect")?.0 {
        "any reply" => None,
        word if word.split_whitespace().count() == 1 => Some(word.to_owned()),
        other => return Err(format!("expects `{other}`: write one word or `any reply`")),
    };
    Ok(Row {
        id: ids.join(", "),
        ids,
        title: title.trim().to_owned(),
        on,
        example,
        needs,
        stub: column("Model")?.0 == "stub",
        ask: column("Ask")?.0.to_owned(),
        expect,
    })
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

/// The row's example bound to this machine, the verifier's targets, the
/// stub's port, and the credential variables a stub row's providers read.
struct Bound {
    document: Value,
    targets: Value,
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
    let mut targets = serde_json::Map::new();
    for (name, sandbox) in spec["sandboxes"]
        .as_object_mut()
        .ok_or("the example has no sandboxes")?
    {
        if let Some(repository) = sandbox["image"]["ref"]
            .as_str()
            .and_then(|r| r.strip_suffix(&zero))
        {
            let harness = sandbox["harness"]["kind"].as_str().unwrap_or_default();
            let tag = harness.rsplit('.').next().unwrap_or_default();
            sandbox["image"]["ref"] = json!((inputs.image)(repository, tag)?);
        }
        let mut target = json!({
            "agent": sandbox["agent"]["name"],
            "request": row.ask,
            "response_pointer": "/output/response",
        });
        if let Some(word) = &row.expect {
            target["answer"] = json!(word);
        }
        targets.insert(name.clone(), target);
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
    Ok(Bound {
        document,
        targets: Value::Object(targets),
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
/// labelled with its UID or in its gateway's sandbox namespace, when dropped.
struct Cleanup {
    cli: PathBuf,
    state: PathBuf,
    engine: String,
    uid: String,
    workspace: String,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.state.exists() {
            let _ = Command::new(&self.cli)
                .args(["destroy", "--output", "json", "--state-dir"])
                .arg(&self.state)
                .status();
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
        let left: Vec<String> = ["container", "volume", "network"]
            .iter()
            .flat_map(|kind| {
                let args: &[&str] = match *kind {
                    "container" => &["container", "ls", "--all", "--format", "{{.Names}}"],
                    "volume" => &["volume", "ls", "--format", "{{.Name}}"],
                    _ => &["network", "ls", "--format", "{{.Name}}"],
                };
                docker(&self.engine, args).unwrap_or_default()
            })
            .filter(|name| name.starts_with(&self.workspace))
            .collect();
        if !left.is_empty() {
            eprintln!("cleanup left {}: remove them by hand", left.join(", "));
        }
    }
}

/// Runs one row and reports whether its lifecycle passed.
fn run_row(row: &Row, host: &Host, bundle: &Bundle, root: &Path) -> Result<(), String> {
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
    let _cleanup = Cleanup {
        cli: bundle
            .root()
            .join("bin")
            .join(nemoclaw_sdk::bundle::executable("nemoclaw")),
        state: run.join("deployment"),
        engine: engine.clone(),
        uid: parsed.metadata.uid.to_string(),
        workspace: parsed.workspace(),
    };
    let scenario = json!({ "stub": row.stub, "port": bound.stub_port, "targets": bound.targets });
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["hcl_live::case", "--exact", "--ignored", "--nocapture"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .env("NEMOCLAW_HCL_CASE", "lifecycle")
        .env("NEMOCLAW_HCL_TEST_DIRECTORY", "scenarios")
        .env("NEMOCLAW_HCL_RUN", &run)
        .env("NEMOCLAW_HCL_DOCUMENT", &config)
        .env("TF_VAR_scenario", scenario.to_string())
        .env("TF_VAR_model_key", &key)
        .env("DOCKER_HOST", &engine)
        .status()
        .map_err(|error| format!("cannot run hcl_live::case: {error}"))?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| format!("the lifecycle failed; see {}", run.display()))
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
    let mut outcomes = BTreeMap::new();
    for row in &rows {
        let outcome = if selected
            .as_ref()
            .is_some_and(|s| !row.ids.iter().any(|id| s.contains(id)))
        {
            "not selected".to_owned()
        } else if let Some(reason) = host.skip_reason(row) {
            format!("skipped: {reason}")
        } else {
            eprintln!("scenario {}: {}", row.id, row.title);
            match run_row(row, &host, &bundle, &root) {
                Ok(()) => "passed".to_owned(),
                Err(error) => format!("FAILED: {error}"),
            }
        };
        outcomes.insert(row.id.clone(), outcome);
    }
    eprintln!("\nScenarios on this machine ({} {}):", host.os, host.arch);
    for row in &rows {
        eprintln!("  {} {}: {}", row.id, row.title, outcomes[&row.id]);
    }
    let failed: Vec<_> = outcomes
        .iter()
        .filter(|(_, outcome)| outcome.starts_with("FAILED"))
        .map(|(id, _)| id.as_str())
        .collect();
    assert!(failed.is_empty(), "scenarios failed: {failed:?}");
}

#[cfg(test)]
mod tests {
    use super::*;

    const TABLE: &str = "| On | ID | Scenario | Example | Needs | Model | Ask | Expect |\n|---|---|---|---|---|---|---|---|\n";

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
        let page = format!(
            "{TABLE}| ✅ | LAPTOP-OPENCLAW | x | [a](a.yaml) | docker | stub | Hi. | any reply |\n"
        );
        let error = parse(&page).unwrap_err();
        assert!(error.contains("`LAPTOP`"), "{error}");
    }

    #[test]
    fn a_deployment_named_by_two_rows_fails_the_page() {
        let page = format!(
            "{TABLE}| ✅ | K8S-OPENCLAW, K8S-HERMES | x | [a](a.yaml) | docker | stub | Hi. | any reply |\n| ✅ | K8S-HERMES | y | [a](a.yaml) | docker | stub | Hi. | any reply |\n"
        );
        assert!(parse(&page).unwrap_err().contains("K8S-HERMES"));
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
            "{TABLE}| ✅ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker, gpus GB10 | stub | Hi. | any reply |\n"
        );
        let error = parse(&page).unwrap_err();
        assert!(
            error.contains("DOCKER-OPENCLAW") && error.contains("`gpus GB10`"),
            "{error}"
        );
    }

    #[test]
    fn an_example_cell_without_a_link_fails_the_page() {
        let page = format!(
            "{TABLE}| ✅ | DOCKER-OPENCLAW | x | a.yaml | docker | stub | Hi. | any reply |\n"
        );
        assert!(parse(&page).unwrap_err().contains("0 examples"));
    }

    #[test]
    fn an_empty_cell_fails_the_page() {
        let page = format!(
            "{TABLE}| ✅ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker | stub |  | any reply |\n"
        );
        assert!(parse(&page).unwrap_err().contains("no Ask"));
    }

    #[test]
    fn a_repeated_scenario_fails_the_page() {
        let line = "| ✅ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker | stub | Hi. | any reply |\n";
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
        let page = format!(
            "{TABLE}| ⏸️ | DOCKER-OPENCLAW | x | [a](a.yaml) | docker | stub | Hi. | any reply |\n"
        );
        let row = parse(&page).unwrap().remove(0);
        let mac = host("macos", "aarch64", &[]);
        assert_eq!(mac.skip_reason(&row).unwrap(), "paused on the page");
    }

    #[test]
    fn an_unknown_on_cell_fails_the_page_with_its_row() {
        let page = format!(
            "{TABLE}| on | DOCKER-OPENCLAW | x | [a](a.yaml) | docker | stub | Hi. | any reply |\n"
        );
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
        assert_eq!(
            bound.targets,
            json!({"assistant": {"agent": "primary", "request": row.ask, "response_pointer": "/output/response", "answer": STUB_REPLY}})
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
        assert_eq!(bound.targets["assistant"]["answer"], "READY");
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
            bound(&row, "fabric-openclaw.yaml")
                .err()
                .unwrap()
                .contains("managed Docker")
        );
    }
}
