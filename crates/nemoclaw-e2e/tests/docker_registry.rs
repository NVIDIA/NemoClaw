// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A deployment that lists a registry pulls its images with a login in the
//! Docker configuration file of the machine running OpenTofu, and keeps the
//! credentials out of state.
use crate::registry_fixture::{HTPASSWD, PASSWORD, REGISTRY, USER, docker, private_file};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use nemoclaw_test_fixtures::Bundle;
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Stdio},
    time::Duration,
};

/// The registry container, the pushed tag, and the pulled image, removed
/// however the test ends.
struct Owned {
    container: String,
    images: Vec<String>,
}
impl Drop for Owned {
    fn drop(&mut self) {
        let quiet = |args: &[&str]| {
            let _ = Command::new("docker")
                .args(args)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        };
        for image in &self.images {
            quiet(&["image", "rm", "--force", image]);
        }
        // The registry image declares an anonymous volume for its storage.
        quiet(&["rm", "--force", "--volumes", &self.container]);
    }
}

fn nonce() -> String {
    let mut bytes = [0; 8];
    getrandom::fill(&mut bytes).unwrap();
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Log in to `authority` with a Docker configuration under `home`, as a user
/// would with `docker login`.
fn login(home: &Path, authority: &str) {
    let config = home.join(".docker");
    let mut child = Command::new("docker")
        .arg("--config")
        .arg(&config)
        .args(["login", authority, "--username", USER, "--password-stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(PASSWORD.as_bytes())
        .unwrap();
    assert!(child.wait().unwrap().success(), "fixture login failed");
}

/// A workspace whose OpenTofu installs the bundle's Docker provider.
fn workspace(bundle: &Bundle, graph: &Value) -> tempfile::TempDir {
    let directory = tempfile::tempdir().unwrap();
    let mirror = bundle.root().join("providers");
    fs::write(
        directory.path().join("tofu.rc"),
        format!(
            "provider_installation {{ filesystem_mirror {{ path = {} include = [\"registry.opentofu.org/kreuzwerker/docker\"] }} direct {{ exclude = [\"registry.opentofu.org/kreuzwerker/docker\"] }} }}",
            serde_json::to_string(&mirror).unwrap()
        ),
    )
    .unwrap();
    fs::write(
        directory.path().join("main.tf.json"),
        serde_json::to_vec_pretty(graph).unwrap(),
    )
    .unwrap();
    directory
}

/// Run OpenTofu with the bundle's Docker provider.
fn tofu(bundle: &Bundle, directory: &Path, args: &[&str]) -> (bool, String) {
    let output = Command::new(bundle.tofu())
        .args(args)
        .current_dir(directory)
        .env("TF_CLI_CONFIG_FILE", directory.join("tofu.rc"))
        .env("TF_IN_AUTOMATION", "1")
        .env("CHECKPOINT_DISABLE", "1")
        .stdin(Stdio::null())
        .output()
        .unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    (output.status.success(), text)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a local Docker engine and NEMOCLAW_TEST_BUNDLE; run through cargo ci live-docker"]
async fn a_listed_registry_pulls_with_the_hosts_login_without_credentials_in_state() {
    let bundle = Bundle::from_env();
    let run = nonce();
    let auth_dir = tempfile::tempdir().unwrap();
    let auth = auth_dir.path().join("htpasswd");
    private_file(&auth, HTPASSWD.as_bytes());
    let container = format!("nc-registry-{run}");
    let mut owned = Owned {
        container: container.clone(),
        images: Vec::new(),
    };
    let mount = format!(
        "type=bind,source={},target=/auth/htpasswd,readonly",
        auth.display()
    );
    docker(
        "start registry",
        &[
            "run",
            "--detach",
            "--name",
            &container,
            "--publish",
            "127.0.0.1::5000",
            "--env",
            "REGISTRY_AUTH=htpasswd",
            "--env",
            "REGISTRY_AUTH_HTPASSWD_REALM=nemoclaw-fixture",
            "--env",
            "REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd",
            "--mount",
            &mount,
            REGISTRY,
        ],
        false,
    )
    .await;
    let published =
        String::from_utf8(docker("inspect port", &["port", &container, "5000/tcp"], true).await)
            .unwrap();
    let authority = published
        .lines()
        .find(|line| line.starts_with("127.0.0.1:"))
        .expect("the registry publishes on loopback")
        .trim()
        .to_owned();

    // The registry is up once it answers, and refuses anonymous requests.
    let client = reqwest::Client::new();
    let mut status = None;
    for _ in 0..50 {
        if let Ok(response) = client.get(format!("http://{authority}/v2/")).send().await {
            status = Some(response.status().as_u16());
            break;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    assert_eq!(status, Some(401), "the registry must require a login");

    // Push an image with the fixture's login, then remove the local tag so
    // OpenTofu has to pull it.
    let home = tempfile::tempdir().unwrap();
    login(home.path(), &authority);
    let config = home.path().join(".docker");
    let config = config.to_str().unwrap();
    let image = format!("{authority}/nemoclaw/private:{run}");
    owned.images.push(image.clone());
    docker("tag fixture image", &["tag", REGISTRY, &image], false).await;
    docker(
        "push fixture image",
        &["--config", config, "push", &image],
        false,
    )
    .await;
    docker("remove local tag", &["image", "rm", &image], false).await;

    // The Docker provider block NemoClaw generates for a configuration that
    // lists the registry.
    let mut document: Value =
        serde_saphyr::from_str(include_str!("../../../examples/managed-ollama.yaml")).unwrap();
    let config_file = home.path().join(".docker").join("config.json");
    let config_file = config_file.to_str().unwrap();
    document["spec"]["registries"] = json!([{ "address": authority, "configFile": config_file }]);
    let document = nemoclaw_sdk::config::Document::parse(document.to_string().as_bytes()).unwrap();
    let generations: nemoclaw_sdk::compile::Generations = [
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
        "inference_service",
        "ollama_service",
    ]
    .map(|key| (key.into(), "a".repeat(32)))
    .into();
    let compiled = nemoclaw_sdk::compile::compile(&document, &generations, "0.1.0").unwrap();
    let mut provider = compiled["provider"]["docker"][0].clone();
    assert_eq!(
        provider["registry_auth"],
        json!([{ "address": authority, "config_file": config_file }])
    );
    provider["host"] = json!("unix:///var/run/docker.sock");
    let graph = |provider: &Value| {
        json!({
            "terraform": { "required_providers": { "docker": compiled["terraform"]["required_providers"]["docker"] } },
            "provider": { "docker": [provider] },
            "resource": { "docker_image": { "private": {
                "name": image,
                "keep_locally": false,
                "provider": format!("docker.{}", provider["alias"].as_str().unwrap()),
            } } },
        })
    };

    // Without the registry listed, the pull is refused.
    let mut anonymous = provider.clone();
    anonymous.as_object_mut().unwrap().remove("registry_auth");
    let refused = workspace(&bundle, &graph(&anonymous));
    let (ok, output) = tofu(
        &bundle,
        refused.path(),
        &["init", "-input=false", "-no-color"],
    );
    assert!(ok, "init failed: {output}");
    let (ok, output) = tofu(
        &bundle,
        refused.path(),
        &["apply", "-input=false", "-no-color", "-auto-approve"],
    );
    assert!(!ok, "an anonymous pull must be refused");
    assert!(!output.contains(PASSWORD));

    // With it listed, the provider uses the host's login.
    let listed = workspace(&bundle, &graph(&provider));
    let (ok, output) = tofu(
        &bundle,
        listed.path(),
        &["init", "-input=false", "-no-color"],
    );
    assert!(ok, "init failed: {output}");
    let (ok, output) = tofu(
        &bundle,
        listed.path(),
        &["apply", "-input=false", "-no-color", "-auto-approve"],
    );
    assert!(ok, "the listed registry's image must pull: {output}");
    let state = fs::read_to_string(listed.path().join("terraform.tfstate")).unwrap();
    let encoded = STANDARD.encode(format!("{USER}:{PASSWORD}"));
    assert!(state.contains(&image), "the image is in state");
    for secret in [PASSWORD, encoded.as_str()] {
        assert!(
            !state.contains(secret),
            "state must not hold the registry credentials"
        );
        assert!(
            !output.contains(secret),
            "output must not show the registry credentials"
        );
    }
    let (ok, output) = tofu(
        &bundle,
        listed.path(),
        &["destroy", "-input=false", "-no-color", "-auto-approve"],
    );
    assert!(ok, "destroy failed: {output}");
    drop(owned);
}
