// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Runner {
    calls: AtomicUsize,
    fail: Option<PreparationAction>,
}
#[async_trait::async_trait]
impl PreparationRunner for Runner {
    async fn run(
        &self,
        action: PreparationAction,
        _model: &Path,
        directory: &Path,
        _cancel: &CancellationToken,
    ) -> Result<Vec<u8>, Error> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        fs::write(directory.join("retained.tmp"), b"progress").unwrap();
        if self.fail == Some(action) {
            return Err(Error::Conflict("fixture interruption"));
        }
        if action == PreparationAction::Prepare {
            assert!(
                !directory.join(PREPARED_FILE).exists(),
                "unpublished orphan must not make preparer skip work"
            );
            fs::write(directory.join(PREPARED_FILE), b"packed").unwrap();
            fs::write(
                directory.join(format!("{PREPARED_FILE}.json")),
                br#"{"verified":"fixture"}"#,
            )
            .unwrap();
            return Ok(Vec::new());
        }
        Ok(serde_json::to_vec(&crate::snapshot::File {
            name: PREPARED_FILE.into(),
            size: 6,
            sha256: hex(Sha256::digest(b"packed")),
        })
        .unwrap())
    }
}
#[tokio::test]
async fn preparation_recovers_interrupted_publication_and_skips_verified_data() {
    let root = tempfile::tempdir().unwrap();
    let staging = root.path().join(format!("{}.preparing", preparation_key()));
    fs::create_dir(&staging).unwrap();
    fs::write(staging.join(PREPARED_FILE), b"incomplete").unwrap();
    let runner = Runner {
        calls: AtomicUsize::new(0),
        fail: None,
    };
    let cancel = CancellationToken::new();
    let prepared = prepare(root.path(), Path::new("model"), &runner, &cancel)
        .await
        .unwrap();
    assert_eq!(
        observe_preparation(&root.path().join(preparation_key())).unwrap(),
        prepared
    );
    assert_eq!(
        prepare(root.path(), Path::new("model"), &runner, &cancel)
            .await
            .unwrap(),
        prepared
    );
    assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
    fs::write(
        root.path().join(preparation_key()).join(PREPARED_FILE),
        b"changed",
    )
    .unwrap();
    assert!(
        prepare(root.path(), Path::new("model"), &runner, &cancel)
            .await
            .is_err()
    );
    assert_eq!(runner.calls.load(Ordering::SeqCst), 2);
}
#[tokio::test]
async fn failed_preparation_or_verification_preserves_staging_without_publication() {
    for action in [PreparationAction::Prepare, PreparationAction::Verify] {
        let root = tempfile::tempdir().unwrap();
        let runner = Runner {
            calls: AtomicUsize::new(0),
            fail: Some(action),
        };
        assert!(
            prepare(
                root.path(),
                Path::new("model"),
                &runner,
                &CancellationToken::new()
            )
            .await
            .is_err()
        );
        assert!(!root.path().join(preparation_key()).exists());
        assert_eq!(
            fs::read(
                root.path()
                    .join(format!("{}.preparing", preparation_key()))
                    .join("retained.tmp")
            )
            .unwrap(),
            b"progress"
        );
    }
}
#[tokio::test]
async fn established_directory_without_receipt_is_retained_for_inspection() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join(preparation_key());
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join(PREPARED_FILE), b"retain").unwrap();
    let runner = Runner {
        calls: AtomicUsize::new(0),
        fail: None,
    };
    assert!(
        prepare(
            root.path(),
            Path::new("model"),
            &runner,
            &CancellationToken::new()
        )
        .await
        .is_err()
    );
    assert_eq!(fs::read(directory.join(PREPARED_FILE)).unwrap(), b"retain");
    assert_eq!(runner.calls.load(Ordering::SeqCst), 0);
}
