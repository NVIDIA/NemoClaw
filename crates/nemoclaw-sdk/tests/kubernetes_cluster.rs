// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Owned objects are created only when absent, recognised by the UID
//! recorded at creation, and deleted only while that UID still holds.

use crate::transport::Fixture;
use nemoclaw_sdk::{
    ObservationError,
    kubernetes::cluster::{Cluster, Owned},
};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

type Log = Arc<Mutex<Vec<(String, String, Value)>>>;

/// A fake API server holding one ConfigMap; records each request.
async fn server(existing: Option<Value>) -> (Fixture, Log) {
    let log: Log = Arc::default();
    let record = log.clone();
    let stored = Arc::new(Mutex::new(existing));
    let fixture = Fixture::start_tcp(move |request| {
        let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
        record.lock().unwrap().push((request.method.clone(), request.path.clone(), body.clone()));
        let mut stored = stored.lock().unwrap();
        let path = request.path.split('?').next().unwrap().to_owned();
        let missing = || Some((404, br#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"NotFound","code":404}"#.to_vec()));
        match (request.method.as_str(), path.as_str()) {
            ("GET", "/api/v1/namespaces/agents/configmaps/settings") => match &*stored {
                Some(object) => Some((200, object.to_string().into_bytes())),
                None => missing(),
            },
            ("POST", "/api/v1/namespaces/agents/configmaps") => {
                if stored.is_some() {
                    return Some((409, br#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"AlreadyExists","code":409}"#.to_vec()));
                }
                let mut object = body;
                object["metadata"]["uid"] = json!("uid-created");
                *stored = Some(object.clone());
                Some((201, object.to_string().into_bytes()))
            }
            ("DELETE", "/api/v1/namespaces/agents/configmaps/settings") => {
                let wanted = body["preconditions"]["uid"].as_str().map(str::to_owned);
                match &*stored {
                    Some(object) if wanted.as_deref() == object["metadata"]["uid"].as_str() => {
                        *stored = None;
                        Some((200, br#"{"kind":"Status","apiVersion":"v1","status":"Success","code":200}"#.to_vec()))
                    }
                    Some(_) => Some((409, br#"{"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Conflict","code":409}"#.to_vec())),
                    None => missing(),
                }
            }
            _ => Some((500, b"{}".to_vec())),
        }
    })
    .await;
    (fixture, log)
}

fn cluster(fixture: &Fixture) -> Cluster {
    let config = kube::Config::new(fixture.endpoint.parse().unwrap());
    Cluster::new(
        nemoclaw_sdk::kubernetes::client(config).unwrap(),
        "owner-1",
        "generation-1",
    )
}

fn settings() -> Value {
    json!({"apiVersion": "v1", "kind": "ConfigMap",
           "metadata": {"name": "settings", "namespace": "agents"},
           "data": {"mode": "development"}})
}

#[tokio::test]
async fn an_absent_object_is_created_with_owner_labels_and_its_uid_recorded() {
    let (fixture, log) = server(None).await;
    let owned = cluster(&fixture).create(settings()).await.unwrap();
    assert_eq!(owned.uid, "uid-created");
    let (_, _, sent) = log
        .lock()
        .unwrap()
        .iter()
        .find(|(m, _, _)| m == "POST")
        .cloned()
        .unwrap();
    assert_eq!(
        sent["metadata"]["labels"]["nemoclaw.nvidia.com/uid"],
        "owner-1"
    );
    assert_eq!(
        sent["metadata"]["labels"]["nemoclaw.nvidia.com/generation"],
        "generation-1"
    );
}

#[tokio::test]
async fn an_existing_object_is_never_adopted() {
    let foreign = json!({"apiVersion": "v1", "kind": "ConfigMap",
                         "metadata": {"name": "settings", "namespace": "agents", "uid": "uid-foreign"}});
    let (fixture, _) = server(Some(foreign)).await;
    assert!(matches!(
        cluster(&fixture).create(settings()).await,
        Err(ObservationError::BindingMismatch)
    ));
}

#[tokio::test]
async fn a_recorded_object_is_verified_by_uid_and_owner() {
    let mut object = settings();
    object["metadata"]["uid"] = json!("uid-1");
    object["metadata"]["labels"] = json!({"nemoclaw.nvidia.com/uid": "owner-1"});
    let (fixture, _) = server(Some(object)).await;
    let cluster = cluster(&fixture);
    let owned = Owned::new(&settings(), "uid-1");
    cluster.verify(&owned).await.unwrap();
    // A replacement with another UID, or a missing object, is not ours.
    assert!(matches!(
        cluster.verify(&Owned::new(&settings(), "uid-other")).await,
        Err(ObservationError::BindingMismatch)
    ));
}

#[tokio::test]
async fn an_object_without_our_owner_label_is_not_ours() {
    let mut object = settings();
    object["metadata"]["uid"] = json!("uid-1");
    let (fixture, _) = server(Some(object)).await;
    assert!(matches!(
        cluster(&fixture)
            .verify(&Owned::new(&settings(), "uid-1"))
            .await,
        Err(ObservationError::BindingMismatch)
    ));
}

#[tokio::test]
async fn deletion_requires_the_recorded_uid() {
    let mut object = settings();
    object["metadata"]["uid"] = json!("uid-replacement");
    let (fixture, log) = server(Some(object)).await;
    let cluster = cluster(&fixture);
    assert!(matches!(
        cluster.delete(&Owned::new(&settings(), "uid-1")).await,
        Err(ObservationError::BindingMismatch)
    ));
    let (_, _, sent) = log
        .lock()
        .unwrap()
        .iter()
        .find(|(m, _, _)| m == "DELETE")
        .cloned()
        .unwrap();
    assert_eq!(sent["preconditions"]["uid"], "uid-1");
    cluster
        .delete(&Owned::new(&settings(), "uid-replacement"))
        .await
        .unwrap();
    // Deleting an object that is already gone succeeds.
    cluster
        .delete(&Owned::new(&settings(), "uid-replacement"))
        .await
        .unwrap();
}
