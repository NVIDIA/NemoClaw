// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Runtime settings compiled from a managed gateway's authored settings.
//!
//! Deployment state binds these settings as gateway resource attributes and in
//! service specifications, and container labels hash the specifications that
//! carry them, so their layout stays fixed when the authored configuration
//! changes. They carry the gateway image, which the SDK pins and documents do
//! not name.

use crate::config::{
    ConfigError, DEFAULT_GATEWAY_IMAGE, ImagePullPolicy, ManagedGateway, ManagedKubernetes, Runtime,
};
use serde::{Deserialize, Serialize};

/// A managed gateway's runtime settings, with the SDK's gateway image pin on a
/// local engine.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct GatewaySettings {
    pub runtime: Runtime,
    pub endpoint: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub engine: String,
    /// The SDK's gateway image pin on a local engine, and empty on Kubernetes,
    /// whose chart values carry the pinned images.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub image: String,
    /// Mutable acquisition policy supplied by the provider, excluded from
    /// container identity.
    #[serde(rename = "imagePullPolicy", skip_serializing_if = "Option::is_none")]
    pub image_pull_policy: Option<ImagePullPolicy>,
    #[serde(rename = "networkCIDR", skip_serializing_if = "String::is_empty")]
    pub network_cidr: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kubernetes: Option<ManagedKubernetes>,
}

impl ManagedGateway {
    /// Runtime settings for this gateway, with the SDK's gateway image pin on a
    /// local engine. The acquisition policy is a mutable provider attribute
    /// rather than container identity, so it is left out.
    pub(crate) fn runtime_settings(&self) -> GatewaySettings {
        GatewaySettings {
            runtime: self.runtime.clone(),
            endpoint: self.endpoint.clone(),
            engine: self.engine.clone(),
            image: if self.kubernetes.is_none() {
                DEFAULT_GATEWAY_IMAGE.into()
            } else {
                String::new()
            },
            image_pull_policy: None,
            network_cidr: self.network_cidr.clone(),
            kubernetes: self.kubernetes.clone(),
        }
    }
}

impl GatewaySettings {
    /// Validate the authored settings and the image: a local engine requires
    /// the SDK's gateway image pin, and Kubernetes takes no image.
    ///
    /// # Errors
    /// Returns the authored gateway's validation error, or an error for any
    /// other image.
    pub fn validate_managed(&self) -> Result<(), ConfigError> {
        ManagedGateway {
            runtime: self.runtime.clone(),
            endpoint: self.endpoint.clone(),
            engine: self.engine.clone(),
            image_pull_policy: self.image_pull_policy,
            network_cidr: self.network_cidr.clone(),
            kubernetes: self.kubernetes.clone(),
        }
        .validate_managed()?;
        let pinned = match self.kubernetes {
            None => self.image == DEFAULT_GATEWAY_IMAGE,
            Some(_) => self.image.is_empty(),
        };
        crate::config::validation::require(
            pinned,
            "managed gateway settings require the SDK's gateway image pin on a local engine and no image on Kubernetes",
        )
    }

    /// Resolve the first address after the configured network address.
    ///
    /// # Errors
    /// Returns an error for a Kubernetes gateway, a malformed IPv4 CIDR, or an
    /// address overflow.
    pub fn bridge(&self) -> Result<String, ConfigError> {
        if self.kubernetes.is_some() {
            return Err(ConfigError::new(
                "Kubernetes gateways have no local engine bridge",
            ));
        }
        crate::config::bridge_address(&self.network_cidr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ComputeDriver, Document};

    fn spark() -> GatewaySettings {
        Document::parse(include_bytes!("../../tests/fixtures/config/spark.yaml").as_slice())
            .unwrap()
            .spec
            .gateway
            .managed()
            .unwrap()
            .runtime_settings()
    }

    #[test]
    fn local_settings_require_the_sdk_gateway_image_pin() {
        let settings = spark();
        assert_eq!(settings.image, DEFAULT_GATEWAY_IMAGE);
        settings.validate_managed().unwrap();
        for image in ["", "ghcr.io/nvidia/openshell/gateway@sha256:0000"] {
            let other = GatewaySettings {
                image: image.into(),
                ..settings.clone()
            };
            assert!(other.validate_managed().is_err(), "{image:?}");
        }
        // The provider applies the acquisition policy after compilation.
        let pulled = GatewaySettings {
            image_pull_policy: Some(ImagePullPolicy::Never),
            ..settings
        };
        pulled.validate_managed().unwrap();
    }

    #[test]
    fn kubernetes_settings_take_no_image_or_local_engine_settings() {
        let mut value: serde_json::Value =
            serde_saphyr::from_str(include_str!("../../tests/fixtures/config/local.yaml")).unwrap();
        value["spec"]["gateway"] = serde_json::json!({
            "management": "managed",
            "runtime": {"provider": "openshift"},
            "endpoint": "https://127.0.0.1:17671",
            "kubernetes": {
                "kubeconfig": {"env": "CLUSTER_KUBECONFIG"}, "context": "explicit",
                "namespace": "agents", "authentication": {"profile": "development"}
            }
        });
        value["spec"]["sandboxes"][0]["image"]["metadata"] =
            serde_json::json!({"env": "IMAGE_METADATA"});
        let document = Document::parse(value.to_string().as_bytes()).unwrap();
        let settings = document
            .spec
            .gateway
            .as_managed()
            .unwrap()
            .runtime_settings();
        assert_eq!(settings.runtime.provider, ComputeDriver::OpenShift);
        assert_eq!(
            serde_json::to_string(&settings).unwrap(),
            r#"{"runtime":{"provider":"openshift"},"endpoint":"https://127.0.0.1:17671","kubernetes":{"kubeconfig":{"env":"CLUSTER_KUBECONFIG"},"context":"explicit","namespace":"agents","authentication":{"profile":"development"}}}"#
        );
        settings.validate_managed().unwrap();
        assert!(settings.bridge().is_err());
        for changed in [
            GatewaySettings {
                image: DEFAULT_GATEWAY_IMAGE.into(),
                ..settings.clone()
            },
            GatewaySettings {
                engine: "unix:///var/run/docker.sock".into(),
                ..settings.clone()
            },
            GatewaySettings {
                network_cidr: "172.30.1.0/24".into(),
                ..settings
            },
        ] {
            assert!(changed.validate_managed().is_err(), "{changed:?}");
        }
    }
}
