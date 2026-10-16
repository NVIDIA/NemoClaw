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
    /// Plan only the runtime of `document` (its managed gateway, model servers,
    /// and their storage and readiness reads), or apply it when `apply` is set,
    /// using the saved record if there is one. Returns whether the plan had
    /// changes.
    pub async fn scenario_runtime_stage(
        &self,
        document: &Document,
        apply: bool,
        cancel: &CancellationToken,
    ) -> Result<bool, Error> {
        let (bundle, store) = self.open()?;
        let mut record = self.scenario_record(&store, document)?;
        record.allocate_missing_generations(document)?;
        store.save(&record)?;
        let compiled =
            compile::deployment_graph(document, &record.generations, &bundle.manifest.version)?;
        self.initialize(&bundle, &store, &compiled.graph, cancel)
            .await?;
        let mut arguments: Vec<String> = ["plan", "-input=false", "-no-color", "-out=apply.plan"]
            .map(String::from)
            .to_vec();
        let runtime: BTreeSet<String> = compiled
            .runtime
            .iter()
            .map(|target| target.address.clone())
            .collect();
        for section in ["resource", "data"] {
            for (kind, instances) in compiled.graph[section].as_object().into_iter().flatten() {
                for name in instances
                    .as_object()
                    .into_iter()
                    .flatten()
                    .map(|(name, _)| name)
                {
                    let address = format!("{kind}.{name}");
                    let gateway_read = section == "data"
                        && (kind == "openshell_gateway" && name == "current"
                            || kind == "openshell_docker_gateway_readiness");
                    if runtime.contains(&address) || gateway_read {
                        let prefix = if section == "data" { "data." } else { "" };
                        arguments.push(format!("-target={prefix}{address}"));
                    }
                }
            }
        }
        let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
        self.tofu(&bundle, &store, document, &arguments, cancel)
            .await?;
        let shown = self
            .tofu(
                &bundle,
                &store,
                document,
                &["show", "-json", "apply.plan"],
                cancel,
            )
            .await?;
        let plan: Value =
            serde_json::from_slice(&shown).map_err(|_| Error::State("invalid scenario plan"))?;
        let changed = plan["resource_changes"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|change| {
                change["change"]["actions"] != json!(["no-op"]) && change["mode"] == "managed"
            });
        if apply {
            // As an apply does, record the document and clear a finished
            // destroy before changing anything.
            record.begin_apply(document, BTreeMap::new());
            store.save(&record)?;
            self.tofu(
                &bundle,
                &store,
                document,
                &["apply", "-input=false", "-no-color", "apply.plan"],
                cancel,
            )
            .await?;
        }
        Ok(changed)
    }

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
