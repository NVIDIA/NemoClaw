// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A scripted OpenTofu for tests that drive `Deployment` over a bundle.
//!
//! `Scripted::new` writes a bundle whose manifest verifies and whose
//! `libexec/tofu` is a short shell script. The script logs each call, answers
//! `show -json` from canned files, and ends an apply as a control file says, so
//! a test can interrupt or fail one stage and then inspect what the SDK saved.
//! The SDK refuses a bundle file that changed after it verified the bundle, so
//! `Scripted::new` writes the script once; steer it with `Scripted::set`.

#![cfg(unix)]

use nemoclaw_sdk::{
    CancellationToken, Deployment, ObservationError, Progress, Secrets,
    compile::{Generations, Target},
    config::Document,
    kubernetes::{GATEWAY_KIND, STORAGE_KIND, gateway::ADDRESS as HELM_RELEASE},
};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

/// `@CONTROL@` and `@STATE@` become the control directory and the state
/// directory. Control files are named `root.NAME`: `apply` (`ok`, `fail` or `block`, which sleeps 30 s
/// unless the SDK interrupts it; it execs `sleep` so that the interrupt reaches
/// the blocked process, because a shell that waits for a child can lose it),
/// `planning` (`ok` or `fail`, for `plan`), `state` (the `show -json` state), and the name
/// of a saved plan (the `show -json PLAN` plan). A `show` without a control file
/// prints an empty state or plan. An `apply` that finds the saved record,
/// `intent.json`, creates the control file `root.record-at-apply`.
const SCRIPT: &str = r##"#!/bin/sh
control='@CONTROL@'
stage=root
printf '%s\n' "$stage $*" >> "$control/calls"
case "$1" in
  init) ;;
  plan)
    planning=ok
    [ -f "$control/$stage.planning" ] && planning=$(cat "$control/$stage.planning")
    if [ "$planning" = fail ]; then printf 'provider failed\n' >&2; exit 1; fi
    printf '{"type":"version","ui":"1.0"}\n' ;;
  show)
    canned="$control/$stage.${3:-state}"
    if [ -f "$canned" ]; then cat "$canned"; else printf '{"format_version":"1.0"}\n'; fi ;;
  apply)
    if [ -f '@STATE@/intent.json' ]; then : > "$control/$stage.record-at-apply"; fi
    printf '%s\n' '{"type":"version","ui":"1.0"}' '{"type":"apply_start","hook":{"resource":{"addr":"openshell_kubernetes_storage.runtime","resource_type":"openshell_kubernetes_storage"},"action":"create"}}'
    mode=ok
    [ -f "$control/$stage.apply" ] && mode=$(cat "$control/$stage.apply")
    case "$mode" in
      block) exec sleep 30 ;;
      fail) printf 'provider failed\n' >&2; exit 1 ;;
      *) printf '{"version":4,"resources":[]}\n' > terraform.tfstate ;;
    esac ;;
  *) printf 'unexpected command\n' >&2; exit 64 ;;
esac
"##;

/// A temporary bundle with a scripted `tofu`, a control directory, and the path
/// of a state directory that `Deployment` creates. A test creates one.
pub struct Scripted {
    _directory: tempfile::TempDir,
    root: PathBuf,
}

impl Scripted {
    pub fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        // The script compares its physical working directory with the state
        // directory, and a macOS temporary path traverses a symbolic link.
        let root = directory.path().canonicalize().unwrap();
        let scripted = Self {
            _directory: directory,
            root,
        };
        fs::create_dir(scripted.control()).unwrap();
        let quoted = |path: PathBuf| {
            let text = path.to_str().unwrap().to_owned();
            assert!(
                !text.contains('\''),
                "the path {text} holds a quote that the script cannot quote"
            );
            text
        };
        let script = SCRIPT
            .replace("@CONTROL@", &quoted(scripted.control()))
            .replace("@STATE@", &quoted(scripted.state()));
        crate::bundle::write_bundle(&scripted.bundle(), Some(&script));
        scripted
    }

    pub fn bundle(&self) -> PathBuf {
        self.root.join("bundle")
    }

    pub fn state(&self) -> PathBuf {
        self.root.join("state")
    }

    /// A path in the test's temporary directory, outside the bundle and state.
    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    fn control(&self) -> PathBuf {
        self.path("control")
    }

    /// Set a control file: `STAGE.apply`, `STAGE.state`, or `STAGE.PLAN`.
    pub fn set(&self, name: &str, text: impl AsRef<[u8]>) {
        fs::write(self.control().join(name), text).unwrap();
    }

    /// Every call the script received, as `STAGE ARGUMENT...`.
    pub fn calls(&self) -> Vec<String> {
        fs::read_to_string(self.control().join("calls"))
            .map(|text| text.lines().map(str::to_owned).collect())
            .unwrap_or_default()
    }

    /// Every call as `STAGE SUBCOMMAND`, such as `runtime apply`.
    pub fn commands(&self) -> Vec<String> {
        self.calls()
            .iter()
            .map(|call| {
                call.split_whitespace()
                    .take(2)
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .collect()
    }

    /// A deployment over this bundle and state directory whose
    /// `TEST_KUBECONFIG` and `TEST_IMAGE_METADATA` references resolve, with the
    /// kubeconfig at `kubeconfig`.
    pub fn deployment(&self, kubeconfig: &Path) -> Deployment {
        Deployment::new(&self.state(), &self.bundle())
            .with_secrets(Arc::new(Values(kubeconfig.to_owned())))
    }

    /// The saved record's text, to check that an operation left it unchanged.
    pub fn intent(&self) -> Option<String> {
        fs::read_to_string(self.state().join("intent.json")).ok()
    }

    /// The resource generations the first apply allocated. Compiled targets,
    /// and so the bindings and plans a test canned, carry them, and the SDK
    /// compares them with the saved record's. This is the only decoding of the
    /// record; every other check compares its text.
    pub fn generations(&self) -> Generations {
        let intent: Value = serde_json::from_str(
            &self
                .intent()
                .expect("the first apply saved no record to read generations from"),
        )
        .unwrap();
        serde_json::from_value(intent["generations"].clone()).unwrap()
    }
}

/// Resolves the references of `kubernetes_document`. Every value is at least
/// eight characters, so the SDK keeps child diagnostics and progress.
struct Values(PathBuf);

impl Secrets for Values {
    fn resolve(&self, name: &str) -> Result<String, ObservationError> {
        match name {
            "TEST_KUBECONFIG" => Ok(self.0.to_string_lossy().into_owned()),
            "TEST_IMAGE_METADATA" => Ok("/absent/image-metadata.json".into()),
            _ => Err(ObservationError::Authentication),
        }
    }
}

/// The local configuration on a managed Kubernetes gateway. The same `uid`
/// belongs to every name and namespace, so the deployment's identity is stable
/// while its digest changes. The name feeds no resource; the namespace feeds
/// every platform resource.
pub fn kubernetes_document(name: &str, namespace: &str) -> Document {
    let mut value = crate::support::fixture("local.yaml");
    value["metadata"]["name"] = json!(name);
    value["spec"]["gateway"] = json!({
        "management": "managed", "runtime": {"provider": "kubernetes"},
        "endpoint": "https://127.0.0.1:17671",
        "kubernetes": {
            "kubeconfig": {"env": "TEST_KUBECONFIG"}, "context": "test-cluster",
            "namespace": namespace, "authentication": {"profile": "development"}
        }
    });
    value["spec"]["sandboxes"][0]["image"]["metadata"] = json!({"env": "TEST_IMAGE_METADATA"});
    Document::parse(serde_json::to_vec(&value).unwrap().as_slice()).unwrap()
}

/// Generations for compiling a Kubernetes runtime's targets before a deployment
/// has allocated its own. A plan that creates resources checks only their
/// addresses, so it needs none of the allocated ones.
pub fn placeholder_generations() -> Generations {
    [
        GATEWAY_KIND,
        STORAGE_KIND,
        "workspace",
        "provider",
        "sandbox",
        "managed_gateway",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

/// A target's values and the identity its binding records: the Helm release is
/// bound by its name, every other resource by an opaque ID.
fn bound(target: &Target) -> Value {
    let mut values = serde_json::to_value(&target.values).unwrap();
    values["id"] = if target.address == HELM_RELEASE {
        values["name"].clone()
    } else {
        json!(format!("physical-{}", target.address))
    };
    values
}

fn change(address: &str, action: &str, before: Value, after: Value) -> Value {
    json!({"address": address, "mode": "managed",
        "change": {"actions": [action], "before": before, "after": after}})
}

/// `show -json PLAN` for one change of the same `action` per target, `create`
/// or `no-op`. A bound target's no-op change repeats its binding, as OpenTofu's
/// refreshed plan does.
pub fn plan_json(targets: &[Target], action: &str) -> String {
    let changes: Vec<Value> = targets
        .iter()
        .map(|target| {
            let (before, after) = match action {
                "create" => (Value::Null, serde_json::to_value(&target.values).unwrap()),
                _ => (bound(target), bound(target)),
            };
            change(&target.address, action, before, after)
        })
        .collect();
    json!({"format_version": "1.0", "resource_changes": changes}).to_string()
}

/// `show -json PLAN` for a destroy: the bound targets named in `retained` are
/// no-ops, and the others are deleted.
pub fn destroy_plan_json(targets: &[Target], retained: &[&str]) -> String {
    let changes: Vec<Value> = targets
        .iter()
        .map(|target| {
            if retained.contains(&target.address.as_str()) {
                change(&target.address, "no-op", bound(target), bound(target))
            } else {
                change(&target.address, "delete", bound(target), Value::Null)
            }
        })
        .collect();
    json!({"format_version": "1.0", "resource_changes": changes}).to_string()
}

/// `show -json` state with one managed binding per target.
pub fn state_json(targets: &[Target]) -> String {
    let resources: Vec<Value> = targets
        .iter()
        .map(
            |target| json!({"address": target.address, "mode": "managed", "values": bound(target)}),
        )
        .collect();
    json!({"format_version": "1.0", "values": {"root_module": {"resources": resources}}})
        .to_string()
}

type Hook = Arc<dyn Fn(Progress) + Send + Sync>;

/// Records progress and cancels at the event a test names.
#[derive(Clone, Default)]
pub struct Events(Arc<Mutex<Vec<Progress>>>);

impl Events {
    /// Records every event.
    pub fn recording(&self) -> Hook {
        let events = self.0.clone();
        Arc::new(move |event| events.lock().unwrap().push(event))
    }

    /// Records every event and cancels `token` at each one `when` accepts.
    pub fn cancelling(
        &self,
        token: &CancellationToken,
        when: impl Fn(&Progress) -> bool + Send + Sync + 'static,
    ) -> Hook {
        let (events, token) = (self.0.clone(), token.clone());
        Arc::new(move |event| {
            let stop = when(&event);
            events.lock().unwrap().push(event);
            if stop {
                token.cancel();
            }
        })
    }

    /// The SDK started `expected` OpenTofu applies.
    pub fn assert_mutations(&self, expected: usize, context: &str) {
        let events = self.0.lock().unwrap();
        let started = events
            .iter()
            .filter(|event| **event == Progress::MutationStarted)
            .count();
        assert_eq!(started, expected, "{context}: OpenTofu applies started");
    }

    /// Whether any recorded event satisfies `wanted`.
    pub fn contains(&self, wanted: impl Fn(&Progress) -> bool) -> bool {
        self.0.lock().unwrap().iter().any(wanted)
    }
}

/// A plan is about to start; the SDK has not yet spawned it.
pub fn planning(event: &Progress) -> bool {
    matches!(
        event,
        Progress::Waiting {
            operation: "tofu.plan",
            ..
        }
    )
}

/// The destroy record is saved and no stage has started.
pub fn destroying(event: &Progress) -> bool {
    matches!(event, Progress::Destroying)
}
