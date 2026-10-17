// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Image-owned applications use the same compute compiler as typed inference services.
pub(super) mod base;
mod execution;
mod limits;
use crate::{
    Error,
    compile::Generations,
    config::{ConfigError, Document, validation::require},
    managed::{ImageLaunch, Process},
    services::contract::{InstallPlan, Installer, RemovePlan},
};
pub use execution::{ContainerExecution, ContainerReadiness};
pub(crate) use limits::DEFAULT_MEMORY_LIMIT_GIB;
pub use limits::{ServiceContainer, ServiceIpc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

pub const SERVICE_KIND: &str = "container_service";
pub const STORAGE_KIND: &str = "container_storage";
/// Data source that observes the selected container readiness contract.
pub const HEALTH_DATA_SOURCE: &str = "host_container_health";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An image-owned service on the managed Docker gateway's engine and network.
/// A private publication can also supply an inference serviceRef.
pub struct Service {
    /// Immutable application image. The image owns its entrypoint and default command.
    pub image: String,
    /// Optional argument list for the image entrypoint, without implicit shell expansion.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<Vec<String>>,
    /// Literal nonsecret configuration files uploaded before startup with mode 0444. Contents are retained in plans and state; these are not secret files or immutable mounts.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub files: BTreeMap<String, String>,
    /// Execution limits. These do not replace the image's model-memory policy.
    #[serde(default)]
    pub container: ContainerExecution,
    /// Listener inside the container. It must match the application's own configuration; omission uses publication.port when published.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u16", range(min = 1, max = 65535))]
    pub port: Option<u16>,
    /// HTTP, managed-runtime status, or image HEALTHCHECK readiness on every apply.
    #[serde(default)]
    pub readiness: ContainerReadiness,
    /// Numeric UID:GID. Omission selects 65532:65532; root requires an explicit 0:0 for images that need it.
    #[serde(default = "default_user")]
    pub user: String,
    /// Literal application settings, visible in configuration, plans/state, exports, and Docker inspection. No host-variable expansion or protected credential delivery.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub environment: BTreeMap<String, String>,
    /// Optional loopback or private IPv4 TCP publication. Omission publishes no port.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "ContainerPublication")]
    pub publication: Option<ContainerPublication>,
    /// Disposable application data. Omission provides /data; destroy removes this volume. Typed model services retain their own storage policy.
    #[serde(default)]
    pub data: ContainerData,
}
fn default_user() -> String {
    "65532:65532".into()
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One application TCP listener on the host.
pub struct ContainerPublication {
    /// Loopback or private host IPv4 address.
    pub bind_address: String,
    /// Same unprivileged TCP port inside the container and on the host.
    pub port: u16,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// An owned disposable data volume. The image must supply a mount directory writable by its configured user.
pub struct ContainerData {
    /// /data or one application directory below /var/lib.
    pub mount_path: String,
}
impl Default for ContainerData {
    fn default() -> Self {
        Self {
            mount_path: "/data".into(),
        }
    }
}

pub(crate) fn constrain_schema(defs: &mut serde_json::Map<String, serde_json::Value>) {
    use crate::config::{constraints as c, schema::validation::property};
    let service = defs["ServiceDefinition"]["oneOf"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|variant| variant["properties"]["kind"]["const"] == "container")
        .unwrap();
    property(service, "image", json!({"pattern":c::IMAGE}));
    property(
        service,
        "user",
        json!({"pattern":c::APPLICATION_USER, "default":"65532:65532"}),
    );
    property(
        service,
        "environment",
        json!({"propertyNames":{"pattern":c::ENV}}),
    );
    property(
        &mut defs["ContainerData"],
        "mountPath",
        json!({"pattern":c::APPLICATION_ROOT}),
    );
    property(
        &mut defs["ContainerPublication"],
        "port",
        json!({"minimum":1024,"maximum":65535}),
    );
}

impl Service {
    pub fn validate(&self) -> Result<(), ConfigError> {
        crate::config::schema::validate_service("container", self)?;
        if let Some(publication) = &self.publication {
            require(
                publication
                    .bind_address
                    .parse::<std::net::Ipv4Addr>()
                    .is_ok_and(|ip| ip.is_loopback() || ip.is_private()),
                "container publication requires a loopback or private IPv4 address",
            )?;
        }
        self.container.resources()?;
        require(
            self.command.iter().flatten().all(|arg| !arg.contains('\0'))
                && self.environment.values().all(|value| !value.contains('\0')),
            "container arguments and environment must not contain NUL",
        )?;
        require(
            self.files.iter().all(|(path, _)| {
                execution::absolute_path(path)
                    && path != "/run/nemoclaw"
                    && !path.starts_with("/run/nemoclaw/")
                    && path != &self.data.mount_path
                    && !path.starts_with(&format!("{}/", self.data.mount_path))
            }),
            "configuration files require canonical paths outside data and protected-input mounts",
        )?;
        require(
            !(self.readiness.path.is_some() && self.readiness.runtime_status.is_some()),
            "choose HTTP or runtime-status readiness, not both",
        )?;
        if let Some(path) = &self.readiness.path {
            require(
                path.starts_with('/')
                    && !path.starts_with("//")
                    && !path.contains(['\0', '\r', '\n'])
                    && self.listener_port() > 0,
                "HTTP readiness requires a path and listener port",
            )?;
        }
        if let Some(path) = &self.readiness.runtime_status {
            require(
                execution::absolute_path(path),
                "runtime status requires a canonical absolute path",
            )?;
        }
        require(
            self.port
                .is_none_or(|port| self.publication.as_ref().is_none_or(|p| p.port == port)),
            "publication port must match the container listener",
        )?;
        Ok(())
    }
    pub(crate) fn listener_port(&self) -> u16 {
        self.port
            .unwrap_or_else(|| self.publication.as_ref().map_or(0, |p| p.port))
    }
    /// The managed local Docker gateway whose engine and network the application shares.
    pub(crate) fn gateway(
        document: &Document,
    ) -> Result<&crate::config::ManagedGateway, ConfigError> {
        let gateway = document.spec.gateway.managed()?;
        require(
            gateway.runtime.provider == crate::config::ComputeDriver::Docker
                && gateway.engine.starts_with("unix:///"),
            "container requires a managed local Docker gateway",
        )?;
        Ok(gateway)
    }
}
fn address(kind: &str, name: &str) -> String {
    format!("nemoclaw_{kind}.{name}")
}

impl Installer for Service {
    fn install(
        &self,
        document: &Document,
        name: &str,
        generations: &Generations,
    ) -> Result<InstallPlan, Error> {
        self.validate()?;
        let gateway = Self::gateway(document)?;
        let resources = self.container.resources()?;
        let process = Process {
            engine: gateway.engine.clone(),
            image: self.image.clone(),
            network_cidr: gateway.network_cidr.clone(),
            image_owned: Some(ImageLaunch {
                user: self.user.clone(),
                environment: self.environment.clone(),
                command: self.command.clone(),
                files: self.files.clone(),
                ulimits: self.container.ulimits.clone(),
            }),
            mount_target: self.data.mount_path.clone(),
            bind_address: self
                .publication
                .as_ref()
                .map_or(String::new(), |p| p.bind_address.clone()),
            port: self.listener_port(),
            shared_memory_bytes: resources.shared_memory_bytes,
            host_ipc: resources.host_ipc,
            memory_bytes: resources.memory_bytes,
            cpu_limit_millis: resources.cpu_limit_millis,
            gpu: self.container.gpu,
            ..Process::default()
        };
        let spec = base::specification(
            document,
            generations,
            SERVICE_KIND,
            format!("{}-container-{name}", document.workspace()),
            gateway.runtime_settings(),
            process,
        )?;
        base::install(
            spec,
            name,
            STORAGE_KIND,
            None,
            [(
                "readiness".into(),
                serde_json::to_string(&self.readiness)
                    .map_err(|_| Error::State("cannot encode container readiness"))?,
            )]
            .into(),
            InstallPlan {
                targets: Vec::new(),
                dependencies: BTreeMap::from([(address(SERVICE_KIND, name), Vec::new())]),
            },
        )
    }
    fn remove(&self, _: &Document, _: &str, _: &Generations) -> Result<RemovePlan, Error> {
        Ok(RemovePlan::default())
    }
}
