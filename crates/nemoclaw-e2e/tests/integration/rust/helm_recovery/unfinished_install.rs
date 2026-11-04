// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Destroy after an apply that failed or stopped while Helm installed the
//! gateway release.
//!
//! When an install fails after Helm recorded the release, the pinned Helm
//! provider returns the error without the release's state: storage and
//! authentication are bound, and the release is only a record in the cluster.
//! Authentication's removal waits for that record to go, so destroy removes the
//! release itself, but only when the deployment's install record names it.

use super::*;

/// The fixture's runtime apply failed while Helm installed the release, after
/// the SDK recorded the install.
async fn failed_install() -> Fixture {
    let fixture = Fixture::prepare().await;
    fixture
        .api
        .objects
        .insert(release_record(&fixture.name, &fixture.namespace, "failed"));
    fixture
        .deployment
        .scenario_record_helm_install()
        .expect("the scenario records the install");
    fixture
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn destroy_removes_the_release_that_a_failed_install_left() {
    let fixture = failed_install().await;
    let before = fixture.snapshot();
    let preview = fixture
        .deployment
        .plan_destroy(&CancellationToken::new())
        .await
        .expect("the preview plans the release's removal");
    let removal = preview
        .changes
        .iter()
        .find(|change| change.resource == "helm_release.gateway")
        .expect("the preview shows the release's removal");
    assert_eq!(removal.actions, ["delete"]);
    assert!(removal.reason.is_some(), "the preview says why");
    before.assert_unchanged(&fixture, "preview");
    // Destroy removes the release and then everything but storage, and leaves
    // the other owners' objects, including a release in the same namespace.
    fixture.finish().await;
    assert!(
        !fixture.stage().join("helm-install.json").exists(),
        "a finished destroy forgets the install"
    );
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn destroy_leaves_an_unbound_release_that_no_install_record_names() {
    let fixture = Fixture::prepare().await;
    let before = fixture.snapshot();
    for preview in [true, false] {
        let context = if preview { "preview" } else { "destroy" };
        let cancel = CancellationToken::new();
        let result = if preview {
            fixture.deployment.plan_destroy(&cancel).await
        } else {
            fixture.deployment.destroy(&cancel).await
        };
        match result {
            Err(Error::UnclaimedRelease { release, namespace }) => {
                assert_eq!(release, fixture.name, "{context}");
                assert_eq!(namespace, fixture.namespace, "{context}");
            }
            Err(other) => panic!("{context}: expected the unclaimed release, got: {other}"),
            Ok(_) => panic!("{context}: expected the unclaimed release, not success"),
        }
        before.assert_unchanged(&fixture, context);
    }
}
