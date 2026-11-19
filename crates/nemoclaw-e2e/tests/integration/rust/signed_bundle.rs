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

/// `tofu init -upgrade` keeps a provider version already installed from the
/// previous bundle's directory, so the deployment goes on running the unsigned
/// providers while that bundle exists. Once it's gone, OpenTofu refuses the
/// signed providers: their hashes differ from those the dependency lock file
/// recorded for the same versions. This records that open problem (#14628); when the SDK
/// handles it, this test should show the signed bundle applying on its own.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE"]
async fn a_deployment_from_an_unsigned_bundle_fails_on_the_lock_file_once_only_the_signed_bundle_remains()
 {
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
    *document.spec.gateway.endpoint_mut() = fixture.endpoint.clone();
    let _image_engine = nemoclaw_e2e::image_runtime::engine(&mut document).await;
    let cancel = CancellationToken::new();
    Deployment::new(&state, &unsigned)
        .apply(&document, &cancel)
        .await
        .unwrap();
    let lock = fs::read_to_string(state.join(".terraform.lock.hcl")).unwrap();

    let upgraded = Deployment::new(&state, &signed)
        .apply(&document, &cancel)
        .await;
    assert!(
        upgraded.is_ok(),
        "the upgrade applies while the unsigned bundle exists: {upgraded:?}"
    );
    assert_eq!(
        fs::read_to_string(state.join(".terraform.lock.hcl")).unwrap(),
        lock,
        "the lock file keeps the unsigned providers' hashes"
    );

    fs::remove_dir_all(&unsigned).unwrap();
    let error = Deployment::new(&state, &signed)
        .apply(&document, &cancel)
        .await
        .unwrap_err()
        .to_string();
    // OpenTofu wraps its diagnostics.
    let error = error.split_whitespace().collect::<Vec<_>>().join(" ");
    assert!(
        error.contains(
            "doesn't match any of the checksums previously recorded in the dependency lock file"
        ),
        "OpenTofu refuses the signed providers: {error}"
    );
}
