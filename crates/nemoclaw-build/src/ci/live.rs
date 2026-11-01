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
    /// Native harness settings, when the test needs them.
    pub settings: Option<&'a serde_json::Map<String, serde_json::Value>>,
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
        settings,
    } = inputs;
    // JSON is a YAML flow mapping, so serializing cannot produce malformed YAML.
    let settings = settings
        .map(|settings| {
            format!(
                "\n        settings: {}",
                serde_json::Value::Object(settings.clone())
            )
        })
        .unwrap_or_default();
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
    hosted:
      provider: openai
      endpoint: https://inference.example.test/v1
  sandboxes:
    assistant:
      image:
        ref: {image}
      network:
        tier: isolated
      harness:
        kind: {harness}{settings}
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

/// The variable holding the model key the interface live test supplies.
pub const INTERFACES_MODEL_KEY: &str = "NEMOCLAW_TEST_INTERFACES_MODEL_KEY";

pub struct InterfacesInputs<'a> {
    pub name: &'a str,
    pub uid: &'a str,
    pub port: u16,
    pub subnet: &'a str,
    pub openclaw: &'a str,
    pub hermes: &'a str,
    pub deepagents_code: &'a str,
    /// Where the test serves its model stand-in, on the host.
    pub model_port: u16,
}

/// A managed Docker gateway with OpenClaw's dashboard, Hermes's API server and
/// dashboard, and Deep Agents Code's terminal enabled. The model endpoint is
/// the test's stand-in on the gateway network's host address, with a key the
/// test supplies. Every sandbox takes its image's default policy. The gateway
/// allows driver configuration, so the test can mount a volume on a sandbox.
pub fn interfaces_document(inputs: &InterfacesInputs<'_>) -> String {
    let InterfacesInputs {
        name,
        uid,
        port,
        subnet,
        openclaw,
        hermes,
        deepagents_code,
        model_port,
    } = inputs;
    let host = subnet
        .strip_suffix(".0/24")
        .map(|prefix| format!("{prefix}.1"))
        .expect("a /24 subnet");
    // JSON is a YAML flow mapping, so serializing cannot produce malformed YAML.
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
    config:
      openshell.drivers.docker:
        allow_driver_config: true
  inferenceProviders:
    model:
      provider: openai
      endpoint: http://{host}:{model_port}/v1
      credential:
        env: {INTERFACES_MODEL_KEY}
  sandboxes:
    claw:
      image:
        ref: {openclaw}
      network:
        tier: isolated
      harness:
        kind: nvidia.fabric.openclaw
        settings: {{\"interfaces\": {{\"dashboard\": {{\"port\": 18789}}}}}}
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: model
              overrides:
                model: fixture-model
    coder:
      image:
        ref: {deepagents_code}
      network:
        tier: isolated
      harness:
        kind: nvidia.fabric.langchain.deepagents-code
        settings: {{\"approval_mode\": \"auto\", \"interfaces\": {{\"terminal\": {{}}}}}}
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: model
              overrides:
                model: fixture-model
    hermes:
      image:
        ref: {hermes}
      network:
        tier: isolated
      harness:
        kind: nvidia.fabric.hermes
        settings: {{\"interfaces\": {{\"api\": {{\"port\": 8642}}, \"dashboard\": {{\"port\": 9119}}}}}}
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: model
              overrides:
                model: fixture-model
"
    )
}
