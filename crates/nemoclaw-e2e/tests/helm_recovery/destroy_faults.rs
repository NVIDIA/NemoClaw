// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Destroy that meets an authentication failure or is cancelled.
//!
//! The pinned Helm provider treats a release lookup that the API server rejects
//! as an absent release: it drops the binding and sends no delete. A 401 must
//! therefore stop the operation through the Kubernetes provider's own
//! observations, with every binding and the issuer's objects kept.

use super::*;
use std::time::{Duration, Instant};

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn an_authentication_failure_before_planning_stops_destroy_and_changes_nothing() {
    let fixture = Fixture::create().await;
    let before = fixture.snapshot();
    *fixture.api.fault.lock().unwrap() = Fault::Unauthorized;

    // The Kubernetes provider reads a 401 as an authentication failure, never
    // as an absent object, and the refresh stops the plan.
    let error = fixture
        .deployment
        .destroy(&CancellationToken::new())
        .await
        .expect_err("destroy must stop on the 401");
    assert_execution(&error, "plan", &["observation authentication failed"]);
    let error = fixture
        .deployment
        .plan_destroy(&CancellationToken::new())
        .await
        .expect_err("the preview must stop on the 401");
    assert_execution(&error, "plan", &["observation authentication failed"]);

    assert!(
        fixture.api.failures.load(Ordering::Relaxed) > 0,
        "the fault did not reach the providers"
    );
    // The fault rejects every request, so only the request log shows that
    // nothing tried to write.
    before.assert_unchanged(&fixture, "401 before planning");
    before.assert_state_unchanged(&fixture, "401 before planning");
    fixture
        .assert_export_refused("export requires all declared resource bindings")
        .await;
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn an_authentication_failure_after_the_saved_plan_restores_the_release_binding_and_a_retry_finishes()
 {
    let fixture = Fixture::create().await;
    let before = fixture.snapshot();

    // Once destroy applies its saved plan, the API rejects every request. The
    // Helm provider reads the rejected lookup as a deleted release and drops
    // its binding without uninstalling anything; then authentication's removal
    // fails with the 401.
    let error = fixture
        .failing_after_plan(Fault::Unauthorized)
        .destroy(&CancellationToken::new())
        .await
        .expect_err("destroy must stop on the 401");

    assert!(
        fixture.api.failures.load(Ordering::Relaxed) > 0,
        "the fault did not reach the providers after planning"
    );
    // This diagnostic comes from authentication's removal, which runs only after
    // the Helm provider reported its delete as done. It therefore also shows
    // that the binding was lost and needs the restore, and it ties the test to
    // the pinned Helm provider's handling of a 401.
    assert_execution(
        &error,
        "apply",
        &["Destroy incomplete", "observation authentication failed"],
    );
    // A regression that does not restore the dropped binding fails the bindings
    // comparison. Neither the recovery checkpoint nor a write remains.
    before.assert_unchanged(&fixture, "401 after the saved plan");
    fixture
        .assert_export_refused("cannot export while destroy is unfinished")
        .await;
    fixture.finish().await;
    assert!(
        recovery_files(&fixture.stage(), &before.files).is_empty(),
        "destroy removes its recovery checkpoint"
    );
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn an_authentication_failure_reading_the_issuer_after_the_release_is_uninstalled_keeps_the_issuer_and_a_retry_finishes()
 {
    let fixture = Fixture::create().await;
    let before = fixture.snapshot();

    // Only ConfigMap reads are rejected, and only after destroy saved its plan.
    // Helm uninstalls the release, and the cluster would accept deletes of the
    // issuer's objects, so only the Kubernetes provider's own check keeps them:
    // it must verify the issuer's ConfigMaps before it deletes anything.
    let error = fixture
        .failing_after_plan(Fault::ConfigMapsUnauthorized)
        .destroy(&CancellationToken::new())
        .await
        .expect_err("destroy must stop on the 401");

    assert_execution(
        &error,
        "apply",
        &["Destroy incomplete", "observation authentication failed"],
    );
    let writes = fixture.api.writes();
    let issued = &writes[before.writes.len()..];
    assert!(
        issued
            .iter()
            .all(|(_, path)| path.contains("sh.helm.release.")),
        "only the release record may change: {issued:?}"
    );
    let mut remaining = before.objects.clone();
    remaining.retain(|path, _| !path.contains("sh.helm.release."));
    assert!(
        fixture.objects() == remaining,
        "the uninstall changed more than the release record"
    );
    // The retry removes the issuer only while authentication stays bound, and
    // destroy retains storage. What becomes of the uninstalled release's
    // binding is the Helm recovery's concern, not this test's.
    let bindings = fixture.bindings();
    for address in [
        "openshell_kubernetes_auth.runtime",
        "openshell_kubernetes_storage.runtime",
    ] {
        assert_eq!(
            bindings.get(address),
            before.bindings.get(address),
            "{address} changed"
        );
    }
    fixture
        .assert_export_refused("cannot export while destroy is unfinished")
        .await;
    // The release is gone, so the retry removes the issuer.
    fixture.finish().await;
}

#[tokio::test]
#[ignore = "requires a verified NEMOCLAW_TEST_BUNDLE; isolated Kubernetes API fixture"]
async fn cancelling_at_the_first_refresh_returns_promptly_while_the_api_is_unreachable_and_changes_nothing()
 {
    let fixture = Fixture::create().await;
    for fault in [Fault::Healthy, Fault::Offline] {
        let before = fixture.snapshot();
        *fixture.api.fault.lock().unwrap() = fault;
        let cancel = CancellationToken::new();
        let cancelled_at = Arc::new(Mutex::new(None));
        let deployment = fixture.deployment().with_progress({
            let (stop, cancelled_at) = (cancel.clone(), cancelled_at.clone());
            Arc::new(move |progress| {
                if matches!(
                    progress,
                    Progress::Resource {
                        action: "refresh",
                        status: "started",
                        ..
                    }
                ) {
                    cancelled_at
                        .lock()
                        .unwrap()
                        .get_or_insert_with(Instant::now);
                    stop.cancel();
                }
            })
        });

        let result = deployment.destroy(&cancel).await;

        let waited = cancelled_at
            .lock()
            .unwrap()
            .expect("OpenTofu never reported a refresh to cancel")
            .elapsed();
        assert!(
            matches!(result, Err(Error::Cancelled)),
            "{fault:?}: expected a cancelled destroy, got {result:?}"
        );
        if fault == Fault::Offline {
            // An unreachable API keeps the refresh waiting for about ten seconds
            // (measured on macOS arm64) before it fails by itself. OpenTofu that
            // answers the interrupt returns at once, and one that does not is
            // killed after the SDK's five seconds, which a loaded host can
            // reach. Only a cancellation that the SDK ignores returns when the
            // refresh fails by itself. If that timeout fell below the bound,
            // this row would stop testing the cancellation.
            assert!(
                waited < Duration::from_secs(8),
                "destroy returned {waited:?} after the cancel, as if it waited for the refresh to fail"
            );
        }
        // Refresh only reads. A regression that continues to the destroy plan's
        // apply changes the bindings and the cluster.
        before.assert_unchanged(&fixture, &format!("{fault:?}"));
        before.assert_state_unchanged(&fixture, &format!("{fault:?}"));
        fixture
            .assert_export_refused("export requires all declared resource bindings")
            .await;
    }
    fixture.finish().await;
}
