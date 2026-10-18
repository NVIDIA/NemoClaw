// This file is part of the tf-provider project
//
// Copyright (C) ANEO, 2024-2024. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License")
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

use std::{collections::HashMap, fmt::Display, hash::Hash};

use serde::{ser::SerializeMap, Serialize};

use crate::tfplugin6;

/// Specify if a description must interpreted as markdown or plain
#[derive(Clone, PartialEq, Eq, Hash, Debug, Default)]
pub enum StringKind {
    /// No formatting
    #[default]
    Plain = 0,

    /// Markdown formatting
    Markdown = 1,
}

/// Description
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Description {
    /// Kind of the description (either [`StringKind::Plain`] or [`StringKind::Markdown`])
    pub kind: StringKind,
    /// Content of the description
    pub content: String,
}

impl Description {
    /// Create a plain description
    ///
    /// # Arguments
    ///
    /// * `content` - Content of the description
    pub fn plain<T>(content: T) -> Self
    where
        T: ToString,
    {
        Self {
            kind: StringKind::Plain,
            content: content.to_string(),
        }
    }
    /// Create a markdown description
    ///
    /// # Arguments
    ///
    /// * `content` - Content of the description
    pub fn markdown<T>(content: T) -> Self
    where
        T: ToString,
    {
        Self {
            kind: StringKind::Markdown,
            content: content.to_string(),
        }
    }
}

impl<T> From<T> for Description
where
    T: ToString,
{
    fn from(value: T) -> Self {
        Description::plain(value.to_string())
    }
}

/// NestedBlock
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum NestedBlock {
    /// The nested block must appear exactly once
    Single(Block),
    /// The nested block can appear multiple times
    List(Block),
    /// The nested block can appear multiple times (unordered)
    Set(Block),
    /// The nested block can appear multiple times and have names
    Map(Block),
    /// The nested block can appear at most once (if not given, it will be populate with Nulls)
    Group(Block),
    /// The nested block can appear at most once (if not given, it will be null)
    /// This is implemented with a list block, and must be serialized with `value::serde_as_vec`
    /// ```
    /// # use serde::{Serialize, Deserialize};
    /// use tf_provider::value::{self, Value};
    ///
    /// #[derive(Serialize, Deserialize)]
    /// struct MyBlock {
    ///   /* ... */
    /// }
    ///
    /// #[derive(Serialize, Deserialize)]
    /// struct MyState {
    ///   #[serde(with = "value::serde_as_vec")]
    ///   my_block: Value<MyBlock>,
    /// }
    ///
    /// ```
    Optional(Block),
}

/// Block
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Block {
    /// Version of the block
    pub version: i64,
    /// Attributes of the block
    pub attributes: HashMap<String, Attribute>,
    /// Nested blocks of the block
    pub blocks: HashMap<String, NestedBlock>,
    /// Description for the block
    pub description: Description,
    /// Is the block deprecated
    pub deprecated: bool,
}

impl Default for Block {
    /// Create an empty block (with a version of 1, and a description "empty")
    fn default() -> Block {
        Block {
            version: 1,
            attributes: Default::default(),
            blocks: Default::default(),
            description: "empty".into(),
            deprecated: false,
        }
    }
}

fn cvt_nested_blocks_tf6(
    blocks: &HashMap<String, NestedBlock>,
) -> ::prost::alloc::vec::Vec<tfplugin6::schema::NestedBlock> {
    use tfplugin6::schema::nested_block::NestingMode;
    blocks
        .iter()
        .map(|(name, nested_block)| {
            let (nesting_mode, block) = match nested_block {
                NestedBlock::Single(block) => (NestingMode::Single, block),
                NestedBlock::List(block) => (NestingMode::List, block),
                NestedBlock::Set(block) => (NestingMode::Set, block),
                NestedBlock::Map(block) => (NestingMode::Map, block),
                NestedBlock::Group(block) => (NestingMode::Group, block),
                NestedBlock::Optional(block) => (NestingMode::List, block),
            };
            let nitems = match nested_block {
                NestedBlock::Single(_) => (1, 1),
                NestedBlock::List(_) => (0, i64::MAX),
                NestedBlock::Set(_) => (0, i64::MAX),
                NestedBlock::Map(_) => (0, 0),
                NestedBlock::Group(_) => (0, 0),
                NestedBlock::Optional(_) => (0, 1),
            };
            tfplugin6::schema::NestedBlock {
                type_name: name.clone(),
                block: Some(block.into()),
                nesting: nesting_mode as i32,
                min_items: nitems.0,
                max_items: nitems.1,
            }
        })
        .collect()
}

#[allow(deprecated)]
fn cvt_attributes_tf6(
    attrs: &HashMap<String, Attribute>,
) -> ::prost::alloc::vec::Vec<tfplugin6::schema::Attribute> {
    use tfplugin6::schema::object::NestingMode;
    use tfplugin6::schema::Object;
    attrs
        .iter()
        .map(|(name, attr)| {
            let attr_type = attr.attr_type.to_string().into();
            let nested = match &attr.attr_type {
                AttributeType::AttributeSingle(attrs) => Some((NestingMode::Single, attrs)),
                AttributeType::AttributeList(attrs) => Some((NestingMode::List, attrs)),
                AttributeType::AttributeSet(attrs) => Some((NestingMode::Set, attrs)),
                AttributeType::AttributeMap(attrs) => Some((NestingMode::Map, attrs)),
                _ => None,
            }
            .map(|(nesting_mode, attrs)| Object {
                attributes: cvt_attributes_tf6(attrs),
                nesting: nesting_mode as i32,
                min_items: 0,
                max_items: if nesting_mode == NestingMode::Single {
                    1
                } else {
                    i64::MAX
                },
            });
            tfplugin6::schema::Attribute {
                name: name.clone(),
                r#type: attr_type,
                nested_type: nested,
                description: attr.description.content.clone(),
                required: attr.constraint == AttributeConstraint::Required,
                optional: attr.constraint == AttributeConstraint::OptionalComputed
                    || attr.constraint == AttributeConstraint::Optional,
                computed: attr.constraint == AttributeConstraint::OptionalComputed
                    || attr.constraint == AttributeConstraint::Computed,
                sensitive: attr.sensitive,
                description_kind: match attr.description.kind {
                    StringKind::Plain => tfplugin6::StringKind::Plain,
                    StringKind::Markdown => tfplugin6::StringKind::Markdown,
                } as i32,
                deprecated: attr.deprecated,
            }
        })
        .collect()
}

impl From<&Block> for tfplugin6::schema::Block {
    fn from(value: &Block) -> Self {
        Self {
            attributes: cvt_attributes_tf6(&value.attributes),
            block_types: cvt_nested_blocks_tf6(&value.blocks),
            version: value.version,
            description: value.description.content.clone(),
            description_kind: match value.description.kind {
                StringKind::Plain => tfplugin6::StringKind::Plain,
                StringKind::Markdown => tfplugin6::StringKind::Markdown,
            } as i32,
            deprecated: value.deprecated,
        }
    }
}

/// Specify the Attribute type
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum AttributeType {
    /// String
    String,
    /// Number (int or float)
    Number,
    /// Boolean
    Bool,
    /// List
    List(Box<AttributeType>),
    /// Set
    Set(Box<AttributeType>),
    /// Map
    Map(Box<AttributeType>),
    /// Object
    Object(HashMap<String, AttributeType>),
    /// Tuple
    Tuple(Vec<AttributeType>),
    /// Nested attributes
    AttributeSingle(HashMap<String, Attribute>),
    /// List of nested attributes
    AttributeList(HashMap<String, Attribute>),
    /// Set of nested attributes
    AttributeSet(HashMap<String, Attribute>),
    /// Map of nested attributes
    AttributeMap(HashMap<String, Attribute>),
    /// Dynamic (serialized into a json pair `[type, value]`)
    Any,
}

impl Serialize for AttributeType {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        struct AttributesAsType<'a>(&'a HashMap<String, Attribute>);
        impl Serialize for AttributesAsType<'_> {
            fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
            where
                S: serde::Serializer,
            {
                let mut map = serializer.serialize_map(Some(self.0.len()))?;
                for (name, attr) in self.0 {
                    map.serialize_entry(name, &attr.attr_type)?;
                }
                map.end()
            }
        }
        match self {
            AttributeType::String => serializer.serialize_str("string"),
            AttributeType::Number => serializer.serialize_str("number"),
            AttributeType::Bool => serializer.serialize_str("bool"),
            AttributeType::List(attr) => ("list", attr).serialize(serializer),
            AttributeType::Set(attr) => ("set", attr).serialize(serializer),
            AttributeType::Map(attr) => ("map", attr).serialize(serializer),
            AttributeType::Object(attrs) => ("object", attrs).serialize(serializer),
            AttributeType::Tuple(attrs) => ("tuple", attrs).serialize(serializer),
            AttributeType::AttributeSingle(attrs) => {
                ("object", &AttributesAsType(attrs)).serialize(serializer)
            }
            AttributeType::AttributeList(attrs) => {
                ("list", ("object", &AttributesAsType(attrs))).serialize(serializer)
            }
            AttributeType::AttributeSet(attrs) => {
                ("set", ("object", &AttributesAsType(attrs))).serialize(serializer)
            }
            AttributeType::AttributeMap(attrs) => {
                ("map", ("object", &AttributesAsType(attrs))).serialize(serializer)
            }
            AttributeType::Any => serializer.serialize_str("dynamic"),
        }
    }
}

impl Display for AttributeType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            serde_json::to_string(self)
                .or(Err(std::fmt::Error))?
                .as_str(),
        )
    }
}

/// Specify the Attribute type
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum AttributeConstraint {
    /// The attribute is computed, but cannot be specified by the practitioner (output only)
    Computed,
    /// The attribute is optional, and the provider cannot generate a value for it
    Optional,
    /// The attribute is both optional and computed:
    /// the practitioner can omit the value, and the provider can generate a value for it
    OptionalComputed,
    /// The attribute is required
    Required,
}

/// Attribute
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Attribute {
    /// Type of the Attribute
    pub attr_type: AttributeType,
    /// Description of the Attribute
    pub description: Description,
    /// Is the attribute required
    pub constraint: AttributeConstraint,
    /// Is the attribute sensitive
    pub sensitive: bool,
    /// Is the attribute deprecated
    pub deprecated: bool,
}

impl Default for Attribute {
    fn default() -> Self {
        Self {
            attr_type: AttributeType::Any,
            description: "empty".into(),
            constraint: AttributeConstraint::OptionalComputed,
            sensitive: false,
            deprecated: false,
        }
    }
}

/// Schema
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Schema {
    /// Version of the schema
    pub version: i64,
    /// Root block of the schema
    pub block: Block,
}

impl From<&Schema> for tfplugin6::Schema {
    fn from(value: &Schema) -> Self {
        Self {
            version: value.version,
            block: Some((&value.block).into()),
        }
    }
}

/// Type for a function parameter or return value
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Type {
    /// String
    String,
    /// Number (int or float)
    Number,
    /// Boolean
    Bool,
    /// List
    List(Box<Type>),
    /// Set
    Set(Box<Type>),
    /// Map
    Map(Box<Type>),
    /// Object
    Object(HashMap<String, Type>),
    /// Tuple
    Tuple(Vec<Type>),
    /// Dynamic (serialized into a json pair `[type, value]`)
    Any,
}

impl Serialize for Type {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Type::String => serializer.serialize_str("string"),
            Type::Number => serializer.serialize_str("number"),
            Type::Bool => serializer.serialize_str("bool"),
            Type::List(attr) => ("list", attr).serialize(serializer),
            Type::Set(attr) => ("set", attr).serialize(serializer),
            Type::Map(attr) => ("map", attr).serialize(serializer),
            Type::Object(attrs) => ("object", attrs).serialize(serializer),
            Type::Tuple(attrs) => ("tuple", attrs).serialize(serializer),
            Type::Any => serializer.serialize_str("dynamic"),
        }
    }
}

impl Display for Type {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            serde_json::to_string(self)
                .or(Err(std::fmt::Error))?
                .as_str(),
        )
    }
}

/// Function parameter schema
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Parameter {
    /// Name of the parameter
    pub name: String,
    /// Type of the parameter
    pub param_type: Type,
    /// Whether the parameter can be null or not
    ///
    /// When enabled denotes that a null argument value
    /// can be passed to the provider. When disabled,
    /// Terraform returns an error if the argument value is null.
    pub allow_null: bool,
    /// Whether the parameter can be unknown or not
    ///
    /// When enabled denotes that only wholly known
    /// argument values will be passed to the provider. When disabled,
    /// Terraform skips the function call entirely and assumes an unknown
    /// value result from the function.
    pub allow_unknown: bool,
    /// Description of the argument
    pub description: Description,
}

impl Default for Parameter {
    fn default() -> Self {
        Self {
            name: Default::default(),
            param_type: Type::Any,
            allow_null: Default::default(),
            allow_unknown: Default::default(),
            description: Description::plain(""),
        }
    }
}

impl From<&Parameter> for tfplugin6::function::Parameter {
    fn from(value: &Parameter) -> Self {
        Self {
            name: value.name.clone(),
            r#type: value.param_type.to_string().into(),
            allow_null_value: value.allow_null,
            allow_unknown_values: value.allow_unknown,
            description: value.description.content.clone(),
            description_kind: match value.description.kind {
                StringKind::Markdown => tfplugin6::StringKind::Markdown,
                StringKind::Plain => tfplugin6::StringKind::Plain,
            } as i32,
        }
    }
}

/// Function schema
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionSchema {
    /// List of positional function parameters
    pub parameters: Vec<Parameter>,
    /// Optional final parameter which accepts
    /// zero or more argument values, in which Terraform will send an
    /// ordered list of the parameter type
    pub variadic: Option<Parameter>,
    /// Type constraint for the function result
    pub return_type: Type,
    /// Human-readable shortened documentation for the function
    pub summary: String,
    /// Description of the function
    pub description: Description,
    /// Whether the function deprecated
    ///
    /// If the function is deprecated, this field contains the deprecation message
    pub deprecated: Option<String>,
}

impl Default for FunctionSchema {
    fn default() -> Self {
        Self {
            parameters: Default::default(),
            variadic: Default::default(),
            return_type: Type::Any,
            summary: Default::default(),
            description: Description::plain(""),
            deprecated: Default::default(),
        }
    }
}

impl From<&FunctionSchema> for tfplugin6::Function {
    fn from(value: &FunctionSchema) -> Self {
        Self {
            parameters: value.parameters.iter().map(Into::into).collect(),
            variadic_parameter: value.variadic.as_ref().map(Into::into),
            r#return: Some(tfplugin6::function::Return {
                r#type: value.return_type.to_string().into_bytes(),
            }),
            summary: value.summary.clone(),
            description: value.description.content.clone(),
            description_kind: match value.description.kind {
                StringKind::Markdown => tfplugin6::StringKind::Markdown,
                StringKind::Plain => tfplugin6::StringKind::Plain,
            } as i32,
            deprecation_message: match &value.deprecated {
                Some(msg) if msg.is_empty() => "deprecated".to_owned(),
                Some(msg) => msg.clone(),
                None => String::new(),
            },
        }
    }
}
