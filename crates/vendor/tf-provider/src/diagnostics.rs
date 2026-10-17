// This file is part of the tf-provider project
//
// Copyright (C) ANEO, 2024-2024. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License")
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

//! [`Diagnostics`] module

use std::{
    backtrace::{Backtrace, BacktraceStatus},
    borrow::Cow,
};

use crate::{attribute_path::AttributePath, tfplugin6, utils::CollectDiagnostics};

/// List of Errors and Warnings to send back to Terraform
#[derive(Clone, PartialEq, Eq, Hash, Debug, Default)]
pub struct Diagnostics {
    /// List of errors
    pub errors: Vec<Diagnostic>,
    /// List of warnings
    pub warnings: Vec<Diagnostic>,
}

impl Diagnostics {
    /// Add an error diagnostic
    ///
    /// # Arguments
    ///
    /// * `diag` - diagnostic
    pub fn add_error(&mut self, diag: Diagnostic) {
        self.errors.push(diag)
    }

    /// Add a warning diagnostic
    ///
    /// # Arguments
    ///
    /// * `diag` - diagnostic
    pub fn add_warning(&mut self, diag: Diagnostic) {
        self.warnings.push(diag)
    }

    /// Add an error
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `detail` - Detail of the diagnostic component
    /// * `attribute` - Attribute path for the diagnostic component
    pub fn error<S: Into<Cow<'static, str>>, D: Into<Cow<'static, str>>>(
        &mut self,
        summary: S,
        detail: D,
        attribute: AttributePath,
    ) {
        self.add_error(Diagnostic::new(summary, detail, attribute))
    }

    /// Add an error without [`AttributePath`]
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `detail` - Detail of the diagnostic component
    pub fn root_error<S: Into<Cow<'static, str>>, D: Into<Cow<'static, str>>>(
        &mut self,
        summary: S,
        detail: D,
    ) {
        self.add_error(Diagnostic::root(summary, detail))
    }

    /// Add an error without details
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `attribute` - Attribute path for the diagnostic component
    pub fn error_short<S: Into<Cow<'static, str>>>(
        &mut self,
        summary: S,
        attribute: AttributePath,
    ) {
        self.add_error(Diagnostic::short(summary, attribute))
    }

    /// Add an error without [`AttributePath`] nor details
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    pub fn root_error_short<S: Into<Cow<'static, str>>>(&mut self, summary: S) {
        self.add_error(Diagnostic::root_short(summary))
    }

    /// Add a warning
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `detail` - Detail of the diagnostic component
    /// * `attribute` - Attribute path for the diagnostic component
    pub fn warning<S: Into<Cow<'static, str>>, D: Into<Cow<'static, str>>>(
        &mut self,
        summary: S,
        detail: D,
        attribute: AttributePath,
    ) {
        self.add_warning(Diagnostic::new(summary, detail, attribute))
    }

    /// Add a warning without [`AttributePath`]
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `detail` - Detail of the diagnostic component
    pub fn root_warning<S: Into<Cow<'static, str>>, D: Into<Cow<'static, str>>>(
        &mut self,
        summary: S,
        detail: D,
    ) {
        self.add_warning(Diagnostic::root(summary, detail))
    }

    /// Add a warning without details
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `attribute` - Attribute path for the diagnostic component
    pub fn warning_short<S: Into<Cow<'static, str>>>(
        &mut self,
        summary: S,
        attribute: AttributePath,
    ) {
        self.add_warning(Diagnostic::short(summary, attribute))
    }

    /// Add a warning without [`AttributePath`] nor details
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    pub fn root_warning_short<S: Into<Cow<'static, str>>>(&mut self, summary: S) {
        self.add_warning(Diagnostic::root_short(summary))
    }

    /// Append other diagnostics
    pub fn add_diagnostics(&mut self, mut diags: Diagnostics) {
        self.errors.append(&mut diags.errors);
        self.warnings.append(&mut diags.warnings);
    }

    /// Add an internal error if there is no existing errors
    pub fn internal_error(&mut self) {
        Option::<()>::None.collect_diagnostics(self);
    }

    /// Create an error for a function argument
    ///
    /// # Arguments
    ///
    /// * `index` - index of the argument triggering the diagnostics
    /// * `message` - Short message of the diagnostics
    pub fn function_error<S: Into<Cow<'static, str>>>(&mut self, index: i64, message: S) {
        self.add_error(Diagnostic::function(index, message))
    }
}

/// Diagnostic component
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Diagnostic {
    /// Summary of the diagnostic component
    pub summary: Cow<'static, str>,
    /// Detail of the diagnostic component
    pub detail: Cow<'static, str>,
    /// Attribute path for the diagnostic component
    pub attribute: AttributePath,
}

/// Diagnostic
impl Diagnostic {
    /// Create a diagnostic
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `detail` - Detail of the diagnostic component
    /// * `attribute` - Attribute path for the diagnostic component
    pub fn new<S: Into<Cow<'static, str>>, D: Into<Cow<'static, str>>>(
        summary: S,
        detail: D,
        attribute: AttributePath,
    ) -> Self {
        let backtrace = Backtrace::capture();
        let mut detail = detail.into();
        if backtrace.status() == BacktraceStatus::Captured {
            if detail.is_empty() {
                detail = format!("{}", backtrace).into();
            } else {
                detail = format!("{}\n{}", detail, backtrace).into();
            }
        }
        Self {
            summary: summary.into(),
            detail,
            attribute,
        }
    }

    /// Create a diagnostic for a function argument
    ///
    /// # Arguments
    ///
    /// * `index` - index of the argument triggering the diagnostics
    /// * `message` - Short message of the diagnostics
    pub fn function<S: Into<Cow<'static, str>>>(index: i64, message: S) -> Self {
        Self::new(
            message,
            String::default(),
            AttributePath::function_argument(index),
        )
    }

    /// Create a diagnostic without [`AttributePath`]
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `detail` - Detail of the diagnostic component
    pub fn root<S: Into<Cow<'static, str>>, D: Into<Cow<'static, str>>>(
        summary: S,
        detail: D,
    ) -> Self {
        Self::new(summary, detail, Default::default())
    }

    /// Create a diagnostic without details
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    /// * `attribute` - Attribute path for the diagnostic component
    pub fn short<S: Into<Cow<'static, str>>>(summary: S, attribute: AttributePath) -> Self {
        Self::new(summary, String::default(), attribute)
    }
    /// Create a diagnostic [`AttributePath`] nor details
    ///
    /// # Arguments
    ///
    /// * `summary` - Summary of the diagnostic component
    pub fn root_short<S: Into<Cow<'static, str>>>(summary: S) -> Self {
        Self::new(summary, String::default(), Default::default())
    }
}

impl From<Diagnostics> for ::prost::alloc::vec::Vec<tfplugin6::Diagnostic> {
    fn from(value: Diagnostics) -> Self {
        use tfplugin6::diagnostic::Severity;
        let map_cvt = |vec: Vec<Diagnostic>, severity: Severity| {
            vec.into_iter().map(move |diag| tfplugin6::Diagnostic {
                severity: severity.into(),
                summary: diag.summary.into_owned(),
                detail: diag.detail.into_owned(),
                attribute: if diag.attribute.steps.is_empty() {
                    None
                } else {
                    Some(diag.attribute.into())
                },
            })
        };
        map_cvt(value.errors, Severity::Error)
            .chain(map_cvt(value.warnings, Severity::Warning))
            .collect()
    }
}
