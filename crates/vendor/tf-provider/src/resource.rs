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

//! [`Resource`] module

use crate::attribute_path::AttributePath;
use crate::diagnostics::Diagnostics;
use crate::raw::RawValue;
use crate::schema::Schema;
use crate::utils::OptionFactor;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// Trait for implementing a resource with automatic serialization/deserialization
///
/// See also: [`DynamicResource`]
#[async_trait]
pub trait Resource: Send + Sync {
    /// State of the resource
    ///
    /// The state will be automatically serialized/deserialized at the border of the request.
    type State<'a>: Serialize + Deserialize<'a> + Send;

    /// Private state of the resource
    ///
    /// The private state will be automatically serialized/deserialized at the border of the request.
    type PrivateState<'a>: Serialize + Deserialize<'a> + Send;

    /// State of the provider metadata
    ///
    /// The state will be automatically serialized/deserialized at the border of the request.
    type ProviderMetaState<'a>: Serialize + Deserialize<'a> + Send;

    /// Get the schema of the resource
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

    /// Validate the configuration of the resource
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
    async fn validate<'a>(&self, diags: &mut Diagnostics, config: Self::State<'a>) -> Option<()> {
        _ = diags;
        _ = config;
        Some(())
    }

    /// Read the new state of the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the read
    /// * `state` - State as stored in the Terraform state
    /// * `private_state` - Private state as stored in the Terraform state
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// Return must be [`None`] if the resource has been destroyed externally.
    /// Return must be [`Some`] if the resource is still there, even if there was errors while reading the resource.
    async fn read<'a>(
        &self,
        diags: &mut Diagnostics,
        state: Self::State<'a>,
        private_state: Self::PrivateState<'a>,
        provider_meta_state: Self::ProviderMetaState<'a>,
    ) -> Option<(Self::State<'a>, Self::PrivateState<'a>)>;

    /// Plan the creation of a new resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the plan
    /// * `proposed_state` - State proposed by Terraform
    /// * `config_state` - State as declared in the Terraform file
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn plan_create<'a>(
        &self,
        diags: &mut Diagnostics,
        proposed_state: Self::State<'a>,
        config_state: Self::State<'a>,
        provider_meta_state: Self::ProviderMetaState<'a>,
    ) -> Option<(Self::State<'a>, Self::PrivateState<'a>)>;

    /// Plan the changes on the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the plan
    /// * `prior_state` - State as stored in the Terraform state
    /// * `proposed_state` - State proposed by Terraform
    /// * `config_state` - State as declared in the Terraform file
    /// * `private_state` - Private state as stored in the Terraform state
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn plan_update<'a>(
        &self,
        diags: &mut Diagnostics,
        prior_state: Self::State<'a>,
        proposed_state: Self::State<'a>,
        config_state: Self::State<'a>,
        prior_private_state: Self::PrivateState<'a>,
        provider_meta_state: Self::ProviderMetaState<'a>,
    ) -> Option<(Self::State<'a>, Self::PrivateState<'a>, Vec<AttributePath>)>;

    /// Plan the destruction of the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the plan
    /// * `prior_state` - State as stored in the Terraform state
    /// * `prior_private_state` - Private state as stored in the Terraform state
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn plan_destroy<'a>(
        &self,
        diags: &mut Diagnostics,
        prior_state: Self::State<'a>,
        prior_private_state: Self::PrivateState<'a>,
        provider_meta_state: Self::ProviderMetaState<'a>,
    ) -> Option<Self::PrivateState<'a>>;

    /// Create a new resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the creation
    /// * `planned_state` - State proposed by the provider upon plan
    /// * `config_state` - State as declared in the Terraform file
    /// * `planned_private_state` - Private state proposed by the provider upon plan
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    /// Return must be [`Some`] if the resource was created, even if there was errors while creating the resource.
    async fn create<'a>(
        &self,
        diags: &mut Diagnostics,
        planned_state: Self::State<'a>,
        config_state: Self::State<'a>,
        planned_private_state: Self::PrivateState<'a>,
        provider_meta_state: Self::ProviderMetaState<'a>,
    ) -> Option<(Self::State<'a>, Self::PrivateState<'a>)>;

    /// Apply the changes on the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the update
    /// * `prior_state` - State as stored in the Terraform state
    /// * `planned_state` - State proposed by the provider upon plan
    /// * `config_state` - State as declared in the Terraform file
    /// * `planned_private_state` - Private state proposed by the provider upon plan
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics, and the resource state is kept unchanged.
    /// Return must be [`Some`] if the resource was updated, even if there was errors while updated the resource.
    async fn update<'a>(
        &self,
        diags: &mut Diagnostics,
        prior_state: Self::State<'a>,
        planned_state: Self::State<'a>,
        config_state: Self::State<'a>,
        planned_private_state: Self::PrivateState<'a>,
        provider_meta_state: Self::ProviderMetaState<'a>,
    ) -> Option<(Self::State<'a>, Self::PrivateState<'a>)>;

    /// Destroy the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the destruction
    /// * `prior_state` - State as stored in the Terraform state
    /// * `planned_private_state` - Private state proposed by the provider upon plan
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn destroy<'a>(
        &self,
        diags: &mut Diagnostics,
        prior_state: Self::State<'a>,
        planned_private_state: Self::PrivateState<'a>,
        provider_meta_state: Self::ProviderMetaState<'a>,
    ) -> Option<()>;

    /// Import an existing resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the import
    /// * `id` - Opaque string that the provider can use to identify the actual resource to import
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    /// Return must be [`Some`] if the resource was imported, even if there was errors while importing the resource.
    async fn import<'a>(
        &self,
        diags: &mut Diagnostics,
        id: String,
    ) -> Option<(Self::State<'a>, Self::PrivateState<'a>)> {
        _ = id;
        diags.root_error_short("Import is not supported");
        None
    }

    /// Upgrade the resource from a prior version of the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the import
    /// * `version` - Prior version of the resource to upgrade as recorded in Terraform state
    /// * `prior_state` - Prior state of the resource to upgrade as recorded in Terraform state
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics, and the resource state is kept unchanged.
    /// Return must be [`Some`] if the resource was upgraded, even if there was errors while upgraded the resource.
    ///
    /// Because the schema of the resource might have changed,
    /// the prior state must be deserialized explicitely.
    async fn upgrade<'a>(
        &self,
        diags: &mut Diagnostics,
        version: i64,
        prior_state: RawValue,
    ) -> Option<Self::State<'a>> {
        _ = version;
        _ = prior_state;
        diags.root_error_short("Upgrade is not supported");
        None
    }
}

/// Trait for implementing a resource *without* automatic serialization/deserialization
///
/// See also: [`Resource`]
#[async_trait]
pub trait DynamicResource: Send + Sync {
    /// Get the schema of the resource
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

    /// Validate the configuration of the resource
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

    /// Read the new state of the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the read
    /// * `state` - State as stored in the Terraform state
    /// * `private_state` - Private state as stored in the Terraform state
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// Return must be [`None`] if the resource has been destroyed externally.
    /// Return must be [`Some`] if the resource is still there, even if there was errors while reading the resource.
    async fn read(
        &self,
        diags: &mut Diagnostics,
        state: RawValue,
        private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)>;

    /// Plan the creation of a new resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the plan
    /// * `proposed_state` - State proposed by Terraform
    /// * `config_state` - State as declared in the Terraform file
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn plan_create(
        &self,
        diags: &mut Diagnostics,
        proposed_state: RawValue,
        config_state: RawValue,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)>;

    /// Plan the changes on the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the plan
    /// * `prior_state` - State as stored in the Terraform state
    /// * `proposed_state` - State proposed by Terraform
    /// * `config_state` - State as declared in the Terraform file
    /// * `private_state` - Private state as stored in the Terraform state
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn plan_update(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        proposed_state: RawValue,
        config_state: RawValue,
        prior_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>, Vec<AttributePath>)>;

    /// Plan the destruction of the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the plan
    /// * `prior_state` - State as stored in the Terraform state
    /// * `prior_private_state` - Private state as stored in the Terraform state
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn plan_destroy(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        prior_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<Vec<u8>>;

    /// Create a new resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the creation
    /// * `planned_state` - State proposed by the provider upon plan
    /// * `config_state` - State as declared in the Terraform file
    /// * `planned_private_state` - Private state proposed by the provider upon plan
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    /// Return must be [`Some`] if the resource was created, even if there was errors while creating the resource.
    async fn create(
        &self,
        diags: &mut Diagnostics,
        planned_state: RawValue,
        config_state: RawValue,
        planned_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)>;

    /// Apply the changes on the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the update
    /// * `prior_state` - State as stored in the Terraform state
    /// * `planned_state` - State proposed by the provider upon plan
    /// * `config_state` - State as declared in the Terraform file
    /// * `planned_private_state` - Private state proposed by the provider upon plan
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics, and the resource state is kept unchanged.
    /// Return must be [`Some`] if the resource was updated, even if there was errors while updated the resource.
    async fn update(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        planned_state: RawValue,
        config_state: RawValue,
        planned_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)>;

    /// Destroy the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the destruction
    /// * `prior_state` - State as stored in the Terraform state
    /// * `planned_private_state` - Private state proposed by the provider upon plan
    /// * `provider_meta_state` - State of the provider metadata as declared in the Terraform file
    ///
    /// # Remarks
    ///
    /// The return is ignored if there is an error in diagnostics.
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    async fn destroy(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        planned_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<()>;

    /// Import an existing resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the import
    /// * `id` - Opaque string that the provider can use to identify the actual resource to import
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics.
    /// Return must be [`Some`] if the resource was imported, even if there was errors while importing the resource.
    async fn import(&self, diags: &mut Diagnostics, id: String) -> Option<(RawValue, Vec<u8>)> {
        _ = id;
        diags.root_error_short("Import is not supported");
        None
    }

    /// Upgrade the resource
    ///
    /// # Arguments
    ///
    /// * `diags` - Diagnostics to record warnings and errors that occured during the import
    /// * `version` - Prior version of the resource to upgrade as recorded in Terraform state
    /// * `prior_state` - Prior state of the resource to upgrade as recorded in Terraform state
    ///
    /// # Remarks
    ///
    /// If the return is [`None`], an ad-hoc error is added to diagnostics, and the resource state is kept unchanged.
    /// Return must be [`Some`] if the resource was upgraded, even if there was errors while upgraded the resource.
    async fn upgrade(
        &self,
        diags: &mut Diagnostics,
        version: i64,
        prior_state: RawValue,
    ) -> Option<RawValue> {
        _ = version;
        _ = prior_state;
        diags.root_error_short("Upgrade is not supported");
        None
    }
}

#[async_trait]
impl<T: Resource> DynamicResource for T {
    /// Get the schema of the resource
    fn schema(&self, diags: &mut Diagnostics) -> Option<Schema> {
        <T as Resource>::schema(self, diags)
    }
    /// Validate the configuration of the resource
    async fn validate(&self, diags: &mut Diagnostics, config: RawValue) -> Option<()> {
        let config = config.deserialize(diags)?;
        <T as Resource>::validate(self, diags, config).await
    }
    /// Read the new state of the resource
    async fn read(
        &self,
        diags: &mut Diagnostics,
        state: RawValue,
        private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)> {
        let private_state = RawValue::MessagePack(private_state);
        let (state, private_state, provider_meta_state) = (
            state.deserialize(diags),
            private_state.deserialize(diags),
            provider_meta_state.deserialize(diags),
        )
            .factor()?;

        let (state, private_state) =
            <T as Resource>::read(self, diags, state, private_state, provider_meta_state).await?;

        (
            RawValue::serialize(diags, &state),
            RawValue::serialize_vec(diags, &private_state),
        )
            .factor()
    }
    /// Plan the creation of a new resource
    async fn plan_create(
        &self,
        diags: &mut Diagnostics,
        proposed_state: RawValue,
        config_state: RawValue,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)> {
        let (proposed_state, config_state, provider_meta_state) = (
            proposed_state.deserialize(diags),
            config_state.deserialize(diags),
            provider_meta_state.deserialize(diags),
        )
            .factor()?;

        let (state, private_state) = <T as Resource>::plan_create(
            self,
            diags,
            proposed_state,
            config_state,
            provider_meta_state,
        )
        .await?;

        (
            RawValue::serialize(diags, &state),
            RawValue::serialize_vec(diags, &private_state),
        )
            .factor()
    }
    /// Plan the changes on the resource
    async fn plan_update(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        proposed_state: RawValue,
        config_state: RawValue,
        prior_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>, Vec<AttributePath>)> {
        let prior_private_state = RawValue::MessagePack(prior_private_state);
        let (prior_state, proposed_state, config_state, prior_private_state, provider_meta_state) =
            (
                prior_state.deserialize(diags),
                proposed_state.deserialize(diags),
                config_state.deserialize(diags),
                prior_private_state.deserialize(diags),
                provider_meta_state.deserialize(diags),
            )
                .factor()?;

        let (state, private_state, destroy_triggers) = <T as Resource>::plan_update(
            self,
            diags,
            prior_state,
            proposed_state,
            config_state,
            prior_private_state,
            provider_meta_state,
        )
        .await?;

        (
            RawValue::serialize(diags, &state),
            RawValue::serialize_vec(diags, &private_state),
            Some(destroy_triggers),
        )
            .factor()
    }
    /// Plan the destruction of the resource
    async fn plan_destroy(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        prior_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<Vec<u8>> {
        let prior_private_state = RawValue::MessagePack(prior_private_state);
        let (prior_state, prior_private_state, provider_meta_state) = (
            prior_state.deserialize(diags),
            prior_private_state.deserialize(diags),
            provider_meta_state.deserialize(diags),
        )
            .factor()?;

        let private_state = <T as Resource>::plan_destroy(
            self,
            diags,
            prior_state,
            prior_private_state,
            provider_meta_state,
        )
        .await?;

        RawValue::serialize_vec(diags, &private_state)
    }
    /// Create a new resource
    async fn create(
        &self,
        diags: &mut Diagnostics,
        planned_state: RawValue,
        config_state: RawValue,
        planned_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)> {
        let planned_private_state = RawValue::MessagePack(planned_private_state);
        let (planned_state, config_state, planned_private_state, provider_meta_state) = (
            planned_state.deserialize(diags),
            config_state.deserialize(diags),
            planned_private_state.deserialize(diags),
            provider_meta_state.deserialize(diags),
        )
            .factor()?;
        let (state, private_state) = <T as Resource>::create(
            self,
            diags,
            planned_state,
            config_state,
            planned_private_state,
            provider_meta_state,
        )
        .await?;
        (
            RawValue::serialize(diags, &state),
            RawValue::serialize_vec(diags, &private_state),
        )
            .factor()
    }
    /// Apply the changes on the resource
    async fn update(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        planned_state: RawValue,
        config_state: RawValue,
        planned_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<(RawValue, Vec<u8>)> {
        let planned_private_state = RawValue::MessagePack(planned_private_state);
        let (prior_state, planned_state, config_state, planned_private_state, provider_meta_state) =
            (
                prior_state.deserialize(diags),
                planned_state.deserialize(diags),
                config_state.deserialize(diags),
                planned_private_state.deserialize(diags),
                provider_meta_state.deserialize(diags),
            )
                .factor()?;
        let (state, private_state) = <T as Resource>::update(
            self,
            diags,
            prior_state,
            planned_state,
            config_state,
            planned_private_state,
            provider_meta_state,
        )
        .await?;
        (
            RawValue::serialize(diags, &state),
            RawValue::serialize_vec(diags, &private_state),
        )
            .factor()
    }
    /// Destroy the resource
    async fn destroy(
        &self,
        diags: &mut Diagnostics,
        prior_state: RawValue,
        planned_private_state: Vec<u8>,
        provider_meta_state: RawValue,
    ) -> Option<()> {
        let planned_private_state = RawValue::MessagePack(planned_private_state);
        let (prior_state, planned_private_state, provider_meta_state) = (
            prior_state.deserialize(diags),
            planned_private_state.deserialize(diags),
            provider_meta_state.deserialize(diags),
        )
            .factor()?;

        <T as Resource>::destroy(
            self,
            diags,
            prior_state,
            planned_private_state,
            provider_meta_state,
        )
        .await
    }
    /// Import an existing resource
    async fn import(&self, diags: &mut Diagnostics, id: String) -> Option<(RawValue, Vec<u8>)> {
        let (state, private_state) = <T as Resource>::import(self, diags, id).await?;
        (
            RawValue::serialize(diags, &state),
            RawValue::serialize_vec(diags, &private_state),
        )
            .factor()
    }
    /// Upgrade the resource
    async fn upgrade(
        &self,
        diags: &mut Diagnostics,
        version: i64,
        prior_state: RawValue,
    ) -> Option<RawValue> {
        let state = <T as Resource>::upgrade(self, diags, version, prior_state).await?;
        RawValue::serialize(diags, &state)
    }
}

impl<T: Resource + 'static> From<T> for Box<dyn DynamicResource> {
    fn from(value: T) -> Self {
        Box::new(value)
    }
}
