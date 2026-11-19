// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A deployment created with an unsigned bundle meets a signed one: signing
//! changes the providers' bytes but not their versions (#14621).

use nemoclaw_e2e::openshell::Fixture;
use nemoclaw_sdk::{
    CancellationToken, Deployment,
    bundle::{self, Bundle, Manifest},
    config::Document,
};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

fn copy(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// A copy of `unsigned` whose providers carry a signature, resealed as
/// Release / Stage reseals a signed bundle.
fn sign(unsigned: &Path, signed: &Path) {
    copy(unsigned, signed);
    let path = signed.join("manifest.json");
    let mut manifest: Manifest = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for (name, digest) in &mut manifest.files {
        if name.starts_with("providers/") {
            let provider = signed.join(name);
            fs::OpenOptions::new()
                .append(true)
                .open(&provider)
                .unwrap()
                .write_all(b"signature")
                .unwrap();
            *digest = bundle::hash_file(&provider).unwrap();
        }
    }
    fs::write(&path, serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
    Bundle::open(signed).unwrap();
}

/// The files under `directory`, by path relative to it, following links.
fn files(directory: &Path, prefix: &Path, found: &mut Vec<PathBuf>) {
    for entry in fs::read_dir(directory).unwrap() {
        let path = entry.unwrap().path();
        let relative = prefix.join(path.file_name().unwrap());
        if fs::metadata(&path).unwrap().is_dir() {
            files(&path, &relative, found);
        } else {
            found.push(relative);
        }
    }
}

/// Applies with the unsigned bundle, then with the signed one, keeping or
/// deleting the unsigned bundle in between, and checks that OpenTofu runs the
/// signed providers.
async fn upgrade(keep_unsigned: bool) {
    let directory = tempfile::tempdir().unwrap();
    let unsigned = directory.path().join("unsigned");
    copy(
        &PathBuf::from(std::env::var_os("NEMOCLAW_TEST_BUNDLE").unwrap()),
        &unsigned,
    );
    let signed = directory.path().join("signed");
    sign(&unsigned, &signed);
    let state = directory.path().join("state");
    let fixture = Fixture::start().await;
    let mut document = Document::parse(
        include_str!("../../../../nemoclaw-sdk/tests/fixtures/config/local.yaml").as_bytes(),
    )
    .unwrap();
    nemoclaw_e2e::point_gateway_at(&mut document, &fixture.endpoint);
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let cancel = CancellationToken::new();
    Deployment::new(&state, &unsigned)
        .apply(&document, &cancel)
        .await
        .unwrap();
    if !keep_unsigned {
        fs::remove_dir_all(&unsigned).unwrap();
    }

    Deployment::new(&state, &signed)
        .apply(&document, &cancel)
        .await
        .unwrap();

    // OpenTofu runs the providers it installed for the deployment, at the
    // bundle's paths under .terraform/providers.
    let installed = state.join(".terraform/providers");
    let mut providers = Vec::new();
    files(&signed.join("providers"), Path::new(""), &mut providers);
    providers.retain(|provider| installed.join(provider).exists());
    assert!(!providers.is_empty(), "OpenTofu installed no providers");
    for provider in providers {
        assert!(
            fs::read(installed.join(&provider)).unwrap()
                == fs::read(signed.join("providers").join(&provider)).unwrap(),
            "{} isn't the signed bundle's",
            provider.display()
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn a_deployment_from_an_unsigned_bundle_runs_the_signed_providers_while_the_unsigned_bundle_remains()
 {
    upgrade(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn a_deployment_from_an_unsigned_bundle_applies_with_the_signed_providers_once_the_unsigned_bundle_is_gone()
 {
    upgrade(false).await;
}
