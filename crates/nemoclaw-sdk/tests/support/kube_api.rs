// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! An in-memory Kubernetes API server for SDK tests.
//!
//! It stores objects by path and answers get, list, create (assigning a UID)
//! and delete with a UID precondition. That is enough for the SDK's cluster
//! code; anything else answers 500.

#![allow(dead_code)]
use crate::transport::Fixture;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

#[derive(Clone, Default)]
pub struct Objects(pub Arc<Mutex<BTreeMap<String, Value>>>);

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
    /// Store `object`, giving it a UID if it has none.
    pub fn insert(&self, mut object: Value) {
        if object.pointer("/metadata/uid").is_none() {
            let uid = format!("uid-{}", self.0.lock().unwrap().len() + 1);
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
        let selector = url::form_urlencoded::parse(query.as_bytes())
            .find_map(|(key, value)| (key == "labelSelector").then(|| value.into_owned()));
        let mut objects = self.0.lock().unwrap();
        match method {
            "GET" => {
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
                let name = object.pointer("/metadata/name")?.as_str()?.to_owned();
                let key = format!("{path}/{name}");
                if objects.contains_key(&key) {
                    return status(409, "AlreadyExists");
                }
                object["metadata"]["uid"] = json!(format!("uid-{}", objects.len() + 1));
                objects.insert(key, object.clone());
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
                objects.remove(path);
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
    nemoclaw_sdk::kubernetes::client(kube::Config::new(fixture.endpoint.parse().unwrap())).unwrap()
}
