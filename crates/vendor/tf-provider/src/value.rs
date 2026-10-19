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

//! [`Value`] module

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet},
    fmt::{Debug, Display},
    iter::FusedIterator,
    mem,
    ops::{Deref, DerefMut},
};

use serde::{Deserialize, Serialize};

use crate::utils::serde_unknown;

/// Encode either a known value, a null value, or an unknown value as specified by the Terraform protocol.
///
/// [`Value`] is closely modeled after [`Option`] where:
/// - [`Value::Value`] is equivalent to [`Option::Some`],
/// - [`Value::Null`] is equivalent to [`Option::None`],
/// - [`Value::Unknown`] has no option counterpart and represent a value that is currently unknown, but will be known later on.
///
/// [`Value::Unknown`] is *not* a [`Future`](std::future::Future), but merely a tag.
#[derive(Copy, Clone, PartialEq, PartialOrd, Eq, Ord, Hash, Default, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value<T> {
    /// Value is present
    Value(T),
    /// No value is present
    #[default]
    Null,
    /// Value is unknown
    #[serde(with = "serde_unknown")]
    Unknown,
}

#[derive(Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ValueAny {
    String(String),
    Number(i64),
    Bool(bool),
    List(Vec<ValueAny>),
    Map(BTreeMap<String, ValueAny>),
    #[default]
    Null,
    #[serde(with = "serde_unknown")]
    Unknown,
}

impl ValueAny {
    /// Dump the json representation of the value
    pub fn json(&self) -> String {
        serde_json::to_string(self).unwrap_or("<invalid>".into())
    }
    /// Dump the indented json representation of the value
    pub fn json_pretty(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or("<invalid>".into())
    }
}

/// Struct without any field
#[derive(
    Copy, Clone, PartialEq, PartialOrd, Eq, Ord, Debug, Hash, Default, Serialize, Deserialize,
)]
pub struct StructEmpty {}

pub type ValueEmpty = Value<StructEmpty>;
pub type ValueString<'a> = Value<Cow<'a, str>>;
pub type ValueNumber = Value<i64>;
pub type ValueBool = Value<bool>;
pub type ValueList<T> = Value<Vec<T>>;
pub type ValueSet<T> = Value<BTreeSet<T>>;
pub type ValueMap<'a, T> = Value<BTreeMap<Cow<'a, str>, T>>;

/// Serde codec to encode a nullable as a vec that has either zero or one element
pub mod serde_as_vec {
    use anyhow::anyhow;
    use serde::{de::Error, ser::SerializeSeq, Deserialize, Serialize};

    use super::Value;

    /// Serialize a nullable Value into a Vec of Values with 0 or 1 element
    pub fn serialize<T, S>(value: &Value<T>, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
        T: Serialize,
    {
        let mut seq = serializer.serialize_seq(Some(value.is_value() as usize))?;
        if let Value::Value(value) = value {
            seq.serialize_element(value)?;
        }
        seq.end()
    }

    /// Deserialize a Vec of values into a single, nullable, Value
    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Value<T>, D::Error>
    where
        D: serde::Deserializer<'de>,
        T: Deserialize<'de>,
    {
        let vec: Vec<Value<T>> = Deserialize::deserialize(deserializer)?;
        let mut iter = vec.into_iter();
        if let Some(value) = iter.next() {
            if iter.next().is_none() {
                Ok(value)
            } else {
                Err(anyhow!("Try to store multiple elements in a single Value"))
                    .map_err(D::Error::custom)
            }
        } else {
            Ok(Value::Null)
        }
    }
}

impl<T> Value<T> {
    /////////////////////////////////////////////////////////////////////////
    // Querying the contained values
    /////////////////////////////////////////////////////////////////////////

    /// Check if the value is known and present
    #[inline]
    pub const fn is_value(&self) -> bool {
        matches!(self, Self::Value(_))
    }

    /// Check if the value is null
    #[inline]
    pub const fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    /// Check if the value is unknown
    #[inline]
    pub const fn is_unknown(&self) -> bool {
        matches!(self, Self::Unknown)
    }

    /////////////////////////////////////////////////////////////////////////
    // Adapter for working with references
    /////////////////////////////////////////////////////////////////////////

    /// Converts from `&Value<T>` to `Value<&T>`
    ///
    /// # Examples
    ///
    /// Calculates the length of a <code>Value<[String]></code> as a <code>Value<[usize]></code>
    /// without moving the [`String`]. The [`map`] method takes the `self` argument by value,
    /// consuming the original, so this technique uses `as_ref` to first take a `Value` to a
    /// reference to the value inside the original.
    ///
    /// [`map`]: Value::map
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let text: Value<String> = Value::Value("Hello, world!".to_string());
    /// // First, cast `Value<String>` to `Value<&String>` with `as_ref`,
    /// // then consume *that* with `map`, leaving `text` on the stack.
    /// let text_length: Value<usize> = text.as_ref().map(|s| s.len());
    /// println!("still can print text: {text:?}");
    /// ```
    #[inline]
    pub const fn as_ref(&self) -> Value<&T> {
        match *self {
            Self::Value(ref x) => Value::Value(x),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Converts from `&mut Value<T>` to `Value<&mut T>`
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x = Value::Value(2);
    /// match x.as_mut() {
    ///     Value::Value(v) => *v = 42,
    ///     _ => {},
    /// }
    /// assert_eq!(x, Value::Value(42));
    /// ```
    #[inline]
    pub fn as_mut(&mut self) -> Value<&mut T> {
        match *self {
            Self::Value(ref mut x) => Value::Value(x),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /////////////////////////////////////////////////////////////////////////
    // Getting to contained values
    /////////////////////////////////////////////////////////////////////////

    /// Returns the contained [`Value::Value`] value, consuming the self value.
    ///
    /// # Panics
    ///
    /// Panics if the value is [`Value::Null`] or [`Value::Unknown`] with a custom panic message provided by msg.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value("value");
    /// assert_eq!(x.expect("message"), "value");
    /// ```
    ///
    /// ```should_panic
    /// # use tf_provider::value::Value;
    /// let x: Value<&str> = Value::Null;
    /// x.expect("message"); // panics with `message`
    /// ```
    ///
    /// ```should_panic
    /// # use tf_provider::value::Value;
    /// let x: Value<&str> = Value::Unknown;
    /// x.expect("message"); // panics with `message`
    /// ```
    #[inline]
    pub fn expect(self, msg: &str) -> T {
        match self {
            Self::Value(val) => val,
            Self::Null => panic!("{} (Null)", msg),
            Self::Unknown => panic!("{} (Unknown)", msg),
        }
    }

    /// Returns the contained [`Value::Value`] value, consuming the self value.
    ///
    /// Because this function may panic, its use is generally discouraged.
    /// Instead, prefer to use pattern matching and handle the [`Value::Null`] and [`Value::Unknown`] cases explicitly,
    /// or call [`unwrap_or`], [`unwrap_or_else`], or [`unwrap_or_default`].
    ///
    /// [`unwrap_or`]: Value::unwrap_or
    /// [`unwrap_or_else`]: Value::unwrap_or_else
    /// [`unwrap_or_default`]: Value::unwrap_or_default
    ///
    /// # Panics
    ///
    /// Panics if the value is [`Value::Null`] or [`Value::Unknown`].
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value("value");
    /// assert_eq!(x.unwrap(), "value");
    /// ```
    ///
    /// ```should_panic
    /// # use tf_provider::value::Value;
    /// let x: Value<&str> = Value::Null;
    /// assert_eq!(x.unwrap(), "value"); // panics
    /// ```
    ///
    /// ```should_panic
    /// # use tf_provider::value::Value;
    /// let x: Value<&str> = Value::Unknown;
    /// assert_eq!(x.unwrap(), "value"); // panics
    /// ```
    #[inline]
    pub fn unwrap(self) -> T {
        match self {
            Self::Value(x) => x,
            Self::Null => panic!("called `Value::unwrap()` on a `Null` value"),
            Self::Unknown => panic!("called `Value::unwrap()` on an `Unknown` value"),
        }
    }

    /// Returns the contained Some value or a provided default.
    ///
    /// Arguments passed to `unwrap_or` are eagerly evaluated;
    /// if you are passing the result of a function call, it is recommended to use [`unwrap_or_else`], which is lazily evaluated.
    ///
    /// [`unwrap_or_else`]: Value::unwrap_or_else
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// assert_eq!(Value::Value("car").unwrap_or("bike"), "car");
    /// assert_eq!(Value::Null.unwrap_or("bike"), "bike");
    /// assert_eq!(Value::Unknown.unwrap_or("bike"), "bike");
    /// ```
    #[inline]
    pub fn unwrap_or(self, default: T) -> T {
        match self {
            Self::Value(x) => x,
            _ => default,
        }
    }

    /// Returns the contained [`Value::Value`] value or computes it from a closure.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let k = 10;
    /// assert_eq!(Value::Value(4).unwrap_or_else(|| 2 * k), 4);
    /// assert_eq!(Value::Null.unwrap_or_else(|| 2 * k), 20);
    /// assert_eq!(Value::Unknown.unwrap_or_else(|| 2 * k), 20);
    /// ```
    #[inline]
    pub fn unwrap_or_else<F>(self, f: F) -> T
    where
        F: FnOnce() -> T,
    {
        match self {
            Self::Value(x) => x,
            _ => f(),
        }
    }

    /// Returns the contained [`Value::Value`] value or a default.
    ///
    /// Consumes the `self` argument then, if [`Value::Value`], returns the contained value,
    /// otherwise if [`Value::Null`] or [`Value::Unknown`], returns the [default value] for that type.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x: Value<u32> = Value::Value(12);
    /// let y: Value<u32> = Value::Null;
    /// let z: Value<u32> = Value::Unknown;
    ///
    /// assert_eq!(x.unwrap_or_default(), 12);
    /// assert_eq!(y.unwrap_or_default(), 0);
    /// assert_eq!(z.unwrap_or_default(), 0);
    /// ```
    ///
    /// [default value]: Default::default
    #[inline]
    pub fn unwrap_or_default(self) -> T
    where
        T: Default,
    {
        match self {
            Self::Value(x) => x,
            _ => Default::default(),
        }
    }

    /////////////////////////////////////////////////////////////////////////
    // Transforming contained values
    /////////////////////////////////////////////////////////////////////////

    /// Maps a `Value<T>` to `Value<U>` by applying a function to a contained value (if `Value::Value`)
    /// or returns `Value::Null` (if `Value::Null`) and `Value::Unknown` (if `Value::Unknown`).
    ///
    /// # Examples
    ///
    /// Calculates the length of a <code>Value<[String]></code> as a
    /// <code>Value<[usize]></code>, consuming the original:
    /// ```
    /// # use tf_provider::value::Value;
    /// let maybe_some_string = Value::Value(String::from("Hello, World!"));
    /// // `Value::map` takes self *by value*, consuming `maybe_some_string`
    /// let maybe_some_len = maybe_some_string.map(|s| s.len());
    /// assert_eq!(maybe_some_len, Value::Value(13));
    ///
    /// let x: Value<&str> = Value::Null;
    /// assert_eq!(x.map(|s| s.len()), Value::Null);
    ///
    /// let y: Value<&str> = Value::Unknown;
    /// assert_eq!(y.map(|s| s.len()), Value::Unknown);
    /// ```
    #[inline]
    pub fn map<U, F>(self, f: F) -> Value<U>
    where
        F: FnOnce(T) -> U,
    {
        match self {
            Self::Value(x) => Value::Value(f(x)),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Calls a function with a reference to the contained value if [`Value::Value`].
    ///
    /// Returns the original value.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x: Value<i32> = Value::Value(2);
    /// // prints "got: 2"
    /// x.inspect(|x| println!("got: {x}"));
    ///
    /// let x: Value<i32> = Value::Null;
    /// // Does not print anything
    /// x.inspect(|x| println!("got: {x}"));
    ///
    /// let x: Value<i32> = Value::Unknown;
    /// // Does not print anything
    /// x.inspect(|x| println!("got: {x}"));
    /// ```
    #[inline]
    pub fn inspect<F>(self, f: F) -> Self
    where
        F: FnOnce(&T),
    {
        if let Self::Value(ref x) = self {
            f(x);
        }
        self
    }

    /// Returns the provided default result (if null or unknown),
    /// or applies a function to the contained value (if any).
    ///
    /// Arguments passed to `map_or` are eagerly evaluated; if you are passing
    /// the result of a function call, it is recommended to use [`map_or_else`],
    /// which is lazily evaluated.
    ///
    /// [`map_or_else`]: Value::map_or_else
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value("foo");
    /// assert_eq!(x.map_or(42, |v| v.len()), 3);
    ///
    /// let x: Value<&str> = Value::Null;
    /// assert_eq!(x.map_or(42, |v| v.len()), 42);
    ///
    /// let x: Value<&str> = Value::Unknown;
    /// assert_eq!(x.map_or(42, |v| v.len()), 42);
    /// ```
    #[inline]
    pub fn map_or<U, F>(self, default: U, f: F) -> U
    where
        F: FnOnce(T) -> U,
    {
        match self {
            Self::Value(x) => f(x),
            _ => default,
        }
    }

    /// Computes a default function result (if null or unknown), or
    /// applies a different function to the contained value (if any).
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let k = 21;
    ///
    /// let x = Value::Value("foo");
    /// assert_eq!(x.map_or_else(|| 2 * k, |v| v.len()), 3);
    ///
    /// let x: Value<&str> = Value::Null;
    /// assert_eq!(x.map_or_else(|| 2 * k, |v| v.len()), 42);
    ///
    /// let x: Value<&str> = Value::Unknown;
    /// assert_eq!(x.map_or_else(|| 2 * k, |v| v.len()), 42);
    /// ```
    #[inline]
    pub fn map_or_else<U, D, F>(self, default: D, f: F) -> U
    where
        F: FnOnce(T) -> U,
        D: FnOnce() -> U,
    {
        match self {
            Self::Value(x) => f(x),
            _ => default(),
        }
    }

    /// Transforms the `Value<T>` into a [`Result<T, E>`], mapping [`Value::Value(v)`] to
    /// [`Ok(v)`], [`Value::Null`] to [`Err(err)`], and [`Value::Unknown`] to [`Err(err)`].
    ///
    /// Arguments passed to `ok_or` are eagerly evaluated; if you are passing the
    /// result of a function call, it is recommended to use [`ok_or_else`], which is
    /// lazily evaluated.
    ///
    /// [`Ok(v)`]: Ok
    /// [`Err(err)`]: Err
    /// [`Value::Value(v)`]: Value::Value
    /// [`ok_or_else`]: Value::ok_or_else
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value("foo");
    /// assert_eq!(x.ok_or(0), Ok("foo"));
    ///
    /// let x: Value<&str> = Value::Null;
    /// assert_eq!(x.ok_or(0), Err(0));
    ///
    /// let x: Value<&str> = Value::Unknown;
    /// assert_eq!(x.ok_or(0), Err(0));
    /// ```
    #[inline]
    pub fn ok_or<E>(self, err: E) -> Result<T, E> {
        match self {
            Self::Value(x) => Ok(x),
            _ => Err(err),
        }
    }

    /// Transforms the `Value<T>` into a [`Result<T, E>`], mapping [`Value::Value(v)`] to
    /// [`Ok(v)`], [`Value::Null`] to [`Err(err())`], and [`Value::Unknown`] to [`Err(err())`].
    ///
    /// [`Ok(v)`]: Ok
    /// [`Err(err())`]: Err
    /// [`Value::Value(v)`]: Value::Value
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value("foo");
    /// assert_eq!(x.ok_or_else(|| 0), Ok("foo"));
    ///
    /// let x: Value<&str> = Value::Null;
    /// assert_eq!(x.ok_or_else(|| 0), Err(0));
    ///
    /// let x: Value<&str> = Value::Unknown;
    /// assert_eq!(x.ok_or_else(|| 0), Err(0));
    /// ```
    #[inline]
    pub fn ok_or_else<E, F>(self, err: F) -> Result<T, E>
    where
        F: FnOnce() -> E,
    {
        match self {
            Self::Value(x) => Ok(x),
            _ => Err(err()),
        }
    }

    /// Converts from `Value<T>` (or `&Value<T>`) to `Value<&T::Target>`.
    ///
    /// Leaves the original Option in-place, creating a new one with a reference
    /// to the original one, additionally coercing the contents via [`Deref`].
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x: Value<String> = Value::Value("hey".to_owned());
    /// assert_eq!(x.as_deref(), Value::Value("hey"));
    ///
    /// let x: Value<String> = Value::Null;
    /// assert_eq!(x.as_deref(), Value::Null);
    ///
    /// let x: Value<String> = Value::Unknown;
    /// assert_eq!(x.as_deref(), Value::Unknown);
    /// ```
    #[inline]
    pub fn as_deref(&self) -> Value<&T::Target>
    where
        T: Deref,
    {
        match self.as_ref() {
            Value::Value(x) => Value::Value(x.deref()),
            Value::Null => Value::Null,
            Value::Unknown => Value::Unknown,
        }
    }

    /// Converts from `Value<T>` (or `&mut Value<T>`) to `Value<&mut T::Target>`.
    ///
    /// Leaves the original `Value` in-place, creating a new one containing a mutable reference to
    /// the inner type's [`Deref::Target`] type.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x: Value<String> = Value::Value("hey".to_owned());
    /// assert_eq!(x.as_deref_mut().map(|x| {
    ///     x.make_ascii_uppercase();
    ///     x
    /// }), Value::Value("HEY".to_owned().as_mut_str()));
    ///
    /// let mut x: Value<String> = Value::Null;
    /// assert_eq!(x.as_deref_mut().map(|x| {
    ///     x.make_ascii_uppercase();
    ///     x
    /// }), Value::Null);
    ///
    /// let mut x: Value<String> = Value::Unknown;
    /// assert_eq!(x.as_deref_mut().map(|x| {
    ///     x.make_ascii_uppercase();
    ///     x
    /// }), Value::Unknown);
    /// ```
    #[inline]
    pub fn as_deref_mut(&mut self) -> Value<&mut T::Target>
    where
        T: DerefMut,
    {
        match self.as_mut() {
            Value::Value(x) => Value::Value(x.deref_mut()),
            Value::Null => Value::Null,
            Value::Unknown => Value::Unknown,
        }
    }

    /// Transforms the `Value<T>` into a [`Option<T>`], mapping [`Value::Value(v)`] to
    /// [`Some(v)`], [`Value::Null`] to [`None`], and [`Value::Unknown`] to [`None`].
    ///
    /// [`Some(v)`]: Some
    /// [`Value::Value(v)`]: Value::Value
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value("foo");
    /// assert_eq!(x.as_option(), Some("foo"));
    ///
    /// let x: Value<&str> = Value::Null;
    /// assert_eq!(x.as_option(), None);
    ///
    /// let x: Value<&str> = Value::Unknown;
    /// assert_eq!(x.as_option(), None);
    /// ```
    #[inline]
    pub fn as_option(self) -> Option<T> {
        match self {
            Self::Value(x) => Some(x),
            _ => None,
        }
    }

    /// Transforms the `&Value<T>` into a [`Option<&T>`], mapping [`Value::Value(v)`] to
    /// [`Some(v)`], [`Value::Null`] to [`None`], and [`Value::Unknown`] to [`None`].
    ///
    /// [`Some(v)`]: Some
    /// [`Value::Value(v)`]: Value::Value
    ///
    /// # Examples
    ///
    /// Calculates the length of a <code>Value<[String]></code> as an <code>Option<[usize]></code>
    /// without moving the [`String`]. The [`map`] method takes the `self` argument by value,
    /// consuming the original, so this technique uses `as_ref` to first take a `Value` to a
    /// reference to the value inside the original.
    ///
    /// [`map`]: Option::map
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let text: Value<String> = Value::Value("Hello, world!".to_string());
    /// // First, cast `Value<String>` to `Option<&String>` with `as_ref_option`
    /// let text_ref: Option<&String> = text.as_ref_option();
    /// // then consume *that* with `map`, leaving `text` on the stack.
    /// let text_length: Option<usize> = text_ref.map(|s| s.len());
    /// println!("still can print text: {text:?}");
    /// ```
    #[inline]
    pub fn as_ref_option(&self) -> Option<&T> {
        match self {
            Self::Value(x) => Some(x),
            _ => None,
        }
    }

    /// Transforms the `&mut Value<T>` into a [`Option<&mut T>`], mapping [`Value::Value(v)`] to
    /// [`Some(v)`], [`Value::Null`] to [`None`], and [`Value::Unknown`] to [`None`].
    ///
    /// [`Some(v)`]: Some
    /// [`Value::Value(v)`]: Value::Value
    ///
    /// # Examples
    ///
    /// Calculates the length of a <code>Value<[String]></code> as an <code>Option<[usize]></code>
    /// without moving the [`String`]. The [`map`] method takes the `self` argument by value,
    /// consuming the original, so this technique uses `as_ref` to first take a `Value` to a
    /// reference to the value inside the original.
    ///
    /// [`map`]: Option::map
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x = Value::Value(2);
    /// match x.as_mut_option() {
    ///     Some(v) => *v = 42,
    ///     None => {},
    /// }
    /// assert_eq!(x, Value::Value(42));
    /// ```
    #[inline]
    pub fn as_mut_option(&mut self) -> Option<&mut T> {
        match self {
            Self::Value(x) => Some(x),
            _ => None,
        }
    }

    /// Converts from `Value<T>` (or `&Value<T>`) to `Option<&T::Target>`, mapping [`Value::Value(v)`] to
    /// [`Some(v)`], [`Value::Null`] to [`None`], and [`Value::Unknown`] to [`None`].
    ///
    /// [`Some(v)`]: Some
    /// [`Value::Value(v)`]: Value::Value
    ///
    /// Leaves the original Option in-place, creating a new one with a reference
    /// to the original one, additionally coercing the contents via [`Deref`].
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x: Value<String> = Value::Value("hey".to_owned());
    /// assert_eq!(x.as_deref_option(), Some("hey"));
    ///
    /// let x: Value<String> = Value::Null;
    /// assert_eq!(x.as_deref_option(), None);
    ///
    /// let x: Value<String> = Value::Unknown;
    /// assert_eq!(x.as_deref_option(), None);
    /// ```
    #[inline]
    pub fn as_deref_option(&self) -> Option<&T::Target>
    where
        T: Deref,
    {
        match self {
            Self::Value(x) => Some(x),
            _ => None,
        }
    }

    /// Converts from `Value<T>` (or `&mut Value<T>`) to `Option<&mut T::Target>`, mapping [`Value::Value(v)`] to
    /// [`Some(v)`], [`Value::Null`] to [`None`], and [`Value::Unknown`] to [`None`].
    ///
    /// [`Some(v)`]: Some
    /// [`Value::Value(v)`]: Value::Value
    ///
    /// Leaves the original `Value` in-place, creating a new one containing a mutable reference to
    /// the inner type's [`Deref::Target`] type.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x: Value<String> = Value::Value("hey".to_owned());
    /// assert_eq!(x.as_deref_mut_option().map(|x| {
    ///     x.make_ascii_uppercase();
    ///     x
    /// }), Some("HEY".to_owned().as_mut_str()));
    ///
    /// let mut x: Value<String> = Value::Null;
    /// assert_eq!(x.as_deref_mut_option().map(|x| {
    ///     x.make_ascii_uppercase();
    ///     x
    /// }), None);
    ///
    /// let mut x: Value<String> = Value::Unknown;
    /// assert_eq!(x.as_deref_mut_option().map(|x| {
    ///     x.make_ascii_uppercase();
    ///     x
    /// }), None);
    /// ```
    #[inline]
    pub fn as_deref_mut_option(&mut self) -> Option<&mut T::Target>
    where
        T: DerefMut,
    {
        match self {
            Self::Value(x) => Some(x),
            _ => None,
        }
    }

    /////////////////////////////////////////////////////////////////////////
    // Iterator constructors
    /////////////////////////////////////////////////////////////////////////

    /// Returns an iterator over the possibly contained value.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value(4);
    /// assert_eq!(x.iter().next(), Some(&4));
    ///
    /// let x: Value<u32> = Value::Null;
    /// assert_eq!(x.iter().next(), None);
    ///
    /// let x: Value<u32> = Value::Unknown;
    /// assert_eq!(x.iter().next(), None);
    /// ```
    #[inline]
    pub fn iter(&self) -> Iter<'_, T> {
        Iter {
            inner: Item { val: self.as_ref() },
        }
    }

    /// Returns a mutable iterator over the possibly contained value.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x = Value::Value(4);
    /// match x.iter_mut().next() {
    ///     Some(v) => *v = 42,
    ///     None => {},
    /// }
    /// assert_eq!(x, Value::Value(42));
    ///
    /// let mut x: Value<u32> = Value::Null;
    /// assert_eq!(x.iter_mut().next(), None);
    ///
    /// let mut x: Value<u32> = Value::Unknown;
    /// assert_eq!(x.iter_mut().next(), None);
    /// ```
    #[inline]
    pub fn iter_mut(&mut self) -> IterMut<'_, T> {
        IterMut {
            inner: Item { val: self.as_mut() },
        }
    }

    /////////////////////////////////////////////////////////////////////////
    // Boolean operations on the values, eager and lazy
    /////////////////////////////////////////////////////////////////////////

    /// Returns [`Value::Null`] if it is [`Value::Null`],
    /// returns [`Value::Unknown`] if it is [`Value::Unknown`],
    /// otherwise returns `rhs`.
    ///
    /// Arguments passed to `and` are eagerly evaluated; if you are passing the
    /// result of a function call, it is recommended to use [`and_then`], which is
    /// lazily evaluated.
    ///
    /// [`and_then`]: Value::and_then
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value(2);
    /// let y: Value<&str> = Value::Null;
    /// assert_eq!(x.and(y), Value::Null);
    ///
    /// let x = Value::Value(2);
    /// let y: Value<&str> = Value::Unknown;
    /// assert_eq!(x.and(y), Value::Unknown);
    ///
    /// let x: Value<u32> = Value::Null;
    /// let y = Value::Value("foo");
    /// assert_eq!(x.and(y), Value::Null);
    ///
    /// let x: Value<u32> = Value::Unknown;
    /// let y = Value::Value("foo");
    /// assert_eq!(x.and(y), Value::Unknown);
    ///
    /// let x = Value::Value(2);
    /// let y = Value::Value("foo");
    /// assert_eq!(x.and(y), Value::Value("foo"));
    ///
    /// let x: Value<u32> = Value::Null;
    /// let y: Value<&str> = Value::Null;
    /// assert_eq!(x.and(y), Value::Null);
    ///
    /// let x: Value<u32> = Value::Null;
    /// let y: Value<&str> = Value::Unknown;
    /// assert_eq!(x.and(y), Value::Null);
    ///
    /// let x: Value<u32> = Value::Unknown;
    /// let y: Value<&str> = Value::Null;
    /// assert_eq!(x.and(y), Value::Unknown);
    ///
    /// let x: Value<u32> = Value::Unknown;
    /// let y: Value<&str> = Value::Unknown;
    /// assert_eq!(x.and(y), Value::Unknown);
    /// ```
    #[inline]
    pub fn and<U>(self, rhs: Value<U>) -> Value<U> {
        match self {
            Self::Value(_) => rhs,
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Returns [`Value::Null`] if it is [`Value::Null`],
    /// returns [`Value::Unknown`] if it is [`Value::Unknown`],
    /// otherwise calls `f` with the wrapped value and returns the result.
    ///
    /// Often used to chain fallible operations that may return [`Value::Null`] or [`Value::Unknown`].
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let array = [Value::Value(10), Value::Null, Value::Unknown];
    ///
    /// let x: Value<&[Value<i32>]> = Value::Value(&array);
    /// assert_eq!(x.and_then(|slice| slice[0]), Value::Value(10));
    /// assert_eq!(x.and_then(|slice| slice[1]), Value::Null);
    /// assert_eq!(x.and_then(|slice| slice[2]), Value::Unknown);
    ///
    /// let x: Value<&[Value<i32>]> = Value::Null;
    /// assert_eq!(x.and_then(|slice| slice[0]), Value::Null);
    /// assert_eq!(x.and_then(|slice| slice[1]), Value::Null);
    ///
    /// let x: Value<&[Value<i32>]> = Value::Unknown;
    /// assert_eq!(x.and_then(|slice| slice[0]), Value::Unknown);
    /// assert_eq!(x.and_then(|slice| slice[1]), Value::Unknown);
    /// ```
    #[inline]
    pub fn and_then<U, F>(self, f: F) -> Value<U>
    where
        F: FnOnce(T) -> Value<U>,
    {
        match self {
            Self::Value(x) => f(x),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Returns [`Value::Null`] if it is [`Value::Null`],
    /// returns [`Value::Unknown`] if it is [`Value::Unknown`],
    /// otherwise calls `predicate` with the wrapped value and returns:
    ///
    /// - [`Value::Value(t)`] if `predicate` returns `true` (where `t` is the wrapped
    ///   value), and
    /// - [`Value::Null`] if `predicate` returns `false`.
    ///
    /// This function works similar to [`Iterator::filter()`]. You can imagine
    /// the `Value<T>` being an iterator over one or zero elements. `filter()`
    /// lets you decide which elements to keep.
    ///
    /// # Examples
    ///
    /// ```rust
    /// # use tf_provider::value::Value;
    /// fn is_even(n: &i32) -> bool {
    ///     n % 2 == 0
    /// }
    ///
    /// assert_eq!(Value::Value(4).filter(is_even), Value::Value(4));
    /// assert_eq!(Value::Value(3).filter(is_even), Value::Null);
    /// assert_eq!(Value::Null.filter(is_even), Value::Null);
    /// assert_eq!(Value::Unknown.filter(is_even), Value::Unknown);
    /// ```
    ///
    /// [`Value::Value(t)`]: Value::Value
    #[inline]
    pub fn filter<P>(self, predicate: P) -> Self
    where
        P: FnOnce(&T) -> bool,
    {
        match self {
            Self::Value(x) => {
                if predicate(&x) {
                    Value::Value(x)
                } else {
                    Value::Null
                }
            }
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Returns the value if it contains a value or is unknown, otherwise returns `rhs`.
    ///
    /// Arguments passed to `or` are eagerly evaluated; if you are passing the
    /// result of a function call, it is recommended to use [`or_else`], which is
    /// lazily evaluated.
    ///
    /// [`or_else`]: Value::or_else
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = Value::Value(2);
    /// let y = Value::Null;
    /// assert_eq!(x.or(y), Value::Value(2));
    ///
    /// let x = Value::Value(2);
    /// let y = Value::Unknown;
    /// assert_eq!(x.or(y), Value::Value(2));
    ///
    /// let x = Value::Value(2);
    /// let y = Value::Value(100);
    /// assert_eq!(x.or(y), Value::Value(2));
    ///
    /// let x = Value::Null;
    /// let y = Value::Value(100);
    /// assert_eq!(x.or(y), Value::Value(100));
    ///
    /// let x: Value<u32> = Value::Null;
    /// let y = Value::Null;
    /// assert_eq!(x.or(y), Value::Null);
    ///
    /// let x: Value<u32> = Value::Null;
    /// let y = Value::Unknown;
    /// assert_eq!(x.or(y), Value::Unknown);
    ///
    /// let x = Value::Unknown;
    /// let y = Value::Value(100);
    /// assert_eq!(x.or(y), Value::Unknown);
    ///
    /// let x: Value<u32> = Value::Unknown;
    /// let y = Value::Null;
    /// assert_eq!(x.or(y), Value::Unknown);
    ///
    /// let x: Value<u32> = Value::Unknown;
    /// let y = Value::Unknown;
    /// assert_eq!(x.or(y), Value::Unknown);
    /// ```
    #[inline]
    pub fn or(self, rhs: Self) -> Self {
        match self {
            Self::Value(x) => Value::Value(x),
            Self::Null => rhs,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Returns the value if it contains a value or is unknown, otherwise calls `f` and
    /// returns the result.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// fn vikings() -> Value<&'static str> { Value::Value("vikings") }
    /// fn nobody() -> Value<&'static str> { Value::Null }
    /// fn unknown() -> Value<&'static str> { Value::Unknown }
    ///
    /// assert_eq!(Value::Value("barbarians").or_else(vikings), Value::Value("barbarians"));
    /// assert_eq!(Value::Value("barbarians").or_else(nobody), Value::Value("barbarians"));
    /// assert_eq!(Value::Value("barbarians").or_else(unknown), Value::Value("barbarians"));
    /// assert_eq!(Value::Null.or_else(vikings), Value::Value("vikings"));
    /// assert_eq!(Value::Null.or_else(nobody), Value::Null);
    /// assert_eq!(Value::Null.or_else(unknown), Value::Unknown);
    /// assert_eq!(Value::Unknown.or_else(vikings), Value::Unknown);
    /// assert_eq!(Value::Unknown.or_else(nobody), Value::Unknown);
    /// assert_eq!(Value::Unknown.or_else(unknown), Value::Unknown);
    /// ```
    #[inline]
    pub fn or_else<F>(self, f: F) -> Self
    where
        F: FnOnce() -> Self,
    {
        match self {
            Self::Value(x) => Value::Value(x),
            Self::Null => f(),
            Self::Unknown => Value::Unknown,
        }
    }

    /////////////////////////////////////////////////////////////////////////
    // Misc
    /////////////////////////////////////////////////////////////////////////

    /// Takes the value out, leaving a [`Value::Null`] in its place.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x = Value::Value(2);
    /// let y = x.take();
    /// assert_eq!(x, Value::Null);
    /// assert_eq!(y, Value::Value(2));
    ///
    /// let mut x: Value<u32> = Value::Null;
    /// let y = x.take();
    /// assert_eq!(x, Value::Null);
    /// assert_eq!(y, Value::Null);
    ///
    /// let mut x: Value<u32> = Value::Unknown;
    /// let y = x.take();
    /// assert_eq!(x, Value::Null);
    /// assert_eq!(y, Value::Unknown);
    /// ```
    pub fn take(&mut self) -> Self {
        mem::replace(self, Value::Null)
    }

    /// Replaces the actual value by the value given in parameter,
    /// returning the old value if present,
    /// leaving a [`Value::Null`] in its place without deinitializing either one.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x = Value::Value(2);
    /// let old = x.replace(5);
    /// assert_eq!(x, Value::Value(5));
    /// assert_eq!(old, Value::Value(2));
    ///
    /// let mut x = Value::Null;
    /// let old = x.replace(3);
    /// assert_eq!(x, Value::Value(3));
    /// assert_eq!(old, Value::Null);
    ///
    /// let mut x = Value::Unknown;
    /// let old = x.replace(3);
    /// assert_eq!(x, Value::Value(3));
    /// assert_eq!(old, Value::Unknown);
    /// ```
    pub fn replace(&mut self, val: T) -> Self {
        mem::replace(self, Value::Value(val))
    }

    /// Check if the value contains `x`.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// assert_eq!(Value::Value(3).contains(&3), true);
    /// assert_eq!(Value::Value(2).contains(&3), false);
    /// assert_eq!(Value::<i32>::Null.contains(&3), false);
    /// assert_eq!(Value::<i32>::Unknown.contains(&3), false);
    /// ```
    pub fn contains<U>(&self, x: &U) -> bool
    where
        U: PartialEq<T>,
    {
        match self {
            Self::Value(y) => x.eq(y),
            _ => false,
        }
    }
}

impl<T> Value<&T> {
    /// Maps an `Value<&T>` to an `Value<T>` by copying the contents of the
    /// value.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = 12;
    /// let opt_x = Value::Value(&x);
    /// assert_eq!(opt_x, Value::Value(&12));
    /// let copied = opt_x.copied();
    /// assert_eq!(copied, Value::Value(12));
    ///
    /// assert_eq!(Value::<&i32>::Null.copied(), Value::Null);
    /// assert_eq!(Value::<&i32>::Unknown.copied(), Value::Unknown);
    /// ```
    pub fn copied(self) -> Value<T>
    where
        T: Copy,
    {
        match self {
            Self::Value(&x) => Value::Value(x),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Maps an `Value<&T>` to an `Value<T>` by cloning the contents of the
    /// value.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let x = vec![1, 4];
    /// let opt_x = Value::Value(&x);
    /// assert_eq!(opt_x, Value::Value(&vec![1, 4]));
    /// let cloned = opt_x.cloned();
    /// assert_eq!(cloned, Value::Value(vec![1, 4]));
    ///
    /// assert_eq!(Value::<&Vec<i32>>::Null.cloned(), Value::Null);
    /// assert_eq!(Value::<&Vec<i32>>::Unknown.cloned(), Value::Unknown);
    /// ```
    pub fn cloned(self) -> Value<T>
    where
        T: Clone,
    {
        match self {
            Self::Value(x) => Value::Value(x.clone()),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }
}
impl<T> Value<&mut T> {
    /// Maps an `Value<&mut T>` to an `Value<T>` by copying the contents of the
    /// value.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x = 12;
    /// let opt_x = Value::Value(&mut x);
    /// assert_eq!(opt_x, Value::Value(&mut 12));
    /// let copied = opt_x.copied();
    /// assert_eq!(copied, Value::Value(12));
    ///
    /// assert_eq!(Value::<&mut i32>::Null.copied(), Value::Null);
    /// assert_eq!(Value::<&mut i32>::Unknown.copied(), Value::Unknown);
    /// ```
    pub fn copied(self) -> Value<T>
    where
        T: Copy,
    {
        match self {
            Self::Value(&mut x) => Value::Value(x),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }

    /// Maps an `Value<&mut T>` to an `Value<T>` by cloning the contents of the
    /// value.
    ///
    /// # Examples
    ///
    /// ```
    /// # use tf_provider::value::Value;
    /// let mut x = vec![1, 4];
    /// let opt_x = Value::Value(&mut x);
    /// assert_eq!(opt_x, Value::Value(&mut vec![1, 4]));
    /// let cloned = opt_x.cloned();
    /// assert_eq!(cloned, Value::Value(vec![1, 4]));
    ///
    /// assert_eq!(Value::<&mut Vec<i32>>::Null.cloned(), Value::Null);
    /// assert_eq!(Value::<&mut Vec<i32>>::Unknown.cloned(), Value::Unknown);
    /// ```
    pub fn cloned(self) -> Value<T>
    where
        T: Clone,
    {
        match self {
            Self::Value(x) => Value::Value(x.clone()),
            Self::Null => Value::Null,
            Self::Unknown => Value::Unknown,
        }
    }
}

impl<'a> Value<Cow<'a, str>> {
    /// Maps a `&'a Value<Cow<'a, str>>` to `&'a str`
    ///
    /// If the value is null or unknown, returns "".
    #[inline]
    pub fn as_str(&'a self) -> &'a str {
        match self {
            Self::Value(x) => x.as_ref(),
            _ => "",
        }
    }

    /// Maps a `&'a Value<Cow<'a, str>>` to `&'a [u8]`
    ///
    /// If the value is null or unknown, returns b"".
    #[inline]
    pub fn as_bytes(&'a self) -> &'a [u8] {
        match self {
            Self::Value(x) => x.as_bytes(),
            _ => b"",
        }
    }

    /// Maps a `Value<Cow<'a, str>>` to `Value<Cow<'b, str>>`,
    /// extending the lifetime of the content.
    ///
    /// If the value is [`Value::Null`], returns [`Value::Null`].
    /// If the value is [`Value::Unknown`], returns [`Value::Unknown`].
    ///
    /// # Remarks
    ///
    /// If the value is owned, it is moved into the return value without cloning.
    /// If the value is borrowed, it is cloned to make it owned.
    #[inline]
    pub fn extend<'b>(self) -> Value<Cow<'b, str>> {
        match self {
            Value::Value(Cow::Borrowed(s)) => Value::Value(Cow::from(s.to_owned())),
            Value::Value(Cow::Owned(s)) => Value::Value(Cow::from(s)),
            Value::Null => Value::Null,
            Value::Unknown => Value::Unknown,
        }
    }
}
impl<'a> Value<&'a Cow<'a, str>> {
    /// Maps a `&Value<&'a Cow<'a, str>>` to `&'a str`
    ///
    /// If the value is null or unknown, returns "".
    #[inline]
    pub fn as_str(&self) -> &'a str {
        match *self {
            Self::Value(x) => x.as_ref(),
            _ => "",
        }
    }

    /// Maps a `&Value<&'a Cow<'a, str>>` to `&'a [u8]`
    ///
    /// If the value is null or unknown, returns b"".
    #[inline]
    pub fn as_bytes(&self) -> &'a [u8] {
        match *self {
            Self::Value(x) => x.as_bytes(),
            _ => b"",
        }
    }
}

impl<T> IntoIterator for Value<T> {
    type Item = T;
    type IntoIter = IntoIter<T>;

    #[inline]
    fn into_iter(self) -> IntoIter<T> {
        IntoIter {
            inner: Item { val: self },
        }
    }
}

impl<'a, T> IntoIterator for &'a Value<T> {
    type Item = &'a T;
    type IntoIter = Iter<'a, T>;

    fn into_iter(self) -> Iter<'a, T> {
        self.iter()
    }
}

impl<'a, T> IntoIterator for &'a mut Value<T> {
    type Item = &'a mut T;
    type IntoIter = IterMut<'a, T>;

    fn into_iter(self) -> IterMut<'a, T> {
        self.iter_mut()
    }
}

impl<T: Debug> Debug for Value<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Value(value) => Debug::fmt(value, f),
            Self::Null => f.write_str("Null"),
            Self::Unknown => f.write_str("Unknown"),
        }
    }
}

impl Debug for ValueAny {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::String(value) => Debug::fmt(value, f),
            Self::Number(value) => Debug::fmt(value, f),
            Self::Bool(value) => Debug::fmt(value, f),
            Self::List(value) => Debug::fmt(value, f),
            Self::Map(value) => Debug::fmt(value, f),
            Self::Null => f.write_str("Null"),
            Self::Unknown => f.write_str("Unknown"),
        }
    }
}

impl<T> From<T> for Value<T> {
    #[inline]
    fn from(value: T) -> Self {
        Self::Value(value)
    }
}
impl<'a, T> From<&'a Value<T>> for Value<&'a T> {
    #[inline]
    fn from(value: &'a Value<T>) -> Self {
        value.as_ref()
    }
}
impl<'a, T> From<&'a mut Value<T>> for Value<&'a mut T> {
    #[inline]
    fn from(value: &'a mut Value<T>) -> Self {
        value.as_mut()
    }
}
impl<T> From<Option<T>> for Value<T> {
    #[inline]
    fn from(value: Option<T>) -> Self {
        match value {
            Some(x) => Self::Value(x),
            None => Self::Null,
        }
    }
}

impl<'a> From<&'a str> for Value<Cow<'a, str>> {
    fn from(value: &'a str) -> Self {
        Self::Value(Cow::Borrowed(value))
    }
}
impl From<String> for Value<Cow<'_, str>> {
    fn from(value: String) -> Self {
        Self::Value(Cow::Owned(value))
    }
}

impl Deref for Value<Cow<'_, str>> {
    type Target = str;

    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl Display for Value<Cow<'_, str>> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug)]
struct Item<A> {
    val: Value<A>,
}

impl<A> Iterator for Item<A> {
    type Item = A;

    #[inline]
    fn next(&mut self) -> Option<A> {
        self.val.take().as_option()
    }

    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        match self.val {
            Value::Value(_) => (1, Some(1)),
            _ => (0, Some(0)),
        }
    }
}

impl<A> DoubleEndedIterator for Item<A> {
    #[inline]
    fn next_back(&mut self) -> Option<A> {
        self.val.take().as_option()
    }
}

impl<A> ExactSizeIterator for Item<A> {}
impl<A> FusedIterator for Item<A> {}

#[derive(Debug)]
pub struct Iter<'a, A: 'a> {
    inner: Item<&'a A>,
}

impl<'a, A> Iterator for Iter<'a, A> {
    type Item = &'a A;

    #[inline]
    fn next(&mut self) -> Option<&'a A> {
        self.inner.next()
    }
    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<'a, A> DoubleEndedIterator for Iter<'a, A> {
    #[inline]
    fn next_back(&mut self) -> Option<&'a A> {
        self.inner.next_back()
    }
}

impl<A> ExactSizeIterator for Iter<'_, A> {}

impl<A> FusedIterator for Iter<'_, A> {}

impl<A> Clone for Iter<'_, A> {
    #[inline]
    fn clone(&self) -> Self {
        Iter {
            inner: self.inner.clone(),
        }
    }
}

#[derive(Debug)]
pub struct IterMut<'a, A: 'a> {
    inner: Item<&'a mut A>,
}

impl<'a, A> Iterator for IterMut<'a, A> {
    type Item = &'a mut A;

    #[inline]
    fn next(&mut self) -> Option<&'a mut A> {
        self.inner.next()
    }
    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<'a, A> DoubleEndedIterator for IterMut<'a, A> {
    #[inline]
    fn next_back(&mut self) -> Option<&'a mut A> {
        self.inner.next_back()
    }
}

impl<A> ExactSizeIterator for IterMut<'_, A> {}

impl<A> FusedIterator for IterMut<'_, A> {}

pub struct IntoIter<A> {
    inner: Item<A>,
}

impl<A> Iterator for IntoIter<A> {
    type Item = A;

    #[inline]
    fn next(&mut self) -> Option<A> {
        self.inner.next()
    }
    #[inline]
    fn size_hint(&self) -> (usize, Option<usize>) {
        self.inner.size_hint()
    }
}

impl<A> DoubleEndedIterator for IntoIter<A> {
    #[inline]
    fn next_back(&mut self) -> Option<A> {
        self.inner.next_back()
    }
}

impl<A> ExactSizeIterator for IntoIter<A> {}

impl<A> FusedIterator for IntoIter<A> {}
