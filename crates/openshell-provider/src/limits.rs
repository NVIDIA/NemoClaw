// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A sandbox's CPU and memory limits: OpenShell's `template.resources.limits`,
//! the request its `sandbox create --cpu` and `--memory` send. OpenShell
//! validates the quantities and its compute driver applies them.
use prost_types::{Struct, Value, value::Kind};
use std::collections::BTreeMap;

const LIMITS: &str = "limits";

/// The limits a sandbox requests, or none when both inputs are empty.
pub(super) fn request(cpu: &str, memory: &str) -> Option<Struct> {
    let limits: BTreeMap<_, _> = [("cpu", cpu), ("memory", memory)]
        .into_iter()
        .filter(|(_, quantity)| !quantity.is_empty())
        .map(|(name, quantity)| {
            (
                name.to_owned(),
                Value {
                    kind: Some(Kind::StringValue(quantity.to_owned())),
                },
            )
        })
        .collect();
    (!limits.is_empty()).then(|| Struct {
        fields: [(
            LIMITS.to_owned(),
            Value {
                kind: Some(Kind::StructValue(Struct { fields: limits })),
            },
        )]
        .into(),
    })
}

/// The CPU and memory inputs an observed request corresponds to; empty when
/// the sandbox has no such limit.
pub(super) fn observed(resources: Option<&Struct>) -> (String, String) {
    let limit = |name: &str| {
        resources
            .and_then(|resources| resources.fields.get(LIMITS))
            .and_then(|limits| match &limits.kind {
                Some(Kind::StructValue(limits)) => limits.fields.get(name),
                _ => None,
            })
            .and_then(|quantity| match &quantity.kind {
                Some(Kind::StringValue(quantity)) => Some(quantity.clone()),
                _ => None,
            })
            .unwrap_or_default()
    };
    (limit("cpu"), limit("memory"))
}
