// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The travel example in examples/hcl/travel, applied unchanged as plain HCL
//! against the bundle's providers, with fakes for the Docker engine, the
//! OpenShell gateway, the model server, and the Pi image.
use nemoclaw_e2e::{http_fixture::Fixture as Http, openshell::Fixture};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output},
};

const EXAMPLE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../examples/hcl/travel");
const MODEL: &str = "nemotron-mini:4b";

/// An engine that holds the Pi image and reports its Fabric catalog.
async fn pi_image_engine(image: String) -> Http {
    use nemoclaw_sdk::fabric_catalog::IMAGE_CATALOG_LABEL;
    let label = serde_json::to_string(&nemoclaw_e2e::image_runtime::catalog()).unwrap();
    Http::engine(move |request| {
        let value = if request.path == "/info" {
            json!({"ID":"fixture", "Architecture":"arm64", "ServerVersion":"28.0", "OSType":"linux"})
        } else {
            json!({"Id":"sha256:pi", "Architecture":"arm64", "Os":"linux", "RepoDigests":[image], "Config":{"Labels":{IMAGE_CATALOG_LABEL:label}}})
        };
        Some((200, serde_json::to_vec(&value).unwrap()))
    })
    .await
}

fn save(root: &Path, name: &str, value: &Value) {
    fs::write(root.join(name), value.to_string()).unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_BUNDLE; isolated fixtures"]
async fn travel_example_applies_as_plain_hcl_against_the_shipped_providers() {
    let bundle = PathBuf::from(std::env::var("NEMOCLAW_TEST_BUNDLE").expect("explicit bundle"));
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    let ollama_image = format!("ollama-runtime@sha256:{}", "a".repeat(64));
    let pi_image = format!("pi@sha256:{}", "b".repeat(64));

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
        // The example's container joins Docker's default network.
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
    let pi_engine = pi_image_engine(pi_image.clone()).await;

    // Users install the bundle's providers as a filesystem mirror and init.
    let work = root.join("travel");
    fs::create_dir(&work).unwrap();
    fs::copy(
        Path::new(EXAMPLE).join("instructions.md"),
        work.join("instructions.md"),
    )
    .unwrap();
    // A development bundle's providers are pre-releases, which OpenTofu
    // selects only when pinned exactly, as the example tells readers to do.
    let version = nemoclaw_sdk::bundle::Bundle::open(&bundle)
        .unwrap()
        .manifest
        .version;
    let mut example = fs::read_to_string(Path::new(EXAMPLE).join("main.tf")).unwrap();
    for provider in ["ollama", "openshell", "fabric"] {
        let source = format!("source = \"registry.opentofu.org/nvidia/{provider}\"");
        assert!(example.contains(&source), "{provider}");
        example = example.replace(&source, &format!("{source}, version = \"{version}\""));
    }
    fs::write(work.join("main.tf"), example).unwrap();
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
            "ollama_image": ollama_image,
            "pi_image": pi_image,
            "pi_image_engine": pi_engine.endpoint,
            "model": {"name": MODEL, "digest": "c".repeat(64)},
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
            .output()
            .unwrap()
    };
    let run = |args: &[&str], success: bool| {
        let output = tofu(args);
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
    let ready = run(&["output", "-json", "ready"], true);
    assert_eq!(
        serde_json::from_slice::<Value>(&ready.stdout).unwrap(),
        true
    );

    {
        let state = gateway.state.lock().unwrap();
        assert_eq!(state.providers.len(), 1);
        assert_eq!(state.profiles.len(), 1);
        assert_eq!(state.sandboxes.len(), 1);
        let configuration = state
            .fabric_configurations
            .values()
            .next()
            .expect("the agent is configured");
        assert_eq!(configuration["metadata"]["name"], "travel");
        assert_eq!(configuration["models"]["default"]["model"], MODEL);
        assert!(
            configuration["instructions"]["system"]["content"]
                .as_str()
                .unwrap()
                .starts_with("You research travel options")
        );
    }
    let engine: Value =
        serde_json::from_slice(&fs::read(root.join("engine.json")).unwrap()).unwrap();
    assert_eq!(engine["creates"], 1, "{engine}");

    // Applied state matches the configuration.
    let plan = tofu(&["plan", "-detailed-exitcode", "-input=false"]);
    assert_eq!(
        plan.status.code(),
        Some(0),
        "{}\n{}",
        String::from_utf8_lossy(&plan.stdout),
        String::from_utf8_lossy(&plan.stderr)
    );
    // Teardown: deleting the sandbox needs the provider's destroy = true;
    // with it, tofu destroy removes everything, the workspace included.
    run(&["destroy", "-auto-approve", "-input=false"], false);
    assert_eq!(gateway.state.lock().unwrap().sandboxes.len(), 1);
    run(
        &[
            "destroy",
            "-auto-approve",
            "-input=false",
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
