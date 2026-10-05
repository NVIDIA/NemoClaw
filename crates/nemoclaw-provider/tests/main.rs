// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Provider integration tests, linked into one binary.
//! Each file is a module; shared helpers are declared once here.

mod support;

#[path = "hardware_schema.rs"]
mod hardware_schema;
#[path = "managed_gateway_live.rs"]
mod managed_gateway_live;
#[path = "planning.rs"]
mod planning;
#[path = "refresh.rs"]
mod refresh;
#[path = "schema.rs"]
mod schema;
#[path = "validation.rs"]
mod validation;
