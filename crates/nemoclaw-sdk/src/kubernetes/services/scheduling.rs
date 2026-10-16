// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Necessary scheduling conditions checked before replacing a model Pod that may be serving.

use super::Spec;
use crate::ObservationError;
use k8s_openapi::api::core::v1::Node;
use kube::{
    Api, Client,
    api::{DynamicObject, ListParams},
};
use serde_json::Value;
use std::collections::BTreeMap;

/// Whether a replacement changes the Pod's scheduling inputs.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Inputs {
    /// Changed inputs must be shown to fit before the current Pod is replaced.
    Changed,
    /// The scheduler placed the current Pod with these inputs. Only Node state
    /// that definitely blocks them, such as a cordon or a new taint, refuses
    /// the replacement; unreadable Nodes or requests do not.
    Unchanged,
}

pub(super) fn changed(previous: &Spec, desired: &Spec) -> Inputs {
    if previous.architecture != desired.architecture
        || previous.settings.node_selector != desired.settings.node_selector
        || previous.settings.tolerations != desired.settings.tolerations
        || previous.settings.runtime_class_name != desired.settings.runtime_class_name
        || previous.settings.cpu_request_millis != desired.settings.cpu_request_millis
        || previous.settings.memory_request_gib != desired.settings.memory_request_gib
    {
        Inputs::Changed
    } else {
        Inputs::Unchanged
    }
}

pub(super) async fn preflight(
    client: Client,
    spec: &Spec,
    pod: &DynamicObject,
    inputs: Inputs,
) -> Result<(), ObservationError> {
    let nodes = match Api::<Node>::all(client).list(&ListParams::default()).await {
        Ok(nodes) => nodes,
        Err(kube::Error::Api(status))
            if matches!(status.code, 401 | 403) && inputs == Inputs::Unchanged =>
        {
            return Ok(());
        }
        Err(kube::Error::Api(status)) if status.code == 403 => {
            return Err(ObservationError::Backend(
                "changing a model's nodeSelector, tolerations, runtimeClassName, architecture, or CPU or memory requests requires permission to list nodes (cluster scope) to check the replacement Pod; the current Pod was not replaced",
            ));
        }
        Err(kube::Error::Api(status)) if status.code == 401 => {
            return Err(ObservationError::Authentication);
        }
        Err(kube::Error::Api(_)) => return Err(ObservationError::Query),
        Err(_) => return Err(ObservationError::Transport),
    };
    let selector = pod
        .data
        .pointer("/spec/nodeSelector")
        .and_then(Value::as_object)
        .ok_or(ObservationError::Incomplete)?;
    let candidates: Vec<_> = nodes
        .iter()
        .filter(|node| {
            selector.iter().all(|(key, value)| {
                node.metadata
                    .labels
                    .as_ref()
                    .and_then(|labels| labels.get(key))
                    .map(String::as_str)
                    == value.as_str()
            })
        })
        .collect();
    if candidates.is_empty() {
        return Err(failure(spec, "no Node matches nodeSelector"));
    }
    let tolerations = pod
        .data
        .pointer("/spec/tolerations")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|node| {
            !node
                .spec
                .as_ref()
                .is_some_and(|node| node.unschedulable == Some(true))
                || tolerates(
                    tolerations,
                    "node.kubernetes.io/unschedulable",
                    "",
                    "NoSchedule",
                )
        })
        .collect();
    if candidates.is_empty() {
        return Err(failure(
            spec,
            "matching Nodes are cordoned and the Pod has no unschedulable toleration",
        ));
    }
    let candidates: Vec<_> = candidates
        .into_iter()
        .filter(|node| {
            node.spec.as_ref().is_none_or(|node| {
                node.taints.as_ref().is_none_or(|taints| {
                    taints.iter().all(|taint| {
                        !matches!(taint.effect.as_str(), "NoSchedule" | "NoExecute")
                            || tolerates(
                                tolerations,
                                &taint.key,
                                taint.value.as_deref().unwrap_or(""),
                                &taint.effect,
                            )
                    })
                })
            })
        })
        .collect();
    if candidates.is_empty() {
        return Err(failure(
            spec,
            "no matching Node has tolerated scheduling taints",
        ));
    }
    let Some(requests) = requests(pod) else {
        return match inputs {
            Inputs::Changed => Err(failure(
                spec,
                "cannot assess admitted Pod resource requests",
            )),
            Inputs::Unchanged => Ok(()),
        };
    };
    let mut deficient = std::collections::BTreeSet::new();
    let mut unassessed = None;
    'nodes: for node in candidates {
        let Some(allocatable) = node
            .status
            .as_ref()
            .and_then(|status| status.allocatable.as_ref())
        else {
            unassessed = Some("cannot assess Node allocatable resources");
            continue;
        };
        let mut fits = true;
        for (resource, required) in &requests {
            let Some(available) = allocatable
                .get(resource)
                .map(|value| quantity(&value.0))
                .unwrap_or(Some(0))
            else {
                unassessed = Some("cannot assess Node allocatable quantity");
                continue 'nodes;
            };
            if available < *required {
                deficient.insert(resource.as_str());
                fits = false;
            }
        }
        if fits {
            return Ok(());
        }
    }
    if let Some(reason) = unassessed {
        return match inputs {
            Inputs::Changed => Err(failure(spec, reason)),
            Inputs::Unchanged => Ok(()),
        };
    }
    Err(failure(
        spec,
        &format!(
            "no matching Node has enough allocatable {}",
            deficient.into_iter().collect::<Vec<_>>().join(", ")
        ),
    ))
}

fn tolerates(tolerations: &[Value], key: &str, value: &str, effect: &str) -> bool {
    tolerations.iter().any(|toleration| {
        let wanted_key = toleration["key"].as_str().unwrap_or("");
        let wanted_effect = toleration["effect"].as_str().unwrap_or("");
        (wanted_effect.is_empty() || wanted_effect == effect)
            && match toleration["operator"].as_str().unwrap_or("Equal") {
                "Exists" => wanted_key.is_empty() || wanted_key == key,
                "Equal" => wanted_key == key && toleration["value"].as_str().unwrap_or("") == value,
                _ => false,
            }
    })
}

fn failure(spec: &Spec, detail: &str) -> ObservationError {
    ObservationError::ModelScheduling {
        name: spec.name.clone(),
        detail: ObservationError::sanitized_resource_detail(
            &format!("replacement preflight: {detail}; the current Pod was not replaced"),
            &spec.name,
        ),
    }
}

fn requests(pod: &DynamicObject) -> Option<BTreeMap<String, u128>> {
    // Admission can inject init-sidecar lifetimes or Pod-level accounting. Those
    // require scheduler semantics beyond this check; keep the current Pod rather
    // than treating their resource demand as zero.
    if pod
        .data
        .pointer("/spec/initContainers")
        .is_some_and(|value| value.as_array().is_none_or(|values| !values.is_empty()))
        || pod
            .data
            .pointer("/spec/resources")
            .is_some_and(|value| !value.is_null())
    {
        return None;
    }
    let mut requests = BTreeMap::<String, u128>::new();
    for container in pod.data.pointer("/spec/containers")?.as_array()? {
        if let Some(values) = container
            .pointer("/resources/requests")
            .and_then(Value::as_object)
        {
            for (resource, value) in values {
                let current = requests.entry(resource.clone()).or_default();
                *current = current.checked_add(quantity(value.as_str()?)?)?;
            }
        }
    }
    if let Some(values) = pod
        .data
        .pointer("/spec/overhead")
        .and_then(Value::as_object)
    {
        for (resource, value) in values {
            let current = requests.entry(resource.clone()).or_default();
            *current = current.checked_add(quantity(value.as_str()?)?)?;
        }
    }
    Some(requests)
}

// Compare quantities in exact nanounits; even Kubernetes' largest byte quantity fits u128.
fn quantity(value: &str) -> Option<u128> {
    let value = value.strip_prefix('+').unwrap_or(value);
    let split = value
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(value.len());
    let (amount, suffix) = value.split_at(split);
    let (integer, fraction) = amount.split_once('.').unwrap_or((amount, ""));
    let mut mantissa: u128 = format!("{integer}{fraction}").parse().ok()?;
    let exponent = match suffix {
        "" => 9,
        "n" => 0,
        "u" => 3,
        "m" => 6,
        "k" => 12,
        "M" => 15,
        "G" => 18,
        "T" => 21,
        "P" => 24,
        "E" => 27,
        "Ki" | "Mi" | "Gi" | "Ti" | "Pi" | "Ei" => {
            let shift = match suffix {
                "Ki" => 10,
                "Mi" => 20,
                "Gi" => 30,
                "Ti" => 40,
                "Pi" => 50,
                _ => 60,
            };
            mantissa = mantissa.checked_mul(1u128 << shift)?;
            9
        }
        _ if suffix.starts_with(['e', 'E']) => 9i32.checked_add(suffix[1..].parse().ok()?)?,
        _ => return None,
    };
    let exponent = exponent.checked_sub(i32::try_from(fraction.len()).ok()?)?;
    if exponent >= 0 {
        mantissa.checked_mul(10u128.checked_pow(exponent as u32)?)
    } else {
        let divisor = 10u128.checked_pow(exponent.unsigned_abs())?;
        mantissa
            .is_multiple_of(divisor)
            .then_some(mantissa / divisor)
    }
}
