// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Resources with typed attributes and blocks whose backends take JSON.
//!
//! The adapter and its planning rules work on string rows. A structured input
//! reaches them as canonical JSON in its row field, and leaves them as the
//! typed value OpenTofu planned, so planned and applied values never differ.

use crate::{
    Definition, ResourceAdapter, State,
    shape::{Dynamic, Fields, Shape, block, dynamic, from_hcl, json, single_blocks, to_hcl},
};
use async_trait::async_trait;
use serde_json::Value as Json;
use std::collections::BTreeMap;
use tf_provider::{
    AttributePath, Diagnostics, Resource,
    schema::{Attribute, AttributeConstraint, NestedBlock, Schema},
    value::{Value, ValueEmpty},
};

/// OpenTofu values of a resource with typed inputs.
pub type StructuredState = BTreeMap<String, Value<Dynamic>>;

/// A typed input attribute carried as JSON in a backend row field.
#[derive(Clone, Debug)]
pub struct Structured {
    pub attribute: &'static str,
    pub field: &'static str,
    pub shape: Shape,
}

impl Structured {
    fn encode(&self, value: &Value<Dynamic>) -> Result<Value<String>, &'static str> {
        Ok(match value {
            Value::Unknown => Value::Unknown,
            Value::Null => Value::Null,
            value => match json(value) {
                None => Value::Unknown,
                Some(value) => match self.row_value(value)? {
                    Some(encoded) => Value::Value(encoded),
                    None => Value::Null,
                },
            },
        })
    }
    /// The row field's canonical JSON for a known OpenTofu value, as state or
    /// a plan records it; `None` when the input is absent.
    pub fn row_value(&self, value: Json) -> Result<Option<String>, &'static str> {
        // An optional block arrives as a list of at most one block.
        let value = match (&self.shape, value) {
            (Shape::Object(_), Json::Array(mut items)) => items.pop().unwrap_or(Json::Null),
            (_, value) => value,
        };
        if value.is_null() {
            return Ok(None);
        }
        let value = single_blocks(&self.shape, value);
        let value = match &self.shape {
            Shape::Object(fields) => from_hcl(fields, &value),
            _ => value,
        };
        serde_json::to_string(&value)
            .map(Some)
            .map_err(|_| "cannot encode input")
    }
    /// OpenTofu configuration for the row field's JSON, as a graph declares it.
    pub fn configuration(&self, encoded: &str) -> Result<Json, &'static str> {
        let value: Json = serde_json::from_str(encoded).map_err(|_| "invalid input JSON")?;
        Ok(match &self.shape {
            Shape::Object(fields) => to_hcl(fields, &value),
            _ => value,
        })
    }
    fn decode(&self, value: &Value<String>) -> Value<Dynamic> {
        match value {
            Value::Value(encoded) if !encoded.is_empty() => {
                match serde_json::from_str::<Json>(encoded) {
                    Ok(value) => wire(
                        &self.shape,
                        &match &self.shape {
                            Shape::Object(fields) => to_hcl(fields, &value),
                            _ => value,
                        },
                    ),
                    Err(_) => Value::Unknown,
                }
            }
            Value::Unknown => Value::Unknown,
            _ => absent(&self.shape),
        }
    }
}

/// The value OpenTofu holds for an absent input of this shape.
fn absent(shape: &Shape) -> Value<Dynamic> {
    match shape {
        Shape::Object(_) | Shape::ObjectList(_) => Value::Value(Dynamic::List(Vec::new())),
        Shape::ObjectMap(_) => Value::Value(Dynamic::Map(BTreeMap::new())),
        _ => Value::Null,
    }
}

/// The complete OpenTofu value of known JSON with OpenTofu names: blocks carry
/// every attribute, an optional block is a list of at most one, and absent
/// collections of blocks are empty.
fn wire(shape: &Shape, value: &Json) -> Value<Dynamic> {
    fn object(fields: &Fields, value: &Json) -> Value<Dynamic> {
        Value::Value(Dynamic::Map(
            fields
                .iter()
                .map(|(name, field)| {
                    let item = value.get(name).filter(|item| !item.is_null());
                    let item = match (&field.shape, item) {
                        (Shape::Object(fields), Some(item)) if field.required => {
                            object(fields, item)
                        }
                        (shape, Some(item)) => wire(shape, item),
                        (shape, None) => absent(shape),
                    };
                    (name.clone(), item)
                })
                .collect(),
        ))
    }
    match (shape, value) {
        (_, Json::Null) => absent(shape),
        (Shape::Object(fields), value) => Value::Value(Dynamic::List(vec![object(fields, value)])),
        (Shape::ObjectList(fields), Json::Array(items)) => Value::Value(Dynamic::List(
            items.iter().map(|item| object(fields, item)).collect(),
        )),
        (Shape::ObjectMap(fields), Json::Object(entries)) => Value::Value(Dynamic::Map(
            entries
                .iter()
                .map(|(key, item)| (key.clone(), object(fields, item)))
                .collect(),
        )),
        (_, value) => dynamic(value),
    }
}

/// A resource adapter whose structured inputs are typed in OpenTofu.
pub struct StructuredAdapter(pub ResourceAdapter);

impl StructuredAdapter {
    fn definition(&self) -> &Definition {
        self.0.definition()
    }
    fn structured(&self, name: &str) -> Option<&Structured> {
        self.definition()
            .structured
            .iter()
            .find(|structured| structured.attribute == name)
    }
    /// The adapter's string state for typed OpenTofu values.
    fn inward(&self, diags: &mut Diagnostics, state: &StructuredState) -> Option<State> {
        let mut inward = State::new();
        for (name, value) in state {
            if let Some(structured) = self.structured(name) {
                match structured.encode(value) {
                    Ok(value) => inward.insert(structured.field.into(), value),
                    Err(error) => {
                        diags.error_short(error, AttributePath::new(name.clone()));
                        return None;
                    }
                };
                continue;
            }
            inward.insert(
                name.clone(),
                match value {
                    Value::Value(Dynamic::String(value)) => Value::Value(value.clone()),
                    Value::Value(_) => {
                        diags.error_short("Expected a string", AttributePath::new(name.clone()));
                        return None;
                    }
                    Value::Null => Value::Null,
                    Value::Unknown => Value::Unknown,
                },
            );
        }
        Some(inward)
    }
    /// Typed OpenTofu values for the adapter's string state. Structured inputs
    /// come from `planned` when given, so they stay exactly as OpenTofu planned.
    fn outward(&self, state: State, planned: Option<&StructuredState>) -> StructuredState {
        let mut outward = StructuredState::new();
        for (name, value) in state {
            if let Some(structured) = self
                .definition()
                .structured
                .iter()
                .find(|structured| structured.field == name)
            {
                let value = planned
                    .and_then(|planned| planned.get(structured.attribute).cloned())
                    .unwrap_or_else(|| structured.decode(&value));
                outward.insert(structured.attribute.into(), value);
                continue;
            }
            outward.insert(name, value.map(Dynamic::String));
        }
        outward
    }
}

#[async_trait]
impl Resource for StructuredAdapter {
    type State<'a> = StructuredState;
    type PrivateState<'a> = ValueEmpty;
    type ProviderMetaState<'a> = ValueEmpty;

    async fn validate<'a>(&self, diags: &mut Diagnostics, config: StructuredState) -> Option<()> {
        let config = self.inward(diags, &config)?;
        self.0.validate(diags, config).await
    }

    fn schema(&self, diags: &mut Diagnostics) -> Option<Schema> {
        let mut schema = self.0.schema(diags)?;
        for structured in &self.definition().structured {
            schema.block.attributes.remove(structured.field);
            let optional = self.definition().is_optional(structured.field);
            match &structured.shape {
                Shape::Object(fields) => {
                    let block = block(fields, "");
                    schema.block.blocks.insert(
                        structured.attribute.into(),
                        if optional {
                            NestedBlock::Optional(block)
                        } else {
                            NestedBlock::Single(block)
                        },
                    );
                }
                shape => {
                    schema.block.attributes.insert(
                        structured.attribute.into(),
                        Attribute {
                            attr_type: crate::shape::attribute_type(shape),
                            constraint: if optional {
                                AttributeConstraint::Optional
                            } else {
                                AttributeConstraint::Required
                            },
                            ..Default::default()
                        },
                    );
                }
            }
        }
        Some(schema)
    }

    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        state: StructuredState,
        private: ValueEmpty,
        meta: ValueEmpty,
    ) -> Option<(StructuredState, ValueEmpty)> {
        let inward = self.inward(diags, &state)?;
        let (observed, private) = self.0.read(diags, inward.clone(), private, meta).await?;
        // Keep the recorded typed value while the backend observes the same JSON.
        let unchanged: StructuredState = state
            .into_iter()
            .filter(|(name, _)| {
                self.structured(name).is_some_and(|structured| {
                    inward.get(structured.field) == observed.get(structured.field)
                })
            })
            .collect();
        Some((self.outward(observed, Some(&unchanged)), private))
    }

    async fn plan_create<'a>(
        &self,
        diags: &mut Diagnostics,
        proposed: StructuredState,
        config: StructuredState,
        meta: ValueEmpty,
    ) -> Option<(StructuredState, ValueEmpty)> {
        let inward_proposed = self.inward(diags, &proposed)?;
        let inward_config = self.inward(diags, &config)?;
        let (planned, private) = self
            .0
            .plan_create(diags, inward_proposed, inward_config, meta)
            .await?;
        Some((self.outward(planned, Some(&proposed)), private))
    }

    async fn plan_update<'a>(
        &self,
        diags: &mut Diagnostics,
        prior: StructuredState,
        proposed: StructuredState,
        config: StructuredState,
        private: ValueEmpty,
        meta: ValueEmpty,
    ) -> Option<(StructuredState, ValueEmpty, Vec<AttributePath>)> {
        let inward_prior = self.inward(diags, &prior)?;
        let inward_proposed = self.inward(diags, &proposed)?;
        let inward_config = self.inward(diags, &config)?;
        let (planned, private, replacements) = self
            .0
            .plan_update(
                diags,
                inward_prior,
                inward_proposed,
                inward_config,
                private,
                meta,
            )
            .await?;
        let replacements = replacements
            .into_iter()
            .map(|path| {
                self.definition()
                    .structured
                    .iter()
                    .find(|structured| path == AttributePath::new(structured.field))
                    .map_or(path, |structured| AttributePath::new(structured.attribute))
            })
            .collect();
        Some((
            self.outward(planned, Some(&proposed)),
            private,
            replacements,
        ))
    }

    async fn plan_destroy<'a>(
        &self,
        diags: &mut Diagnostics,
        state: StructuredState,
        private: ValueEmpty,
        meta: ValueEmpty,
    ) -> Option<ValueEmpty> {
        let state = self.inward(diags, &state)?;
        self.0.plan_destroy(diags, state, private, meta).await
    }

    async fn create<'a>(
        &self,
        diags: &mut Diagnostics,
        planned: StructuredState,
        config: StructuredState,
        private: ValueEmpty,
        meta: ValueEmpty,
    ) -> Option<(StructuredState, ValueEmpty)> {
        let inward_planned = self.inward(diags, &planned)?;
        let inward_config = self.inward(diags, &config)?;
        let (state, private) = self
            .0
            .create(diags, inward_planned, inward_config, private, meta)
            .await?;
        Some((self.outward(state, Some(&planned)), private))
    }

    async fn update<'a>(
        &self,
        diags: &mut Diagnostics,
        prior: StructuredState,
        planned: StructuredState,
        config: StructuredState,
        private: ValueEmpty,
        meta: ValueEmpty,
    ) -> Option<(StructuredState, ValueEmpty)> {
        let inward_prior = self.inward(diags, &prior)?;
        let inward_planned = self.inward(diags, &planned)?;
        let inward_config = self.inward(diags, &config)?;
        let (state, private) = self
            .0
            .update(
                diags,
                inward_prior,
                inward_planned,
                inward_config,
                private,
                meta,
            )
            .await?;
        // A failed update keeps the prior state, typed inputs included.
        let source = if diags.errors.is_empty() {
            &planned
        } else {
            &prior
        };
        Some((self.outward(state, Some(source)), private))
    }

    async fn destroy<'a>(
        &self,
        diags: &mut Diagnostics,
        state: StructuredState,
        private: ValueEmpty,
        meta: ValueEmpty,
    ) -> Option<()> {
        let state = self.inward(diags, &state)?;
        self.0.destroy(diags, state, private, meta).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Backend, Mutation, Row, shape::fields};
    use nemoclaw_backend::{Error, ObservationError};
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    /// Records planned rows and observes the configured JSON.
    #[derive(Default)]
    struct Recorder {
        planned: Mutex<Vec<Row>>,
        observed: Mutex<Option<Row>>,
    }

    #[async_trait]
    impl Backend for Recorder {
        async fn plan(&self, _: &str, desired: &Row, _: Option<&Row>) -> Result<(), Error> {
            self.planned.lock().unwrap().push(desired.clone());
            Ok(())
        }
        async fn read(&self, _: &str, _: &Row, _: bool) -> Result<Option<Row>, ObservationError> {
            Ok(self.observed.lock().unwrap().clone())
        }
        async fn ensure(&self, _: &str, _: &Row) -> Mutation {
            unreachable!("planning and refresh only")
        }
        async fn remove(&self, _: &str, _: &Row, _: bool) -> Result<(), ObservationError> {
            Ok(())
        }
    }

    fn policy() -> Shape {
        Shape::Object(
            fields(
                &json!({"type": "object", "required": ["rules"], "properties": {
                    "mode": {"type": "string"},
                    "rules": {"type": "object", "additionalProperties": {
                        "type": "object", "required": ["hostName"], "properties": {
                            "hostName": {"type": "string"},
                            "limits": {"type": "object", "properties": {"maxBytes": {"type": "integer"}}}
                        }
                    }}
                }}),
                &[],
            )
            .unwrap(),
        )
    }

    fn adapter(backend: Arc<Recorder>) -> StructuredAdapter {
        let definition = Definition::new("sandbox", &["name", "policy_json", "names_json"], &[])
            .optional(&["policy_json", "names_json"])
            .structured("policy", "policy_json", policy())
            .structured("names", "names_json", Shape::List(Box::new(Shape::String)));
        StructuredAdapter(ResourceAdapter::new(definition, backend))
    }

    fn value(json: Json) -> Value<Dynamic> {
        serde_json::from_value(json).unwrap()
    }

    #[test]
    fn typed_inputs_replace_their_json_row_fields_in_the_schema() {
        let schema = adapter(Arc::default())
            .schema(&mut Diagnostics::default())
            .unwrap();
        assert!(!schema.block.attributes.contains_key("policy_json"));
        assert!(matches!(
            schema.block.blocks["policy"],
            NestedBlock::Optional(_)
        ));
        let NestedBlock::Optional(policy) = &schema.block.blocks["policy"] else {
            unreachable!()
        };
        assert!(matches!(policy.blocks["rules"], NestedBlock::Map(_)));
        assert!(schema.block.attributes.contains_key("names"));
    }

    #[tokio::test]
    async fn backends_receive_canonical_json_and_plans_keep_the_typed_value() {
        let backend = Arc::new(Recorder::default());
        let adapter = adapter(backend.clone());
        // OpenTofu sends an optional block as a list, with every attribute.
        let proposed = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            (
                "policy".into(),
                value(
                    json!([{"mode": null, "rules": {"github": {"host_name": "api.github.com", "limits": []}}}]),
                ),
            ),
            ("names".into(), value(json!(["b", "a"]))),
            ("id".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        let (planned, _) = adapter
            .plan_create(
                &mut diags,
                proposed.clone(),
                proposed.clone(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(planned["policy"], proposed["policy"]);
        assert_eq!(planned["names"], proposed["names"]);
        let row = backend.planned.lock().unwrap()[0].clone();
        assert_eq!(
            row["policy_json"],
            r#"{"rules":{"github":{"hostName":"api.github.com"}}}"#
        );
        assert_eq!(row["names_json"], r#"["b","a"]"#);
    }

    #[tokio::test]
    async fn refresh_reports_observed_json_as_complete_typed_values() {
        let backend = Arc::new(Recorder::default());
        *backend.observed.lock().unwrap() = Some(Row::from([
            ("name".into(), "coder".into()),
            ("id".into(), "sandbox-id".into()),
            (
                "policy_json".into(),
                r#"{"rules":{"github":{"hostName":"api.github.com","limits":{"maxBytes":7}}}}"#
                    .into(),
            ),
            ("names_json".into(), String::new()),
        ]));
        let prior = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("id".into(), value(json!("sandbox-id"))),
            ("policy".into(), value(json!([]))),
            ("names".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        let (state, _) = adapter(backend)
            .read(
                &mut diags,
                prior,
                ValueEmpty::default(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(
            json(&state["policy"]).unwrap(),
            json!([{"mode": null, "rules": {"github": {"host_name": "api.github.com", "limits": [{"max_bytes": 7}]}}}])
        );
        assert_eq!(state["names"], Value::Null);
    }
}
