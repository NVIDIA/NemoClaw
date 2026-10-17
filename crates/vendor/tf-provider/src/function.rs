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

//! [`Function`] module
use async_trait::async_trait;
use serde::{de, Deserialize, Serialize};

use crate::{raw::RawValue, schema::FunctionSchema, Diagnostics};

#[async_trait]
/// Trait for implementing a function with automatic serialization/deserialization
///
/// See also: [`DynamicFunction`]
pub trait Function: Send + Sync {
    /// Function Input
    ///
    /// The input will be automatically serialized/deserialized at the border of the request.
    type Input<'a>: Deserialize<'a> + Send;

    /// Function Output
    ///
    /// The output will be automatically serialized/deserialized at the border of the request.
    type Output<'a>: Serialize + Send;

    /// Get the schema of the function
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the schema
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn schema(&self, diags: &mut Diagnostics) -> Option<FunctionSchema>;

    /// Call Function
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when calling the function
    /// * `params` - Function parameters packed into the input type
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn call<'a>(
        &self,
        diags: &mut Diagnostics,
        params: Self::Input<'a>,
    ) -> Option<Self::Output<'a>>;
}

#[async_trait]
/// Trait for implementing a function *without* automatic serialization/deserialization
///
/// See also: [`Function`]
pub trait DynamicFunction: Send + Sync {
    /// Get the schema of the function
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the schema
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn schema(&self, diags: &mut Diagnostics) -> Option<FunctionSchema>;

    /// Call Function
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when calling the function
    /// * `params` - Function parameters
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn call<'a>(&self, diags: &mut Diagnostics, params: Vec<RawValue>) -> Option<RawValue>;
}

#[async_trait]
impl<T: Function> DynamicFunction for T {
    /// Get the schema of the function
    fn schema(&self, diags: &mut Diagnostics) -> Option<FunctionSchema> {
        <T as Function>::schema(self, diags)
    }
    /// CallFunction
    async fn call<'a>(&self, diags: &mut Diagnostics, params: Vec<RawValue>) -> Option<RawValue> {
        let mut decoder = Decoder {
            params: &params,
            index: 0,
        };
        match Deserialize::deserialize(&mut decoder) {
            Ok(params) => {
                let value = <T as Function>::call(self, diags, params).await?;
                RawValue::serialize(diags, &value)
            }
            Err(DecoderError::UnsupportedFormat) => {
                diags.root_error("Provider Bug: Unsupported format", "This is a provider bug.\nThe input type is not a struct, a vec, or a tuple.\nTherefore, it can not be parsed as a list of arguments.");
                None
            }
            Err(DecoderError::MsgPackError(index, err)) => {
                diags.function_error(index as i64, err.to_string());
                None
            }
            Err(DecoderError::JsonError(index, err)) => {
                diags.function_error(index as i64, err.to_string());
                None
            }
            Err(DecoderError::Custom(msg)) => {
                diags.root_error_short(msg);
                None
            }
        }
    }
}

impl<T: Function + 'static> From<T> for Box<dyn DynamicFunction> {
    fn from(value: T) -> Self {
        Box::new(value)
    }
}

struct Decoder<'de> {
    params: &'de [RawValue],
    index: usize,
}

#[derive(Debug)]
enum DecoderError {
    UnsupportedFormat,
    JsonError(usize, serde_json::Error),
    MsgPackError(usize, rmp_serde::decode::Error),
    Custom(String),
}

impl std::fmt::Display for DecoderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedFormat => f.write_str("Bad format"),
            Self::JsonError(_, err) => err.fmt(f),
            Self::MsgPackError(_, err) => err.fmt(f),
            Self::Custom(msg) => f.write_str(msg),
        }
    }
}
impl std::error::Error for DecoderError {
    fn source(&self) -> Option<&(dyn de::StdError + 'static)> {
        match self {
            Self::JsonError(_, err) => err.source(),
            Self::MsgPackError(_, err) => err.source(),
            _ => None,
        }
    }
}

impl serde::de::Error for DecoderError {
    fn custom<T>(msg: T) -> Self
    where
        T: std::fmt::Display,
    {
        Self::Custom(msg.to_string())
    }
}

macro_rules! deserialize {
    ($deserialize:ident) => {
        fn $deserialize<V: de::Visitor<'de>>(self, _visitor: V) -> Result<V::Value, Self::Error> {
            Err(DecoderError::UnsupportedFormat)
        }
    };
}

impl<'de> de::Deserializer<'de> for &mut Decoder<'de> {
    type Error = DecoderError;

    deserialize!(deserialize_bool);
    deserialize!(deserialize_i8);
    deserialize!(deserialize_i16);
    deserialize!(deserialize_i32);
    deserialize!(deserialize_i64);
    deserialize!(deserialize_i128);
    deserialize!(deserialize_u8);
    deserialize!(deserialize_u16);
    deserialize!(deserialize_u32);
    deserialize!(deserialize_u64);
    deserialize!(deserialize_u128);
    deserialize!(deserialize_f32);
    deserialize!(deserialize_f64);
    deserialize!(deserialize_char);
    deserialize!(deserialize_str);
    deserialize!(deserialize_string);
    deserialize!(deserialize_bytes);
    deserialize!(deserialize_byte_buf);
    deserialize!(deserialize_option);
    deserialize!(deserialize_unit);

    fn deserialize_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_seq(self)
    }

    fn deserialize_unit_struct<V>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_unit()
    }

    fn deserialize_newtype_struct<V>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_seq(self)
    }

    fn deserialize_tuple<V>(self, _len: usize, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_seq(self)
    }

    fn deserialize_tuple_struct<V>(
        self,
        _name: &'static str,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_seq(self)
    }

    fn deserialize_map<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        Err(DecoderError::UnsupportedFormat)
    }

    fn deserialize_struct<V>(
        self,
        _name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_seq(self)
    }

    fn deserialize_enum<V>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        _visitor: V,
    ) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        Err(DecoderError::UnsupportedFormat)
    }

    fn deserialize_identifier<V>(self, _visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        Err(DecoderError::UnsupportedFormat)
    }

    fn deserialize_ignored_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
    where
        V: de::Visitor<'de>,
    {
        visitor.visit_seq(self)
    }
}

impl<'de> de::SeqAccess<'de> for Decoder<'de> {
    type Error = DecoderError;

    fn next_element_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>, Self::Error>
    where
        T: de::DeserializeSeed<'de>,
    {
        match self.params {
            [] => Ok(None),
            [param, params @ ..] => {
                let index = self.index;
                self.index += 1;
                self.params = params;
                match param {
                    RawValue::MessagePack(bytes) => {
                        let mut deserializer =
                            rmp_serde::Deserializer::from_read_ref(bytes.as_slice());
                        match seed.deserialize(&mut deserializer) {
                            Ok(value) => Ok(Some(value)),
                            Err(err) => Err(DecoderError::MsgPackError(index, err)),
                        }
                    }
                    RawValue::Json(bytes) => {
                        let mut deserializer =
                            serde_json::Deserializer::from_slice(bytes.as_slice());
                        match seed.deserialize(&mut deserializer) {
                            Ok(value) => Ok(Some(value)),
                            Err(err) => Err(DecoderError::JsonError(index, err)),
                        }
                    }
                }
            }
        }
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.params.len())
    }
}
