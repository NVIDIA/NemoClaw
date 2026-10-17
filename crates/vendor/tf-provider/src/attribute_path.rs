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

//! [`AttributePath`] module

use std::{borrow::Cow, fmt::Display};

use crate::tfplugin6;

/// Represent the path to an attribute
///
/// # Example
///
/// ```
/// # use tf_provider::AttributePath;
/// let path = AttributePath::new("foo").key("bar").attribute("array").index(1);
/// // foo["bar"].array[1]
/// ```
#[derive(Clone, PartialEq, Eq, Hash, Debug, Default)]
pub struct AttributePath {
    pub steps: Vec<AttributePathStep>,
}

impl AttributePath {
    /// Create a new attribute path with the `root` attribute
    ///
    /// # Arguments
    ///
    /// * `name` - Name of the root attribute
    pub fn new<T: Into<Cow<'static, str>>>(name: T) -> Self {
        Self {
            steps: vec![AttributePathStep::Attribute(name.into())],
        }
    }

    /// Create a new attribute path without any path component
    pub fn root() -> Self {
        Self::default()
    }

    /// Create a new attribute path for a function argument
    ///
    /// # Arguments
    ///
    /// * `index` - index of the function argument
    pub fn function_argument(index: i64) -> Self {
        Self {
            steps: vec![AttributePathStep::Index(index)],
        }
    }

    /// Create a new attribute path where the attribute `.name` has been appended
    ///
    /// # Arguments
    ///
    /// * `name` - name of the attribute
    pub fn attribute<T: Into<Cow<'static, str>>>(mut self, name: T) -> Self {
        self.add_attribute(name);
        self
    }

    /// Create a new attribute path where the access `["key"]` has been appended
    ///
    /// # Arguments
    ///
    /// * `key` - string subscript
    pub fn key<T: Into<Cow<'static, str>>>(mut self, key: T) -> Self {
        self.add_key(key);
        self
    }

    /// Create a new attribute path where the access `[idx]` has been appended
    ///
    /// # Arguments
    ///
    /// * `idx` - integer subscript
    pub fn index<T: Into<i64>>(mut self, idx: T) -> Self {
        self.add_index(idx);
        self
    }

    /// Add name access to the path (ie: `.name`)
    ///
    /// # Arguments
    ///
    /// * `name` - name of the attribute
    pub fn add_attribute<T: Into<Cow<'static, str>>>(&mut self, name: T) -> &mut Self {
        self.steps.push(AttributePathStep::Attribute(name.into()));
        self
    }

    /// add key access to the path (ie: `["key"]`)
    ///
    /// # Arguments
    ///
    /// * `key` - string subscript
    pub fn add_key<T: Into<Cow<'static, str>>>(&mut self, key: T) -> &mut Self {
        self.steps.push(AttributePathStep::Key(key.into()));
        self
    }

    /// add index access to the path (ie: `[idx]`)
    ///
    /// # Arguments
    ///
    /// * `idx` - integer subscript
    pub fn add_index<T: Into<i64>>(&mut self, idx: T) -> &mut Self {
        self.steps.push(AttributePathStep::Index(idx.into()));
        self
    }

    /// Add step to the path
    ///
    /// # Arguments
    ///
    /// * `step` - step to add
    pub fn add_step(&mut self, step: AttributePathStep) -> &mut Self {
        self.steps.push(step);
        self
    }

    /// Add multiple steps into the path
    ///
    /// # Arguments
    ///
    /// * `steps` - steps to add
    pub fn add_steps(&mut self, mut steps: AttributePath) -> &mut Self {
        self.steps.append(&mut steps.steps);
        self
    }
}

impl Display for AttributePath {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut sep = "";
        for step in &self.steps {
            match step {
                AttributePathStep::Attribute(name) => {
                    f.write_fmt(format_args!("{}{}", sep, name))?
                }
                AttributePathStep::Key(key) => f.write_fmt(format_args!("[{:?}]", key))?,
                AttributePathStep::Index(idx) => f.write_fmt(format_args!("[{}]", idx))?,
            }
            sep = ".";
        }
        Ok(())
    }
}

impl std::ops::AddAssign<AttributePathStep> for AttributePath {
    fn add_assign(&mut self, rhs: AttributePathStep) {
        self.steps.push(rhs);
    }
}

impl std::ops::Add<AttributePathStep> for AttributePath {
    type Output = Self;
    fn add(mut self, rhs: AttributePathStep) -> Self::Output {
        self += rhs;
        self
    }
}

impl From<AttributePathStep> for AttributePath {
    fn from(value: AttributePathStep) -> Self {
        Self { steps: vec![value] }
    }
}

impl From<AttributePath> for tfplugin6::AttributePath {
    fn from(value: AttributePath) -> Self {
        Self {
            steps: value.steps.into_iter().map(|step| step.into()).collect(),
        }
    }
}

/// Single step of an [`AttributePath`]
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum AttributePathStep {
    /// Attribute access: `.foo`
    Attribute(Cow<'static, str>),
    /// String subscript: `["foo"]`
    Key(Cow<'static, str>),
    /// Integer subscript: `[1]`
    Index(i64),
}

impl Display for AttributePathStep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttributePathStep::Attribute(name) => f.write_str(name.as_ref()),
            AttributePathStep::Key(key) => f.write_fmt(format_args!("[{:?}]", key)),
            AttributePathStep::Index(idx) => f.write_fmt(format_args!("[{}]", idx)),
        }
    }
}

impl std::ops::Add<AttributePathStep> for AttributePathStep {
    type Output = AttributePath;
    fn add(self, rhs: AttributePathStep) -> Self::Output {
        AttributePath {
            steps: vec![self, rhs],
        }
    }
}

impl From<AttributePathStep> for tfplugin6::attribute_path::Step {
    fn from(value: AttributePathStep) -> Self {
        use tfplugin6::attribute_path::step::Selector;
        Self {
            selector: Some(match value {
                AttributePathStep::Attribute(name) => Selector::AttributeName(name.into_owned()),
                AttributePathStep::Key(key) => Selector::ElementKeyString(key.into_owned()),
                AttributePathStep::Index(idx) => Selector::ElementKeyInt(idx),
            }),
        }
    }
}
