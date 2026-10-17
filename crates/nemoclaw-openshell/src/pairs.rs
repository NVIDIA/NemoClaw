// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The OpenShell provider profile and registration rows that an
//! `openshell_inference`, `openshell_web_search` or `openshell_api` row owns.
use crate::search::{SearchProvider, web_search_names};
use std::collections::BTreeMap;

type Row = BTreeMap<String, String>;

fn value<'a>(row: &'a Row, field: &str) -> &'a str {
    row.get(field).map(String::as_str).unwrap_or_default()
}

/// The workspace, identity, and gateway connection both rows share.
fn common(row: &Row) -> Row {
    ["workspace", "owner", "generation"]
        .into_iter()
        .chain(crate::GATEWAY_FIELDS.map(|(_, field)| field))
        .filter_map(|field| Some((field.to_owned(), row.get(field)?.clone())))
        .collect()
}

/// The registration row's binding to the object it established.
fn bind(registration: &mut Row, row: &Row) {
    if let Some(id) = row.get("id").filter(|id| !id.is_empty()) {
        registration.insert("id".into(), id.clone());
    }
}

/// The profile and registration an API credential resource owns. Changing the
/// host reference keeps the profile's placeholder and the registration name.
pub fn api_rows(row: &Row) -> (Row, Row) {
    let profile = format!("nemoclaw-api-{}", value(row, "name"));
    let mut profile_row = common(row);
    profile_row.insert("name".into(), profile.clone());
    for field in ["endpoint", "binaries_json", "auth_style", "header_name"] {
        profile_row.insert(field.into(), value(row, field).into());
    }
    let mut registration = common(row);
    registration.extend([
        ("name".into(), value(row, "name").into()),
        ("profile_name".into(), profile),
        ("provider_type".into(), "api".into()),
        ("endpoint".into(), value(row, "endpoint").into()),
        ("credential_env".into(), value(row, "credential_env").into()),
    ]);
    bind(&mut registration, row);
    (profile_row, registration)
}

/// The profile and registration rows a web search row owns, or `None` for an
/// unknown search provider.
pub fn web_search_rows(row: &Row) -> Option<(Row, Row)> {
    let provider = SearchProvider::from_name(value(row, "provider_type"))?;
    let (profile, registration) =
        web_search_names(provider, value(row, "credential_env"), value(row, "name"));
    let mut profile_row = common(row);
    profile_row.extend([
        ("name".into(), profile.clone()),
        ("binaries_json".into(), value(row, "binaries_json").into()),
    ]);
    let mut registration_row = common(row);
    registration_row.extend([
        ("name".into(), registration),
        ("endpoint".into(), provider.endpoint().into()),
        ("credential_env".into(), value(row, "credential_env").into()),
        ("provider_type".into(), provider.name().into()),
        ("profile_name".into(), profile),
    ]);
    bind(&mut registration_row, row);
    Some((profile_row, registration_row))
}

/// The provider type an inference `api` registers: Anthropic's, or the
/// OpenAI-compatible default. `None` for an unknown API.
pub fn inference_provider_type(api: &str) -> Option<&'static str> {
    match api {
        "openai-completions" | "openai-responses" => Some(""),
        "anthropic-messages" => Some("anthropic"),
        _ => None,
    }
}

/// The profile and registration rows an inference row owns, or `None` for an
/// unknown API. The profile is named after the registration, which finds it
/// by that name.
pub fn inference_rows(row: &Row) -> Option<(Row, Row)> {
    let provider_type = inference_provider_type(value(row, "api"))?;
    let authenticated =
        !value(row, "credential_env").is_empty() || !value(row, "credential_source").is_empty();
    let mut profile_row = common(row);
    profile_row.extend([
        (
            "name".into(),
            format!("nemoclaw-inference-{}", value(row, "name")),
        ),
        ("endpoint".into(), value(row, "endpoint").into()),
        ("provider_type".into(), provider_type.into()),
        ("authenticated".into(), authenticated.to_string()),
        ("binaries_json".into(), value(row, "binaries_json").into()),
        ("cluster_source".into(), value(row, "cluster_source").into()),
    ]);
    let mut registration_row = common(row);
    registration_row.extend([
        ("name".into(), value(row, "name").into()),
        ("endpoint".into(), value(row, "endpoint").into()),
        ("credential_env".into(), value(row, "credential_env").into()),
        (
            "credential_source".into(),
            value(row, "credential_source").into(),
        ),
        ("provider_type".into(), provider_type.into()),
    ]);
    bind(&mut registration_row, row);
    Some((profile_row, registration_row))
}
