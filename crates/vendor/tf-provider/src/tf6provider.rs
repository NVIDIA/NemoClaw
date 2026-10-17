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

//! Implementation of TF gRPC services for the version 6 of the protocol

use std::fmt::Write;
use std::sync::Arc;

use crate::attribute_path::AttributePathStep;
use crate::diagnostics::Diagnostics;
use crate::raw::RawValue;
use crate::server::Server;
use crate::tfplugin6 as tf;
use crate::utils::{CollectDiagnostics, OptionExpand};

#[tonic::async_trait]
impl tf::provider_server::Provider for Arc<Server> {
    async fn get_metadata(
        &self,
        _request: tonic::Request<tf::get_metadata::Request>,
    ) -> std::result::Result<tonic::Response<tf::get_metadata::Response>, tonic::Status> {
        let resources = self
            .resources
            .keys()
            .map(|name| tf::get_metadata::ResourceMetadata {
                type_name: name.clone(),
            })
            .collect();
        let data_sources = self
            .data_sources
            .keys()
            .map(|name| tf::get_metadata::DataSourceMetadata {
                type_name: name.clone(),
            })
            .collect();
        let functions = self
            .functions
            .keys()
            .map(|name| tf::get_metadata::FunctionMetadata { name: name.clone() })
            .collect();
        Ok(tonic::Response::new(tf::get_metadata::Response {
            server_capabilities: Some(tf::ServerCapabilities {
                plan_destroy: true,
                get_provider_schema_optional: false,
                move_resource_state: false,
            }),
            diagnostics: self.init_diags.clone().into(),
            data_sources,
            resources,
            functions,
        }))
    }
    async fn get_provider_schema(
        &self,
        _request: tonic::Request<tf::get_provider_schema::Request>,
    ) -> Result<tonic::Response<tf::get_provider_schema::Response>, tonic::Status> {
        let schema = self.schema.as_ref().map(Into::into);
        let meta_schema = self.meta_schema.as_ref().map(Into::into);
        let resources = self
            .resources
            .iter()
            .map(|(name, (_, schema))| (name.clone(), schema.into()))
            .collect();
        let data_sources = self
            .data_sources
            .iter()
            .map(|(name, (_, schema))| (name.clone(), schema.into()))
            .collect();
        let functions = self
            .functions
            .iter()
            .map(|(name, (_, schema))| (name.clone(), schema.into()))
            .collect();

        Ok(tonic::Response::new(tf::get_provider_schema::Response {
            provider: schema,
            resource_schemas: resources,
            data_source_schemas: data_sources,
            diagnostics: self.init_diags.clone().into(),
            provider_meta: meta_schema,
            server_capabilities: Some(tf::ServerCapabilities {
                plan_destroy: true,
                get_provider_schema_optional: false,
                move_resource_state: false,
            }),
            functions,
        }))
    }
    async fn validate_provider_config(
        &self,
        request: tonic::Request<tf::validate_provider_config::Request>,
    ) -> Result<tonic::Response<tf::validate_provider_config::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        _ = if let Some(config) = request.config {
            self.provider.validate(&mut diags, config.into()).await
        } else {
            None
        }
        .ok_or_else(|| diags.internal_error());

        Ok(tonic::Response::new(
            tf::validate_provider_config::Response {
                diagnostics: diags.into(),
            },
        ))
    }
    async fn validate_resource_config(
        &self,
        request: tonic::Request<tf::validate_resource_config::Request>,
    ) -> Result<tonic::Response<tf::validate_resource_config::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        _ = if let (Some(resource), Some(config)) = (
            self.get_resource(&mut diags, &request.type_name),
            request.config,
        ) {
            resource.validate(&mut diags, config.into()).await
        } else {
            None
        }
        .ok_or_else(|| diags.internal_error());

        Ok(tonic::Response::new(
            tf::validate_resource_config::Response {
                diagnostics: diags.into(),
            },
        ))
    }
    async fn validate_data_resource_config(
        &self,
        request: tonic::Request<tf::validate_data_resource_config::Request>,
    ) -> Result<tonic::Response<tf::validate_data_resource_config::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        _ = if let (Some(data_source), Some(config)) = (
            self.get_data_source(&mut diags, &request.type_name),
            request.config,
        ) {
            data_source.validate(&mut diags, config.into()).await
        } else {
            None
        }
        .ok_or_else(|| diags.internal_error());

        Ok(tonic::Response::new(
            tf::validate_data_resource_config::Response {
                diagnostics: diags.into(),
            },
        ))
    }
    async fn upgrade_resource_state(
        &self,
        request: tonic::Request<tf::upgrade_resource_state::Request>,
    ) -> Result<tonic::Response<tf::upgrade_resource_state::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        let upgraded_state = if let (Some((resource, schema)), Some(raw_state)) =
            (self.resources.get(&request.type_name), request.raw_state)
        {
            if raw_state.json.is_empty() {
                diags.root_error_short("Upgrading from a legacy state is not supported");
                None
            } else {
                let json = RawValue::Json(raw_state.json);
                if request.version == schema.version {
                    Some(json)
                } else {
                    resource.upgrade(&mut diags, request.version, json).await
                }
            }
        } else {
            None
        }
        .collect_diagnostics(&mut diags);

        Ok(tonic::Response::new(tf::upgrade_resource_state::Response {
            diagnostics: diags.into(),
            upgraded_state: upgraded_state.map(Into::into),
        }))
    }
    /// ////// One-time initialization, called before other functions below
    async fn configure_provider(
        &self,
        request: tonic::Request<tf::configure_provider::Request>,
    ) -> Result<tonic::Response<tf::configure_provider::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        if let Some(config) = request.config {
            if self
                .provider
                .configure(&mut diags, request.terraform_version, config.into())
                .await
                .is_none()
            {
                diags.internal_error();
            }
        }

        Ok(tonic::Response::new(tf::configure_provider::Response {
            diagnostics: diags.into(),
        }))
    }
    /// ////// Managed Resource Lifecycle
    async fn read_resource(
        &self,
        request: tonic::Request<tf::read_resource::Request>,
    ) -> Result<tonic::Response<tf::read_resource::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        let (state, private_state) =
            if let (Some(resource), Some(state), Some(provider_meta_state)) = (
                self.get_resource(&mut diags, &request.type_name),
                request.current_state,
                request.provider_meta,
            ) {
                resource
                    .read(
                        &mut diags,
                        state.into(),
                        request.private,
                        provider_meta_state.into(),
                    )
                    .await
            } else {
                None
            }
            .expand();

        Ok(tonic::Response::new(tf::read_resource::Response {
            new_state: state.map(Into::into),
            diagnostics: diags.into(),
            private: private_state.unwrap_or_default(),
        }))
    }
    async fn plan_resource_change(
        &self,
        request: tonic::Request<tf::plan_resource_change::Request>,
    ) -> Result<tonic::Response<tf::plan_resource_change::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        let (state, private_state, triggers) = if let (
            Some(resource),
            Some(prior_state),
            Some(proposed_state),
            Some(config_state),
            Some(provider_meta_state),
        ) = (
            self.get_resource(&mut diags, &request.type_name),
            request.prior_state,
            request.proposed_new_state,
            request.config,
            request.provider_meta,
        ) {
            let prior_state = RawValue::from(prior_state);
            let proposed_state = RawValue::from(proposed_state);
            let config_state = RawValue::from(config_state);

            match (
                prior_state.is_null(),
                proposed_state.is_null(),
                config_state.is_null(),
            ) {
                (false, false, false) => {
                    resource
                        .plan_update(
                            &mut diags,
                            prior_state,
                            proposed_state,
                            config_state,
                            request.prior_private,
                            provider_meta_state.into(),
                        )
                        .await
                }
                (false, true, true) => {
                    let planned_private = resource
                        .plan_destroy(
                            &mut diags,
                            prior_state,
                            request.prior_private,
                            provider_meta_state.into(),
                        )
                        .await;
                    Some((
                        Default::default(),
                        planned_private.unwrap_or_default(),
                        vec![],
                    ))
                }
                (true, false, false) => {
                    if let Some((state, private_state)) = resource
                        .plan_create(
                            &mut diags,
                            proposed_state,
                            config_state,
                            provider_meta_state.into(),
                        )
                        .await
                    {
                        Some((state, private_state, vec![]))
                    } else {
                        None
                    }
                }
                _ => {
                    diags.root_error_short("Resource is planned both for creation and deletion");
                    None
                }
            }
        } else {
            None
        }
        .map(|(state, private_state, triggers)| {
            (
                state.into(),
                private_state,
                triggers.into_iter().map(|attr| attr.into()).collect(),
            )
        })
        .collect_diagnostics(&mut diags)
        .expand();

        Ok(tonic::Response::new(tf::plan_resource_change::Response {
            planned_state: state,
            requires_replace: triggers.unwrap_or_default(),
            planned_private: private_state.unwrap_or_default(),
            diagnostics: diags.into(),
            legacy_type_system: false,
        }))
    }
    async fn apply_resource_change(
        &self,
        request: tonic::Request<tf::apply_resource_change::Request>,
    ) -> Result<tonic::Response<tf::apply_resource_change::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        let (state, private_state) = if let (
            Some(resource),
            Some(prior_state),
            Some(planned_state),
            Some(config_state),
            Some(provider_meta_state),
        ) = (
            self.get_resource(&mut diags, &request.type_name),
            request.prior_state,
            request.planned_state,
            request.config,
            request.provider_meta,
        ) {
            let prior_state = RawValue::from(prior_state);
            let planned_state = RawValue::from(planned_state);
            let config_state = RawValue::from(config_state);

            match (
                prior_state.is_null(),
                planned_state.is_null(),
                config_state.is_null(),
            ) {
                (false, false, false) => {
                    resource
                        .update(
                            &mut diags,
                            prior_state,
                            planned_state,
                            config_state,
                            request.planned_private,
                            provider_meta_state.into(),
                        )
                        .await
                }
                (false, true, true) => {
                    resource
                        .destroy(
                            &mut diags,
                            prior_state,
                            request.planned_private,
                            provider_meta_state.into(),
                        )
                        .await;
                    Some((Default::default(), vec![]))
                }
                (true, false, false) => {
                    resource
                        .create(
                            &mut diags,
                            planned_state,
                            config_state,
                            request.planned_private,
                            provider_meta_state.into(),
                        )
                        .await
                }
                _ => {
                    diags.root_error_short("Resource is marked both for creation and deletion");
                    None
                }
            }
        } else {
            None
        }
        .collect_diagnostics(&mut diags)
        .expand();

        Ok(tonic::Response::new(tf::apply_resource_change::Response {
            new_state: state.map(Into::into),
            private: private_state.unwrap_or_default(),
            diagnostics: diags.into(),
            legacy_type_system: false,
        }))
    }
    async fn import_resource_state(
        &self,
        request: tonic::Request<tf::import_resource_state::Request>,
    ) -> Result<tonic::Response<tf::import_resource_state::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        let imported = if let Some(resource) = self.get_resource(&mut diags, &request.type_name) {
            resource.import(&mut diags, request.id).await
        } else {
            None
        }
        .collect_diagnostics(&mut diags)
        .map(
            |(state, private_state)| tf::import_resource_state::ImportedResource {
                type_name: request.type_name,
                state: Some(state.into()),
                private: private_state,
            },
        );

        Ok(tonic::Response::new(tf::import_resource_state::Response {
            imported_resources: imported.into_iter().collect(),
            diagnostics: diags.into(),
        }))
    }

    async fn move_resource_state(
        &self,
        _request: tonic::Request<tf::move_resource_state::Request>,
    ) -> std::result::Result<tonic::Response<tf::move_resource_state::Response>, tonic::Status>
    {
        let mut diags = Diagnostics::default();
        diags.root_error_short("MoveResourceState is not implemented");
        Ok(tonic::Response::new(tf::move_resource_state::Response {
            diagnostics: diags.into(),
            target_private: vec![],
            target_state: None,
        }))
    }
    async fn read_data_source(
        &self,
        request: tonic::Request<tf::read_data_source::Request>,
    ) -> Result<tonic::Response<tf::read_data_source::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        let state = if let (Some(data_source), Some(config), Some(provider_meta_state)) = (
            self.get_data_source(&mut diags, &request.type_name),
            request.config,
            request.provider_meta,
        ) {
            data_source
                .read(&mut diags, config.into(), provider_meta_state.into())
                .await
        } else {
            None
        }
        .collect_diagnostics(&mut diags);

        Ok(tonic::Response::new(tf::read_data_source::Response {
            state: state.map(Into::into),
            diagnostics: diags.into(),
        }))
    }
    async fn get_functions(
        &self,
        _request: tonic::Request<tf::get_functions::Request>,
    ) -> std::result::Result<tonic::Response<tf::get_functions::Response>, tonic::Status> {
        let functions = self
            .functions
            .iter()
            .map(|(name, (_, schema))| (name.clone(), schema.into()))
            .collect();
        Ok(tonic::Response::new(tf::get_functions::Response {
            diagnostics: self.init_diags.clone().into(),
            functions,
        }))
    }
    async fn call_function(
        &self,
        request: tonic::Request<tf::call_function::Request>,
    ) -> std::result::Result<tonic::Response<tf::call_function::Response>, tonic::Status> {
        let request = request.into_inner();
        let mut diags = Diagnostics::default();

        let result = if let Some(function) = self.get_function(&mut diags, &request.name) {
            function
                .call(
                    &mut diags,
                    request.arguments.into_iter().map(Into::into).collect(),
                )
                .await
        } else {
            None
        }
        .collect_diagnostics(&mut diags);

        #[derive(Debug, Clone, Copy)]
        enum Index {
            None,
            Mixed,
            Unique(i64),
        }

        // Check if all diagnostics have the same index, if any
        let mut idx = Index::None;
        for diag in [&diags.errors, &diags.warnings].into_iter().flatten() {
            match (idx, diag.attribute.steps.as_slice()) {
                (Index::None, [AttributePathStep::Index(j)]) => {
                    idx = Index::Unique(*j);
                }
                (Index::Unique(i), [AttributePathStep::Index(j)]) if i == *j => (),
                _ => {
                    idx = Index::Mixed;
                }
            }
        }

        if diags.errors.is_empty() && !diags.warnings.is_empty() {
            diags.root_error_short("Function has emitted warnings");
        }

        // Format error message
        let (result, error) = if diags.errors.is_empty() {
            (result, None)
        } else {
            let mut message = String::new();
            let has_warnings = !diags.warnings.is_empty();
            for (diags, warning) in [(&diags.errors, false), (&diags.warnings, true)].into_iter() {
                let prefix = match (warning, has_warnings) {
                    (true, _) => "Warning: ",
                    (false, true) => "Error: ",
                    (false, false) => "",
                };

                for diag in diags {
                    if !message.is_empty() {
                        _ = writeln!(&mut message);
                    }
                    _ = write!(&mut message, "{prefix}");

                    if let (Index::None | Index::Mixed, [AttributePathStep::Index(j)]) =
                        (idx, diag.attribute.steps.as_slice())
                    {
                        _ = write!(&mut message, "Argument #{}: ", *j + 1);
                    };
                    _ = write!(&mut message, "{}", diag.summary);
                    if !diag.detail.is_empty() {
                        _ = write!(&mut message, "\n  {}", diag.detail);
                    }
                }
            }

            (
                None,
                Some(tf::FunctionError {
                    text: message,
                    function_argument: if let Index::Unique(i) = idx {
                        Some(i)
                    } else {
                        None
                    },
                }),
            )
        };

        Ok(tonic::Response::new(tf::call_function::Response {
            error,
            result: result.map(Into::into),
        }))
    }
    /// ////// Graceful Shutdown
    async fn stop_provider(
        &self,
        _request: tonic::Request<tf::stop_provider::Request>,
    ) -> Result<tonic::Response<tf::stop_provider::Response>, tonic::Status> {
        self.cancellation_token.cancel();

        Ok(tonic::Response::new(tf::stop_provider::Response {
            error: "".to_string(),
        }))
    }
}
