// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::*;
use crate::kubernetes::gateway::ADDRESS;

// The gateway release is atomic: when its install fails or times out, Helm
// removes it before the Helm provider returns. A hard stop, such as a second
// interrupt or a killed process, ends the provider first and leaves the release
// `pending-install`; the provider saved no state for it, so OpenTofu binds
// nothing, and Helm refuses every later install of the name (#14155). NemoClaw
// can't tell that release from another owner's, so plan, apply, and destroy
// name it before they change anything, and leave it.

/// Refuse when the plan's refresh of the authentication resource observed the
/// record of the gateway release that `document` installs, and the state does
/// not bind the release.
pub(super) fn check_unbound(
    plan: &Plan,
    bindings: &BTreeMap<String, StateBinding>,
    document: &Document,
    generations: &compile::Generations,
) -> Result<(), Error> {
    if bindings.contains_key(ADDRESS) {
        return Ok(());
    }
    let Some(spec) = crate::kubernetes::gateway_spec(document, generations)? else {
        return Ok(());
    };
    let target = spec.settings.kubernetes.as_ref().ok_or(Error::State(
        "managed Kubernetes gateway settings are missing",
    ))?;
    let observed = plan.resource_changes.iter().any(|change| {
        let before = &change.change.before;
        change.address == KUBERNETES_AUTH
            && change.deposed.is_none()
            && before["release_present"] == "true"
            && before["name"] == spec.name.as_str()
            && before["namespace"] == target.namespace.as_str()
    });
    if observed {
        return Err(Error::UnboundRelease {
            release: spec.name.clone(),
            namespace: target.namespace.clone(),
        });
    }
    Ok(())
}

/// Refuse a plan that installs the gateway release while the cluster records
/// it and the state does not bind it: Helm would refuse the name after the
/// apply had changed other resources.
pub(in crate::deployment) fn check_install(
    plan: &Plan,
    bindings: &BTreeMap<String, StateBinding>,
    document: &Document,
    generations: &compile::Generations,
) -> Result<(), Error> {
    let installs = plan.resource_changes.iter().any(|change| {
        change.address == ADDRESS
            && change.deposed.is_none()
            && change
                .change
                .actions
                .iter()
                .any(|action| action == "create")
    });
    if !installs {
        return Ok(());
    }
    check_unbound(plan, bindings, document, generations)
}
