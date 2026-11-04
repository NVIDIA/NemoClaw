// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::kubernetes::gateway::ADDRESS;

const RECORD: &str = "helm-install.json";

/// Why destroy removes a release that the state does not bind.
const LEFTOVER: &str = "left by an apply that did not finish installing it";

// When an install fails after Helm stored the release, the pinned Helm
// provider returns the error without the release's state, so OpenTofu binds
// nothing (#14155). Helm then refuses every later install of the name. The SDK
// records each install it starts, until destroy finishes, and claims an
// unbound release only through that record: apply refuses before mutating,
// and destroy removes the release through the Helm provider.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Install {
    version: u32,
    name: String,
    namespace: String,
    chart: String,
}

impl Install {
    /// The gateway release that `document` installs, if it manages a
    /// Kubernetes gateway.
    fn of(document: &Document, generations: &compile::Generations) -> Result<Option<Self>, Error> {
        crate::kubernetes::gateway_spec(document, generations)?
            .map(|spec| Self::from_spec(&spec))
            .transpose()
    }

    fn from_spec(spec: &crate::kubernetes::Spec) -> Result<Self, Error> {
        let target = spec.settings.kubernetes.as_ref().ok_or(Error::State(
            "managed Kubernetes gateway settings are missing",
        ))?;
        Ok(Self {
            version: 1,
            name: spec.name.clone(),
            namespace: target.namespace.clone(),
            chart: crate::kubernetes::gateway::CHART.into(),
        })
    }

    /// The plan's refresh of the authentication resource observed this
    /// release's record in the cluster.
    fn observed(&self, plan: &Plan) -> bool {
        plan.resource_changes.iter().any(|change| {
            let before = &change.change.before;
            change.address == KUBERNETES_AUTH
                && change.deposed.is_none()
                && before["release_present"] == "true"
                && before["name"] == self.name.as_str()
                && before["namespace"] == self.namespace.as_str()
        })
    }

    /// This deployment's install record names the release.
    fn claimed(&self, store: &Store) -> Result<bool, Error> {
        let bytes = match fs::read(store.directory.join(RECORD)) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(Error::State("cannot read the Helm install record")),
        };
        let recorded: Self = serde_json::from_slice(&bytes)
            .map_err(|_| Error::State("invalid Helm install record; retain it and state"))?;
        Ok(recorded == *self)
    }

    fn unclaimed(self) -> Error {
        Error::UnclaimedRelease {
            release: self.name,
            namespace: self.namespace,
        }
    }
}

/// The release that `document` installs, when the cluster records it and the
/// state does not bind it.
fn leftover(
    plan: &Plan,
    bindings: &BTreeMap<String, StateBinding>,
    document: &Document,
    generations: &compile::Generations,
) -> Result<Option<Install>, Error> {
    if bindings.contains_key(ADDRESS) {
        return Ok(None);
    }
    Ok(Install::of(document, generations)?.filter(|install| install.observed(plan)))
}

/// The plan installs the gateway release.
fn installs(plan: &Plan) -> bool {
    plan.resource_changes.iter().any(|change| {
        change.address == ADDRESS
            && change.deposed.is_none()
            && change
                .change
                .actions
                .iter()
                .any(|action| action == "create")
    })
}

/// Refuse a plan that installs the gateway release while the cluster records
/// it and the state does not bind it: Helm would refuse the name after the
/// apply had changed other resources.
pub(in crate::deployment) fn check_install(
    store: &Store,
    plan: &Plan,
    bindings: &BTreeMap<String, StateBinding>,
    document: &Document,
    generations: &compile::Generations,
) -> Result<(), Error> {
    if !installs(plan) {
        return Ok(());
    }
    let Some(install) = leftover(plan, bindings, document, generations)? else {
        return Ok(());
    };
    if !install.claimed(store)? {
        return Err(install.unclaimed());
    }
    Err(Error::LeftoverRelease {
        release: install.name,
        namespace: install.namespace,
    })
}

/// Record the install before an apply whose plan installs the release.
pub(in crate::deployment) fn record_install(
    store: &Store,
    plan: &Plan,
    document: &Document,
    generations: &compile::Generations,
) -> Result<(), Error> {
    if !installs(plan) {
        return Ok(());
    }
    save_install(store, document, generations)
}

pub(super) fn save_install(
    store: &Store,
    document: &Document,
    generations: &compile::Generations,
) -> Result<(), Error> {
    match Install::of(document, generations)? {
        Some(install) => Ok(save_json(&store.directory.join(RECORD), &install)?),
        None => Ok(()),
    }
}

/// Forget the deployment's installs once destroy has finished.
pub(super) fn clear_installs(store: &Store) -> Result<(), Error> {
    match fs::remove_file(store.directory.join(RECORD)) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(Error::State("cannot remove the Helm install record")),
    }
    #[cfg(unix)]
    fs::File::open(&store.directory)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| Error::State("cannot sync the Helm install record's removal"))?;
    Ok(())
}

impl Deployment {
    /// The teardown change for the release that `plan` observed and the state
    /// does not bind, when this deployment's install record claims it.
    pub(super) fn leftover_release(
        &self,
        store: &Store,
        plan: &Plan,
        record: &Record,
        bindings: &BTreeMap<String, StateBinding>,
    ) -> Result<Option<Change>, Error> {
        let Some(install) = leftover(plan, bindings, &record.document, &record.generations)? else {
            return Ok(None);
        };
        if !install.claimed(store)? {
            return Err(install.unclaimed());
        }
        Ok(Some(Change {
            resource: ADDRESS.into(),
            actions: vec!["delete".into()],
            reason: Some(LEFTOVER.into()),
        }))
    }

    /// Remove the claimed release through the Helm provider in a separate
    /// OpenTofu root, so the deployment's own state and graph stay as they are.
    pub(super) async fn remove_leftover_release(
        &self,
        bundle: &Bundle,
        store: &Store,
        record: &Record,
        cancel: &CancellationToken,
    ) -> Result<(), Error> {
        let spec = crate::kubernetes::gateway_spec(&record.document, &record.generations)?.ok_or(
            Error::State("a leftover Helm release requires a managed Kubernetes gateway"),
        )?;
        let install = Install::from_spec(&spec)?;
        let mut graph = json!({});
        crate::kubernetes::gateway::configure(&mut graph, &spec)?;
        // Import needs only the release's identity: its values reference
        // resources that this root does not declare.
        let release = graph["resource"]["helm_release"]["gateway"].take();
        graph["resource"]["helm_release"]["gateway"] = json!({
            "name": release["name"], "namespace": release["namespace"], "chart": release["chart"],
        });
        let temporary = tempfile::Builder::new()
            .prefix(".helm-install-")
            .tempdir_in(&store.directory)
            .map_err(|_| Error::State("cannot prepare the Helm release removal"))?;
        let root = Store::open(temporary.path())?;
        self.initialize(bundle, &root, &graph, cancel).await?;
        let environment = teardown::destroy_environment(&record.document);
        let id = format!("{}/{}", install.namespace, install.name);
        self.tofu(
            bundle,
            &root,
            &environment,
            &["import", "-input=false", "-no-color", ADDRESS, &id],
            cancel,
        )
        .await?;
        // Import has just read the release. A refresh would plan it against
        // its configuration, which loads the chart.
        self.tofu(
            bundle,
            &root,
            &environment,
            &[
                "apply",
                "-destroy",
                "-refresh=false",
                "-auto-approve",
                "-input=false",
                "-no-color",
            ],
            cancel,
        )
        .await?;
        Ok(())
    }
}
