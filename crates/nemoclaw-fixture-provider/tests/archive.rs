// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Building this test also builds the fixture provider that the provider
//! protocol tests find beside their test executables.

/// The lifecycle profile selects this ignored test, so nextest archives the
/// fixture provider beside the extracted lifecycle tests.
#[test]
#[ignore = "run by the lifecycle profile to archive the fixture provider with its tests"]
fn the_fixture_provider_is_found_beside_the_test_executables() {
    let provider = nemoclaw_test_fixtures::fixture_executable("nemoclaw-fixture-provider");
    assert!(provider.is_file());
}
