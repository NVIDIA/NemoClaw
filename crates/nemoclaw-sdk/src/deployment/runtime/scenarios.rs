// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Setup for nemoclaw-e2e's recovery scenarios.
//!
//! Some recovery paths start from states that the public API reaches only
//! through faults a test cannot trigger offline: a runtime apply that stopped
//! after OpenTofu saved its identities, or a Helm release the provider would
//! have to pull a chart to install. These methods build those states; the
//! tests then exercise the public `plan_destroy`, `destroy`, and `apply`.
//!
//! They exist only for those tests. The `test-scenarios` feature that compiles
//! them is off by default, no other crate feature enables it, and only
//! nemoclaw-e2e's dev-dependency turns it on.

use super::teardown::destroy_environment;
use crate::deployment::*;

#[doc(hidden)]
impl Deployment {
    /// Plan only the runtime stage of `document`, or apply it when `apply` is
    /// set, using the saved record if there is one. Returns whether the stage
    /// had changes.
    pub async fn scenario_runtime_stage(
        &self,
        document: &Document,
        apply: bool,
        cancel: &CancellationToken,
    ) -> Result<bool, Error> {
        let (bundle, store) = self.open()?;
        let mut record = self.scenario_record(&store, document)?;
        let (changes, deferred, _, _) = self
            .runtime_stage(&bundle, &store, document, &mut record, apply, cancel)
            .await?;
        Ok(!changes.is_empty() || deferred)
    }

    /// Save `document` as an apply whose runtime stage started and did not
    /// finish, as if the host stopped after OpenTofu saved its identities.
    pub fn scenario_interrupt_runtime_apply(&self, document: &Document) -> Result<(), Error> {
        let (_, store) = self.open()?;
        let mut record = self.scenario_record(&store, document)?;
        record.begin_runtime_apply(document);
        store.save(&record)
    }

    /// Run OpenTofu `commands` in the runtime stage of the saved configuration,
    /// initialized for its runtime graph, with destroy's environment.
    pub async fn scenario_runtime_tofu(
        &self,
        commands: &[&[&str]],
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let (bundle, store) = self.open()?;
        let record = store
            .load()?
            .ok_or(Error::Conflict("a scenario needs a saved configuration"))?;
        let stage = Store::open(&store.directory.join("runtime"))?;
        let graph = compile::compile_runtime(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
        )?;
        self.initialize(&bundle, &stage, &graph, cancel).await?;
        let environment = destroy_environment(&record.document);
        for command in commands {
            self.tofu(&bundle, &stage, &environment, command, cancel)
                .await?;
        }
        Ok(())
    }

    fn scenario_record(&self, store: &Store, document: &Document) -> Result<Record, Error> {
        match store.load()? {
            Some(record) => Ok(record),
            None => Record::new(document.clone()),
        }
    }
}
