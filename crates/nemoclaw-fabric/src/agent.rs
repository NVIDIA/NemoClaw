// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A Fabric agent as typed inputs: the sections of Fabric's agent
//! configuration that a deployment sets, and the document they compose.

use nemoclaw_tofu::{Reference, Row, Structured, shape::Shape};
use serde_json::{Value, json};

/// The Fabric configuration document version agents use.
pub const SCHEMA_VERSION: &str = "fabric.agent/v1alpha1";

/// Row fields of an agent's own inputs.
pub const NAME: &str = "name";
pub const DESCRIPTION: &str = "description";
pub const ADAPTER_ID: &str = "adapter_id";

/// The resource type of an agent, and the type of the harness `ref` it takes.
pub const RESOURCE_TYPE: &str = "fabric_agent";
pub const HARNESS_TYPE: &str = "fabric_harness";

/// Row fields its sandbox and harness refs carry beyond the agent's own.
pub const SANDBOX: &str = "sandbox";
pub const HARNESS_IMAGE: &str = "harness_image";
pub const HARNESS_CATALOG: &str = "harness_catalog_json";

/// The inputs an agent takes as refs: how to reach its gateway, the sandbox
/// that runs it, and the harness that sandbox launches.
pub fn references() -> Vec<Reference> {
    vec![
        nemoclaw_openshell::gateway_reference(),
        Reference {
            attribute: "sandbox",
            kind: nemoclaw_openshell::type_name("sandbox"),
            fields: vec![
                ("name", SANDBOX),
                ("workspace", "workspace"),
                ("owner", "owner"),
                ("generation", "generation"),
                ("id", "sandbox_id"),
            ],
            list: false,
        },
        Reference {
            attribute: "harness",
            kind: HARNESS_TYPE,
            fields: vec![
                (ADAPTER_ID, ADAPTER_ID),
                ("image", HARNESS_IMAGE),
                ("catalog_json", HARNESS_CATALOG),
            ],
            list: false,
        },
    ]
}

/// Rewrite an agent's OpenTofu values, from state or a plan, into the row
/// fields its inputs carry, so they compare with compiled rows.
pub fn flatten(resource_type: &str, values: &mut Value) {
    let Some(object) = values.as_object_mut() else {
        return;
    };
    if resource_type != RESOURCE_TYPE {
        return;
    }
    object.remove(nemoclaw_tofu::REF);
    for reference in references() {
        let value = object.remove(reference.attribute).unwrap_or_default();
        for (attribute, field) in reference.fields {
            let carried = value[attribute].as_str().unwrap_or_default();
            object.insert(field.into(), carried.into());
        }
    }
    for input in structured_inputs() {
        let value = object.remove(input.attribute).unwrap_or_default();
        let encoded = input.row_value(value).ok().flatten().unwrap_or_default();
        object.insert(input.field.into(), encoded.into());
    }
}

/// Typed inputs and the row fields carrying their JSON: harness settings, then
/// Fabric's configuration sections by name.
pub const SETTINGS: (&str, &str) = ("settings", "settings_json");
const RUNTIME: &str = "runtime";
pub const SECTIONS: [(&str, &str); 11] = [
    ("instructions", "instructions_json"),
    ("models", "models_json"),
    ("runtime", "runtime_config_json"),
    ("tools", "tools_json"),
    ("skills", "skills_json"),
    ("mcp", "mcp_json"),
    ("workflow", "workflow_json"),
    ("environment", "environment_json"),
    ("discovery", "discovery_json"),
    ("relay", "relay_json"),
    ("telemetry", "telemetry_json"),
];

/// The typed inputs of an agent, shaped by Fabric's own configuration schema.
pub fn structured_inputs() -> Vec<Structured> {
    let mut schema = nemo_fabric_core::generate_schema(nemo_fabric_core::SchemaName::Agent)
        .expect("Fabric publishes its agent configuration schema");
    // Other sections are not inputs, and some have no OpenTofu type.
    if let Some(properties) = schema["properties"].as_object_mut() {
        properties.retain(|name, _| {
            name == "harness" || SECTIONS.iter().any(|(section, _)| section == name)
        });
    }
    let fields = nemoclaw_tofu::shape::fields(&schema, &[])
        .expect("Fabric's agent configuration sections map to OpenTofu");
    let Shape::Object(harness) = &fields["harness"].shape else {
        panic!("Fabric's harness section is an object")
    };
    std::iter::once(Structured {
        attribute: SETTINGS.0,
        field: SETTINGS.1,
        shape: harness["settings"].shape.clone(),
    })
    .chain(SECTIONS.iter().map(|&(section, field)| Structured {
        attribute: section,
        field,
        shape: fields[section].shape.clone(),
    }))
    .collect()
}

/// The Fabric configuration document a row describes.
pub fn compose(row: &Row) -> Result<Value, String> {
    let text = |field: &str| row.get(field).map(String::as_str).unwrap_or_default();
    let section = |attribute: &str, field: &str| -> Result<Option<Value>, String> {
        match text(field) {
            "" => Ok(None),
            encoded => serde_json::from_str::<Value>(encoded)
                .map(|value| Some(value).filter(|value| !value.is_null()))
                .map_err(|_| format!("{attribute} is not valid JSON")),
        }
    };
    let mut metadata = json!({ "name": text(NAME) });
    if !text(DESCRIPTION).is_empty() {
        metadata["description"] = text(DESCRIPTION).into();
    }
    let mut harness = json!({ "adapter_id": text(ADAPTER_ID) });
    if let Some(settings) = section(SETTINGS.0, SETTINGS.1)? {
        harness["settings"] = settings;
    }
    let mut config = json!({
        "schema_version": SCHEMA_VERSION,
        "metadata": metadata,
        "harness": harness,
    });
    for (name, field) in SECTIONS {
        if let Some(value) = section(name, field)? {
            config[name] = value;
        }
    }
    // Fabric requires a runtime section; an omitted one sets nothing.
    if config.get(RUNTIME).is_none() {
        config[RUNTIME] = json!({});
    }
    Ok(config)
}

/// The derived attribute holding the digest of the document an agent applies.
pub const CONFIG_SHA256: &str = "config_sha256";

/// The inputs an agent's document depends on.
fn document_fields() -> impl Iterator<Item = &'static str> {
    [NAME, DESCRIPTION, ADAPTER_ID, SETTINGS.1]
        .into_iter()
        .chain(SECTIONS.map(|(_, field)| field))
}

/// `sha256:<hex>` over a document's JSON with object keys sorted, so equal
/// documents have equal digests whatever their key order.
pub fn digest(config: &Value) -> String {
    use sha2::{Digest, Sha256};
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), sorted(value)))
                    .collect::<std::collections::BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    let canonical = serde_json::to_string(&sorted(config)).expect("JSON serializes");
    let hash = Sha256::digest(canonical.as_bytes());
    format!(
        "sha256:{}",
        hash.iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

/// The digest of an agent's document, once the inputs it needs are known.
pub fn config_digest(known: &Row, unknown: &[&str]) -> Option<String> {
    if document_fields().any(|field| unknown.contains(&field)) {
        return None;
    }
    compose(known).ok().map(|config| digest(&config))
}

/// The row fields a Fabric configuration document sets; every typed input is
/// present, empty when the document omits it.
pub fn decompose(config: &Value) -> Row {
    let text = |value: &Value| value.as_str().unwrap_or_default().to_owned();
    let encoded = |value: &Value| {
        if value.is_null() {
            String::new()
        } else {
            value.to_string()
        }
    };
    let mut row = Row::from([
        (NAME.into(), text(&config["metadata"]["name"])),
        (DESCRIPTION.into(), text(&config["metadata"]["description"])),
        (ADAPTER_ID.into(), text(&config["harness"]["adapter_id"])),
        (SETTINGS.1.into(), encoded(&config["harness"]["settings"])),
    ]);
    for (name, field) in SECTIONS {
        let value = &config[name];
        let empty_runtime =
            name == RUNTIME && value.as_object().is_some_and(|section| section.is_empty());
        row.insert(
            field.into(),
            if empty_runtime {
                String::new()
            } else {
                encoded(value)
            },
        );
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;
    use nemoclaw_tofu::shape::Shape;
    use serde_json::json;

    fn document() -> Value {
        json!({
            "schema_version": SCHEMA_VERSION,
            "metadata": {"name": "travel", "description": "Plans trips."},
            "harness": {"adapter_id": "nvidia.fabric.pi", "settings": {"budget": 4}},
            "instructions": {"system": {"content": "Be brief.", "mode": "replace"}},
            "models": {"default": {"provider": "openai", "model": "nemotron", "base_url": "https://inference.local/v1"}},
            "runtime": {"artifacts": "/sandbox/artifacts", "timeout_seconds": 600},
            "tools": {"enabled": ["bash"]},
        })
    }

    #[test]
    fn inputs_follow_fabric_configuration_sections() {
        let inputs = structured_inputs();
        let shape = |attribute: &str| {
            inputs
                .iter()
                .find(|input| input.attribute == attribute)
                .map(|input| (input.field, input.shape.clone()))
                .unwrap_or_else(|| panic!("{attribute} is an input"))
        };
        assert_eq!(shape("settings"), ("settings_json", Shape::Json));
        assert!(matches!(shape("models").1, Shape::ObjectMap(_)));
        let Shape::Object(instructions) = shape("instructions").1 else {
            panic!("instructions are a block")
        };
        assert_eq!(instructions["system"].json, "system");
        let Shape::Object(runtime) = shape("runtime").1 else {
            panic!("runtime is a block")
        };
        assert!(runtime.contains_key("timeout_seconds"));
        assert_eq!(shape("tools").0, "tools_json");
        assert_eq!(inputs.len(), 1 + SECTIONS.len());
    }

    /// Every section Fabric defines is an input, so none is dropped.
    #[test]
    fn every_fabric_section_is_an_input() {
        let schema =
            nemo_fabric_core::generate_schema(nemo_fabric_core::SchemaName::Agent).unwrap();
        let mut defined: Vec<&str> = schema["properties"]
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .filter(|name| !["schema_version", "metadata", "harness"].contains(name))
            .collect();
        defined.sort_unstable();
        let mut inputs: Vec<&str> = SECTIONS.iter().map(|(section, _)| *section).collect();
        inputs.sort_unstable();
        assert_eq!(inputs, defined);
    }

    #[test]
    fn a_document_splits_into_inputs_and_composes_again() {
        let row = decompose(&document());
        assert_eq!(row[NAME], "travel");
        assert_eq!(row[DESCRIPTION], "Plans trips.");
        assert_eq!(row[ADAPTER_ID], "nvidia.fabric.pi");
        assert_eq!(row["settings_json"], r#"{"budget":4}"#);
        assert_eq!(row["tools_json"], r#"{"enabled":["bash"]}"#);
        assert_eq!(compose(&row).unwrap(), document());
    }

    #[test]
    fn omitted_inputs_are_absent_from_the_document() {
        let mut minimal = document();
        let object = minimal.as_object_mut().unwrap();
        for section in ["instructions", "models", "tools"] {
            object.remove(section);
        }
        // Fabric requires a runtime section, so an empty one stands for none.
        object.insert("runtime".into(), json!({}));
        object["metadata"]
            .as_object_mut()
            .unwrap()
            .remove("description");
        object["harness"]
            .as_object_mut()
            .unwrap()
            .remove("settings");
        let row = decompose(&minimal);
        for field in [
            "settings_json",
            "instructions_json",
            "models_json",
            "runtime_config_json",
            "tools_json",
            DESCRIPTION,
        ] {
            assert_eq!(row[field], "", "{field}");
        }
        assert_eq!(compose(&row).unwrap(), minimal);
        // Null settings mean no settings.
        let mut null = minimal.clone();
        null["harness"]["settings"] = Value::Null;
        assert_eq!(decompose(&null)["settings_json"], "");
    }

    #[test]
    fn an_agent_takes_its_gateway_sandbox_and_harness_by_ref() {
        let references = references();
        let kinds: Vec<_> = references
            .iter()
            .map(|reference| (reference.attribute, reference.kind))
            .collect();
        assert_eq!(
            kinds,
            [
                ("gateway", "openshell_gateway"),
                ("sandbox", "openshell_sandbox"),
                ("harness", HARNESS_TYPE)
            ]
        );
        // The SDK names a referenced object by the first field it carries.
        assert_eq!(references[1].fields[0], ("name", SANDBOX));
    }

    /// State and plans hold typed values; rows hold the fields they carry.
    #[test]
    fn typed_values_flatten_into_row_fields() {
        let mut values = json!({
            "name": "travel",
            "ref": {"type": "fabric_agent"},
            "sandbox": {"type": "openshell_sandbox", "workspace": "team", "name": "travel", "owner": "o", "generation": "g", "id": "sandbox-id"},
            "harness": {"type": HARNESS_TYPE, "adapter_id": "nvidia.fabric.pi", "image": "image@sha256:aa", "catalog_json": "{}"},
            "settings": "{\"budget\":4}",
            "instructions": [{"system": [{"content": "Be brief.", "mode": null}]}],
            "models": {"default": {"provider": "openai", "model": "nemotron", "base_url": null}},
            "runtime": [],
            "tools": null,
        });
        flatten(RESOURCE_TYPE, &mut values);
        let row: Row = serde_json::from_value(values).unwrap();
        assert_eq!(row[NAME], "travel");
        assert_eq!(row[SANDBOX], "travel");
        assert_eq!(row["workspace"], "team");
        assert_eq!(row["sandbox_id"], "sandbox-id");
        assert_eq!(row[ADAPTER_ID], "nvidia.fabric.pi");
        assert_eq!(row[HARNESS_CATALOG], "{}");
        assert_eq!(row["settings_json"], r#"{"budget":4}"#);
        assert_eq!(
            row["instructions_json"],
            r#"{"system":{"content":"Be brief."}}"#
        );
        assert_eq!(
            row["models_json"],
            r#"{"default":{"model":"nemotron","provider":"openai"}}"#
        );
        assert_eq!(row["runtime_config_json"], "");
        assert_eq!(row["tools_json"], "");
        assert!(!row.contains_key("ref"));
        // Other types are left alone.
        let mut other = json!({"ref": {}});
        flatten("openshell_sandbox", &mut other);
        assert_eq!(other, json!({"ref": {}}));
    }

    /// Fabric requires some sections; an agent that omits them still composes
    /// a document Fabric accepts.
    #[test]
    fn a_minimal_agent_is_valid_fabric_configuration() {
        let row = Row::from([
            (NAME.into(), "travel".into()),
            (ADAPTER_ID.into(), "nvidia.fabric.pi".into()),
        ]);
        let config = compose(&row).unwrap();
        if let Err(error) = serde_json::from_value::<nemo_fabric_core::FabricConfig>(config.clone())
        {
            panic!("{error}");
        }
        assert_eq!(compose(&decompose(&config)).unwrap(), config);
    }

    /// The harness's catalog decides which fields an agent may set.
    #[test]
    fn an_agent_is_planned_against_its_harness_catalog() {
        let mut row = decompose(&json!({
            "schema_version": SCHEMA_VERSION,
            "metadata": {"name": "assistant"},
            "harness": {"adapter_id": "nvidia.fabric.pi"},
            "instructions": {"system": {"content": "Answer briefly.", "mode": "replace"}},
            "models": {"default": {"provider": "openai", "model": "first-model", "api_key_env": "API_KEY"}},
        }));
        let catalog = crate::catalog::FabricCatalog::bundled().for_adapter("nvidia.fabric.pi");
        let rejection = |row: &Row| {
            crate::capabilities::configuration_rejection(&catalog, compose(row).unwrap())
        };
        assert_eq!(rejection(&row), None);
        row.insert(
            "models_json".into(),
            r#"{"default":{"provider":"openai","model":"first-model"}}"#.into(),
        );
        assert_eq!(
            rejection(&row).as_deref(),
            Some(
                "models.default.api_key_env: the selected adapter rejects this configuration field"
            )
        );
    }

    /// Typed inputs carry a document without loss, including fields Fabric's
    /// schema leaves open, such as a model's `api` extension.
    #[test]
    fn typed_inputs_keep_every_field_of_a_document() {
        let mut config = document();
        config["models"]["default"]["api"] = "openai-completions".into();
        config["models"]["default"]["max_tokens"] = 4096.into();
        config["models"]["default"]["settings"] = json!({"reasoning": {"effort": "low"}});
        config["environment"] = json!({"provider": "local", "workspace": "/sandbox/workspace"});
        let mut row = decompose(&config);
        for input in structured_inputs() {
            let encoded = row[input.field].clone();
            if encoded.is_empty() {
                continue;
            }
            let typed = input.configuration(&encoded).unwrap();
            row.insert(input.field.into(), input.row_value(typed).unwrap().unwrap());
        }
        assert_eq!(compose(&row).unwrap(), config);
    }

    /// The digest identifies a document's content, whatever its key order.
    #[test]
    fn a_digest_identifies_a_document_regardless_of_key_order() {
        let config = document();
        let reordered: Value =
            serde_json::from_str(r#"{"tools":{"enabled":["bash"]},"runtime":{"timeout_seconds":600,"artifacts":"/sandbox/artifacts"},"models":{"default":{"base_url":"https://inference.local/v1","model":"nemotron","provider":"openai"}},"metadata":{"description":"Plans trips.","name":"travel"},"instructions":{"system":{"mode":"replace","content":"Be brief."}},"harness":{"settings":{"budget":4},"adapter_id":"nvidia.fabric.pi"},"schema_version":"fabric.agent/v1alpha1"}"#)
                .unwrap();
        assert_eq!(digest(&reordered), digest(&config));
        assert!(digest(&config).starts_with("sha256:"));
        assert_eq!(digest(&config).len(), "sha256:".len() + 64);
        let mut changed = config.clone();
        changed["tools"]["enabled"] = json!(["read"]);
        assert_ne!(digest(&changed), digest(&config));
    }

    /// An agent's digest is known once the inputs its document needs are.
    #[test]
    fn the_configuration_digest_waits_for_the_document_inputs() {
        let row = decompose(&document());
        assert_eq!(
            config_digest(&row, &[]),
            Some(digest(&compose(&row).unwrap()))
        );
        assert_eq!(
            config_digest(&row, &["sandbox_id"]),
            config_digest(&row, &[])
        );
        assert_eq!(config_digest(&row, &["models_json"]), None);
        assert_eq!(config_digest(&row, &[NAME]), None);
    }

    #[test]
    fn a_section_that_is_not_json_names_its_input() {
        let mut row = decompose(&document());
        row.insert("models_json".into(), "{".into());
        assert_eq!(compose(&row).unwrap_err(), "models is not valid JSON");
    }
}
