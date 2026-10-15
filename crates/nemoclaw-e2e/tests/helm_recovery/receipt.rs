// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Destroy when the receipt of the Kubernetes objects is missing or corrupt.
//!
//! The receipt records, by UID, every object the deployment created. A missing
//! or corrupt receipt is not confirmed absence of those objects, so destroy
//! must stop before it changes anything and keep every binding. The test
//! deletes the receipt, then truncates it, and restores the bytes after each;
//! it does not read the receipt's fields.

use super::*;

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn a_deleted_or_truncated_receipt_stops_destroy_while_planning_and_a_restored_receipt_lets_it_finish()
 {
    let fixture = Fixture::create().await;
    let receipt = fs::read(fixture.receipt()).unwrap();
    // A missing receipt must not read as absent objects, and an unreadable one
    // must not read as an empty record, whatever the receipt's format.
    let damage = [
        ("deleted", None),
        ("truncated", Some(&receipt[..receipt.len() / 2])),
    ];
    for (name, bytes) in damage {
        match bytes {
            None => fs::remove_file(fixture.receipt()).unwrap(),
            Some(bytes) => fs::write(fixture.receipt(), bytes).unwrap(),
        }
        let damaged = fixture.snapshot();

        // The Kubernetes provider reads its bound storage as incomplete, never
        // as absent. A regression that reads it as absent lets destroy continue
        // with no verified identity for the namespace, the key, or the issuer.
        let error = fixture
            .deployment
            .destroy(&CancellationToken::new())
            .await
            .expect_err(&format!("destroy over a {name} receipt must fail"));
        assert_execution(&error, "plan", &["observation is incomplete"]);
        let error = fixture
            .deployment
            .plan_destroy(&CancellationToken::new())
            .await
            .expect_err(&format!("the preview over a {name} receipt must fail"));
        assert_execution(&error, "plan", &["observation is incomplete"]);

        // Nothing changed: not the state, a binding, an object, a write, or the
        // damaged receipt itself, which must not be recreated or repaired.
        damaged.assert_unchanged(&fixture, name);
        damaged.assert_state_unchanged(&fixture, name);
        // The failed plan did not start the destroy.
        fixture
            .assert_export_refused("export requires all declared resource bindings")
            .await;
        fs::write(fixture.receipt(), &receipt).unwrap();
    }
    // With the receipt back, the same destroy plans, deletes the release and
    // the issuer, and retains storage.
    fixture.finish().await;
}
