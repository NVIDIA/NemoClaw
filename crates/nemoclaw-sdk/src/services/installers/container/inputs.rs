// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Nonsecret intent for protected application input delivery.
use crate::{
    Error,
    config::{ConfigError, Credential, Document, validation::require},
    managed::Spec,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const INPUTS_KIND: &str = "container_inputs";
pub const MAX_DESCRIPTOR_BYTES: usize = 64 << 10;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// A preloaded, immutable NemoClaw setup image. It runs only to publish protected inputs.
pub struct InputSetup {
    /// Repository SHA-256 manifest digest. Build from image/container-inputs/Dockerfile and preload it in the selected engine; no implicit pull.
    pub image: String,
}
impl InputSetup {
    pub fn validate(&self) -> Result<(), ConfigError> {
        require(
            matches(crate::config::constraints::IMAGE, &self.image),
            "input setup image must be pinned by a SHA-256 digest",
        )
    }
}

pub fn input_revision(
    user: &str,
    root: &str,
    secrets: &BTreeMap<String, ProtectedCredential>,
    connections: &BTreeMap<String, AgentConnection>,
) -> String {
    if secrets.is_empty() && connections.is_empty() {
        return String::new();
    }
    let reference_intent =
        serde_json::to_vec(&(user, root, secrets, connections)).expect("typed input references");
    Sha256::digest(reference_intent)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// A caller-supplied token reference delivered as a protected file, never Docker environment.
pub struct ProtectedCredential {
    /// Caller environment reference; no value appears in deployment configuration or state.
    pub credential: Credential,
    /// Canonical file path below this application's data root.
    pub target_path: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One explicitly selected sandbox agent and application-reachable OpenShell endpoint.
pub struct AgentConnection {
    /// Declared sandbox whose ownership and physical identity bind the connection.
    pub sandbox_ref: String,
    /// Agent name declared by the selected sandbox.
    pub agent: String,
    /// Canonical descriptor file path below the application data root.
    pub target_path: String,
    /// Explicit application-reachable HTTPS OpenShell origin; reachability requires live qualification.
    pub gateway_endpoint: String,
    /// Declared application identity reference; issuance and authority remain external.
    pub authentication: ApplicationAuthentication,
    /// Required peer-verifying TLS trust profile.
    pub tls: ApplicationTrust,
    /// Bounded application client deadlines.
    pub timeouts: ConnectionTimeouts,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Static bearer delivery does not issue, refresh, or narrow an identity's authority.
pub struct ApplicationAuthentication {
    /// Static bearer profile: oidcBearer. This does not establish a supported issuer flow.
    pub mode: String,
    /// Name of this service's explicitly declared protected credential.
    pub secret_ref: String,
    /// none: the application fails closed on expiry; no installer-owned refresh.
    pub refresh_mode: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// The first delivery profile supports verified system trust only.
pub struct ApplicationTrust {
    /// system: use the image's trusted CA roots. Private CA delivery and insecure modes are unsupported.
    pub trust: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// Bounded application-client health and invocation deadlines.
pub struct ConnectionTimeouts {
    /// Non-generative native agent check deadline, 1–12 seconds.
    pub health_seconds: u64,
    /// Explicit agent invocation deadline, 1–120 seconds.
    pub invoke_seconds: u64,
}

fn matches(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).unwrap().is_match(value) && !value.contains(['\0', '\r', '\n'])
}
fn safe_path(root: &str, target: &str) -> bool {
    target.len() <= 512
        && target
            .strip_prefix(&format!("{root}/"))
            .is_some_and(|path| {
                !path.is_empty()
                    && path.split('/').all(|part| {
                        matches(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$", part)
                            && part != "."
                            && part != ".."
                    })
            })
}
pub fn validate_inputs(
    root: &str,
    secrets: &BTreeMap<String, ProtectedCredential>,
    connections: &BTreeMap<String, AgentConnection>,
) -> Result<(), ConfigError> {
    require(
        secrets.len() <= 16 && connections.len() <= 1,
        "container input count exceeds the supported limit",
    )?;
    let mut targets = BTreeSet::new();
    for (name, secret) in secrets {
        require(
            matches(crate::config::constraints::SLUG, name),
            "invalid container credential name",
        )?;
        require(
            matches(crate::config::constraints::ENV, &secret.credential.env)
                && !["TF_", "TOFU_", "PLUGIN_", "NEMOCLAW_INTERNAL_"]
                    .iter()
                    .any(|p| secret.credential.env.starts_with(p))
                && secret.credential.env != "CHECKPOINT_DISABLE",
            "invalid or reserved container credential reference",
        )?;
        require(
            safe_path(root, &secret.target_path) && targets.insert(secret.target_path.as_str()),
            "container input paths must be distinct files below the data root",
        )?;
    }
    for (name, connection) in connections {
        require(
            matches(crate::config::constraints::SLUG, name)
                && matches(crate::config::constraints::SLUG, &connection.sandbox_ref)
                && matches(crate::config::constraints::SLUG, &connection.agent),
            "invalid container agent binding",
        )?;
        require(
            safe_path(root, &connection.target_path)
                && targets.insert(connection.target_path.as_str()),
            "container input paths must be distinct files below the data root",
        )?;
        require(
            connection.authentication.mode == "oidcBearer"
                && connection.authentication.refresh_mode == "none"
                && secrets.contains_key(&connection.authentication.secret_ref),
            "container connection requires a declared static bearer reference",
        )?;
        require(
            connection.tls.trust == "system",
            "container connection supports system TLS trust only",
        )?;
        require(
            (1..=12).contains(&connection.timeouts.health_seconds)
                && (1..=120).contains(&connection.timeouts.invoke_seconds),
            "container connection deadlines exceed the supported bounds",
        )?;
        let endpoint = url::Url::parse(&connection.gateway_endpoint)
            .map_err(|_| ConfigError::new("invalid container gateway endpoint"))?;
        require(
            connection.gateway_endpoint.len() <= 2048
                && endpoint.scheme() == "https"
                && endpoint.username().is_empty()
                && endpoint.password().is_none()
                && endpoint.query().is_none()
                && endpoint.fragment().is_none()
                && endpoint.path() == "/"
                && endpoint.host().is_some_and(|host| match host {
                    url::Host::Domain(name) => {
                        !name.eq_ignore_ascii_case("localhost") && !name.ends_with(".localhost")
                    }
                    url::Host::Ipv4(ip) => {
                        !ip.is_loopback()
                            && !ip.is_unspecified()
                            && !ip.is_multicast()
                            && !ip.is_broadcast()
                            && !ip.is_link_local()
                    }
                    url::Host::Ipv6(ip) => {
                        !ip.is_loopback()
                            && !ip.is_unspecified()
                            && !ip.is_multicast()
                            && !ip.is_unicast_link_local()
                    }
                }),
            "container gateway requires application-reachable verified HTTPS",
        )?;
    }
    for path in &targets {
        require(
            !targets
                .iter()
                .any(|other| other != path && other.starts_with(&format!("{path}/"))),
            "container input file collides with a parent directory",
        )?;
    }
    require(
        !targets
            .iter()
            .any(|path| path.split('/').any(|part| part == ".nemoclaw-inputs")),
        "container input path is reserved",
    )?;
    Ok(())
}
impl AgentConnection {
    pub fn validate_binding(&self, document: &Document) -> Result<(), ConfigError> {
        let sandbox = document.sandbox(&self.sandbox_ref)?;
        require(
            sandbox.agent.name == self.agent,
            "container agent does not match its selected sandbox",
        )?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
/// Provider input contains references and binding metadata, never credential values.
pub struct InputsSpec {
    pub process: Spec,
    pub setup: InputSetup,
    pub service: String,
    pub workspace: String,
    pub secrets: BTreeMap<String, ProtectedCredential>,
    pub connections: BTreeMap<String, AgentConnection>,
}
impl InputsSpec {
    pub fn validate(&self) -> Result<(), Error> {
        self.process.validate()?;
        self.setup.validate()?;
        if self.process.kind != super::SERVICE_KIND
            || self.workspace != self.process.name.split("-container-").next().unwrap_or("")
            || !matches(crate::config::constraints::SLUG, &self.service)
            || self.process.name != format!("{}-container-{}", self.workspace, self.service)
            || self.secrets.is_empty() && self.connections.is_empty()
        {
            return Err(Error::State("invalid application input identity"));
        }
        validate_inputs(
            &self.process.process.as_ref().unwrap().mount_target,
            &self.secrets,
            &self.connections,
        )?;
        let process = self.process.process.as_ref().unwrap();
        if process.input_revision
            != input_revision(
                &process.user,
                &process.mount_target,
                &self.secrets,
                &self.connections,
            )
        {
            return Err(Error::State(
                "application input revision differs from its references",
            ));
        }
        Ok(())
    }
    pub fn descriptor(&self, sandbox_id: &str) -> Result<Option<(String, Value)>, Error> {
        self.validate()?;
        let Some(connection) = self.connections.values().next() else {
            return Ok(None);
        };
        if !matches(crate::config::constraints::UUID, sandbox_id) {
            return Err(Error::State("application sandbox identity is unresolved"));
        }
        let descriptor = json!({
            "schemaVersion":"nemoclaw.agent-connection.v1",
            "deploymentUid":self.process.owner, "service":self.service,
            "gateway":{"endpoint":connection.gateway_endpoint,"tls":{"trust":"system","caFile":null}},
            "authentication":{"mode":"oidcBearer","credentialFile":self.secrets[&connection.authentication.secret_ref].target_path,"refreshMode":"none"},
            "target":{"workspace":self.workspace,"sandbox":connection.sandbox_ref,"sandboxId":sandbox_id,"agent":connection.agent},
            "bridge":{"interfaceVersion":1,"command":"fabric-agent"},
            "timeouts":connection.timeouts
        });
        if descriptor.to_string().len() > MAX_DESCRIPTOR_BYTES {
            return Err(Error::State(
                "application connection descriptor exceeds its size limit",
            ));
        }
        Ok(Some((connection.target_path.clone(), descriptor)))
    }
    pub fn helper_name(&self) -> String {
        format!("{}-inputs", self.process.name)
    }
    pub fn image_requirements(&self) -> Spec {
        let mut spec = self.process.clone();
        let process = spec
            .process
            .as_mut()
            .expect("validated application process");
        process.image = self.setup.image.clone();
        process.image_labels = [(
            nemoclaw_container_inputs::CONTRACT_LABEL.into(),
            nemoclaw_container_inputs::CONTRACT_VERSION.into(),
        )]
        .into();
        process.environment.clear();
        spec
    }
}

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, Value>) {
    use crate::config::{constraints as c, schema::validation::property};
    property(
        &mut defs["InputSetup"],
        "image",
        json!({"pattern":c::IMAGE}),
    );
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|v| v["properties"]["kind"]["const"] == "container")
        .unwrap();
    property(
        service,
        "secrets",
        json!({"maxProperties":16,"propertyNames":{"pattern":c::SLUG}}),
    );
    property(
        service,
        "agentConnections",
        json!({"maxProperties":1,"propertyNames":{"pattern":c::SLUG}}),
    );
    for field in ["sandboxRef", "agent"] {
        property(
            &mut defs["AgentConnection"],
            field,
            json!({"pattern":c::SLUG}),
        );
    }
    property(
        &mut defs["ApplicationAuthentication"],
        "mode",
        json!({"const":"oidcBearer"}),
    );
    property(
        &mut defs["ApplicationAuthentication"],
        "refreshMode",
        json!({"const":"none"}),
    );
    property(
        &mut defs["ApplicationAuthentication"],
        "secretRef",
        json!({"pattern":c::SLUG}),
    );
    property(
        &mut defs["ApplicationTrust"],
        "trust",
        json!({"const":"system"}),
    );
    property(
        &mut defs["ConnectionTimeouts"],
        "healthSeconds",
        json!({"minimum":1,"maximum":12}),
    );
    property(
        &mut defs["ConnectionTimeouts"],
        "invokeSeconds",
        json!({"minimum":1,"maximum":120}),
    );
}
