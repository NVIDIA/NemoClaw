// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use serde_json::json;

fn spec() -> Spec {
    serde_json::from_value(json!({
        "layout":1,"kind":"kubernetes_gateway","name":"nc-0123456789abcdef-gateway",
        "owner":"11111111-1111-4111-8111-111111111111","generation":"0123456789abcdef0123456789abcdef",
        "settings":{
            "endpoint":"https://127.0.0.1:17671",
            "kubernetes":{
                "kubeconfig":{"env":"TEST_CLUSTER_CONFIG"},"context":"explicit-context","namespace":"test-owned",
                "prerequisites":{"agentSandbox":{"management":"managed"}},
                "authentication":{"profile":"development"}
            }
        }
    })).unwrap()
}

#[test]
fn raw_provider_cannot_route_an_engine_spec_to_kubernetes() {
    let mut spec = spec();
    assert!(spec.validate().is_ok());
    spec.settings.engine = "unix:///var/run/docker.sock".into();
    assert!(spec.validate().is_err());
    spec.settings.engine.clear();
    spec.kind = "managed_gateway".into();
    assert!(spec.validate().is_err());
}

#[cfg(unix)]
#[test]
fn backend_rejects_shared_and_symlinked_private_state() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    // macOS temporary paths may begin with the system /var symlink.
    let directory = root.path().canonicalize().unwrap();
    let shared = directory.join("shared");
    std::fs::create_dir(&shared).unwrap();
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        runner::private_directory(&shared),
        Err(ObservationError::Permission)
    );
    let alias = directory.join("alias");
    symlink(&shared, &alias).unwrap();
    assert_eq!(
        runner::private_directory(&alias),
        Err(ObservationError::BindingMismatch)
    );
    let private = directory.join("private");
    assert!(runner::private_directory(&private).is_ok());
}
