// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;

impl OpenShell {
    pub(super) async fn update_resource(
        &self,
        kind: &str,
        want: &Row,
        live: &Row,
    ) -> Result<(), ObservationError> {
        if kind == "provider" {
            self.update_provider(want, live).await?;
        }
        Ok(())
    }
    async fn update_provider(&self, want: &Row, live: &Row) -> Result<(), ObservationError> {
        let name = value(want, "name");
        let workspace = value(want, "workspace");
        if value(live, "credential_source") != value(want, "credential_source")
            || value(live, "provider_type") != value(want, "provider_type")
        {
            return Err(ObservationError::BindingMismatch);
        }
        if ["endpoint", "credential_env"]
            .iter()
            .any(|key| value(live, key) != value(want, key))
        {
            // This direct read supplies the version used for the conditional write.
            let current = self
                .grpc()
                .get_provider(self.request(proto::GetProviderRequest {
                    name: name.into(),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                }))
                .await
                .map_err(|error| remote_error(&error))?
                .into_inner()
                .provider
                .ok_or(ObservationError::Incomplete)?;
            let meta = current.metadata.ok_or(ObservationError::Incomplete)?;
            verify_identity(want, &base(Some(meta.clone()), name, false)?)?;
            if meta.resource_version == 0 {
                return Err(ObservationError::Incomplete);
            }
            let mut provider = self.provider(want).await?;
            let mut metadata = provider
                .metadata
                .take()
                .ok_or(ObservationError::Incomplete)?;
            metadata.id = meta.id;
            metadata.resource_version = meta.resource_version;
            provider.metadata = Some(metadata);
            self.grpc()
                .update_provider(self.request(proto::UpdateProviderRequest {
                    provider: Some(provider),
                    workspace_scope: Some(proto::workspace_selector(workspace)),
                    ..Default::default()
                }))
                .await
                .map_err(|error| remote_error(&error))?;
        }
        Ok(())
    }
}
