// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Fresh inputs for the Docker live tests: deployment UUIDs, unused
//! loopback ports and private subnets, and owned gateway documents.

/// A random version 4 UUID, as deployment metadata requires.
pub fn uuid() -> Result<String, String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).map_err(|_| "cannot generate a deployment UUID")?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = crate::hex(&bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// The first `172.30.N.0/24` from 200 up that neither Docker nor this run uses.
pub fn free_subnet(used: &[String], taken: &[String]) -> Result<String, String> {
    (200..=254)
        .map(|third| format!("172.30.{third}.0/24"))
        .find(|subnet| !used.contains(subnet) && !taken.contains(subnet))
        .ok_or_else(|| "no free 172.30.200-254.0/24 subnet for a test gateway".into())
}

/// An unused loopback port. Another process could take it before the gateway
/// binds; the gateway then fails to start rather than sharing the port.
pub fn free_port() -> Result<u16, String> {
    std::net::TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| "cannot find a free loopback port".into())
}

pub struct GatewayInputs<'a> {
    pub name: &'a str,
    pub uid: &'a str,
    pub port: u16,
    pub subnet: &'a str,
    pub image: &'a str,
    pub harness: &'a str,
}

/// A managed Docker gateway deployment with external inference and no
/// services, as the gateway live tests require. Nothing requests inference.
pub fn gateway_document(inputs: &GatewayInputs<'_>) -> String {
    let GatewayInputs {
        name,
        uid,
        port,
        subnet,
        image,
        harness,
    } = inputs;
    format!(
        "apiVersion: nemoclaw.nvidia.com/v1alpha1
kind: NemoClawConfig
metadata:
  name: {name}
  uid: {uid}
spec:
  gateway:
    management: managed
    runtime:
      provider: docker
    engine: unix:///var/run/docker.sock
    endpoint: http://127.0.0.1:{port}
    networkCIDR: {subnet}
  inferenceProviders:
    - name: hosted
      provider: openai
      endpoint: https://inference.example.test/v1
  sandboxes:
    - name: assistant
      image:
        ref: {image}
      network:
        tier: isolated
      harness:
        kind: {harness}
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: hosted
              overrides:
                model: fixture-model
"
    )
}
