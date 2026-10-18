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

//! Terraform provider library
//!
//! It enables to write your own TF provider that is supported by both Terraform and OpenTofu.
//!
//! Implementing a provider consists in implementing the [`Resource`], [`DataSource`], and/or [`Function`] traits,
//! and implementing the [`Provider`] trait that references the resources, data sources and functions.

mod attribute_path;
mod data_source;
mod diagnostics;
mod function;
mod plugin;
mod provider;
mod raw;
mod resource;
mod server;
mod tf6provider;
mod utils;

pub mod schema;
pub mod value;

mod tfplugin6 {
    tonic::include_proto!("tfplugin6");
}

pub use attribute_path::{AttributePath, AttributePathStep};
pub use data_source::{DataSource, DynamicDataSource};
pub use diagnostics::{Diagnostic, Diagnostics};
pub use function::{DynamicFunction, Function};
pub use provider::{DynamicProvider, Provider};
pub use resource::{DynamicResource, Resource};
pub use server::{serve, serve_dynamic};

#[macro_export]
/// Build a hash map
///
/// # Examples
///
/// ```
/// # use tf_provider::map;
/// # use std::collections::HashMap;
/// let m: HashMap<String, String> = map!{
///     "key1" => "value1",
///     "key2" => "value2",
/// };
/// ```
///
/// # Remarks
///
/// Keys and Values are converted with [`Into::into`] to build the map.
/// Because of that, type annotations are usually required.
macro_rules! map {
    {$($key:expr => $value:expr),*} => {
        {
            let mut map = std::collections::HashMap::default();
            $(
                map.insert($key.into(), $value.into());
            )*
            map
        }
    };

    {$($key:expr => $value:expr),+ ,} => { map!{$($key => $value),+} };
}
