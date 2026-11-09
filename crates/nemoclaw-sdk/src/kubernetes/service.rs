// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The Service that publishes a managed Kubernetes gateway's endpoint; the
//! bundled Kubernetes provider owns it.

use crate::config::{Document, ExposureServiceType};
use std::collections::BTreeMap;

/// The OpenTofu resource type of the exposure Service.
pub const RESOURCE_TYPE: &str = "kubernetes_service_v1";
/// The exposure Service's address in the runtime graph.
pub const ADDRESS: &str = "kubernetes_service_v1.gateway_exposure";

/// What selects the address a managed Kubernetes gateway's endpoint names:
/// its exposure Service's type and annotations. Like the endpoint, it stays
/// as first planned; source ranges only admit clients and may change.
pub fn binding(document: &Document) -> Option<(ExposureServiceType, &BTreeMap<String, String>)> {
    let service = &document
        .spec
        .gateway
        .as_managed()?
        .kubernetes
        .as_ref()?
        .expose
        .as_ref()?
        .service;
    Some((service.service_type, &service.annotations))
}
