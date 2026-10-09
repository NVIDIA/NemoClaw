// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Expired development certificates are refused and change nothing.
//!
//! The development issuer's certificates are valid for 365 days and the SDK has
//! no clock seam, so these tests rewrite the certificates of generated material
//! with a validity window in the past, keeping its keys and issuer host. A
//! control with a window that has not ended shows that the dates are the only
//! difference. `Development::ensure`, `Operations::read`, `Operations::ensure`
//! and `Operations::connect` must refuse the expired material with an
//! authentication failure, send no write, and leave the receipt and the files
//! as they were. How the gateway or the issuer pod behave with expired
//! certificates, and how an operator renews the material, are not covered.

use crate::kube_api::Objects;
use crate::kube_faults::{NAME, OWNER, Snapshot};
use nemoclaw_sdk::{ObservationError, kubernetes::auth::Development};
use rcgen::{BasicConstraints, CertificateParams, DnType, IsCa, Issuer, KeyPair};
use std::path::Path;
use time::{Duration, OffsetDateTime};

/// Replace the CA and server certificates in `auth` with ones for the same keys
/// and issuer host that are valid from `from` until `until`.
fn reissue(auth: &Path, from: OffsetDateTime, until: OffsetDateTime) {
    let key =
        |file: &str| KeyPair::from_pem(&std::fs::read_to_string(auth.join(file)).unwrap()).unwrap();
    let (ca_key, server_key) = (key("ca.key"), key("server.key"));
    let host = format!("{NAME}-oidc.agents.svc.cluster.local");
    let mut ca = CertificateParams::new(Vec::<String>::new()).unwrap();
    ca.distinguished_name
        .push(DnType::CommonName, "test issuer CA");
    ca.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    let mut server = CertificateParams::new(vec![host.clone()]).unwrap();
    server.distinguished_name.push(DnType::CommonName, host);
    for params in [&mut ca, &mut server] {
        params.not_before = from;
        params.not_after = until;
    }
    let ca_certificate = ca.self_signed(&ca_key).unwrap();
    let server_certificate = server
        .signed_by(&server_key, &Issuer::new(ca, &ca_key))
        .unwrap();
    std::fs::write(auth.join("ca.crt"), ca_certificate.pem()).unwrap();
    std::fs::write(auth.join("server.crt"), server_certificate.pem()).unwrap();
}

/// The 365-day window of material generated 400 days ago, which ended 35 days ago.
fn expired() -> (OffsetDateTime, OffsetDateTime) {
    let now = OffsetDateTime::now_utc();
    (now - Duration::days(400), now - Duration::days(35))
}

#[test]
fn expired_development_certificates_are_refused_without_regenerating_material() {
    let directory = tempfile::tempdir().unwrap();
    let auth = directory.path().join("auth");
    let development = Development::new(auth.clone(), NAME, "agents", OWNER);
    development
        .ensure()
        .expect("freshly generated material loads");
    // Control: certificates written by `reissue` load while they are valid, so
    // the window is the only difference once they are expired.
    let now = OffsetDateTime::now_utc();
    reissue(&auth, now - Duration::hours(1), now + Duration::days(365));
    development
        .ensure()
        .expect("rewritten certificates that are still valid load");
    let valid = std::fs::read(auth.join("server.crt")).unwrap();
    let (from, until) = expired();
    reissue(&auth, from, until);
    assert_ne!(
        std::fs::read(auth.join("server.crt")).unwrap(),
        valid,
        "the server certificate was not replaced by an expired one"
    );
    let none = Objects::default();
    let before = Snapshot::capture(&none, &auth);

    let result = development.ensure();

    assert_eq!(
        result.err(),
        Some(ObservationError::Authentication),
        "expired development certificates"
    );
    before.assert_unchanged(&none, &auth, "refusing expired development certificates");
}

#[cfg(unix)]
mod operations {
    use super::{expired, reissue};
    use crate::kube_api::Objects;
    use crate::kube_faults::{
        NAME, Snapshot,
        platform::{self, Call, assert_class, run},
        serve,
    };
    use nemoclaw_sdk::{
        ObservationError,
        kubernetes::{AUTH_KIND, STORAGE_KIND},
    };
    use serde_json::json;
    use std::path::Path;
    use time::{Duration, OffsetDateTime};

    /// Reissue the certificates in `auth`, and publish the new CA in the issuer's
    /// ConfigMap, which `read` compares with the local one. The dates are then
    /// the only difference between the local material and the cluster.
    fn reissue_and_publish(
        objects: &Objects,
        auth: &Path,
        from: OffsetDateTime,
        until: OffsetDateTime,
    ) {
        reissue(auth, from, until);
        let name = format!("{NAME}-oidc-ca");
        let mut ca = objects.get("v1", "ConfigMap", "agents", &name).unwrap();
        ca["data"]["ca.crt"] = json!(std::fs::read_to_string(auth.join("ca.crt")).unwrap());
        objects.insert(ca);
    }

    #[tokio::test]
    async fn expired_certificates_stop_refresh_apply_and_connect_before_any_cluster_write() {
        let objects = platform::cluster();
        let directory = tempfile::tempdir().unwrap();
        let state = directory.path().join("state");
        let server = serve(&objects, |_, _, _| None).await;
        let operations = platform::operations(server.client(), server.endpoint(), &state);
        operations
            .ensure(&platform::spec(STORAGE_KIND), None)
            .await
            .unwrap();
        let auth_spec = platform::spec(AUTH_KIND);
        let applied = operations.ensure(&auth_spec, None).await.unwrap();
        assert_eq!(applied.running, Some(true), "authentication is applied");
        let id = applied.id.as_deref();
        let auth = state.join("auth");
        // Control: certificates reissued for a window that has not ended are
        // accepted, so the refusals below come from the dates.
        let now = OffsetDateTime::now_utc();
        let window = (now - Duration::hours(1), now + Duration::days(365));
        reissue_and_publish(&objects, &auth, window.0, window.1);
        assert_eq!(
            operations.read(&auth_spec, id).await.map(|r| r.running),
            Ok(Some(true)),
            "valid reissued certificates, requests: {:?}",
            server.requests()
        );
        let (from, until) = expired();
        reissue_and_publish(&objects, &auth, from, until);
        let before = Snapshot::capture(&objects, &state);
        let writes = server.mutations().len();

        let read = operations.read(&auth_spec, id).await;
        let apply = operations.ensure(&auth_spec, id).await;
        let connect = run(&operations, "kubernetes", Call::Connect).await;

        let requests = server.requests();
        assert_eq!(
            read,
            Err(ObservationError::Authentication),
            "read, requests: {requests:?}"
        );
        assert_eq!(
            apply,
            Err(ObservationError::Authentication),
            "apply, requests: {requests:?}"
        );
        assert_class(
            &connect,
            &[ObservationError::Authentication],
            &format!("connect, requests: {requests:?}"),
        );
        assert_eq!(
            server.mutations().len(),
            writes,
            "mutating requests after the certificates expired: {:?}",
            &server.mutations()[writes..]
        );
        before.assert_unchanged(&objects, &state, "expired development certificates");
    }
}
