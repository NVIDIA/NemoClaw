// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};

/// Controls image acquisition on the selected container engine. Does not control model downloads or OpenShell sandbox images.
#[derive(
    Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema,
)]
pub enum ImagePullPolicy {
    /// Contact the registry before creation or restart, even when the pinned image is cached. A failed pull fails apply.
    Always,
    /// Pull only when the pinned image is absent from the selected engine.
    #[default]
    IfNotPresent,
    /// Use only a local image. Fail if it is absent from the selected engine.
    Never,
}

impl ImagePullPolicy {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Always => "Always",
            Self::IfNotPresent => "IfNotPresent",
            Self::Never => "Never",
        }
    }

    pub(crate) fn from_row(row: &crate::backend::Row) -> Result<Option<Self>, crate::Error> {
        match row.get("image_pull_policy").map(String::as_str) {
            None | Some("") => Ok(None),
            Some("Always") => Ok(Some(Self::Always)),
            Some("IfNotPresent") => Ok(Some(Self::IfNotPresent)),
            Some("Never") => Ok(Some(Self::Never)),
            _ => Err(crate::Error::Conflict(
                "image pull policy must be Always, IfNotPresent, or Never",
            )),
        }
    }
}
