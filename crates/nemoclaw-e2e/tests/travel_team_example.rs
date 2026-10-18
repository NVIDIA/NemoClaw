// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The travel team in examples/hcl/travel-team, applied unchanged as plain HCL
//! against the bundle's providers, with fakes for the Docker engine, the
//! OpenShell gateway, the model server, and the agent images. It also reports
//! how long planning and applying a realistic team take.
use nemoclaw_e2e::{http_fixture::Fixture as Http, openshell::Fixture};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
    time::Instant,
};

const EXAMPLE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../examples/hcl/travel-team"
);
const MODEL: &str = "nemotron-mini:4b";
const WORKSPACE: &str = "travel-team";
const RESEARCHERS: [&str; 4] = ["flights", "stays", "transport", "attractions"];

/// The example's default HTTPS source for a researcher.
fn source(researcher: &str) -> &'static str {
    match researcher {
        "flights" => "api.flights.example.com",
        "stays" => "api.stays.example.com",
        "transport" => "api.transit.example.com",
        "attractions" => "api.attractions.example.com",
        _ => unreachable!("{researcher} is not a researcher"),
    }
}

/// An engine that holds the agent images and reports their Fabric catalogs.
async fn image_engine(images: Vec<String>) -> Http {
    use nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL;
    let label = serde_json::to_string(&nemoclaw_e2e::image_runtime::catalog()).unwrap();
    Http::engine(move |request| {
        let value = if request.path == "/info" {
            json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"})
        } else {
            json!({"Id":"sha256:agent", "Architecture":"arm64", "Os":"linux", "RepoDigests":images, "Config":{"Labels":{IMAGE_CATALOG_LABEL:label}}})
        };
        Some((200, serde_json::to_vec(&value).unwrap()))
    })
    .await
}

fn save(root: &Path, name: &str, value: &Value) {
    fs::write(root.join(name), value.to_string()).unwrap();
}

fn copy_dir(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// Each sandbox's ID, by name.
fn sandbox_ids(gateway: &Fixture) -> BTreeMap<String, String> {
    let state = gateway.state.lock().unwrap();
    state
        .sandboxes
        .values()
        .map(|sandbox| {
            let metadata = sandbox.metadata.as_ref().unwrap();
            (metadata.name.clone(), metadata.id.clone())
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated fixtures"]
async fn travel_team_applies_as_plain_hcl_against_the_shipped_providers() {
    let bundle = PathBuf::from(std::env::var("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle"));
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let ollama_image = format!("ollama-runtime@sha256:{}", "a".repeat(64));
    let hermes_image = format!("hermes@sha256:{}", "b".repeat(64));

    // Ollama's engine: the SSH simulator, reached as ssh://operator@gpu-box.
    nemoclaw_test_fixtures::ssh::install_simulator(&root.join("bin"), root);
    save(
        root,
        "fixture.json",
        &json!({"files":{}, "stats":{}, "image_refs":[ollama_image], "image":{"Id":"sha256:runtime", "Architecture":"arm64", "Os":"linux", "Config":{"Env":[], "Labels":{}}}}),
    );
    save(
        root,
        "engine.json",
        &json!({"effects":0, "creates":0, "image_missing":false, "pulls":0, "network":{"Name":"bridge"}}),
    );
    save(root, "control.json", &json!({}));

    // The model server Ollama would be, listing the served model.
    let model_server = Http::start_tcp(|request| {
        (request.method == "GET" && request.path == "/v1/models").then(|| {
            (
                200,
                json!({"object":"list", "data":[{"id":MODEL, "object":"model"}]})
                    .to_string()
                    .into_bytes(),
            )
        })
    })
    .await;
    let gateway = Fixture::start().await;
    let engine = image_engine(vec![hermes_image.clone()]).await;

    // Users install the bundle's providers as a filesystem mirror and init.
    let work = root.join("travel-team");
    copy_dir(Path::new(EXAMPLE), &work);
    // A development bundle's providers are pre-releases, which OpenTofu
    // selects only when pinned exactly, as the example tells readers to do.
    let version = nemoclaw_sdk::bundle::Bundle::open(&bundle)
        .unwrap()
        .manifest
        .version;
    let mut versions = fs::read_to_string(work.join("versions.tf")).unwrap();
    for provider in ["ollama", "openshell", "fabric"] {
        let source = format!("source = \"registry.opentofu.org/nvidia/{provider}\"");
        assert!(versions.contains(&source), "{provider}");
        versions = versions.replace(&source, &format!("{source}, version = \"{version}\""));
    }
    fs::write(work.join("versions.tf"), versions).unwrap();
    fs::write(
        root.join("providers.tfrc"),
        format!(
            "provider_installation {{ filesystem_mirror {{ path = {} }} }}\n",
            json!(bundle.join("providers"))
        ),
    )
    .unwrap();
    save(
        &work,
        "terraform.tfvars.json",
        &json!({
            "docker_host": "ssh://operator@gpu-box",
            "gateway_endpoint": gateway.endpoint,
            "images": {"hermes": hermes_image},
            "image_engine": engine.endpoint,
            "ollama_image": ollama_image,
            "local_model": {"name": MODEL, "digest": "c".repeat(64)},
            "model_endpoint": format!("{}/v1", model_server.endpoint),
            // Sandboxes reach the model at a private address of the host.
            "sandbox_model_endpoint": "http://10.0.0.8:11434/v1",
        }),
    );
    let tofu = |args: &[&str]| -> Output {
        Command::new(bundle.join("libexec/tofu"))
            .args(args)
            .arg("-no-color")
            .current_dir(&work)
            .env("TF_CLI_CONFIG_FILE", root.join("providers.tfrc"))
            .env("TF_IN_AUTOMATION", "1")
            .env("CHECKPOINT_DISABLE", "1")
            .env("NEMOCLAW_TEST_REMOTE", root)
            .env("PATH", nemoclaw_test_fixtures::path_with(&root.join("bin")))
            // OpenShell reads registered keys from these during apply.
            .env("NVIDIA_API_KEY", "frontier-key")
            .env("BRAVE_API_KEY", "search-key")
            .env("BOOKINGS_API_KEY", "bookings-key")
            .output()
            .unwrap()
    };
    let run = |args: &[&str], success: bool| {
        let started = Instant::now();
        let output = tofu(args);
        eprintln!("tofu {} took {:.2?}", args[0], started.elapsed());
        assert_eq!(
            output.status.success(),
            success,
            "{args:?}\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        output
    };

    run(&["init", "-input=false"], true);
    run(&["apply", "-auto-approve", "-input=false"], true);

    // Every agent is reachable from the agents output.
    let agents: Value =
        serde_json::from_slice(&run(&["output", "-json", "agents"], true).stdout).unwrap();
    let roles: Vec<&str> = RESEARCHERS
        .into_iter()
        .chain(["scheduler", "buyer"])
        .collect();
    for role in &roles {
        let agent = &agents[role];
        assert_eq!(agent["workspace"], WORKSPACE, "{agents}");
        assert_eq!(agent["sandbox"], *role, "{agents}");
        assert_eq!(agent["agent"], *role, "{agents}");
        assert!(
            agent["runtime_id"]
                .as_str()
                .is_some_and(|id| !id.is_empty()),
            "{agents}"
        );
    }

    {
        let state = gateway.state.lock().unwrap();
        // Two inference registrations, web search, and the booking service.
        assert_eq!(state.providers.len(), 4, "{:?}", state.providers.keys());
        assert_eq!(state.sandboxes.len(), roles.len());
        for role in &roles {
            let sandbox = &state.sandboxes[&format!("{WORKSPACE}/{role}")];
            let spec = sandbox.spec.as_ref().unwrap();
            // Everyone has exactly one model; researchers also search the web,
            // and the buyer authenticates to the booking service.
            let expected = if *role == "scheduler" { 1 } else { 2 };
            assert_eq!(
                spec.providers.len(),
                expected,
                "{role}: {:?}",
                spec.providers
            );
            // OpenShell grants attached providers' endpoints itself, so the
            // policy holds only what providers don't cover: researchers' own
            // sources and the buyer's MCP grant.
            let grants: Vec<&str> = spec
                .policy
                .as_ref()
                .map(|policy| policy.network_policies.keys().map(String::as_str).collect())
                .unwrap_or_default();
            let expected: Vec<String> = match *role {
                "scheduler" => vec![],
                "buyer" => vec!["buyer-bookings".into()],
                researcher => vec![format!(
                    "{researcher}-{}",
                    source(researcher).replace('.', "-")
                )],
            };
            assert_eq!(grants, expected, "{role}");
        }
        let configurations: BTreeMap<&str, &Value> = state
            .fabric_configurations
            .values()
            .map(|configuration| {
                (
                    configuration["metadata"]["name"].as_str().unwrap(),
                    configuration,
                )
            })
            .collect();
        assert_eq!(configurations.len(), roles.len());
        for configuration in configurations.values() {
            assert_eq!(
                configuration["harness"]["adapter_id"],
                "nvidia.fabric.hermes"
            );
            // Hermes's custom provider turns the models' reasoning off.
            assert_eq!(configuration["models"]["default"]["provider"], "custom");
        }
        for researcher in RESEARCHERS {
            let configuration = configurations[researcher];
            assert_eq!(configuration["models"]["default"]["model"], MODEL);
            assert_eq!(configuration["runtime"]["max_turns"], 16);
            assert_eq!(configuration["tools"]["enabled"], json!(["web"]));
            assert!(
                configuration["instructions"]["system"]["content"]
                    .as_str()
                    .unwrap()
                    .starts_with(&format!("You are the {researcher} researcher")),
                "{configuration}"
            );
        }
        let scheduler = configurations["scheduler"];
        assert_eq!(scheduler["tools"]["enabled"], json!(["delegation"]));
        assert_eq!(scheduler["runtime"]["max_turns"], 12);
        let buyer = configurations["buyer"];
        assert_eq!(buyer["models"]["default"]["temperature"], 0.0);
        assert_eq!(buyer["runtime"]["max_turns"], 24);
        // The buyer's only toolset is its MCP server's; OpenShell's grant
        // limits which of the server's tools it may call.
        assert_eq!(buyer["tools"]["enabled"], json!(["bookings"]));
        assert_eq!(
            buyer["mcp"]["servers"]["bookings"]["url"],
            "https://bookings.example.com/mcp"
        );
    }

    // Applied state matches the configuration.
    let started = Instant::now();
    let plan = tofu(&["plan", "-detailed-exitcode", "-input=false"]);
    eprintln!("tofu plan (no changes) took {:.2?}", started.elapsed());
    assert_eq!(
        plan.status.code(),
        Some(0),
        "{}\n{}",
        String::from_utf8_lossy(&plan.stdout),
        String::from_utf8_lossy(&plan.stderr)
    );

    // Changing the hosted model changes the scheduler's and buyer's agents,
    // which replaces their sandboxes and leaves the researchers alone.
    let before = sandbox_ids(&gateway);
    let frontier = json!({
        "endpoint": "https://integrate.api.nvidia.com/v1",
        "model": "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        "credential_env": "NVIDIA_API_KEY",
    });
    let frontier = format!("-var=frontier={frontier}");
    run(&["apply", "-auto-approve", "-input=false", &frontier], true);
    let after = sandbox_ids(&gateway);
    for role in &roles {
        let replaced = matches!(*role, "scheduler" | "buyer");
        assert_eq!(
            before[*role] != after[*role],
            replaced,
            "{role}: {before:?} -> {after:?}"
        );
    }

    // Teardown: deleting the sandboxes needs the providers' destroy = true;
    // with it, tofu destroy removes everything, the workspace included.
    run(
        &["destroy", "-auto-approve", "-input=false", &frontier],
        false,
    );
    run(
        &[
            "destroy",
            "-auto-approve",
            "-input=false",
            &frontier,
            "-var=destroy=true",
        ],
        true,
    );
    let state = gateway.state.lock().unwrap();
    assert!(state.sandboxes.is_empty());
    assert!(state.providers.is_empty());
    assert!(state.profiles.is_empty());
    assert!(state.workspaces.is_empty());
}
