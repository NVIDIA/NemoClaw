// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Step definitions that bind the Markdown oaths in `oaths/` to the SDK.
//!
//! Each step file exposes `register`, and [`build_registry`] threads one
//! builder through them. A stimulus returns the whole next [`Ctx`]; a sensor
//! returns what the SDK produced for Varar to compare with the document.

use std::path::PathBuf;

use ::varar::{Registry, Steps};

// Rust does not derive the `.steps.` infix from a module name.
#[path = "steps/config_diagnostics.steps.rs"]
mod config_diagnostics;

/// The state one example threads through its steps.
#[derive(Clone, Default)]
pub struct Ctx {
    /// The configuration text the example reads.
    pub source: String,
}

pub fn build_registry() -> Registry {
    let mut s = Steps::<Ctx>::new();
    s.param("code", r"[^`]+", |g: &[&str]| g[0].to_owned(), None);
    config_diagnostics::register(&mut s);
    s.into_registry()
}

/// Every example starts from an empty document.
pub fn context_value(_file: &str) -> std::rc::Rc<dyn std::any::Any> {
    std::rc::Rc::new(Ctx::default())
}

/// Resolves a path that an oath writes relative to the repository root.
/// Oaths cannot link to the file: Varar ends a sentence at the dots in a
/// relative link target.
fn repository_path(path: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path)
}
