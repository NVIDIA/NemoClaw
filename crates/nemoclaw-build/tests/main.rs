// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Build tool integration tests, linked into one binary.
//! Each file is a module; shared helpers are declared once here.

#[path = "artifacts.rs"]
mod artifacts;
#[path = "bake.rs"]
mod bake;
#[path = "catalog_sources.rs"]
mod catalog_sources;
#[path = "ci.rs"]
mod ci;
#[path = "docs.rs"]
mod docs;
#[path = "images.rs"]
mod images;
#[path = "runtime_engine.rs"]
mod runtime_engine;
#[path = "schema.rs"]
mod schema;
