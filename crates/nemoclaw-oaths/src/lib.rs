// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Step definitions that bind the Markdown oaths in `oaths/` to the SDK.
//!
//! Each step file exposes `register`, and [`build_registry`] threads one
//! builder through them. A stimulus returns the whole next [`Ctx`]; a sensor
//! returns what the SDK produced for Varar to compare with the document.

use std::path::PathBuf;

use ::varar::{HandlerError, Registry, Steps};

// Rust does not derive the `.steps.` infix from a module name.
#[path = "steps/configuration.steps.rs"]
mod configuration;

/// The state one example threads through its steps.
#[derive(Clone, Default)]
pub struct Ctx {
    /// The configuration text the example reads.
    pub source: String,
}

pub fn build_registry() -> Registry {
    let mut s = Steps::<Ctx>::new();
    s.param("code", r"[^`]+", |g: &[&str]| g[0].to_owned(), None);
    // "no" reads better than "0" in a sentence.
    s.param(
        "count",
        r"no|\d+",
        |g: &[&str]| g[0].parse::<i64>().unwrap_or(0),
        Some(Box::new(|n: &i64| match n {
            0 => "no".to_owned(),
            n => n.to_string(),
        })),
    );
    configuration::register(&mut s);
    s.into_registry()
}

/// Every example starts from an empty document.
pub fn context_value(_file: &str) -> std::rc::Rc<dyn std::any::Any> {
    std::rc::Rc::new(Ctx::default())
}

/// Reads a file that an oath names relative to the repository root.
/// Oaths cannot link to the file: Varar ends a sentence at the dots in a
/// relative link target.
fn read(path: &str) -> Result<String, HandlerError> {
    let full = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(path);
    std::fs::read_to_string(full).map_err(|e| HandlerError::new(format!("cannot read {path}: {e}")))
}
