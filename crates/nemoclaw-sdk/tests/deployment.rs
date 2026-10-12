// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::{
    CancellationToken, Deployment, Error, ObservationError, Progress, Secrets,
    bundle::{Bundle, Manifest, hash_file, required_files},
    compile::OPENTOFU_VERSION,
    config::Document,
};
use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

#[tokio::test]
async fn invalid_programmatic_configuration_cannot_create_deployment_state() {
    let directory = tempfile::tempdir().unwrap();
    let state = directory.path().join("state");
    let deployment = Deployment::new(&state, &directory.path().join("missing-bundle"));
    let document = Document::default();
    assert!(
        deployment
            .plan(&document, &CancellationToken::new())
            .await
            .is_err()
    );
    assert!(!state.exists());
}

/// A bundle whose hashes verify, so opening it succeeds. Its files cannot
/// execute, so no operation that reaches OpenTofu can do anything.
fn write_bundle(directory: &Path) {
    let mut manifest = Manifest {
        version: "0.1.0".into(),
        rust: "1.98.1".into(),
        opentofu: OPENTOFU_VERSION.into(),
        files: Default::default(),
    };
    for name in required_files(&manifest.version).unwrap() {
        let path = directory.join(&name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"non-executable fixture").unwrap();
        manifest.files.insert(name, hash_file(&path).unwrap());
    }
    fs::write(
        directory.join("manifest.json"),
        serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
}

#[derive(Default)]
struct CountingSecrets(AtomicUsize);
impl Secrets for CountingSecrets {
    fn resolve(&self, _: &str) -> Result<String, ObservationError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Err(ObservationError::Authentication)
    }
}

#[tokio::test]
async fn a_document_that_fails_validation_is_rejected_before_the_bundle_opens_or_state_is_created()
{
    let directory = tempfile::tempdir().unwrap();
    let bundle = directory.path().join("bundle");
    write_bundle(&bundle);
    assert!(Bundle::open(&bundle).is_ok(), "the bundle must be valid");
    let document = Document::default();
    let mut defaulted = document.clone();
    defaulted.defaults();
    let rejection = defaulted
        .validate()
        .expect_err("the document must fail validation");
    let state = directory.path().join("state");
    for apply in [false, true] {
        let events = Arc::new(Mutex::new(Vec::<Progress>::new()));
        let secrets = Arc::new(CountingSecrets::default());
        let deployment = Deployment::new(&state, &bundle)
            .with_secrets(secrets.clone())
            .with_progress({
                let events = events.clone();
                Arc::new(move |event| events.lock().unwrap().push(event))
            });
        let cancel = CancellationToken::new();

        let result = if apply {
            deployment.apply(&document, &cancel).await
        } else {
            deployment.plan(&document, &cancel).await
        };

        let operation = if apply { "apply" } else { "plan" };
        match result {
            Err(Error::Configuration(error)) => assert_eq!(error, rejection, "{operation}"),
            other => panic!("{operation} must fail validation, got {other:?}"),
        }
        assert_eq!(
            *events.lock().unwrap(),
            [],
            "{operation} reported progress before validation"
        );
        assert_eq!(
            secrets.0.load(Ordering::SeqCst),
            0,
            "{operation} resolved a credential before validation"
        );
        assert!(
            !state.exists(),
            "{operation} created state before validation: {:?}",
            fs::read_dir(&state).map(|entries| entries.count())
        );
    }
}
