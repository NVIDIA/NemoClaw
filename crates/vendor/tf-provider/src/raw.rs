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

//! [`RawValue`] module

use crate::{diagnostics::Diagnostics, tfplugin6};
use serde::{Deserialize, Serialize};

/// Encode a dynamic value with either Message Pack or JSON encoding
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum RawValue {
    /// Message Pack encoded value
    MessagePack(Vec<u8>),
    /// JSON encoded value
    Json(Vec<u8>),
}

const NULL_MESSAGE_PACK: [u8; 1] = [0xc0_u8];
const NULL_JSON: &str = "null";

impl RawValue {
    /// Check if the encoded value is null
    pub fn is_null(&self) -> bool {
        match self {
            RawValue::MessagePack(mp) => mp.is_empty() || mp.as_slice() == NULL_MESSAGE_PACK,
            RawValue::Json(json) => json.is_empty() || json.as_slice() == NULL_JSON.as_bytes(),
        }
    }

    /// Deserialize a [`RawValue`] into a concrete type
    ///
    /// # Arguments
    ///
    /// * `diags` - diagnostics where deserialization errors and warnings are reported
    ///
    /// # Remarks
    ///
    /// Returns [`None`] iff there is an error reported in diagnostics
    pub fn deserialize<'a, T>(&'a self, diags: &mut Diagnostics) -> Option<T>
    where
        T: Deserialize<'a>,
    {
        match self {
            Self::MessagePack(mp) => {
                let slice = if mp.is_empty() {
                    &NULL_MESSAGE_PACK
                } else {
                    mp.as_slice()
                };
                match rmp_serde::from_slice::<T>(slice) {
                    Ok(value) => Some(value),
                    Err(err) => {
                        diags.root_error_short(err.to_string());
                        None
                    }
                }
            }
            Self::Json(json) => {
                let slice = if json.is_empty() {
                    NULL_JSON.as_bytes()
                } else {
                    json.as_slice()
                };
                match serde_json::from_slice::<T>(slice) {
                    Ok(value) => Some(value),
                    Err(err) => {
                        diags.root_error_short(err.to_string());
                        None
                    }
                }
            }
        }
    }

    /// Serialize `value` into a Message Pack encoded [`Vec<u8>`]
    ///
    /// # Arguments
    ///
    /// * `diags` - diagnostics where serialization errors and warnings are reported
    /// * `value` - object to encode
    ///
    /// # Remarks
    ///
    /// Returns [`None`] iff there is an error reported in diagnostics
    pub fn serialize_vec<T>(diags: &mut Diagnostics, value: &T) -> Option<Vec<u8>>
    where
        T: Serialize,
    {
        match rmp_serde::to_vec_named(value) {
            Ok(value) => Some(value),
            Err(err) => {
                diags.root_error_short(err.to_string());
                None
            }
        }
    }

    /// Serialize `value` into a [`RawValue`]
    ///
    /// # Arguments
    ///
    /// * `diags` - diagnostics where serialization errors and warnings are reported
    /// * `value` - object to encode
    ///
    /// # Remarks
    ///
    /// Returns [`None`] iff there is an error reported in diagnostics
    pub fn serialize<T>(diags: &mut Diagnostics, value: &T) -> Option<RawValue>
    where
        T: Serialize,
    {
        Some(Self::MessagePack(Self::serialize_vec(diags, value)?))
    }
}

impl From<tfplugin6::DynamicValue> for RawValue {
    fn from(value: tfplugin6::DynamicValue) -> Self {
        if value.msgpack.is_empty() {
            RawValue::Json(value.json)
        } else {
            RawValue::MessagePack(value.msgpack)
        }
    }
}

impl From<RawValue> for tfplugin6::DynamicValue {
    fn from(value: RawValue) -> Self {
        match value {
            RawValue::MessagePack(msgpack) => Self {
                msgpack,
                json: Default::default(),
            },
            RawValue::Json(json) => Self {
                msgpack: Default::default(),
                json,
            },
        }
    }
}

impl Default for RawValue {
    fn default() -> Self {
        RawValue::MessagePack(NULL_MESSAGE_PACK.to_vec())
    }
}
