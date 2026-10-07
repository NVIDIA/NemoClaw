// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::new_deployment_uid;

#[test]
fn sparse_authoring_generates_fresh_lowercase_deployment_identities() {
    let first = new_deployment_uid().unwrap();
    let second = new_deployment_uid().unwrap();
    assert_ne!(first, second);
    assert_eq!(first.len(), 36);
    assert!(first.bytes().enumerate().all(|(index, byte)| match index {
        8 | 13 | 18 | 23 => byte == b'-',
        _ => byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase(),
    }));
}
