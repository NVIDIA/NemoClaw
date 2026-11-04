// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runs each scenario in `tests/integration/hcl/tests` under `tofu test`. A
//! scenario is a test file whose runs name the modules they apply:
//! `./cases/<name>`, a document in the crate's `cases`, shared with the live
//! E2E suites; `./examples/<path>`, a NemoClaw document `examples/<path>.yaml`;
//! or `./examples/<path>`, an authored HCL directory `examples/<path>`. The
//! runner compiles each document with the SDK against the fixtures into that
//! module path of a work copy of the integration root, beside a copy of
//! `harness/main.tf`, and copies each authored directory there with the
//! bundle's NVIDIA provider versions pinned. It then runs each test file with
//! fixtures reset and checks what teardown leaves, which no run block sees.

mod fixtures;

use fixtures::Fixtures;
use nemoclaw_sdk::{compile, config::Document};
use nemoclaw_test_fixtures::Bundle;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

/// The shared NemoClaw documents.
const CASES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/cases");
/// The integration `tofu test` root.
const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/integration/hcl");
/// The live E2E test files, which name their documents by file name.
const LIVE_TESTS: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/e2e/hcl/tests");
const EXAMPLES: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples");
const GENERATIONS: [&str; 8] = [
    "workspace",
    "provider",
    "sandbox",
    "managed_gateway",
    "inference_service",
    "ollama",
    "ollama_service",
    "ollama_proxy",
];

struct Scenario {
    name: String,
    environment: BTreeMap<String, String>,
    credentials: BTreeMap<String, String>,
    /// Whether a document it applies has a managed gateway on the fixture
    /// engine, whose storage only a local engine socket reaches.
    engine_socket: bool,
}

/// What a prepared module needs from the scenarios that apply it.
struct Prepared {
    credentials: Vec<String>,
    image_metadata: Vec<String>,
    engine_socket: bool,
}

/// Scenarios are dealt round-robin across shards, so each test stays within
/// the lifecycle per-test budget; nextest runs the shards one at a time on a
/// runner, because they share the fixed engine socket.
const SHARDS: usize = 4;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn scenarios_in_shard_1() {
    run_shard(0).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn scenarios_in_shard_2() {
    run_shard(1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn scenarios_in_shard_3() {
    run_shard(2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn scenarios_in_shard_4() {
    run_shard(3).await;
}

/// Every live E2E test file names a document in `cases`, and every
/// integration test file applies at least one document or authored example
/// that exists, so a renamed or removed input fails with the unit tests,
/// before a bundle is built.
#[test]
fn every_scenario_test_names_its_inputs() {
    let mut missing: Vec<String> = fs::read_dir(LIVE_TESTS)
        .unwrap()
        .filter_map(|entry| {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            let scenario = name.strip_suffix(".tftest.hcl")?.to_owned();
            let case = Path::new(CASES).join(format!("{scenario}.yaml"));
            (!case.is_file()).then(|| format!("e2e/hcl/tests/{name}"))
        })
        .collect();
    for (name, text) in test_files() {
        let modules = references(&text);
        if modules.is_empty() {
            missing.push(format!("hcl/tests/{name}.tftest.hcl applies nothing"));
        }
        for module in modules {
            if input(&module).is_none() {
                missing.push(format!("hcl/tests/{name}.tftest.hcl: {module}"));
            }
        }
    }
    assert!(missing.is_empty(), "missing scenario inputs: {missing:?}");
}

/// Each integration test file's name and text, sorted by name.
fn test_files() -> Vec<(String, String)> {
    let mut tests: Vec<(String, String)> = fs::read_dir(Path::new(ROOT).join("tests"))
        .unwrap()
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            let name = path
                .file_name()?
                .to_str()?
                .strip_suffix(".tftest.hcl")?
                .to_owned();
            Some((name, fs::read_to_string(&path).unwrap()))
        })
        .collect();
    tests.sort();
    tests
}

/// The quoted values assigned to `key` at the start of a test file's lines.
fn quoted<'a>(text: &'a str, key: &'a str) -> impl Iterator<Item = &'a str> {
    text.lines().filter_map(move |line| {
        let value = line
            .trim()
            .strip_prefix(key)?
            .trim_start()
            .strip_prefix('=')?;
        value.trim_start().strip_prefix('"')?.split('"').next()
    })
}

/// The deployment modules a test file's runs apply, as work-directory paths
/// such as `cases/NAME` or `examples/PATH`; helper modules are not listed.
fn references(text: &str) -> Vec<String> {
    let mut modules: Vec<String> = quoted(text, "source")
        .filter_map(|source| source.strip_prefix("./"))
        .filter(|source| source.starts_with("cases/") || source.starts_with("examples/"))
        .map(str::to_owned)
        .collect();
    modules.sort();
    modules.dedup();
    modules
}

/// The environment variables a test file names as an authored example's
/// `credential_env`, for which the runner supplies fixture credentials.
fn credential_environment(text: &str) -> Vec<String> {
    quoted(text, "credential_env").map(str::to_owned).collect()
}

fn fixture_credential(name: &str) -> String {
    format!("fixture-credential-{}", name.to_lowercase())
}

/// Where a module's input is: a NemoClaw document, or an authored HCL directory.
enum Input {
    Document(PathBuf),
    Authored(PathBuf),
}

fn input(module: &str) -> Option<Input> {
    if let Some(name) = module.strip_prefix("cases/") {
        let path = Path::new(CASES).join(format!("{name}.yaml"));
        return path.is_file().then_some(Input::Document(path));
    }
    let path = Path::new(EXAMPLES).join(module.strip_prefix("examples/")?);
    let document = path.with_extension("yaml");
    if document.is_file() {
        Some(Input::Document(document))
    } else if path.join("main.tf").is_file() || path.join("versions.tf").is_file() {
        Some(Input::Authored(path))
    } else {
        None
    }
}

/// Write `module` into `work`: a document compiled beside the harness, or an
/// authored example with the bundle's NVIDIA provider versions pinned, which
/// OpenTofu requires to select a development bundle's pre-release providers.
fn prepare(
    module: &str,
    work: &Path,
    fixtures: &Fixtures,
    fixture_image: &str,
    version: &str,
) -> Prepared {
    let target = work.join(module);
    let source = match input(module).unwrap_or_else(|| panic!("{module} has no input")) {
        Input::Authored(path) => {
            copy(&path, &target);
            for entry in fs::read_dir(&target).unwrap().flatten() {
                if entry
                    .path()
                    .extension()
                    .is_some_and(|extension| extension == "tf")
                {
                    let text = fs::read_to_string(entry.path()).unwrap();
                    fs::write(entry.path(), pin_versions(&text, version)).unwrap();
                }
            }
            return Prepared {
                credentials: Vec::new(),
                image_metadata: Vec::new(),
                engine_socket: false,
            };
        }
        Input::Document(path) => fs::read(&path).unwrap(),
    };
    let mut document = Document::parse(source.as_slice()).unwrap();
    // A sandbox described by image metadata runs the fixture image.
    let mut image_metadata = Vec::new();
    for sandbox in document.spec.sandboxes.values_mut() {
        if let Some(variable) = &sandbox.image.metadata {
            image_metadata.push(variable.env.clone());
            sandbox.image.ref_ = fixture_image.to_owned();
        }
    }
    let credentials = document
        .credential_names()
        .into_iter()
        .filter(|credential| !image_metadata.iter().any(|variable| variable == credential))
        .map(str::to_owned)
        .collect();
    let engine_socket = document
        .spec
        .gateway
        .as_managed()
        .is_some_and(|managed| !managed.engine.is_empty());
    fixtures.redirect(&mut document);
    let generations: compile::Generations =
        GENERATIONS.map(|kind| (kind.into(), "a".repeat(32))).into();
    let mut graph = compile::compile(&document, &generations, version).unwrap();
    for_tofu_test(&mut graph);
    fs::create_dir_all(&target).unwrap();
    fs::write(target.join("nemoclaw.tf.json"), graph.to_string()).unwrap();
    fs::write(target.join("nemoclaw.yaml"), &source).unwrap();
    // The harness names the shared modules relative to the integration root.
    let depth = module.split('/').count();
    let harness = fs::read_to_string(Path::new(ROOT).join("harness/main.tf"))
        .unwrap()
        .replace(
            "\"../../modules/",
            &format!("\"{}modules/", "../".repeat(depth)),
        );
    fs::write(target.join("harness.tf"), harness).unwrap();
    Prepared {
        credentials,
        image_metadata,
        engine_socket,
    }
}

/// Add `version` to each NVIDIA provider requirement in `text`.
fn pin_versions(text: &str, version: &str) -> String {
    const SOURCE: &str = "source = \"registry.opentofu.org/nvidia/";
    let mut pinned = String::new();
    let mut rest = text;
    while let Some(start) = rest.find(SOURCE) {
        let after = start + SOURCE.len();
        let end = after + rest[after..].find('"').unwrap() + 1;
        pinned.push_str(&rest[..end]);
        pinned.push_str(&format!(", version = \"{version}\""));
        rest = &rest[end..];
    }
    pinned.push_str(rest);
    pinned
}

async fn run_shard(shard: usize) {
    let bundle = Bundle::from_env();
    let root = Path::new(ROOT).to_path_buf();
    let tests = test_files();
    assert!(tests.len() >= SHARDS, "every shard needs a scenario");

    let fixtures = Fixtures::start().await;
    let directory = tempfile::tempdir().unwrap();
    let work = directory.path().join("integration");
    copy(&root, &work);
    let manifest: Value =
        serde_json::from_slice(&fs::read(bundle.root().join("manifest.json")).unwrap()).unwrap();
    let version = manifest["Version"].as_str().unwrap();
    // Without an engine to inspect, image metadata names the fixture image's bundle.
    let (fixture_image, metadata) = nemoclaw_e2e::image_runtime::metadata_bundle(directory.path());
    // OpenTofu loads every test file, so every module they name is prepared,
    // once, although this shard runs only its own scenarios.
    let mut prepared: BTreeMap<String, Prepared> = BTreeMap::new();
    let scenarios: Vec<Scenario> = tests
        .into_iter()
        .map(|(name, text)| {
            let mut scenario = Scenario {
                name,
                environment: BTreeMap::new(),
                credentials: BTreeMap::new(),
                engine_socket: false,
            };
            for module in references(&text) {
                let prepared = prepared
                    .entry(module.clone())
                    .or_insert_with(|| prepare(&module, &work, &fixtures, &fixture_image, version));
                scenario.engine_socket |= prepared.engine_socket;
                for credential in &prepared.credentials {
                    scenario
                        .credentials
                        .insert(credential.clone(), fixture_credential(credential));
                }
                for variable in &prepared.image_metadata {
                    scenario
                        .environment
                        .insert(variable.clone(), metadata.display().to_string());
                }
            }
            // An authored example reads the credentials its test file names.
            for credential in credential_environment(&text) {
                scenario
                    .credentials
                    .insert(credential.clone(), fixture_credential(&credential));
            }
            scenario.environment.extend(scenario.credentials.clone());
            scenario
        })
        .collect();

    let mirror = directory.path().join("fixture-provider");
    let platform = mirror
        .join("registry.opentofu.org/nvidia/fixture/1.0.0")
        .join(bundle.root().file_name().unwrap());
    fs::create_dir_all(&platform).unwrap();
    fs::copy(
        nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-control"),
        platform.join(nemoclaw_test_fixtures::executable(
            "terraform-provider-fixture",
        )),
    )
    .unwrap();
    let configuration = directory.path().join("providers.tfrc");
    fs::write(
        &configuration,
        format!(
            "provider_installation {{\n  filesystem_mirror {{\n    path = {mirror:?}\n    include = [\"registry.opentofu.org/nvidia/fixture\"]\n  }}\n  filesystem_mirror {{\n    path = {:?}\n  }}\n}}\n",
            bundle.root().join("providers"),
        ),
    )
    .unwrap();
    let diagnostics = directory.path().join("diagnostics");
    let mut base: BTreeMap<String, String> = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("HOME", directory.path().display().to_string()),
        ("TF_CLI_CONFIG_FILE", configuration.display().to_string()),
        ("TF_IN_AUTOMATION", "1".into()),
        ("CHECKPOINT_DISABLE", "1".into()),
        ("NEMOCLAW_FIXTURE_CONTROL", fixtures.control.clone()),
        (
            nemoclaw_backend::DIAGNOSTICS_ENV,
            diagnostics.display().to_string(),
        ),
    ]
    .map(|(name, value)| (name.to_owned(), value))
    .into();
    // Windows programs need these to find system libraries, temporary
    // directories, and executables.
    if cfg!(windows) {
        for name in [
            "SystemRoot",
            "SystemDrive",
            "windir",
            "ComSpec",
            "PATHEXT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Ok(value) = std::env::var(name) {
                base.insert(name.into(), value);
            }
        }
    }
    // Coverage-instrumented providers write their profiles where the caller asks.
    if let Ok(profile) = std::env::var("LLVM_PROFILE_FILE") {
        base.insert("LLVM_PROFILE_FILE".into(), profile);
    }
    let (initialized, output) =
        tofu(&bundle, &work, &base, ["init", "-input=false", "-no-color"]).await;
    assert!(initialized, "tofu init failed:\n{output}");

    // CI names a directory to summarize and upload; otherwise evidence stays in
    // the work directory.
    let evidence_root = std::env::var_os("NEMOCLAW_INTEGRATION_EVIDENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| directory.path().join("evidence"));
    let mut failed = Vec::new();
    // OpenTofu loads every test file, so every scenario is compiled; this shard runs its own.
    for scenario in scenarios.iter().skip(shard).step_by(SHARDS) {
        // The skip shows in the output and the CI summary, not only as an absence.
        if cfg!(not(unix)) && scenario.engine_socket {
            println!(
                "scenario {}: skipped; managed Docker gateway storage needs a Unix engine socket",
                scenario.name
            );
            record(&scenario.name, "skipped on this platform");
            continue;
        }
        fixtures.reset(scenario.credentials.clone());
        let mut environment = base.clone();
        environment.extend(scenario.environment.clone());
        // OpenTofu matches the filter against its own platform path, which
        // uses backslashes on Windows.
        let filter = format!(
            "-filter={}",
            Path::new("tests")
                .join(format!("{}.tftest.hcl", scenario.name))
                .display()
        );
        let (_, output) = tofu(&bundle, &work, &environment, ["test", "-no-color", &filter]).await;
        let problem = check(&output, &scenario.credentials, &diagnostics)
            .or_else(|| fixtures.teardown_problem());
        println!(
            "scenario {}: {}",
            scenario.name,
            if problem.is_none() {
                "passed"
            } else {
                "failed"
            }
        );
        record(
            &scenario.name,
            if problem.is_none() {
                "passed"
            } else {
                "failed"
            },
        );
        if let Some(problem) = problem {
            let evidence = evidence_root.join(&scenario.name);
            fs::create_dir_all(&evidence).unwrap();
            let observations = fixtures.shared.observations().to_string();
            for (file, text) in [("tofu.txt", output), ("observations.json", observations)] {
                fs::write(evidence.join(file), fixtures.shared.redact(text)).unwrap();
            }
            eprintln!(
                "{}: {problem}\n{}",
                scenario.name,
                fs::read_to_string(evidence.join("tofu.txt")).unwrap()
            );
            failed.push(scenario.name.clone());
        }
    }
    if !failed.is_empty() {
        let kept = directory.keep();
        panic!(
            "failed scenarios: {failed:?}; evidence in {}, work directory in {}",
            evidence_root.display(),
            kept.display()
        );
    }
}

/// Append a scenario's result to the evidence directory CI names, from which
/// it summarizes every shard's results.
fn record(scenario: &str, result: &str) {
    use std::io::Write as _;
    if let Some(root) = std::env::var_os("NEMOCLAW_INTEGRATION_EVIDENCE") {
        fs::create_dir_all(&root).unwrap();
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(Path::new(&root).join("results.tsv"))
            .and_then(|mut file| writeln!(file, "{scenario}\t{result}"))
            .unwrap();
    }
}

/// Run the bundle's OpenTofu in `directory` with only `environment`.
async fn tofu<const N: usize>(
    bundle: &Bundle,
    directory: &Path,
    environment: &BTreeMap<String, String>,
    args: [&str; N],
) -> (bool, String) {
    let mut command = tokio::process::Command::new(bundle.tofu());
    command
        .args(args)
        .current_dir(directory)
        .env_clear()
        .envs(environment)
        .kill_on_drop(true);
    let result = tokio::time::timeout(Duration::from_secs(120), command.output())
        .await
        .expect("tofu exceeded 120 s")
        .unwrap();
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    (result.status.success(), output)
}

/// What failed in a scenario's `tofu test` output: a run, teardown outside
/// storage NemoClaw retains, or a fixture credential in output or diagnostics.
fn check(
    output: &str,
    credentials: &BTreeMap<String, String>,
    diagnostics: &Path,
) -> Option<String> {
    // Every run passed, and there was at least one.
    let passed = output
        .split("Success! ")
        .nth(1)
        .and_then(|summary| summary.split(" passed, 0 failed.").next())
        .and_then(|count| count.parse::<usize>().ok())
        .is_some_and(|count| count > 0);
    if !passed {
        return Some("a run failed".into());
    }
    // OpenTofu's teardown may only fail on storage that NemoClaw retains.
    if !output
        .lines()
        .filter(|line| line.starts_with("Error: "))
        .all(|line| line == "Error: Destroy incomplete")
    {
        return Some("teardown failed outside retained storage".into());
    }
    let files = walk(diagnostics);
    credentials
        .values()
        .any(|value| {
            output.contains(value)
                || files
                    .iter()
                    .any(|file| fs::read_to_string(file).unwrap_or_default().contains(value))
        })
        .then(|| "a fixture credential leaked".into())
}

/// `tofu test` removes what it applied. Deletion follows the harness's
/// `var.permit_destroy`, which a scenario's last run sets as the SDK's teardown
/// graph does, and the fixture provider is declared beside the SDK's providers.
fn for_tofu_test(graph: &mut Value) {
    for resource in graph["resource"]
        .as_object_mut()
        .unwrap()
        .values_mut()
        .flat_map(|resources| resources.as_object_mut().unwrap().values_mut())
    {
        if let Some(lifecycle) = resource.get_mut("lifecycle").and_then(Value::as_object_mut) {
            lifecycle.remove("prevent_destroy");
        }
    }
    for provider in ["openshell", "fabric"] {
        let configuration = &mut graph["provider"][provider];
        if configuration.is_array() {
            configuration[0]["destroy"] = json!("${var.permit_destroy}");
        } else {
            configuration["destroy"] = json!("${var.permit_destroy}");
        }
    }
    graph["terraform"]["required_providers"]["fixture"] =
        json!({"source": "registry.opentofu.org/nvidia/fixture", "version": "= 1.0.0"});
}

fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).into_iter().flatten().flatten() {
        if entry.path().is_dir() {
            copy(&entry.path(), &to.join(entry.file_name()));
        } else {
            fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
        }
    }
}

fn walk(directory: &Path) -> Vec<PathBuf> {
    fs::read_dir(directory)
        .into_iter()
        .flatten()
        .flatten()
        .flat_map(|entry| {
            if entry.path().is_dir() {
                walk(&entry.path())
            } else {
                vec![entry.path()]
            }
        })
        .collect()
}
