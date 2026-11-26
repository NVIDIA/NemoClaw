// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Each project `nemoclaw compile` writes configures what the SDK's compiled
//! graph configures. OpenTofu reads both: the HCL project, and the graph with
//! the project's variables and locals in the JSON syntax. A plan that targets
//! nothing records each configuration without reading data sources or
//! configuring providers, so no engine or gateway is needed, and the two
//! configurations must match. Their defaults give the variables and locals the
//! graph's own values, and the scenarios run their assertions against the HCL.

use super::{GENERATIONS, input, references, test_files, tofu};
use nemoclaw_sdk::{compile, config::Document, project};
use nemoclaw_test_fixtures::Bundle;
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::Path, sync::Arc};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn written_projects_configure_what_their_graphs_configure() {
    let bundle = Arc::new(Bundle::from_env());
    let sdk_bundle = nemoclaw_sdk::bundle::Bundle::open(bundle.root()).unwrap();
    let version = sdk_bundle.manifest.version.clone();
    let generations: compile::Generations =
        GENERATIONS.map(|kind| (kind.into(), "a".repeat(32))).into();
    let mut documents: BTreeMap<String, (Document, Value)> = BTreeMap::new();
    for (_, text) in test_files() {
        for module in references(&text) {
            let Some(super::Input::Document(path)) = input(&module) else {
                continue;
            };
            let document = Document::parse(fs::read(&path).unwrap().as_slice()).unwrap();
            if project::check(&document).is_err() {
                continue;
            }
            let graph = compile::compile(&document, &generations, &version).unwrap();
            documents.insert(module, (document, graph));
        }
    }
    assert!(
        !documents.is_empty(),
        "no scenario applies a document compile writes"
    );
    let cancel = nemoclaw_sdk::CancellationToken::new();
    let mut requirements = serde_json::Map::new();
    for (_, graph) in documents.values() {
        requirements.extend(
            graph["terraform"]["required_providers"]
                .as_object()
                .unwrap()
                .clone(),
        );
    }
    let schemas = project::schemas(
        &sdk_bundle,
        &json!({"terraform": {"required_providers": requirements}}),
        &cancel,
    )
    .await
    .unwrap();

    let directory = tempfile::tempdir().unwrap();
    let configuration = directory.path().join("providers.tfrc");
    fs::write(
        &configuration,
        format!(
            "provider_installation {{\n  filesystem_mirror {{\n    path = {:?}\n  }}\n}}\n",
            bundle.root().join("providers"),
        ),
    )
    .unwrap();
    let mut environment: BTreeMap<String, String> = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("HOME", directory.path().display().to_string()),
        ("TF_CLI_CONFIG_FILE", configuration.display().to_string()),
        ("TF_IN_AUTOMATION", "1".into()),
        ("CHECKPOINT_DISABLE", "1".into()),
    ]
    .map(|(name, value)| (name.to_owned(), value))
    .into();
    super::add_platform_environment(&mut environment);
    let environment = Arc::new(environment);
    let limit = Arc::new(tokio::sync::Semaphore::new(8));
    let mut checks = tokio::task::JoinSet::new();
    for (module, (document, graph)) in documents {
        let mut written = project::render(&document, &graph, &schemas)
            .unwrap_or_else(|error| panic!("{module}: {error}"));
        project::format(&sdk_bundle, &mut written, &cancel)
            .await
            .unwrap_or_else(|error| panic!("{module}: {error}"));
        let lifted = project::lifted(&document, &graph).unwrap();
        let root = directory.path().join(module.replace('/', "-"));
        fs::create_dir_all(root.join("hcl")).unwrap();
        fs::create_dir_all(root.join("json")).unwrap();
        for (name, text) in &written.files {
            fs::write(root.join("hcl").join(name), text).unwrap();
        }
        fs::write(root.join("json").join("main.tf.json"), lifted.to_string()).unwrap();
        let (bundle, environment, limit) = (bundle.clone(), environment.clone(), limit.clone());
        checks.spawn(async move {
            let _permit = limit.acquire().await.unwrap();
            let hcl = configured(&bundle, &root.join("hcl"), &environment, false).await;
            let json = configured(&bundle, &root.join("json"), &environment, true).await;
            let differences = differences(&json, &hcl, String::new());
            (module, differences)
        });
    }
    let mut failures = Vec::new();
    while let Some(checked) = checks.join_next().await {
        let (module, differences) = checked.unwrap();
        if !differences.is_empty() {
            failures.push(format!("{module}:\n  {}", differences.join("\n  ")));
        }
    }
    failures.sort();
    assert!(
        failures.is_empty(),
        "written projects configure other than their graphs:\n{}",
        failures.join("\n")
    );
}

/// The configuration OpenTofu reads from `directory`, normalized, and with its
/// resources in address order.
async fn configured(
    bundle: &Bundle,
    directory: &Path,
    environment: &BTreeMap<String, String>,
    json_syntax: bool,
) -> Value {
    let (initialized, output) = tofu(
        bundle,
        directory,
        environment,
        ["init", "-input=false", "-no-color"],
    )
    .await;
    assert!(
        initialized,
        "{}: tofu init failed:\n{output}",
        directory.display()
    );
    // A target that names nothing plans nothing, so nothing is read.
    let (planned, output) = tofu(
        bundle,
        directory,
        environment,
        [
            "plan",
            "-input=false",
            "-no-color",
            "-refresh=false",
            "-target=terraform_data.nemoclaw_compile_nothing",
            "-out=configuration.plan",
        ],
    )
    .await;
    assert!(
        planned,
        "{}: tofu plan failed:\n{output}",
        directory.display()
    );
    let (shown, output) = tofu(
        bundle,
        directory,
        environment,
        ["show", "-json", "configuration.plan"],
    )
    .await;
    assert!(
        shown,
        "{}: tofu show failed:\n{output}",
        directory.display()
    );
    let plan: Value = serde_json::from_str(&output).unwrap();
    let mut configuration = plan["configuration"].clone();
    normalize(&mut configuration, json_syntax);
    if let Some(resources) = configuration["root_module"]["resources"].as_array_mut() {
        resources.sort_by(|a, b| a["address"].as_str().cmp(&b["address"].as_str()));
    }
    configuration
}

/// An expression with references keeps no constant value. The JSON syntax
/// reports each string as its template source, as a constant value: a
/// template with interpolations isn't constant, and a constant one is
/// reported with the escapes its value lacks.
fn normalize(value: &mut Value, json_syntax: bool) {
    match value {
        Value::Object(fields) => {
            if fields.contains_key("references") {
                fields.remove("constant_value");
            }
            if json_syntax && let Some(Value::String(source)) = fields.get("constant_value") {
                let escapes = [("$${", "${"), ("%%{", "%{")];
                let mut unescaped = source.clone();
                for (escape, _) in escapes {
                    unescaped = unescaped.replace(escape, "");
                }
                if unescaped.contains("${") || unescaped.contains("%{") {
                    fields.remove("constant_value");
                } else {
                    let mut value = source.clone();
                    for (escape, literal) in escapes {
                        value = value.replace(escape, literal);
                    }
                    fields.insert("constant_value".into(), Value::String(value));
                }
            }
            for field in fields.values_mut() {
                normalize(field, json_syntax);
            }
        }
        Value::Array(items) => {
            for item in items {
                normalize(item, json_syntax);
            }
        }
        _ => {}
    }
}

/// Where `actual` differs from `expected`, as JSON paths, the first ten.
fn differences(expected: &Value, actual: &Value, path: String) -> Vec<String> {
    let mut found = Vec::new();
    collect(expected, actual, path, &mut found);
    found.truncate(10);
    found
}

fn collect(expected: &Value, actual: &Value, path: String, found: &mut Vec<String>) {
    if found.len() >= 10 {
        return;
    }
    match (expected, actual) {
        (Value::Object(expected), Value::Object(actual)) => {
            let keys: std::collections::BTreeSet<&String> =
                expected.keys().chain(actual.keys()).collect();
            for key in keys {
                collect(
                    expected.get(key).unwrap_or(&Value::Null),
                    actual.get(key).unwrap_or(&Value::Null),
                    format!("{path}.{key}"),
                    found,
                );
            }
        }
        (Value::Array(expected), Value::Array(actual)) if expected.len() == actual.len() => {
            for (index, (expected, actual)) in expected.iter().zip(actual).enumerate() {
                collect(expected, actual, format!("{path}[{index}]"), found);
            }
        }
        (expected, actual) if expected != actual => {
            found.push(format!("{path}: graph {expected}, HCL {actual}"));
        }
        _ => {}
    }
}

/// The bundled CLI writes a project once, into a new directory: the files by
/// concern and a README, with credential names but no values. It refuses a
/// directory that already has files, and a managed Kubernetes gateway, and
/// leaves both as they were.
#[test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
fn the_cli_writes_a_project_once_and_refuses_managed_clusters() {
    let bundle = Bundle::from_env();
    let cli = bundle
        .root()
        .join("bin")
        .join(nemoclaw_sdk::bundle::executable("nemoclaw"));
    let directory = tempfile::tempdir().unwrap();
    let compile = |document: &Path, output: &Path| {
        std::process::Command::new(&cli)
            .args(["--progress", "off", "compile"])
            .arg(document)
            .arg("--output")
            .arg(output)
            .env(
                "NVIDIA_INFERENCE_API_KEY",
                "fixture-credential-never-written",
            )
            .output()
            .unwrap()
    };
    let project = directory.path().join("project");
    let written = compile(
        &Path::new(super::CASES).join("docker-openclaw-nvidia.yaml"),
        &project,
    );
    assert!(
        written.status.success(),
        "{}",
        String::from_utf8_lossy(&written.stderr)
    );
    let mut files: Vec<String> = fs::read_dir(&project)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    files.sort();
    for expected in [
        "README.md",
        "gateway.tf",
        "sandboxes.tf",
        "variables.tf",
        "versions.tf",
    ] {
        assert!(files.iter().any(|file| file == expected), "{files:?}");
    }
    let text: String = files
        .iter()
        .map(|file| fs::read_to_string(project.join(file)).unwrap())
        .collect();
    assert!(text.contains("NVIDIA_INFERENCE_API_KEY"));
    assert!(!text.contains("fixture-credential-never-written"));
    let stdout = String::from_utf8_lossy(&written.stdout);
    assert!(stdout.contains("README.md"), "{stdout}");

    // Again into the same directory: refused, and nothing changes.
    let before: Vec<(String, String)> = files
        .iter()
        .map(|file| {
            (
                file.clone(),
                fs::read_to_string(project.join(file)).unwrap(),
            )
        })
        .collect();
    let again = compile(
        &Path::new(super::CASES).join("docker-openclaw-nvidia.yaml"),
        &project,
    );
    assert_eq!(again.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&again.stderr).contains("already has files"));
    for (file, text) in before {
        assert_eq!(
            fs::read_to_string(project.join(&file)).unwrap(),
            text,
            "{file}"
        );
    }

    // A managed Kubernetes gateway: refused before anything is written.
    let cluster = directory.path().join("cluster");
    let refused = compile(
        &Path::new(super::EXAMPLES).join("gtc-dc/kubernetes-amd64.yaml"),
        &cluster,
    );
    assert_eq!(refused.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&refused.stderr)
            .contains("a managed Kubernetes or OpenShift gateway's configuration depends on")
    );
    assert!(!cluster.exists());
}
