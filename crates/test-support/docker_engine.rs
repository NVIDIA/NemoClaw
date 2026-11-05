// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A fake Docker engine that keeps volumes, networks, containers, and the
//! files written into them. Tests serve it through the HTTP fixture's
//! `engine` endpoint and include it as a private module, like `http.rs`.
#![allow(
    dead_code,
    reason = "each test binary that includes this module uses a different subset of it"
)]
use serde_json::{Value, json};
use std::{collections::BTreeMap, io::Read};

/// The Docker root directory the fake engine reports; volumes mount below it.
pub const DATA_ROOT: &str = "/var/lib/docker";

#[derive(Default)]
pub struct Engine {
    pub volumes: BTreeMap<String, Value>,
    pub networks: BTreeMap<String, Value>,
    pub containers: Vec<Value>,
    /// Files in volumes, by absolute path.
    pub files: BTreeMap<String, Vec<u8>>,
    /// Every request other than a read, as `METHOD path`.
    pub mutations: Vec<String>,
}

impl Engine {
    pub fn container(&mut self, reference: &str) -> Option<&mut Value> {
        self.containers.iter_mut().find(|container| {
            container["Id"] == reference || container["Name"] == format!("/{reference}")
        })
    }
}

/// The single-entry tar archive Docker's archive endpoint returns.
pub fn tar_entry(name: &str, bytes: &[u8]) -> Vec<u8> {
    let mut archive = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    archive.append_data(&mut header, name, bytes).unwrap();
    archive.into_inner().unwrap()
}

pub fn handle(engine: &mut Engine, method: &str, target: &str, body: &[u8]) -> (u16, Vec<u8>) {
    let url = url::Url::parse(&format!("http://engine{target}")).unwrap();
    let query = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    let path = url.path();
    let segments: Vec<_> = path.trim_start_matches('/').split('/').collect();
    let json = |status, value: Value| (status, serde_json::to_vec(&value).unwrap());
    let missing = || json(404, json!({"message":"missing"}));
    if method != "GET" {
        engine.mutations.push(format!("{method} {path}"));
    }
    match (method, segments.as_slice()) {
        ("GET", ["info"]) => json(200, json!({"ID":"engine","DockerRootDir":DATA_ROOT})),
        ("POST", ["volumes", "create"]) => {
            let request: Value = serde_json::from_slice(body).unwrap();
            let name = request["Name"].as_str().unwrap().to_owned();
            let volume = json!({"Name":name,"Driver":"local","Scope":"local",
                "Mountpoint":format!("{DATA_ROOT}/volumes/{name}/_data"),
                "CreatedAt":"2026-10-08T00:00:00Z","Labels":request["Labels"],"Options":{}});
            engine.volumes.insert(name, volume.clone());
            json(201, volume)
        }
        ("GET", ["volumes", name]) => engine
            .volumes
            .get(*name)
            .map_or_else(missing, |volume| json(200, volume.clone())),
        ("GET", ["networks"]) => json(200, json!(engine.networks.values().collect::<Vec<_>>())),
        ("POST", ["networks", "create"]) => {
            let mut network: Value = serde_json::from_slice(body).unwrap();
            network["Id"] = json!("network");
            network["Internal"] = json!(false);
            network["EnableIPv6"] = json!(false);
            let name = network["Name"].as_str().unwrap().to_owned();
            engine.networks.insert(name, network);
            json(201, json!({"Id":"network","Warning":""}))
        }
        ("GET", ["networks", name]) => engine
            .networks
            .get(*name)
            .map_or_else(missing, |network| json(200, network.clone())),
        ("POST", ["containers", "create"]) => {
            let config: Value = serde_json::from_slice(body).unwrap();
            let mounts: Vec<_> = config["HostConfig"]["Mounts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|mount| json!({"Type":mount["Type"],"Name":mount["Source"],"Destination":mount["Target"],"RW":true}))
                .collect();
            let id = format!("container-{}", engine.containers.len());
            engine.containers.push(json!({
                "Id":id,"Name":format!("/{}", query("name").unwrap()),
                "Config":config,"HostConfig":config["HostConfig"],"Mounts":mounts,
                "State":{"Status":"created","Running":false,"ExitCode":0}
            }));
            json(201, json!({"Id":id,"Warnings":[]}))
        }
        ("GET", ["containers", reference, "json"]) => engine
            .container(reference)
            .map_or_else(missing, |container| json(200, container.clone())),
        // The initializer generates the gateway's signing identity and exits.
        ("POST", ["containers", reference, "start"]) => {
            let Some(container) = engine.container(reference) else {
                return missing();
            };
            container["State"] = json!({"Status":"exited","Running":false,"ExitCode":0});
            let data = container["Mounts"][0]["Destination"]
                .as_str()
                .unwrap()
                .to_owned();
            engine
                .files
                .insert(format!("{data}/tls/jwt/public.pem"), b"public".to_vec());
            (204, Vec::new())
        }
        ("POST", ["containers", _, "wait"]) => json(200, json!({"StatusCode":0})),
        ("GET", ["containers", _, "archive"]) => {
            let file = query("path").unwrap();
            match engine.files.get(&file) {
                Some(bytes) => (200, tar_entry(file.rsplit('/').next().unwrap(), bytes)),
                None => missing(),
            }
        }
        ("PUT", ["containers", _, "archive"]) => {
            let directory = query("path").unwrap();
            let mut archive = tar::Archive::new(body);
            for entry in archive.entries().unwrap() {
                let mut entry = entry.unwrap();
                if entry.header().entry_type().is_file() {
                    let name = entry.path().unwrap().to_str().unwrap().to_owned();
                    let mut bytes = Vec::new();
                    entry.read_to_end(&mut bytes).unwrap();
                    engine.files.insert(format!("{directory}/{name}"), bytes);
                }
            }
            (200, Vec::new())
        }
        _ => panic!("unexpected Docker request {method} {target}"),
    }
}
