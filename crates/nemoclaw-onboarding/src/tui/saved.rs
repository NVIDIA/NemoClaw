// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The saved configuration: the SDK's serialization of the reviewed document,
//! limited to the fields the journey authored.
use nemoclaw_sdk::config::Document;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};
use serde_json::Value;
use std::fmt;

/// `document` as `Document::yaml` writes it, keeping only the keys present in
/// `authored`, so fields nobody supplied or answered take the SDK's defaults
/// when the file is planned.
pub(super) fn authored_yaml(
    document: &Document,
    authored: &Value,
) -> Result<String, Box<dyn std::error::Error>> {
    let full: Node = serde_saphyr::from_str(&document.yaml()?)?;
    let yaml = serde_saphyr::to_string(&full.authored(authored))?;
    // Dropping a key the SDK filled must leave the same document; anything
    // else means an authored value would be lost or changed.
    if Document::parse(yaml.as_bytes())? != *document {
        return Err("the saved configuration does not reproduce the reviewed document".into());
    }
    Ok(yaml)
}

/// A YAML value whose mappings keep the SDK's field order, which
/// `serde_json::Value` sorts.
enum Node {
    Mapping(Vec<(String, Node)>),
    Sequence(Vec<Node>),
    Scalar(Value),
}

impl Node {
    fn authored(self, authored: &Value) -> Self {
        match (self, authored) {
            (Self::Mapping(entries), Value::Object(fields)) => Self::Mapping(
                entries
                    .into_iter()
                    .filter_map(|(key, node)| {
                        let field = fields.get(&key)?;
                        Some((key, node.authored(field)))
                    })
                    .collect(),
            ),
            (Self::Sequence(items), Value::Array(fields)) => Self::Sequence(
                items
                    .into_iter()
                    .zip(fields)
                    .map(|(node, field)| node.authored(field))
                    .collect(),
            ),
            (node, _) => node,
        }
    }
}

impl Serialize for Node {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Mapping(entries) => {
                serializer.collect_map(entries.iter().map(|(key, node)| (key, node)))
            }
            Self::Sequence(items) => serializer.collect_seq(items),
            Self::Scalar(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Node {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NodeVisitor)
    }
}

struct NodeVisitor;

impl<'de> de::Visitor<'de> for NodeVisitor {
    type Value = Node;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a YAML value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Node, E> {
        Ok(Node::Scalar(value.into()))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Node, E> {
        Ok(Node::Scalar(value.into()))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Node, E> {
        Ok(Node::Scalar(value.into()))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Node, E> {
        Ok(Node::Scalar(value.into()))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Node, E> {
        Ok(Node::Scalar(value.into()))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Node, E> {
        Ok(Node::Scalar(Value::Null))
    }

    fn visit_none<E: de::Error>(self) -> Result<Node, E> {
        Ok(Node::Scalar(Value::Null))
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Node, D::Error> {
        Node::deserialize(deserializer)
    }

    fn visit_seq<A: de::SeqAccess<'de>>(self, mut sequence: A) -> Result<Node, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = sequence.next_element()? {
            items.push(item);
        }
        Ok(Node::Sequence(items))
    }

    fn visit_map<A: de::MapAccess<'de>>(self, mut mapping: A) -> Result<Node, A::Error> {
        let mut entries = Vec::new();
        while let Some(entry) = mapping.next_entry()? {
            entries.push(entry);
        }
        Ok(Node::Mapping(entries))
    }
}

/// Every key and sequence item in `yaml`, in document order, as a JSON pointer
/// with its scalar value, if it has one.
#[cfg(test)]
pub(super) fn entries(yaml: &str) -> Vec<(String, Option<Value>)> {
    fn walk(node: &Node, path: &str, entries: &mut Vec<(String, Option<Value>)>) {
        let children: Vec<(String, &Node)> = match node {
            Node::Mapping(fields) => fields
                .iter()
                .map(|(key, node)| (key.replace('~', "~0").replace('/', "~1"), node))
                .collect(),
            Node::Sequence(items) => items
                .iter()
                .enumerate()
                .map(|(index, node)| (index.to_string(), node))
                .collect(),
            Node::Scalar(_) => Vec::new(),
        };
        for (segment, child) in children {
            let path = format!("{path}/{segment}");
            let value = match child {
                Node::Scalar(value) => Some(value.clone()),
                _ => None,
            };
            entries.push((path.clone(), value));
            walk(child, &path, entries);
        }
    }
    let mut entries = Vec::new();
    walk(&serde_saphyr::from_str(yaml).unwrap(), "", &mut entries);
    entries
}
