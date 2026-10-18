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

//! [`Provider`] module

use std::collections::HashMap;

use crate::data_source::DynamicDataSource;
use crate::diagnostics::Diagnostics;
use crate::function::DynamicFunction;
use crate::raw::RawValue;
use crate::resource::DynamicResource;
use crate::schema::Schema;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Trait for implementing a provider with automatic serialization/deserialization
///
/// See also: [`DynamicProvider`]
#[async_trait]
pub trait Provider: Send + Sync + 'static {
    /// Configuration of the provider
    ///
    /// The state will be automatically serialized/deserialized at the border of the request.
    type Config<'a>: Serialize + Deserialize<'a> + Send;

    /// State of the provider metadata
    ///
    /// The metadata state will be automatically serialized/deserialized at the border of the request.
    type MetaState<'a>: Serialize + Deserialize<'a> + Send;

    /// Get the schema of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the schema
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn schema(&self, diags: &mut Diagnostics) -> Option<Schema>;

    /// Validate the configuration of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during validation
    /// * `config` - State as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: Self::Config<'a>) -> Option<()> {
        _ = diags;
        _ = config;
        Some(())
    }

    /// Configure the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during validation
    /// * `terraform_version` - Version of the Terraform binary that calls the provider
    /// * `config` - State as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn configure<'a>(
        &self,
        diags: &mut Diagnostics,
        terraform_version: String,
        config: Self::Config<'a>,
    ) -> Option<()> {
        _ = diags;
        _ = terraform_version;
        _ = config;
        Some(())
    }

    /// Get the schema for the provider metadata (defaults to empty)
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the schema
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn meta_schema(&self, diags: &mut Diagnostics) -> Option<Schema> {
        _ = diags;
        Some(Schema {
            version: 1,
            block: Default::default(),
        })
    }

    /// Get the resources of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the resources
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn get_resources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        _ = diags;
        Some(HashMap::new())
    }

    /// Get the data sources of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the data sources
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn get_data_sources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        _ = diags;
        Some(HashMap::new())
    }

    /// Get the functions of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the functions
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn get_functions(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicFunction>>> {
        _ = diags;
        Some(HashMap::new())
    }
}

/// Trait for implementing a provider *without* automatic serialization/deserialization
///
/// See also: [`Provider`]
#[async_trait]
pub trait DynamicProvider: Send + Sync + 'static {
    /// Get the schema of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the schema
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn schema(&self, diags: &mut Diagnostics) -> Option<Schema>;

    /// Validate the configuration of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during validation
    /// * `config` - State as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn validate(&self, diags: &mut Diagnostics, config: RawValue) -> Option<()> {
        _ = diags;
        _ = config;
        Some(())
    }

    /// Configure the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during validation
    /// * `terraform_version` - Version of the Terraform binary that calls the provider
    /// * `config` - State as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn configure(
        &self,
        diags: &mut Diagnostics,
        terraform_version: String,
        config: RawValue,
    ) -> Option<()> {
        _ = diags;
        _ = terraform_version;
        _ = config;
        Some(())
    }

    /// Get the schema for the provider metadata (defaults to empty)
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the schema
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn meta_schema(&self, diags: &mut Diagnostics) -> Option<Schema> {
        _ = diags;
        Some(Schema {
            version: 1,
            block: Default::default(),
        })
    }

    /// Get the resources of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the resources
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn get_resources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        _ = diags;
        Some(HashMap::new())
    }

    /// Get the data sources of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the data sources
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn get_data_sources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        _ = diags;
        Some(HashMap::new())
    }

    /// Get the functions of the provider
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured when getting back the functions
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    fn get_functions(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicFunction>>> {
        _ = diags;
        Some(HashMap::new())
    }
}

#[async_trait]
impl<T: Provider> DynamicProvider for T {
    /// Get the schema of the provider
    fn schema(&self, diags: &mut Diagnostics) -> Option<Schema> {
        <T as Provider>::schema(self, diags)
    }

    /// Validate the configuration of the provider
    async fn validate(&self, diags: &mut Diagnostics, config: RawValue) -> Option<()> {
        let config = config.deserialize(diags)?;
        <T as Provider>::validate(self, diags, config).await
    }

    /// Configure the provider
    async fn configure(
        &self,
        diags: &mut Diagnostics,
        terraform_version: String,
        config: RawValue,
    ) -> Option<()> {
        let config = config.deserialize(diags)?;
        <T as Provider>::configure(self, diags, terraform_version, config).await
    }

    /// Get the schema for the provider metadata (defaults to empty)
    fn meta_schema(&self, diags: &mut Diagnostics) -> Option<Schema> {
        <T as Provider>::meta_schema(self, diags)
    }

    /// Get the resources of the provider
    fn get_resources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicResource>>> {
        <T as Provider>::get_resources(self, diags)
    }

    /// Get the data sources of the provider
    fn get_data_sources(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicDataSource>>> {
        <T as Provider>::get_data_sources(self, diags)
    }

    /// Get the functions of the provider
    fn get_functions(
        &self,
        diags: &mut Diagnostics,
    ) -> Option<HashMap<String, Box<dyn DynamicFunction>>> {
        <T as Provider>::get_functions(self, diags)
    }
}

impl<T: Provider + 'static> From<T> for Box<dyn DynamicProvider> {
    fn from(value: T) -> Self {
        Box::new(value)
    }
}
