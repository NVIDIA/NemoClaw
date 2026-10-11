// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A Kubernetes client for the in-memory API server in `kube_api`.

use super::transport::Fixture;

/// A client for a fixture started by `Objects::serve`.
pub fn client(fixture: &Fixture) -> kube::Client {
    let _ = rustls::crypto::ring::default_provider().install_default();
    kube::Client::try_from(kube::Config::new(fixture.endpoint.parse().unwrap())).unwrap()
}
