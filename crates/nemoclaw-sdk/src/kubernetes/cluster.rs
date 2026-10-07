// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Objects a deployment creates, recognised by the UID recorded at creation.
//!
//! An object is ours only if its UID matches the recorded one and it carries
//! the deployment's owner label. Nothing that already exists is adopted, and
//! deletes send the recorded UID as a precondition, so a replacement made by
//! someone else is never removed.

use crate::ObservationError;
use kube::{
    Api, Client,
    api::{DeleteParams, DynamicObject, PostParams, Preconditions},
    core::{ApiResource, GroupVersionKind},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Label holding the deployment's `metadata.uid`.
pub const OWNER_LABEL: &str = "nemoclaw.nvidia.com/uid";
/// Label holding the generation that created the object.
pub const GENERATION_LABEL: &str = "nemoclaw.nvidia.com/generation";

/// A created object: its address and the UID it had at creation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Owned {
    pub api_version: String,
    pub kind: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub namespace: String,
    pub name: String,
    pub uid: String,
}

impl Owned {
    /// The owned record for `object` with `uid`.
    pub fn new(object: &Value, uid: &str) -> Self {
        let text = |pointer: &str| {
            object
                .pointer(pointer)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        };
        Self {
            api_version: text("/apiVersion"),
            kind: text("/kind"),
            namespace: text("/metadata/namespace"),
            name: text("/metadata/name"),
            uid: uid.into(),
        }
    }
}

/// Cluster access for one deployment's owner and generation.
pub struct Cluster {
    client: Client,
    owner: String,
    generation: String,
}

fn resource(api_version: &str, kind: &str) -> ApiResource {
    let (group, version) = api_version.rsplit_once('/').unwrap_or(("", api_version));
    ApiResource::from_gvk(&GroupVersionKind::gvk(group, version, kind))
}

fn failure(error: kube::Error) -> ObservationError {
    match error {
        kube::Error::Api(status) => match status.code {
            401 => ObservationError::Authentication,
            403 => ObservationError::Permission,
            409 => ObservationError::BindingMismatch,
            _ => ObservationError::Query,
        },
        _ => ObservationError::Transport,
    }
}

impl Cluster {
    pub fn new(client: Client, owner: &str, generation: &str) -> Self {
        Self {
            client,
            owner: owner.into(),
            generation: generation.into(),
        }
    }

    pub fn client(&self) -> &Client {
        &self.client
    }

    fn api(&self, api_version: &str, kind: &str, namespace: &str) -> Api<DynamicObject> {
        let resource = resource(api_version, kind);
        if namespace.is_empty() {
            Api::all_with(self.client.clone(), &resource)
        } else {
            Api::namespaced_with(self.client.clone(), namespace, &resource)
        }
    }

    /// The object at `owned`'s address, if any, whatever its UID.
    pub async fn get(&self, owned: &Owned) -> Result<Option<DynamicObject>, ObservationError> {
        self.api(&owned.api_version, &owned.kind, &owned.namespace)
            .get_opt(&owned.name)
            .await
            .map_err(failure)
    }

    /// Create `object` with the owner and generation labels. Fails with
    /// `BindingMismatch` if an object already exists at that address.
    pub async fn create(&self, object: Value) -> Result<Owned, ObservationError> {
        self.create_with(object, false, false).await
    }

    /// Create a credential-free model object with bounded admission diagnostics.
    pub async fn create_model(&self, object: Value) -> Result<Owned, ObservationError> {
        self.create_with(object, false, true).await
    }

    /// Ask admission to validate an object without persisting it.
    pub async fn dry_run(&self, object: Value) -> Result<(), ObservationError> {
        self.create_with(object, true, true).await.map(|_| ())
    }

    async fn create_with(
        &self,
        mut object: Value,
        dry_run: bool,
        admission_detail: bool,
    ) -> Result<Owned, ObservationError> {
        let labels = object
            .pointer_mut("/metadata")
            .and_then(Value::as_object_mut)
            .ok_or(ObservationError::Query)?
            .entry("labels")
            .or_insert_with(|| Value::Object(Default::default()));
        let labels = labels.as_object_mut().ok_or(ObservationError::Query)?;
        labels.insert(OWNER_LABEL.into(), self.owner.clone().into());
        labels.insert(GENERATION_LABEL.into(), self.generation.clone().into());
        let address = Owned::new(&object, "");
        let object: DynamicObject =
            serde_json::from_value(object).map_err(|_| ObservationError::Query)?;
        let created = self
            .api(&address.api_version, &address.kind, &address.namespace)
            .create(
                &PostParams {
                    dry_run,
                    ..PostParams::default()
                },
                &object,
            )
            .await
            .map_err(|error| match error {
                kube::Error::Api(status)
                    if admission_detail && matches!(status.code, 400 | 403 | 422 | 429) =>
                {
                    ObservationError::Admission {
                        kind: address.kind.clone(),
                        name: address.name.clone(),
                        detail: ObservationError::sanitized_detail(&status.message),
                    }
                }
                other => failure(other),
            })?;
        let uid = created.metadata.uid.ok_or(ObservationError::Incomplete)?;
        Ok(Owned { uid, ..address })
    }

    /// The object, if it is still the one recorded in `owned`.
    pub async fn verify(&self, owned: &Owned) -> Result<DynamicObject, ObservationError> {
        let object = self
            .get(owned)
            .await?
            .ok_or(ObservationError::BindingMismatch)?;
        let ours = object.metadata.uid.as_deref() == Some(owned.uid.as_str())
            && object
                .metadata
                .labels
                .as_ref()
                .and_then(|labels| labels.get(OWNER_LABEL))
                == Some(&self.owner);
        if !ours {
            return Err(ObservationError::BindingMismatch);
        }
        Ok(object)
    }

    /// Delete the recorded object. Succeeds if it is already gone; fails with
    /// `BindingMismatch` if another object has taken its address.
    pub async fn delete(&self, owned: &Owned) -> Result<(), ObservationError> {
        let parameters = DeleteParams {
            preconditions: Some(Preconditions {
                uid: Some(owned.uid.clone()),
                resource_version: None,
            }),
            ..DeleteParams::default()
        };
        match self
            .api(&owned.api_version, &owned.kind, &owned.namespace)
            .delete(&owned.name, &parameters)
            .await
        {
            Ok(_) => Ok(()),
            Err(kube::Error::Api(status)) if status.code == 404 => Ok(()),
            Err(error) => Err(failure(error)),
        }
    }
}
