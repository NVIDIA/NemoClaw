// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

#[path = "../../../test-support/docker.rs"]
mod transport;
pub(crate) use transport::Fixture;

impl Fixture {
    pub fn engine_for(&self, logical_endpoint: &str) -> super::Engine {
        let mut engine = super::Engine::connect(&self.endpoint).unwrap();
        engine.endpoint = logical_endpoint.into();
        engine
    }
}
