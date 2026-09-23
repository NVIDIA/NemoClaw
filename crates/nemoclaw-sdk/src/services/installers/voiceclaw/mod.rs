// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod config;
pub use config::{PullPolicy, Service, Serving, Speech, SpeechProvider};

use crate::{
    Error,
    compile::{Generations, Target},
    config::{Document, Gateway, ImagePullPolicy},
    managed::{Process, Spec, Storage},
    openshell::{EnvironmentSecrets, OpenShell, Secrets},
    services::contract::{
        InstallPlan, Installer, MANAGED_SERVICE_KIND, MANAGED_SERVICE_STORAGE_KIND, RemovePlan,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};

const DATA_PATH: &str = "/var/lib/voiceclaw";
const SANDBOX_DATA_PATH: &str = "/sandbox";
const SANDBOX_GRANT_PATH: &str = ".nemoclaw/agent-access/voice.json";
const AGENT_PORT: u16 = 18_800;
const VOICECLAW_UID: u64 = 65_532;
const SANDBOX_UID: u64 = 1_000;
const GRANT_LIFETIME_SECONDS: i64 = 30 * 24 * 60 * 60;
const SANDBOX_ID_PLACEHOLDER: &str = "NEMOCLAW_VOICECLAW_SANDBOX_ID";

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, serde_json::Value>) {
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .expect("tagged service variants")
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "voiceclaw")
        .expect("VoiceClaw service schema");
    crate::config::schema::validation::property(
        service,
        "image",
        serde_json::json!({"pattern":crate::config::constraints::LOCAL_IMAGE_ID}),
    );
    crate::config::schema::validation::property(
        service,
        "imagePullPolicy",
        serde_json::json!({"const":"Never"}),
    );
    service["properties"]["imagePullPolicy"]
        .as_object_mut()
        .expect("VoiceClaw pull policy schema")
        .remove("enum");
}

fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.{name}")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfiguration<'a> {
    integration: &'a str,
    sandbox: &'a str,
    agent: &'a str,
    port: i64,
    speech_provider: &'static str,
    speech_credential_path: &'static str,
    agent_credential_path: &'static str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Projection {
    deployment: String,
    workspace: String,
    generation: String,
    integration: String,
    sandbox: String,
    sandbox_id: String,
    agent: String,
    speech_credential_env: String,
}

fn targets(
    document: &Document,
    name: &str,
    service: &Service,
    generations: &Generations,
) -> Result<(Vec<Target>, Spec), Error> {
    let generation = generations
        .get(MANAGED_SERVICE_KIND)
        .filter(|value| !value.is_empty())
        .ok_or(Error::State("missing managed service generation"))?;
    let sandbox_generation = generations
        .get("sandbox")
        .filter(|value| !value.is_empty())
        .ok_or(Error::State("missing sandbox generation"))?;
    let binding = document.voiceclaw_binding(name)?.ok_or(Error::State(
        "VoiceClaw service has no selected integration",
    ))?;
    let configuration = RuntimeConfiguration {
        integration: binding.integration,
        sandbox: binding.sandbox,
        agent: binding.agent,
        port: service.serving.port,
        speech_provider: "nvidia",
        speech_credential_path: "/var/lib/voiceclaw/credentials/speech",
        agent_credential_path: "/var/lib/voiceclaw/credentials/agent",
    };
    let process = Process {
        engine: document.spec.gateway.managed()?.engine.clone(),
        image: service.image.clone(),
        network_cidr: document.spec.gateway.managed()?.network_cidr.clone(),
        create_network: false,
        architecture: Service::architecture()?.into(),
        image_labels: BTreeMap::new(),
        pull_image: false,
        image_pull_policy: Some(ImagePullPolicy::Never),
        configuration: serde_json::to_string(&configuration)
            .map_err(|_| Error::State("cannot encode VoiceClaw runtime configuration"))?,
        entrypoint: vec!["/usr/local/bin/voiceclaw-runtime".into()],
        command: vec!["serve".into()],
        mount_target: DATA_PATH.into(),
        bind_address: document.spec.gateway.managed()?.bridge()?,
        port: service.serving.port as u16,
        shared_memory_bytes: 64 << 20,
        host_ipc: false,
        memory_bytes: 1 << 30,
        gpu: false,
    };
    let spec = Spec {
        layout: 0,
        compute_driver: crate::config::ComputeDriver::Docker,
        kind: MANAGED_SERVICE_KIND.into(),
        name: format!("{}-voiceclaw-{name}", document.workspace()),
        owner: document.metadata.uid.clone(),
        generation: generation.clone(),
        gateway: document.spec.gateway.managed()?.runtime_settings(),
        process: Some(process),
    };
    let storage = Storage {
        name: format!("{}-data", spec.name),
        owner: spec.owner.clone(),
        generation: spec.generation.clone(),
        engine: spec.engine().into(),
    };
    let result = vec![
        Target {
            kind: MANAGED_SERVICE_STORAGE_KIND.into(),
            address: address(MANAGED_SERVICE_STORAGE_KIND, name),
            values: crate::backend::Row::from([("spec".into(), storage.json()?)]),
        },
        Target {
            kind: MANAGED_SERVICE_KIND.into(),
            address: address(MANAGED_SERVICE_KIND, name),
            values: crate::backend::Row::from([
                ("spec".into(), spec.json()?),
                ("image_pull_policy".into(), "Never".into()),
                ("sandbox_generation".into(), sandbox_generation.clone()),
            ]),
        },
    ];
    Ok((result, spec))
}

async fn ready(endpoint: &str) -> Result<bool, Error> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|_| Error::State("cannot initialize VoiceClaw readiness client"))?;
    match client.get(endpoint).send().await {
        Ok(response) if response.status() == reqwest::StatusCode::OK => Ok(true),
        Ok(response) if response.status() == reqwest::StatusCode::SERVICE_UNAVAILABLE => Ok(false),
        Ok(_) => Err(Error::State(
            "VoiceClaw readiness returned an unsupported status; inspect private service logs",
        )),
        Err(error) if error.is_connect() || error.is_timeout() => Ok(false),
        Err(_) => Err(Error::State(
            "VoiceClaw readiness request failed; inspect private service logs",
        )),
    }
}

pub(crate) fn configure_readiness(
    graph: &mut serde_json::Value,
    targets: &[Target],
    document: &Document,
) -> Result<(), Error> {
    for target in targets
        .iter()
        .filter(|target| target.kind == MANAGED_SERVICE_KIND)
    {
        let name = target
            .address
            .split_once('.')
            .ok_or(Error::State("invalid service address"))?
            .1;
        let Some(crate::services::ServiceDefinition::Voiceclaw(service)) =
            document.spec.services.get(name)
        else {
            continue;
        };
        let spec: Spec = serde_json::from_str(&target.values["spec"])
            .map_err(|_| Error::State("invalid VoiceClaw specification"))?;
        let binding = document.voiceclaw_binding(name)?.ok_or(Error::State(
            "VoiceClaw service has no selected integration",
        ))?;
        let projection = Projection {
            deployment: document.metadata.uid.clone(),
            workspace: document.workspace(),
            generation: target
                .values
                .get("sandbox_generation")
                .cloned()
                .ok_or(Error::State("missing VoiceClaw sandbox generation"))?,
            integration: binding.integration.into(),
            sandbox: binding.sandbox.into(),
            sandbox_id: SANDBOX_ID_PLACEHOLDER.into(),
            agent: binding.agent.into(),
            speech_credential_env: service.speech.credential.env.clone(),
        };
        validate_readiness(&spec, &projection, true)?;
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let encoded = serde_json::json!({"kind":"voiceclaw", "spec":spec, "projection":projection})
            .to_string()
            .replace("${", "$${")
            .replace("%{", "%%{")
            .replace(
                SANDBOX_ID_PLACEHOLDER,
                &format!("${{nemoclaw_sandbox.{}.id}}", binding.sandbox),
            );
        graph["data"]["nemoclaw_service_readiness"][logical] = serde_json::json!({
            "spec":encoded,
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}",
            "wait_timeout_seconds":service.serving.startup_timeout_seconds,
            "depends_on":[format!("data.nemoclaw_sandbox_readiness.{}", binding.sandbox)],
        });
    }
    Ok(())
}

pub(crate) fn validate_readiness(
    spec: &Spec,
    projection: &Projection,
    allow_unknown_sandbox_id: bool,
) -> Result<(), Error> {
    spec.validate()?;
    let process = spec
        .process
        .as_ref()
        .ok_or(Error::State("VoiceClaw process is unavailable"))?;
    if spec.kind != MANAGED_SERVICE_KIND
        || process.entrypoint != ["/usr/local/bin/voiceclaw-runtime"]
        || process.command != ["serve"]
    {
        return Err(Error::State("invalid VoiceClaw readiness specification"));
    }
    let configuration: serde_json::Value = serde_json::from_str(&process.configuration)
        .map_err(|_| Error::State("invalid VoiceClaw runtime configuration"))?;
    let name = regex::Regex::new(r"^[a-z][a-z0-9-]{0,39}$").unwrap();
    let generation = regex::Regex::new(r"^[a-f0-9]{32}$").unwrap();
    let sandbox_id = regex::Regex::new(if allow_unknown_sandbox_id {
        r"^(?:[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|NEMOCLAW_VOICECLAW_SANDBOX_ID)$"
    } else {
        r"^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$"
    })
    .unwrap();
    let environment = regex::Regex::new(crate::config::constraints::ENV).unwrap();
    let workspace = regex::Regex::new(r"^nc-[a-f0-9]{16}$").unwrap();
    if projection.deployment != spec.owner
        || !workspace.is_match(&projection.workspace)
        || !generation.is_match(&projection.generation)
        || !name.is_match(&projection.integration)
        || !name.is_match(&projection.sandbox)
        || !sandbox_id.is_match(&projection.sandbox_id)
        || !name.is_match(&projection.agent)
        || !environment.is_match(&projection.speech_credential_env)
        || configuration["integration"] != projection.integration
        || configuration["sandbox"] != projection.sandbox
        || configuration["agent"] != projection.agent
    {
        return Err(Error::State("invalid VoiceClaw projection specification"));
    }
    Ok(())
}

fn credential(bytes: &[u8]) -> Option<&[u8]> {
    (32..=4096)
        .contains(&bytes.len())
        .then_some(bytes)
        .filter(|value| value.iter().all(u8::is_ascii_graphic))
}

async fn project(
    engine: &crate::docker::Engine,
    spec: &Spec,
    projection: &Projection,
    container_id: &str,
) -> Result<(), Error> {
    let process = spec
        .process
        .as_ref()
        .ok_or(Error::State("VoiceClaw process is unavailable"))?;
    let network = spec.network();
    engine
        .verify_running_container_attachment(container_id, &network)
        .await?;
    let sandbox = engine
        .unique_running_container_id(&[
            ("openshell.ai/managed-by", "openshell"),
            ("openshell.ai/sandbox-id", &projection.sandbox_id),
            ("openshell.ai/isolation-role", "sandbox"),
        ])
        .await?;
    let speech = EnvironmentSecrets.resolve(&projection.speech_credential_env)?;
    let existing = engine
        .read_file(container_id, "/var/lib/voiceclaw/credentials/agent", 4096)
        .await?;
    let agent_credential = if let Some(value) = existing.as_deref().and_then(credential) {
        value.to_vec()
    } else {
        let mut random = [0_u8; 32];
        getrandom::fill(&mut random)
            .map_err(|_| Error::State("cannot generate scoped agent credential"))?;
        random
            .iter()
            .flat_map(|byte| format!("{byte:02x}").into_bytes())
            .collect()
    };
    let gateway_endpoint = url::Url::parse(&spec.gateway.endpoint)
        .map_err(|_| Error::State("invalid managed gateway endpoint"))?;
    let gateway_port = gateway_endpoint.port().ok_or(Error::State(
        "managed gateway endpoint has no explicit port",
    ))?;
    if gateway_endpoint.scheme() != "http" {
        return Err(Error::State(
            "VoiceClaw requires the local managed gateway transport",
        ));
    }
    let service_name = format!("voice-{}", projection.integration);
    let openshell = OpenShell::connect(
        &Gateway::Managed(spec.gateway.clone()),
        Arc::new(EnvironmentSecrets),
    )?;
    let agent_route_host = openshell
        .expose_service(
            &projection.workspace,
            &projection.sandbox,
            &projection.sandbox_id,
            &service_name,
            AGENT_PORT,
        )
        .await?;
    let agent_endpoint = format!("http://{}:{gateway_port}", spec.gateway_address()?);
    let mut configuration: serde_json::Value = serde_json::from_str(&process.configuration)
        .map_err(|_| Error::State("invalid VoiceClaw runtime configuration"))?;
    configuration["agentEndpoint"] = serde_json::Value::String(agent_endpoint);
    configuration["agentRouteHost"] = serde_json::Value::String(agent_route_host);
    let configuration = serde_json::to_vec(&configuration)
        .map_err(|_| Error::State("cannot encode VoiceClaw runtime configuration"))?;
    engine
        .write_protected_files(
            container_id,
            DATA_PATH,
            &["runtime", "credentials"],
            &[
                ("runtime/config.json", configuration.as_slice()),
                ("credentials/speech", speech.as_bytes()),
                ("credentials/agent", agent_credential.as_slice()),
            ],
            VOICECLAW_UID,
            VOICECLAW_UID,
        )
        .await?;

    let expires_at = time::OffsetDateTime::now_utc().unix_timestamp() + GRANT_LIFETIME_SECONDS;
    let credential_sha256: String = Sha256::digest(&agent_credential)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let grant = serde_json::to_vec(&serde_json::json!({
        "version":1,
        "deployment":projection.deployment,
        "generation":projection.generation,
        "integration":projection.integration,
        "sandbox":projection.sandbox,
        "agent":projection.agent,
        "clientAddress":"127.0.0.1",
        "credentialSha256":credential_sha256,
        "expiresAt":expires_at,
    }))
    .map_err(|_| Error::State("cannot encode scoped agent grant"))?;
    engine
        .write_protected_files(
            &sandbox,
            SANDBOX_DATA_PATH,
            &[".nemoclaw", ".nemoclaw/agent-access"],
            &[(SANDBOX_GRANT_PATH, grant.as_slice())],
            SANDBOX_UID,
            SANDBOX_UID,
        )
        .await
}

pub(crate) async fn wait_ready(
    engine: &crate::docker::Engine,
    spec: &Spec,
    projection: &Projection,
    container_id: &str,
    timeout: Duration,
) -> Result<(), Error> {
    let process = spec
        .process
        .as_ref()
        .ok_or(Error::State("VoiceClaw process is unavailable"))?;
    project(engine, spec, projection, container_id).await?;
    let endpoint = format!("http://{}:{}/readyz", process.bind_address, process.port);
    loop {
        let observed = engine
            .observe_service(spec, container_id)
            .await?
            .ok_or(Error::State("VoiceClaw runtime is unobservable"))?;
        if !observed.running {
            return Err(Error::State(
                "VoiceClaw stopped during readiness; inspect private logs and explicitly reapply",
            ));
        }
        if ready(&endpoint).await? {
            return Ok(());
        }
        if timeout.is_zero() {
            return Err(Error::State("VoiceClaw is not ready"));
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

impl Installer for Service {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        let (targets, _) = targets(document, name, self, generations)?;
        let binding = document.voiceclaw_binding(name)?.ok_or(Error::State(
            "VoiceClaw service has no selected integration",
        ))?;
        Ok(InstallPlan {
            targets,
            dependencies: BTreeMap::from([(
                address(MANAGED_SERVICE_KIND, name),
                vec![
                    address(MANAGED_SERVICE_STORAGE_KIND, name),
                    format!("nemoclaw_sandbox.{}", binding.sandbox),
                ],
            )]),
        })
    }

    fn remove(
        &self,
        _document: &Document,
        name: &str,
        _generations: &Generations,
    ) -> Result<RemovePlan, Error> {
        Ok(RemovePlan {
            retained: Vec::new(),
            required_storage: vec![(
                address(MANAGED_SERVICE_KIND, name),
                crate::docker_compute::address(&address(MANAGED_SERVICE_STORAGE_KIND, name)),
            )],
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn endpoint(status: &'static str) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 2048];
            let size = socket.read(&mut request).await.unwrap();
            assert!(
                std::str::from_utf8(&request[..size])
                    .unwrap()
                    .starts_with("GET /readyz HTTP/1.1\r\n")
            );
            socket
                .write_all(
                    format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
        });
        format!("http://{address}/readyz")
    }

    #[tokio::test]
    async fn readiness_accepts_only_ready_and_retries_unavailable_or_connection_failure() {
        assert!(ready(&endpoint("200 OK").await).await.unwrap());
        assert!(
            !ready(&endpoint("503 Service Unavailable").await)
                .await
                .unwrap()
        );

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/readyz", listener.local_addr().unwrap());
        drop(listener);
        assert!(!ready(&endpoint).await.unwrap());
    }

    #[tokio::test]
    async fn readiness_rejects_redirects_and_authentication_failures_without_content() {
        for status in ["302 Found", "401 Unauthorized", "500 Internal Server Error"] {
            let error = ready(&endpoint(status).await).await.unwrap_err();
            assert_eq!(
                error.to_string(),
                "VoiceClaw readiness returned an unsupported status; inspect private service logs"
            );
        }
    }
}
