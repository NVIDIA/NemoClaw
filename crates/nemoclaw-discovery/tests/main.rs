// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Discovery integration tests, linked into one binary so the crate links once.

#[path = "../../test-support/http.rs"]
mod transport;

#[path = "facts.rs"]
mod facts;
#[path = "inference.rs"]
mod inference;
#[path = "observations.rs"]
mod observations;
#[path = "observe.rs"]
mod observe;
