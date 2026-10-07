// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Capacity and scheduling for a model service on the gateway's selected cluster.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One GPU model service in the managed gateway's namespace. Storage survives destroy.
pub struct KubernetesService {
    /// Environment reference to an absolute local OCI metadata bundle for this service image. Plan and apply verify its digest, Linux architecture, and runtime labels before changing cluster resources. Destroy does not read it.
    pub image_metadata: crate::config::Credential,
    /// Requested CPU capacity in millicores.
    #[schemars(range(min = 1))]
    pub cpu_request_millis: u32,
    /// CPU limit in millicores; must be at least the request.
    #[schemars(range(min = 1))]
    pub cpu_limit_millis: u32,
    /// Requested container memory in GiB, independent of the model's GPU budget.
    #[serde(rename = "memoryRequestGiB")]
    #[schemars(range(min = 1))]
    pub memory_request_gib: u64,
    /// Container memory limit in GiB; must be at least the request.
    #[serde(rename = "memoryLimitGiB")]
    #[schemars(range(min = 1))]
    pub memory_limit_gib: u64,
    /// Retained model-volume capacity in GiB.
    #[serde(rename = "storageGiB")]
    #[schemars(range(min = 1))]
    pub storage_gib: u64,
    /// StorageClass for retained volumes. Omission selects the cluster default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    /// Required node labels in addition to the model's declared CPU architecture.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub node_selector: BTreeMap<String, String>,
    /// Node taints the model Pod may tolerate.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tolerations: Vec<ServiceToleration>,
    /// Existing RuntimeClass to use for the model Pod.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime_class_name: Option<String>,
}

impl KubernetesService {
    /// Check declared capacity and scheduling without contacting the cluster.
    pub fn validate(&self) -> Result<(), crate::config::ConfigError> {
        crate::config::schema::validate_definition("KubernetesService", self)?;
        crate::config::validation::require(
            self.cpu_request_millis <= self.cpu_limit_millis
                && self.memory_request_gib <= self.memory_limit_gib,
            "cluster service CPU and memory requests must not exceed their limits",
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
/// One explicit Kubernetes node-taint toleration.
pub struct ServiceToleration {
    /// Taint key. An empty key requires Exists and matches every key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub key: String,
    /// Match the taint's value with Equal, or its presence with Exists.
    pub operator: TolerationOperator,
    /// Value matched by Equal; Exists requires an empty value.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub value: String,
    /// Omission matches all taint effects.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "TolerationEffect")]
    pub effect: Option<TolerationEffect>,
    /// Optional eviction delay, valid only for NoExecute tolerations.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[schemars(with = "u64")]
    pub toleration_seconds: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// How a toleration matches a node taint.
pub enum TolerationOperator {
    Equal,
    Exists,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
/// Node-taint effect matched by a toleration.
pub enum TolerationEffect {
    NoSchedule,
    PreferNoSchedule,
    NoExecute,
}

pub(crate) fn constrain(defs: &mut serde_json::Map<String, Value>) {
    use crate::config::schema::validation::{at, property};
    const DNS_SUBDOMAIN: &str =
        r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*";
    const LABEL_NAME: &str = r"[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?";
    let key = json!({
        "pattern": format!(r"^(?:(?=[^/]{{1,253}}/){DNS_SUBDOMAIN}/)?{LABEL_NAME}$(?![\s\S])")
    });
    let value = json!({"type":"string", "pattern": format!(r"^(?:{LABEL_NAME})?$(?![\s\S])")});
    let settings = &mut defs["KubernetesService"];
    // Kubernetes quantities must fit signed 64-bit bytes after conversion from GiB.
    for field in ["memoryRequestGiB", "memoryLimitGiB", "storageGiB"] {
        property(settings, field, json!({"maximum": (i64::MAX as u64) >> 30}));
    }
    for field in ["storageClass", "runtimeClassName"] {
        property(
            settings,
            field,
            json!({"type":"string", "maxLength":253, "pattern":format!(r"^{DNS_SUBDOMAIN}$(?![\s\S])")}),
        );
    }
    property(
        settings,
        "nodeSelector",
        json!({"propertyNames":key.clone(), "additionalProperties":value.clone()}),
    );
    let toleration = &mut defs["ServiceToleration"];
    property(toleration, "key", json!({"anyOf":[{"const":""},key]}));
    property(toleration, "value", value);
    property(
        toleration,
        "tolerationSeconds",
        json!({"type":"integer", "minimum":0, "maximum":i64::MAX}),
    );
    toleration["allOf"] = json!([
        {"if":at("operator",json!({"const":"Exists"}),true),
         "then":at("value",json!({"const":""}),false),
         "else":at("key",json!({"minLength":1}),true)},
        {"if":{"required":["tolerationSeconds"]},
         "then":at("effect",json!({"const":"NoExecute"}),true)}
    ]);
}
