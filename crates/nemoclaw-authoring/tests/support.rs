// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Helpers shared by the authoring tests.
use nemoclaw_sdk::config::{ComputeDriver, Document, Gateway};

/// The engine, compute driver, and image a document's target is read through.
pub struct Target {
    pub engine: String,
    pub compute_driver: ComputeDriver,
    pub image: String,
}

/// Read a one-sandbox document's target directly, independently of the code under test.
pub fn target(document: &Document) -> Target {
    let sandbox = &document.spec.sandboxes[0];
    Target {
        engine: match &document.spec.gateway {
            Gateway::Managed(gateway) => gateway.engine.clone(),
            Gateway::External(gateway) => gateway.engine.clone(),
        },
        compute_driver: sandbox.runtime.provider,
        image: sandbox.image.ref_.clone(),
    }
}
