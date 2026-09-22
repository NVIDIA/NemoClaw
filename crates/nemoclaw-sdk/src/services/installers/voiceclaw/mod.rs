// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod config;
pub use config::{PullPolicy, Service, Serving, Speech, SpeechProvider};

use crate::{
    Error,
    compile::{Generations, Target},
    config::{Document, ImagePullPolicy},
    managed::{Process, Spec, Storage},
    services::contract::{
        InstallPlan, Installer, MANAGED_SERVICE_KIND, MANAGED_SERVICE_STORAGE_KIND, RemovePlan,
    },
};
use serde::Serialize;
use std::{collections::BTreeMap, time::Duration};

const DATA_PATH: &str = "/var/lib/voiceclaw";

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
        validate_readiness(&spec)?;
        let container = crate::docker_compute::address(&target.address);
        let logical = container.split_once('.').unwrap().1;
        let encoded = serde_json::json!({"kind":"voiceclaw", "spec":spec}).to_string();
        graph["data"]["nemoclaw_service_readiness"][logical] = serde_json::json!({
            "spec":encoded.replace("${", "$${").replace("%{", "%%{"),
            "container_id":format!("${{{container}.id}}"),
            "read_trigger":"${timestamp() != \"\"}",
            "wait_timeout_seconds":service.serving.startup_timeout_seconds,
        });
    }
    Ok(())
}

pub(crate) fn validate_readiness(spec: &Spec) -> Result<(), Error> {
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
    Ok(())
}

pub(crate) async fn wait_ready(
    engine: &crate::docker::Engine,
    spec: &Spec,
    container_id: &str,
    timeout: Duration,
) -> Result<(), Error> {
    let process = spec
        .process
        .as_ref()
        .ok_or(Error::State("VoiceClaw process is unavailable"))?;
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
