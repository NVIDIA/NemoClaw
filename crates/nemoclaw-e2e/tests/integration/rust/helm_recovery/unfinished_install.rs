// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Destroy after an apply that stopped at once while Helm installed the
//! gateway release.
//!
//! The atomic install removes a release whose install fails or times out. A
//! hard stop, such as a second interrupt or a killed process, ends the Helm
//! provider before it returns, so the release stays `pending-install` and the
//! state does not bind it: storage and authentication are bound, and the
//! release is only a record in the cluster. Authentication's removal waits for
//! that record to go, and NemoClaw can't tell it from another owner's release,
//! so destroy names it and leaves it.

use super::*;

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn destroy_names_and_leaves_a_release_that_a_stopped_install_left() {
    let fixture = Fixture::prepare().await;
    fixture.api.objects.insert(release_record(
        &fixture.name,
        &fixture.namespace,
        "pending-install",
    ));
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
            Err(Error::UnboundRelease { release, namespace }) => {
                assert_eq!(release, fixture.name, "{context}");
                assert_eq!(namespace, fixture.namespace, "{context}");
            }
            Err(other) => panic!("{context}: expected the unbound release, got: {other}"),
            Ok(_) => panic!("{context}: expected the unbound release, not success"),
        }
        before.assert_unchanged(&fixture, context);
    }
}
