// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Resources with typed attributes and blocks whose backends take JSON.
//!
//! The adapter and its planning rules work on string rows. A structured input
//! reaches them as canonical JSON in its row field, and leaves them as the
//! typed value OpenTofu planned, so planned and applied values never differ.

use crate::{
    Definition, ResourceAdapter, State,
    shape::{Dynamic, Fields, Shape, block, dynamic, json, single_blocks},
};
use async_trait::async_trait;
use serde_json::Value as Json;
use std::collections::BTreeMap;
use tf_provider::{
    AttributePath, Diagnostics, Resource,
    schema::{Attribute, AttributeConstraint, AttributeType, NestedBlock, Schema},
    value::{Value, ValueEmpty},
};

/// The computed attribute holding a resource's exported identity.
pub const REF: &str = "ref";

/// The `ref` attribute naming the resource type that exported it.
pub const REF_TYPE: &str = "type";

/// The identity a resource exports as its computed `ref` object.
#[derive(Clone, Debug)]
pub struct Export {
    /// The resource type, which consumers check.
    pub kind: &'static str,
    /// Row fields copied into the `ref`, under the same names.
    pub fields: Vec<&'static str>,
}

impl Export {
    fn attribute_type(&self) -> AttributeType {
        object_type(self.fields.iter().copied())
    }
    /// The `ref` for a row; parts the row does not know yet stay unknown.
    fn compose(&self, state: &State) -> Value<Dynamic> {
        Value::Value(Dynamic::Map(
            std::iter::once((
                REF_TYPE.into(),
                Value::Value(Dynamic::String(self.kind.into())),
            ))
            .chain(self.fields.iter().map(|field| {
                let value = state.get(*field).cloned().unwrap_or(Value::Null);
                ((*field).into(), value.map(Dynamic::String))
            }))
            .collect(),
        ))
    }
}

/// An input that takes another resource's `ref` and carries some of its
/// attributes to the backend in row fields.
#[derive(Clone, Debug)]
pub struct Reference {
    pub attribute: &'static str,
    /// The resource type whose `ref` this input accepts.
    pub kind: &'static str,
    /// `(ref attribute, row field)` pairs. A list carries one attribute, and
    /// its row field holds a JSON list of that attribute's values.
    pub fields: Vec<(&'static str, &'static str)>,
    /// Whether the input is a list of refs.
    pub list: bool,
}

impl Reference {
    fn attribute_type(&self) -> AttributeType {
        let object = object_type(self.fields.iter().map(|(attribute, _)| *attribute));
        if self.list {
            AttributeType::List(Box::new(object))
        } else {
            object
        }
    }
    fn carries(&self, field: &str) -> bool {
        self.fields.iter().any(|(_, row)| *row == field)
    }
    fn mismatch(&self) -> String {
        format!("Expected a ref of {}", self.kind)
    }
    /// The carried attributes of one configured `ref`; unknown parts stay unknown.
    fn values(&self, value: &Value<Dynamic>) -> Result<Vec<Value<String>>, String> {
        let entries = match value {
            Value::Value(Dynamic::Map(entries)) => entries,
            Value::Unknown | Value::Null => {
                return Ok(self
                    .fields
                    .iter()
                    .map(|_| value.clone().map(|_| String::new()))
                    .collect());
            }
            Value::Value(_) => return Err(self.mismatch()),
        };
        if let Some(Value::Value(Dynamic::String(kind))) = entries.get(REF_TYPE)
            && kind != self.kind
        {
            return Err(format!("{}, not {kind}", self.mismatch()));
        }
        self.fields
            .iter()
            .map(|(attribute, _)| match entries.get(*attribute) {
                Some(Value::Value(Dynamic::String(value))) => Ok(Value::Value(value.clone())),
                Some(Value::Unknown) => Ok(Value::Unknown),
                None | Some(Value::Null) => Ok(Value::Null),
                Some(Value::Value(_)) => Err(format!("Expected a string {attribute} in the ref")),
            })
            .collect()
    }
    /// The row fields for a configured input; unknown parts stay unknown.
    fn decompose(&self, value: &Value<Dynamic>) -> Result<Vec<(String, Value<String>)>, String> {
        if !self.list {
            return Ok(self
                .fields
                .iter()
                .map(|(_, row)| (*row).to_owned())
                .zip(self.values(value)?)
                .collect());
        }
        let row = self.fields[0].1.to_owned();
        let items = match value {
            Value::Value(Dynamic::List(items)) => items,
            Value::Unknown | Value::Null => {
                return Ok(vec![(row, value.clone().map(|_| String::new()))]);
            }
            Value::Value(_) => return Err(self.mismatch()),
        };
        let mut names = Vec::new();
        let mut unknown = false;
        for item in items {
            match self.values(item)?.pop() {
                Some(Value::Value(name)) => names.push(name),
                Some(Value::Unknown) | None => unknown = true,
                Some(Value::Null) => return Err(self.mismatch()),
            }
        }
        // One unknown element leaves the whole list unknown until apply.
        let encoded = if unknown {
            Value::Unknown
        } else {
            Value::Value(serde_json::to_string(&names).map_err(|_| self.mismatch())?)
        };
        Ok(vec![(row, encoded)])
    }
    fn object(
        &self,
        values: impl IntoIterator<Item = (&'static str, Value<String>)>,
    ) -> Value<Dynamic> {
        Value::Value(Dynamic::Map(
            std::iter::once((
                REF_TYPE.into(),
                Value::Value(Dynamic::String(self.kind.into())),
            ))
            .chain(
                values
                    .into_iter()
                    .map(|(attribute, value)| (attribute.into(), value.map(Dynamic::String))),
            )
            .collect(),
        ))
    }
    /// The input recorded for a row; absent when the row carries none.
    fn compose(&self, state: &State) -> Value<Dynamic> {
        let values: Vec<_> = self
            .fields
            .iter()
            .map(|(attribute, row)| (*attribute, state.get(*row).cloned().unwrap_or(Value::Null)))
            .collect();
        // An omitted optional input reaches the backend as empty fields.
        if values
            .iter()
            .all(|(_, value)| matches!(value, Value::Null) || value == &Value::Value(String::new()))
        {
            return Value::Null;
        }
        if !self.list {
            return self.object(values);
        }
        let (attribute, encoded) = &values[0];
        match encoded {
            Value::Value(encoded) => match serde_json::from_str::<Vec<String>>(encoded) {
                Ok(names) => Value::Value(Dynamic::List(
                    names
                        .into_iter()
                        .map(|name| self.object([(*attribute, Value::Value(name))]))
                        .collect(),
                )),
                Err(_) => Value::Unknown,
            },
            other => other.clone().map(|_| Dynamic::List(Vec::new())),
        }
    }
}

/// An object of string attributes, plus the `type` every `ref` carries.
fn object_type<'a>(attributes: impl Iterator<Item = &'a str>) -> AttributeType {
    AttributeType::Object(
        std::iter::once(REF_TYPE)
            .chain(attributes)
            .map(|name| (name.to_owned(), AttributeType::String))
            .collect(),
    )
}

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
        let value = crate::shape::inward(&self.shape, &single_blocks(&self.shape, value));
        serde_json::to_string(&value)
            .map(Some)
            .map_err(|_| "cannot encode input")
    }
    /// OpenTofu configuration for the row field's JSON, as a graph declares it.
    pub fn configuration(&self, encoded: &str) -> Result<Json, &'static str> {
        let value: Json = serde_json::from_str(encoded).map_err(|_| "invalid input JSON")?;
        Ok(crate::shape::outward(&self.shape, &value))
    }
    fn decode(&self, value: &Value<String>) -> Value<Dynamic> {
        match value {
            Value::Value(encoded) if !encoded.is_empty() => {
                match serde_json::from_str::<Json>(encoded) {
                    Ok(value) => wire(&self.shape, &crate::shape::outward(&self.shape, &value)),
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
    fn reference(&self, name: &str) -> Option<&Reference> {
        self.definition()
            .references
            .iter()
            .find(|reference| reference.attribute == name)
    }
    /// Whether a row field travels inside a `ref` input rather than on its own.
    fn referenced(&self, field: &str) -> bool {
        self.definition()
            .references
            .iter()
            .any(|reference| reference.carries(field))
    }
    /// The adapter's string state for typed OpenTofu values.
    fn inward(&self, diags: &mut Diagnostics, state: &StructuredState) -> Option<State> {
        let mut inward = State::new();
        for (name, value) in state {
            // The exported identity is derived from the row; backends never see it.
            if name == REF && self.definition().export.is_some() {
                continue;
            }
            if let Some(reference) = self.reference(name) {
                match reference.decompose(value) {
                    Ok(fields) => inward.extend(fields),
                    Err(error) => {
                        diags.error("Invalid reference", error, AttributePath::new(name.clone()));
                        return None;
                    }
                }
                continue;
            }
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
        for reference in &self.definition().references {
            let value = planned
                .and_then(|planned| planned.get(reference.attribute).cloned())
                .unwrap_or_else(|| reference.compose(&state));
            outward.insert(reference.attribute.into(), value);
        }
        if let Some(export) = &self.definition().export {
            outward.insert(REF.into(), export.compose(&state));
        }
        for (name, value) in state {
            if self.referenced(&name) {
                continue;
            }
            if let Some(structured) = self
                .definition()
                .structured
                .iter()
                .find(|structured| structured.field == name)
            {
                // An observation is the backend's, never the plan's.
                let value = planned
                    .filter(|_| !self.definition().is_computed(structured.field))
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
        for reference in &self.definition().references {
            for (_, row) in &reference.fields {
                schema.block.attributes.remove(*row);
            }
            let optional = reference
                .fields
                .iter()
                .all(|(_, row)| self.definition().is_optional(row));
            schema.block.attributes.insert(
                reference.attribute.into(),
                Attribute {
                    attr_type: reference.attribute_type(),
                    constraint: if optional {
                        AttributeConstraint::Optional
                    } else {
                        AttributeConstraint::Required
                    },
                    ..Default::default()
                },
            );
        }
        if let Some(export) = &self.definition().export {
            schema.block.attributes.insert(
                REF.into(),
                Attribute {
                    attr_type: export.attribute_type(),
                    constraint: AttributeConstraint::Computed,
                    ..Default::default()
                },
            );
        }
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
                Shape::ObjectList(fields) => {
                    schema.block.blocks.insert(
                        structured.attribute.into(),
                        NestedBlock::List(block(fields, "")),
                    );
                }
                Shape::ObjectMap(fields) => {
                    schema.block.blocks.insert(
                        structured.attribute.into(),
                        NestedBlock::Map(block(fields, "")),
                    );
                }
                shape => {
                    schema.block.attributes.insert(
                        structured.attribute.into(),
                        Attribute {
                            attr_type: crate::shape::attribute_type(shape),
                            constraint: if self.definition().is_computed(structured.field) {
                                AttributeConstraint::Computed
                            } else if optional {
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
                }) || self.reference(name).is_some_and(|reference| {
                    reference
                        .fields
                        .iter()
                        .all(|(_, row)| inward.get(*row) == observed.get(*row))
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
                let definition = self.definition();
                if let Some(structured) = definition
                    .structured
                    .iter()
                    .find(|structured| path == AttributePath::new(structured.field))
                {
                    return AttributePath::new(structured.attribute);
                }
                definition
                    .references
                    .iter()
                    .find(|reference| {
                        reference
                            .fields
                            .iter()
                            .any(|(_, row)| path == AttributePath::new(*row))
                    })
                    .map_or(path, |reference| AttributePath::new(reference.attribute))
            })
            .collect::<Vec<_>>();
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

    /// Objects keyed by name are labeled blocks, as in other providers.
    #[test]
    fn named_objects_are_labeled_blocks() {
        let model = fields(
            &json!({"type": "object", "required": ["model"], "properties": {
                "model": {"type": "string"}, "temperature": {"type": "number"}
            }}),
            &[],
        )
        .unwrap();
        let definition = Definition::new("agent", &["name", "models_json"], &[])
            .optional(&["models_json"])
            .structured("models", "models_json", Shape::ObjectMap(model));
        let schema = StructuredAdapter(ResourceAdapter::new(
            definition,
            Arc::new(Recorder::default()),
        ))
        .schema(&mut Diagnostics::default())
        .unwrap();
        assert!(matches!(schema.block.blocks["models"], NestedBlock::Map(_)));
        assert!(!schema.block.attributes.contains_key("models"));
    }

    /// JSON text carries an open object; its row field holds the object itself.
    #[test]
    fn json_text_inputs_hold_their_object_in_the_row() {
        let settings = Structured {
            attribute: "settings",
            field: "settings_json",
            shape: Shape::Json,
        };
        assert_eq!(
            settings
                .row_value(json!("{ \"budget\": 4 }"))
                .unwrap()
                .as_deref(),
            Some(r#"{"budget":4}"#)
        );
        assert_eq!(
            settings.configuration(r#"{"budget":4}"#).unwrap(),
            json!(r#"{"budget":4}"#)
        );
        assert_eq!(
            settings.decode(&Value::Value(r#"{"budget":4}"#.into())),
            value(json!(r#"{"budget":4}"#))
        );
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

    /// An observation the backend reports as a JSON map, such as the URLs a
    /// gateway assigns, is a typed computed map that other resources read.
    fn reporter(backend: Arc<Recorder>) -> StructuredAdapter {
        fn urls(_: &str, prior: &State, proposed: &State) -> Option<Value<String>> {
            Some(if prior.get("ports_json") == proposed.get("ports_json") {
                prior.get("urls_json").cloned().unwrap_or(Value::Unknown)
            } else {
                Value::Unknown
            })
        }
        let definition = Definition::new("sandbox", &["name", "ports_json"], &["ports_json"])
            .optional(&["ports_json"])
            .computed("urls_json", urls)
            .structured("ports", "ports_json", Shape::Map(Box::new(Shape::Number)))
            .structured("urls", "urls_json", Shape::Map(Box::new(Shape::String)));
        StructuredAdapter(ResourceAdapter::new(definition, backend))
    }

    #[test]
    fn a_typed_observation_is_a_computed_attribute() {
        let schema = reporter(Arc::default())
            .schema(&mut Diagnostics::default())
            .unwrap();
        let urls = &schema.block.attributes["urls"];
        assert_eq!(
            urls.attr_type,
            AttributeType::Map(Box::new(AttributeType::String))
        );
        assert!(matches!(urls.constraint, AttributeConstraint::Computed));
        assert!(!schema.block.attributes.contains_key("urls_json"));
    }

    #[tokio::test]
    async fn refresh_reports_a_typed_observation() {
        let backend = Arc::new(Recorder::default());
        *backend.observed.lock().unwrap() = Some(Row::from([
            ("name".into(), "coder".into()),
            ("id".into(), "sandbox-id".into()),
            ("ports_json".into(), r#"{"web":8080}"#.into()),
            ("urls_json".into(), r#"{"web":"http://web.test/"}"#.into()),
        ]));
        let prior = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("id".into(), value(json!("sandbox-id"))),
            ("ports".into(), value(json!({"web": 8080}))),
            ("urls".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        let (state, _) = reporter(backend)
            .read(
                &mut diags,
                prior,
                ValueEmpty::default(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(state["urls"], value(json!({"web": "http://web.test/"})));
    }

    #[tokio::test]
    async fn a_typed_observation_is_unknown_only_while_what_it_observes_changes() {
        let prior = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("id".into(), value(json!("sandbox-id"))),
            ("ports".into(), value(json!({"web": 8080}))),
            ("urls".into(), value(json!({"web": "http://web.test/"}))),
        ]);
        let plan = |ports: Json| {
            let prior = prior.clone();
            async move {
                let mut proposed = prior.clone();
                proposed.insert("ports".into(), value(ports));
                let mut config = proposed.clone();
                config.insert("urls".into(), Value::Null);
                config.insert("id".into(), Value::Null);
                let mut diags = Diagnostics::default();
                let (planned, _, replacements) = reporter(Arc::default())
                    .plan_update(
                        &mut diags,
                        prior,
                        proposed,
                        config,
                        ValueEmpty::default(),
                        ValueEmpty::default(),
                    )
                    .await
                    .unwrap();
                assert!(diags.errors.is_empty(), "{diags:?}");
                assert!(replacements.is_empty());
                planned["urls"].clone()
            }
        };
        assert_eq!(
            plan(json!({"web": 8080})).await,
            value(json!({"web": "http://web.test/"}))
        );
        assert_eq!(plan(json!({"web": 9090})).await, Value::Unknown);
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

    fn producer(backend: Arc<Recorder>) -> StructuredAdapter {
        let definition = Definition::new("workspace", &["name", "owner"], &[])
            .exports("example_workspace", &["name", "owner", "id"]);
        StructuredAdapter(ResourceAdapter::new(definition, backend))
    }

    fn consumer(backend: Arc<Recorder>) -> StructuredAdapter {
        let definition = Definition::new("sandbox", &["name", "workspace", "workspace_owner"], &[])
            .references(
                "workspace",
                "example_workspace",
                &[("name", "workspace"), ("owner", "workspace_owner")],
            );
        StructuredAdapter(ResourceAdapter::new(definition, backend))
    }

    fn object_type(names: &[&str]) -> AttributeType {
        AttributeType::Object(
            names
                .iter()
                .map(|name| ((*name).to_owned(), AttributeType::String))
                .collect(),
        )
    }

    fn workspace(owner: Value<Dynamic>) -> Value<Dynamic> {
        Value::Value(Dynamic::Map(BTreeMap::from([
            ("type".into(), value(json!("example_workspace"))),
            ("name".into(), value(json!("team"))),
            ("owner".into(), owner),
        ])))
    }

    #[test]
    fn exported_and_referenced_identities_are_typed_objects_in_the_schema() {
        let schema = producer(Arc::default())
            .schema(&mut Diagnostics::default())
            .unwrap();
        let reference = &schema.block.attributes["ref"];
        assert_eq!(
            reference.attr_type,
            object_type(&["type", "name", "owner", "id"])
        );
        assert!(matches!(
            reference.constraint,
            AttributeConstraint::Computed
        ));
        let schema = consumer(Arc::default())
            .schema(&mut Diagnostics::default())
            .unwrap();
        assert!(!schema.block.attributes.contains_key("workspace_owner"));
        let workspace = &schema.block.attributes["workspace"];
        assert_eq!(workspace.attr_type, object_type(&["type", "name", "owner"]));
        assert!(matches!(
            workspace.constraint,
            AttributeConstraint::Required
        ));
    }

    #[tokio::test]
    async fn a_planned_ref_is_known_except_for_identity_assigned_on_create() {
        let backend = Arc::new(Recorder::default());
        let proposed = StructuredState::from([
            ("name".into(), value(json!("team"))),
            ("owner".into(), value(json!("deployment"))),
            ("id".into(), Value::Null),
            ("ref".into(), Value::Unknown),
        ]);
        let mut diags = Diagnostics::default();
        let (planned, _) = producer(backend.clone())
            .plan_create(
                &mut diags,
                proposed.clone(),
                proposed,
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        let Value::Value(Dynamic::Map(reference)) = &planned["ref"] else {
            panic!("ref is an object: {:?}", planned["ref"])
        };
        assert_eq!(reference["type"], value(json!("example_workspace")));
        assert_eq!(reference["name"], value(json!("team")));
        assert_eq!(reference["owner"], value(json!("deployment")));
        assert_eq!(reference["id"], Value::Unknown);
        assert!(!backend.planned.lock().unwrap()[0].contains_key("ref"));
    }

    #[tokio::test]
    async fn a_reference_reaches_the_backend_as_row_fields_and_plans_keep_the_object() {
        let backend = Arc::new(Recorder::default());
        let proposed = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("workspace".into(), workspace(value(json!("deployment")))),
            ("id".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        let (planned, _) = consumer(backend.clone())
            .plan_create(
                &mut diags,
                proposed.clone(),
                proposed.clone(),
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(planned["workspace"], proposed["workspace"]);
        assert!(!planned.contains_key("workspace_owner"));
        let row = backend.planned.lock().unwrap()[0].clone();
        assert_eq!(row["workspace"], "team");
        assert_eq!(row["workspace_owner"], "deployment");
    }

    #[tokio::test]
    async fn an_unknown_reference_defers_backend_planning() {
        for reference in [Value::Unknown, workspace(Value::Unknown)] {
            let backend = Arc::new(Recorder::default());
            let proposed = StructuredState::from([
                ("name".into(), value(json!("coder"))),
                ("workspace".into(), reference.clone()),
                ("id".into(), Value::Null),
            ]);
            let mut diags = Diagnostics::default();
            let (planned, _) = consumer(backend.clone())
                .plan_create(
                    &mut diags,
                    proposed.clone(),
                    proposed,
                    ValueEmpty::default(),
                )
                .await
                .unwrap();
            assert!(diags.errors.is_empty(), "{diags:?}");
            assert_eq!(planned["workspace"], reference);
            assert!(backend.planned.lock().unwrap().is_empty());
        }
    }

    #[tokio::test]
    async fn a_reference_to_another_type_is_rejected() {
        let config = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            (
                "workspace".into(),
                value(
                    json!({"type": "example_registration", "name": "team", "owner": "deployment"}),
                ),
            ),
            ("id".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        assert!(
            consumer(Arc::default())
                .validate(&mut diags, config)
                .await
                .is_none()
        );
        let message = format!("{diags:?}");
        assert!(message.contains("example_workspace"), "{message}");
    }

    #[tokio::test]
    async fn refresh_rebuilds_a_reference_from_observed_row_fields() {
        let backend = Arc::new(Recorder::default());
        let observed = |owner: &str| {
            Row::from([
                ("name".into(), "coder".into()),
                ("id".into(), "sandbox-id".into()),
                ("workspace".into(), "team".into()),
                ("workspace_owner".into(), owner.into()),
            ])
        };
        let prior = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("id".into(), value(json!("sandbox-id"))),
            ("workspace".into(), workspace(value(json!("deployment")))),
        ]);
        for (owner, expected) in [
            ("deployment", "deployment"),
            ("someone-else", "someone-else"),
        ] {
            *backend.observed.lock().unwrap() = Some(observed(owner));
            let mut diags = Diagnostics::default();
            let (state, _) = consumer(backend.clone())
                .read(
                    &mut diags,
                    prior.clone(),
                    ValueEmpty::default(),
                    ValueEmpty::default(),
                )
                .await
                .unwrap();
            assert!(diags.errors.is_empty(), "{diags:?}");
            assert_eq!(state["workspace"], workspace(value(json!(expected))));
            assert!(!state.contains_key("workspace_owner"));
        }
    }

    fn registrations(backend: Arc<Recorder>) -> StructuredAdapter {
        let definition = Definition::new("sandbox", &["name", "names_json"], &[])
            .optional(&["names_json"])
            .references_list("providers", "example_registration", ("name", "names_json"))
            .schema_version(1);
        StructuredAdapter(ResourceAdapter::new(definition, backend))
    }

    fn registration(name: &str) -> Value<Dynamic> {
        value(json!({"type": "example_registration", "name": name}))
    }

    #[test]
    fn a_list_of_references_is_a_list_of_objects_in_a_versioned_schema() {
        let schema = registrations(Arc::default())
            .schema(&mut Diagnostics::default())
            .unwrap();
        assert_eq!(schema.version, 1);
        assert!(!schema.block.attributes.contains_key("names_json"));
        let providers = &schema.block.attributes["providers"];
        assert_eq!(
            providers.attr_type,
            AttributeType::List(Box::new(object_type(&["type", "name"])))
        );
        assert!(matches!(
            providers.constraint,
            AttributeConstraint::Optional
        ));
    }

    #[tokio::test]
    async fn a_list_of_references_reaches_the_backend_as_a_json_list() {
        let backend = Arc::new(Recorder::default());
        let providers = Value::Value(Dynamic::List(vec![registration("b"), registration("a")]));
        let proposed = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("providers".into(), providers.clone()),
            ("id".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        let (planned, _) = registrations(backend.clone())
            .plan_create(
                &mut diags,
                proposed.clone(),
                proposed,
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(planned["providers"], providers);
        assert_eq!(
            backend.planned.lock().unwrap()[0]["names_json"],
            r#"["b","a"]"#
        );
    }

    #[tokio::test]
    async fn an_unknown_list_element_defers_backend_planning() {
        let backend = Arc::new(Recorder::default());
        let providers = Value::Value(Dynamic::List(vec![registration("a"), Value::Unknown]));
        let proposed = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("providers".into(), providers.clone()),
            ("id".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        let (planned, _) = registrations(backend.clone())
            .plan_create(
                &mut diags,
                proposed.clone(),
                proposed,
                ValueEmpty::default(),
            )
            .await
            .unwrap();
        assert!(diags.errors.is_empty(), "{diags:?}");
        assert_eq!(planned["providers"], providers);
        assert!(backend.planned.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn a_list_element_of_another_type_is_rejected() {
        let config = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            (
                "providers".into(),
                value(json!([{"type": "example_workspace", "name": "a"}])),
            ),
            ("id".into(), Value::Null),
        ]);
        let mut diags = Diagnostics::default();
        assert!(
            registrations(Arc::default())
                .validate(&mut diags, config)
                .await
                .is_none()
        );
        let message = format!("{diags:?}");
        assert!(
            message.contains("Expected a ref of example_registration, not example_workspace"),
            "{message}"
        );
    }

    #[tokio::test]
    async fn refresh_rebuilds_a_list_of_references() {
        let backend = Arc::new(Recorder::default());
        *backend.observed.lock().unwrap() = Some(Row::from([
            ("name".into(), "coder".into()),
            ("id".into(), "sandbox-id".into()),
            ("names_json".into(), r#"["a","c"]"#.into()),
        ]));
        let prior = StructuredState::from([
            ("name".into(), value(json!("coder"))),
            ("id".into(), value(json!("sandbox-id"))),
            (
                "providers".into(),
                Value::Value(Dynamic::List(vec![registration("a")])),
            ),
        ]);
        let mut diags = Diagnostics::default();
        let (state, _) = registrations(backend)
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
            state["providers"],
            Value::Value(Dynamic::List(vec![registration("a"), registration("c")]))
        );
    }
}
