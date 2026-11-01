// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Typed OpenTofu inputs of OpenShell objects and the JSON row fields that carry them.

use crate::{object_kind, type_name};
use nemoclaw_tofu::{Export, Reference, Structured, shape::Shape};
use serde_json::Value;

fn strings() -> Shape {
    Shape::List(Box::new(Shape::String))
}

/// Typed sandbox policy: authored rules and deployment-managed grants.
/// Every sandbox's inputs include it, so it is derived from the schema once.
fn policy_input() -> Shape {
    static POLICY: std::sync::LazyLock<Shape> = std::sync::LazyLock::new(|| {
        let schema = schemars::schema_for!(crate::runtime::PolicyInput).to_value();
        Shape::Object(
            nemoclaw_tofu::shape::fields(&schema, &[])
                .expect("the sandbox policy maps to OpenTofu"),
        )
    });
    POLICY.clone()
}

/// One sandbox service endpoint, in OpenShell's terms.
fn service_input() -> nemoclaw_tofu::shape::Fields {
    use nemoclaw_tofu::shape::Field;
    let field = |json: &str, shape, required, description: &str| {
        (
            json.to_owned(),
            Field {
                json: json.into(),
                shape,
                required,
                description: description.into(),
            },
        )
    };
    [
        field(
            "name",
            Shape::String,
            true,
            "Service name within the sandbox; empty is OpenShell's unnamed endpoint.",
        ),
        field(
            "target_port",
            Shape::Number,
            true,
            "Loopback TCP port the service listens on inside the sandbox.",
        ),
        field(
            "authorization_mode",
            Shape::String,
            false,
            "STRIP or BEARER_PASSTHROUGH; OpenShell uses STRIP when omitted.",
        ),
    ]
    .into()
}

/// The typed inputs of an object kind, and its typed observations.
pub fn structured_inputs(kind: &str) -> Vec<Structured> {
    let input = |attribute, field, shape| Structured {
        attribute,
        field,
        shape,
    };
    match kind {
        "web_search" | "inference" | "api" => {
            vec![input("binaries", "binaries_json", strings())]
        }
        "sandbox" => vec![
            input("policy", "policy_json", policy_input()),
            input("driver_config", "driver_config_json", Shape::Json),
            input(
                "service",
                "services_json",
                Shape::ObjectList(service_input()),
            ),
            // Computed: the URLs the gateway reports, by service name.
            input(
                "service_urls",
                "service_urls_json",
                Shape::Map(Box::new(Shape::String)),
            ),
        ],
        _ => Vec::new(),
    }
}

/// The identity an object kind exports as its `ref`.
pub fn export(kind: &str) -> Option<Export> {
    let fields: &[&'static str] = match kind {
        "workspace" => &["name", "owner", "generation", "id"],
        // Registrations name what sandboxes attach: `registration`.
        "web_search" | "inference" | "api" => &[
            "workspace",
            "name",
            "registration",
            "owner",
            "generation",
            "id",
        ],
        "sandbox" => &["workspace", "name", "owner", "generation", "id"],
        _ => return None,
    };
    Some(Export {
        kind: crate::ref_type(kind),
        fields: fields.to_vec(),
    })
}

/// The type of the gateway's `ref`, which `data.openshell_gateway` exports.
pub const GATEWAY_TYPE: &str = "openshell_gateway";

/// The type of the `ref` a readiness read exports for a confirmed inference
/// server, which inference registrations take as `server`.
pub const INFERENCE_SERVER_TYPE: &str = "inference_server";

/// How to reach a gateway: `(ref attribute, row field)` for each part of
/// its `ref`. Rows carry them without the gateway observing them. A managed
/// Kubernetes gateway's `kubernetes` specification replaces the credential
/// variables: providers connect to it themselves.
pub const GATEWAY_FIELDS: [(&str, &str); 6] = [
    ("endpoint", "gateway_endpoint"),
    ("credential_env", "gateway_credential_env"),
    ("tls_ca_env", "gateway_tls_ca_env"),
    ("tls_certificate_env", "gateway_tls_certificate_env"),
    ("tls_key_env", "gateway_tls_key_env"),
    ("kubernetes", "gateway_kubernetes"),
];

/// A row without the gateway connection it carries. Gateways never observe
/// how they were reached, so their objects compare without it.
pub fn without_gateway(
    row: &std::collections::BTreeMap<String, String>,
) -> std::collections::BTreeMap<String, String> {
    let mut row = row.clone();
    for (_, field) in GATEWAY_FIELDS {
        row.remove(field);
    }
    row
}

/// The `gateway` input every object reached through a gateway takes.
pub fn gateway_reference() -> Reference {
    Reference {
        attribute: "gateway",
        kind: GATEWAY_TYPE,
        fields: GATEWAY_FIELDS.to_vec(),
        list: false,
    }
}

/// The inputs of an object kind that take other objects' `ref`s.
pub fn references(kind: &str) -> Vec<Reference> {
    let mut references = object_references(kind);
    if !type_name(kind).is_empty() {
        references.insert(0, gateway_reference());
    }
    references
}

fn object_references(kind: &str) -> Vec<Reference> {
    let workspace = Reference {
        attribute: "workspace",
        kind: "openshell_workspace",
        fields: vec![("name", "workspace")],
        list: false,
    };
    match kind {
        // A web search registration belongs to its workspace's owner.
        "web_search" | "api" => vec![Reference {
            attribute: "workspace",
            kind: "openshell_workspace",
            fields: vec![("name", "workspace"), ("owner", "owner")],
            list: false,
        }],
        // An inference registration belongs to its workspace's owner and
        // reaches the server a readiness read confirmed.
        "inference" => vec![
            Reference {
                attribute: "workspace",
                kind: "openshell_workspace",
                fields: vec![("name", "workspace"), ("owner", "owner")],
                list: false,
            },
            Reference {
                attribute: "server",
                kind: INFERENCE_SERVER_TYPE,
                fields: vec![
                    ("endpoint", "endpoint"),
                    ("credential_env", "credential_env"),
                    ("credential_source", "credential_source"),
                ],
                list: false,
            },
        ],
        "sandbox" => vec![
            workspace,
            Reference {
                attribute: "providers",
                kind: crate::PROVIDER_TYPE,
                fields: vec![("registration", "provider_names_json")],
                list: true,
            },
        ],
        _ => Vec::new(),
    }
}

/// Rewrite an OpenShell object's OpenTofu values, from state or a plan, into
/// the row fields its `ref` inputs carry, and drop its exported `ref`, so they
/// compare with compiled rows. An omitted reference carries empty fields, as
/// omitted optional inputs do.
pub fn flatten(resource_type: &str, values: &mut Value) {
    let kind = object_kind(resource_type);
    let Some(object) = values.as_object_mut() else {
        return;
    };
    if type_name(kind) != resource_type {
        return;
    }
    object.remove(nemoclaw_tofu::REF);
    for reference in references(kind) {
        let Some(value) = object.remove(reference.attribute) else {
            continue;
        };
        if reference.list {
            let (attribute, field) = reference.fields[0];
            let names: Option<Vec<&str>> = value.as_array().map(|items| {
                items
                    .iter()
                    .filter_map(|item| item[attribute].as_str())
                    .collect()
            });
            let carried = names.map_or_else(String::new, |names| {
                serde_json::to_string(&names).expect("names serialize")
            });
            object.insert(field.into(), Value::String(carried));
            continue;
        }
        for (attribute, field) in reference.fields {
            let carried = value[attribute].as_str().unwrap_or_default();
            object.insert(field.into(), Value::String(carried.into()));
        }
    }
}
