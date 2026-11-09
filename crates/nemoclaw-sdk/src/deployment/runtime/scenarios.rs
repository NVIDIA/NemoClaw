// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Setup for nemoclaw-e2e's recovery scenarios.
//!
//! Some recovery paths start from states that the public API reaches only
//! through faults a test cannot trigger offline, such as a Helm release the
//! provider would have to pull a chart to install. These methods build those
//! states; the tests then exercise the public `plan_destroy`, `destroy`, and
//! `apply`.
//!
//! They exist only for those tests. The `test-scenarios` feature that compiles
//! them is off by default, no other crate feature enables it, and only
//! nemoclaw-e2e's dev-dependency turns it on.

use super::teardown::destroy_environment;
use crate::deployment::*;

#[doc(hidden)]
impl Deployment {
    /// Save `document` as the deployment's record without applying anything.
    pub fn scenario_save_record(&self, document: &Document) -> Result<(), Error> {
        let (_, store) = self.open()?;
        let record = self.scenario_record(&store, document)?;
        store.save(&record)
    }

    /// Run OpenTofu `commands` in the deployment's state, initialized for the
    /// saved configuration, with destroy's environment.
    pub async fn scenario_runtime_tofu(
        &self,
        commands: &[&[&str]],
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let (bundle, store) = self.open()?;
        let record = store
            .load()?
            .ok_or(Error::Conflict("a scenario needs a saved configuration"))?;
        // The runtime's graph alone: commands such as import evaluate every data
        // source in the configuration, and setup needs only the runtime.
        let graph = compile::compile_runtime(
            &record.document,
            &record.generations,
            &bundle.manifest.version,
        )?;
        self.initialize(&bundle, &store, &graph, cancel).await?;
        let environment = destroy_environment(&record.document);
        for command in commands {
            self.tofu(&bundle, &store, &environment, command, cancel)
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
