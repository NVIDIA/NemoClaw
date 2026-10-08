// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! An in-memory Kubernetes API server for SDK tests.
//!
//! It stores objects by path and answers get, list, create (assigning a UID)
//! and delete with a UID precondition. That is enough for the SDK's cluster
//! code; anything else answers 500.

#![allow(dead_code)]
use super::transport::Fixture;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
};

#[derive(Clone, Default)]
pub struct Objects(
    pub Arc<Mutex<BTreeMap<String, Value>>>,
    Arc<AtomicU64>,
    Arc<Mutex<Controls>>,
);

#[derive(Default)]
struct Controls {
    request_failure: Option<RequestFailure>,
    rejected_requests: Vec<Value>,
    create_failure: Option<(String, bool, u16)>,
    denied_resource: Option<String>,
    delete_delay: Option<(String, u32)>,
    deleting: BTreeMap<String, u32>,
    pod_identity: Option<u32>,
    dry_runs: Vec<Value>,
}

struct RequestFailure {
    method: String,
    path: String,
    dry_run: bool,
    code: u16,
}

fn plural(kind: &str) -> String {
    let kind = kind.to_ascii_lowercase();
    if kind.ends_with('y') {
        format!("{}ies", &kind[..kind.len() - 1])
    } else if kind.ends_with('s') {
        format!("{kind}es")
    } else {
        format!("{kind}s")
    }
}

/// The collection path for an object's kind and namespace.
pub fn collection(api_version: &str, kind: &str, namespace: &str) -> String {
    let base = if api_version.contains('/') {
        format!("/apis/{api_version}")
    } else {
        format!("/api/{api_version}")
    };
    let scope = if namespace.is_empty() {
        String::new()
    } else {
        format!("/namespaces/{namespace}")
    };
    format!("{base}{scope}/{}", plural(kind))
}

fn path(object: &Value) -> String {
    let text = |pointer: &str| {
        object
            .pointer(pointer)
            .and_then(Value::as_str)
            .unwrap_or("")
    };
    format!(
        "{}/{}",
        collection(
            text("/apiVersion"),
            text("/kind"),
            text("/metadata/namespace")
        ),
        text("/metadata/name")
    )
}

fn status(code: u16, reason: &str) -> Option<(u16, Vec<u8>)> {
    Some((
        code,
        json!({"kind": "Status", "apiVersion": "v1", "status": "Failure", "reason": reason, "code": code})
            .to_string()
            .into_bytes(),
    ))
}

impl Objects {
    pub fn reject_request(&self, method: &str, path: &str, dry_run: bool, code: u16) {
        self.2.lock().unwrap().request_failure = Some(RequestFailure {
            method: method.into(),
            path: path.into(),
            dry_run,
            code,
        });
    }
    pub fn rejected_requests(&self) -> Vec<Value> {
        self.2.lock().unwrap().rejected_requests.clone()
    }
    /// Fail the next create of this kind, optionally after committing it.
    pub fn fail_create(&self, kind: &str, committed: bool) {
        self.2.lock().unwrap().create_failure = Some((kind.into(), committed, 500));
    }
    pub fn reject_create(&self, kind: &str) {
        self.2.lock().unwrap().create_failure = Some((kind.into(), false, 403));
    }
    pub fn deny_access(&self, resource: &str) {
        self.2.lock().unwrap().denied_resource = Some(resource.into());
    }
    pub fn delay_deletion(&self, kind: &str, reads: u32) {
        self.2.lock().unwrap().delete_delay = Some((kind.into(), reads));
    }
    pub fn deletion_reads(&self, name: &str) -> Option<u32> {
        self.2
            .lock()
            .unwrap()
            .deleting
            .iter()
            .find_map(|(path, remaining)| path.ends_with(&format!("/{name}")).then_some(*remaining))
    }
    pub fn require_pod_identity(&self, user: u32) {
        self.2.lock().unwrap().pod_identity = Some(user);
    }
    pub fn dry_runs(&self) -> Vec<Value> {
        self.2.lock().unwrap().dry_runs.clone()
    }
    /// Store `object`, giving it a UID if it has none.
    pub fn insert(&self, mut object: Value) {
        if object.pointer("/metadata/uid").is_none() {
            let uid = format!("uid-{}", self.1.fetch_add(1, Ordering::Relaxed) + 1);
            object["metadata"]["uid"] = json!(uid);
        }
        self.0.lock().unwrap().insert(path(&object), object);
    }

    pub fn get(&self, api_version: &str, kind: &str, namespace: &str, name: &str) -> Option<Value> {
        let key = format!("{}/{name}", collection(api_version, kind, namespace));
        self.0.lock().unwrap().get(&key).cloned()
    }

    pub fn len(&self) -> usize {
        self.0.lock().unwrap().len()
    }

    pub fn answer(&self, method: &str, path: &str, body: &[u8]) -> Option<(u16, Vec<u8>)> {
        let (path, query) = path.split_once('?').unwrap_or((path, ""));
        let dry_run = url::form_urlencoded::parse(query.as_bytes())
            .any(|(key, value)| key == "dryRun" && value == "All");
        {
            let mut controls = self.2.lock().unwrap();
            if controls.request_failure.as_ref().is_some_and(|failure| {
                failure.method == method && failure.path == path && failure.dry_run == dry_run
            }) {
                let failure = controls.request_failure.take().unwrap();
                controls.rejected_requests.push(json!({"method":method,"path":path,"dryRun":dry_run,"body":serde_json::from_slice::<Value>(body).unwrap_or(Value::Null)}));
                return Some((failure.code, json!({"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Conflict","code":failure.code,"message":"private-api-message token=private-credential uid=private-observed-uid"}).to_string().into_bytes()));
            }
        }
        let selector = url::form_urlencoded::parse(query.as_bytes())
            .find_map(|(key, value)| (key == "labelSelector").then(|| value.into_owned()));
        let mut objects = self.0.lock().unwrap();
        match method {
            "GET" => {
                let mut controls = self.2.lock().unwrap();
                if let Some(reads) = controls.deleting.get_mut(path) {
                    if *reads == 0 {
                        objects.remove(path);
                        controls.deleting.remove(path);
                    } else {
                        *reads -= 1;
                    }
                }
                if let Some(object) = objects.get(path) {
                    return Some((200, object.to_string().into_bytes()));
                }
                let prefix = format!("{path}/");
                let items: Vec<Value> = objects
                    .iter()
                    .filter(|(key, _)| {
                        key.starts_with(&prefix) && !key[prefix.len()..].contains('/')
                    })
                    .filter(|(_, object)| {
                        selector.as_ref().is_none_or(|selector| {
                            selector.split(',').all(|requirement| {
                                requirement.split_once('=').is_some_and(|(key, value)| {
                                    object["metadata"]["labels"][key].as_str() == Some(value)
                                })
                            })
                        })
                    })
                    .map(|(_, object)| object.clone())
                    .collect();
                if items.is_empty()
                    && path
                        .rsplit('/')
                        .next()
                        .is_some_and(|last| !last.ends_with('s'))
                {
                    return status(404, "NotFound");
                }
                Some((
                    200,
                    json!({"apiVersion": "v1", "kind": "List", "metadata": {}, "items": items})
                        .to_string()
                        .into_bytes(),
                ))
            }
            "POST" => {
                let mut object: Value = serde_json::from_slice(body).ok()?;
                if object["kind"] == "Pod"
                    && self.2.lock().unwrap().pod_identity.is_some_and(|user| {
                        ["runAsUser", "runAsGroup", "fsGroup"]
                            .iter()
                            .any(|field| object["spec"]["securityContext"][*field] != user)
                    })
                {
                    return status(403, "NamespaceIdentityMismatch");
                }
                let failure = {
                    let mut controls = self.2.lock().unwrap();
                    let next = &mut controls.create_failure;
                    if next.as_ref().is_some_and(|(kind, _, code)| {
                        object["kind"] == kind.as_str() && (!dry_run || *code == 403)
                    }) {
                        next.take().map(|(_, committed, code)| (committed, code))
                    } else {
                        None
                    }
                };
                if let Some((false, code)) = failure {
                    let name = object["metadata"]["name"].as_str().unwrap_or("");
                    let message = format!(
                        "{} {name:?} is forbidden: exceeded quota: requested nvidia.com/gpu=1; token=secret-sentinel; Bearer {name}; password='{name}'; opaque=nc-unverified-0123456789abcdef0123456789abcdef",
                        object["kind"].as_str().unwrap_or("object")
                    );
                    return Some((code, json!({"kind":"Status","apiVersion":"v1","status":"Failure","reason":"Forbidden","code":code,"message":message}).to_string().into_bytes()));
                }
                if object["kind"] == "SelfSubjectAccessReview" {
                    let denied =
                        self.2
                            .lock()
                            .unwrap()
                            .denied_resource
                            .as_ref()
                            .is_some_and(|resource| {
                                object["spec"]["resourceAttributes"]["resource"]
                                    == resource.as_str()
                            });
                    object["status"] = json!({"allowed": !denied});
                    return Some((201, object.to_string().into_bytes()));
                }
                let name = object.pointer("/metadata/name")?.as_str()?.to_owned();
                let key = format!("{path}/{name}");
                if objects.contains_key(&key) {
                    return status(409, "AlreadyExists");
                }
                if dry_run {
                    self.2.lock().unwrap().dry_runs.push(object.clone());
                    object["metadata"]["uid"] = json!("dry-run");
                    return Some((201, object.to_string().into_bytes()));
                }
                object["metadata"]["uid"] = json!(format!(
                    "uid-{}",
                    self.1.fetch_add(1, Ordering::Relaxed) + 1
                ));
                objects.insert(key, object.clone());
                if failure.is_some_and(|(committed, _)| committed) {
                    return status(500, "LostResponse");
                }
                Some((201, object.to_string().into_bytes()))
            }
            "DELETE" => {
                let options: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
                let Some(object) = objects.get(path) else {
                    return status(404, "NotFound");
                };
                let wanted = options
                    .pointer("/preconditions/uid")
                    .and_then(Value::as_str);
                if wanted.is_some_and(|uid| {
                    object.pointer("/metadata/uid").and_then(Value::as_str) != Some(uid)
                }) {
                    return status(409, "Conflict");
                }
                let mut controls = self.2.lock().unwrap();
                if let Some((kind, reads)) = controls.delete_delay.clone()
                    && object["kind"] == kind
                {
                    controls.deleting.entry(path.into()).or_insert(reads);
                } else {
                    objects.remove(path);
                }
                Some((
                    200,
                    json!({"kind": "Status", "apiVersion": "v1", "status": "Success", "code": 200})
                        .to_string()
                        .into_bytes(),
                ))
            }
            _ => status(500, "Unsupported"),
        }
    }

    /// Serve these objects on a loopback port.
    pub async fn serve(&self) -> Fixture {
        let objects = self.clone();
        Fixture::start_tcp(move |request| {
            objects.answer(&request.method, &request.path, &request.body)
        })
        .await
    }
}

/// A client for a fixture started by `Objects::serve`.
pub fn client(fixture: &Fixture) -> kube::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    kube::Client::try_from(kube::Config::new(fixture.endpoint.parse().unwrap())).unwrap()
}
