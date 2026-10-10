// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Managed Kubernetes resources applied, refreshed, and torn down through
//! pinned OpenTofu against an in-memory Kubernetes API.
//!
//! In a bundle, Helm installs the gateway chart between the authentication
//! and gateway resources and removes it before the issuer. Here the test
//! writes and deletes the objects Helm would leave: the gateway StatefulSet
//! and the release record. The live Kind suite runs the chart itself.

use crate::{kube_api::Objects, tofu::TofuWorkspace, transport::Fixture};
use serde_json::{Value, json};
use std::{collections::BTreeMap, fs, path::PathBuf};

const NAME: &str = "nc-0123456789abcdef-gateway";
const NAMESPACE: &str = "agents";
const STORAGE: &str = "nemoclaw_kubernetes_storage.platform";
const AUTH: &str = "nemoclaw_kubernetes_auth.platform";
const GATEWAY: &str = "nemoclaw_kubernetes_gateway.platform";
const CHANGED: &str = "observed ownership, generation, or durable identity changed";

/// The issuer objects the authentication resource creates, as
/// (apiVersion, kind, name).
const ISSUER: [(&str, &str, &str); 6] = [
    ("v1", "ConfigMap", "nc-0123456789abcdef-gateway-oidc-ca"),
    ("v1", "Secret", "nc-0123456789abcdef-gateway-oidc"),
    ("v1", "ConfigMap", "nc-0123456789abcdef-gateway-oidc"),
    ("v1", "Service", "nc-0123456789abcdef-gateway-oidc"),
    (
        "networking.k8s.io/v1",
        "NetworkPolicy",
        "nc-0123456789abcdef-gateway-oidc",
    ),
    ("apps/v1", "Deployment", "nc-0123456789abcdef-gateway-oidc"),
];

/// Which resources the configuration declares.
#[derive(Clone, Copy, PartialEq)]
enum Stage {
    /// Storage and authentication, before Helm installs the chart.
    Prepared,
    /// Every resource, after Helm installs the chart.
    Installed,
    /// The teardown graph: destroy permitted, only storage retained.
    Teardown,
}

/// A cluster ready to host a gateway: kube-system, one default StorageClass,
/// and an available Agent Sandbox controller.
fn cluster() -> Objects {
    let objects = Objects::default();
    objects.insert(json!({"apiVersion": "v1", "kind": "Namespace",
        "metadata": {"name": "kube-system", "uid": "system-1"}}));
    objects.insert(json!({"apiVersion": "storage.k8s.io/v1", "kind": "StorageClass",
        "metadata": {"name": "standard", "annotations": {"storageclass.kubernetes.io/is-default-class": "true"}}}));
    objects.insert(
        json!({"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
        "metadata": {"name": "sandboxes.agents.x-k8s.io"}}),
    );
    objects.insert(json!({"apiVersion": "apps/v1", "kind": "Deployment",
        "metadata": {"name": "agent-sandbox-controller", "namespace": "agent-sandbox-system"},
        "status": {"availableReplicas": 1}}));
    objects
}

/// What Helm's chart install leaves for the gateway resource to observe.
fn install_release(objects: &Objects, ready_replicas: u64) {
    objects.insert(json!({"apiVersion": "apps/v1", "kind": "StatefulSet",
        "metadata": {"name": NAME, "namespace": NAMESPACE, "generation": 1,
            "labels": {"app.kubernetes.io/instance": NAME},
            "annotations": {"meta.helm.sh/release-name": NAME, "meta.helm.sh/release-namespace": NAMESPACE}},
        "status": {"observedGeneration": 1, "readyReplicas": ready_replicas}}));
    objects.insert(
        json!({"apiVersion": "v1", "kind": "Secret", "type": "helm.sh/release.v1",
        "metadata": {"name": format!("sh.helm.release.v1.{NAME}.v1"), "namespace": NAMESPACE,
            "labels": {"owner": "helm", "name": NAME, "status": "deployed", "version": "1"}}}),
    );
}

/// The gateway pod becomes ready; the StatefulSet keeps its identity.
fn ready_release(objects: &Objects) {
    let mut statefulset = objects
        .get("apps/v1", "StatefulSet", NAMESPACE, NAME)
        .unwrap();
    statefulset["status"]["readyReplicas"] = json!(1);
    objects.insert(statefulset);
}

fn uninstall_release(objects: &Objects) {
    objects
        .0
        .lock()
        .unwrap()
        .retain(|path, _| !path.contains("/statefulsets/") && !path.contains("sh.helm.release"));
}

struct Platform {
    objects: Objects,
    _api: Fixture,
    workspace: TofuWorkspace,
}

impl Platform {
    async fn start() -> Self {
        let path =
            |name| PathBuf::from(std::env::var_os(name).expect("explicit qualification path"));
        let (tofu, provider) = (path("NEMOCLAW_TEST_TOFU"), path("NEMOCLAW_TEST_PROVIDER"));
        assert!(tofu.is_absolute() && provider.is_absolute());
        let objects = cluster();
        let api = objects.serve().await;
        let workspace = TofuWorkspace::new(tofu, provider);
        let kubeconfig = json!({
            "apiVersion": "v1", "kind": "Config",
            "clusters": [{"name": "fixture", "cluster": {"server": api.endpoint}}],
            "contexts": [{"name": "selected", "context": {"cluster": "fixture", "user": "fixture"}}],
            "users": [{"name": "fixture", "user": {}}],
        });
        fs::write(
            workspace.path().join("cluster.kubeconfig"),
            kubeconfig.to_string(),
        )
        .unwrap();
        Self {
            objects,
            _api: api,
            workspace,
        }
    }

    fn configure(&self, stage: Stage) {
        let target = format!(
            r#"  name                   = "{NAME}"
  compute_driver         = "kubernetes"
  endpoint               = "https://127.0.0.1:17671"
  kubeconfig_env         = "TEST_CLUSTER_KUBECONFIG"
  context                = "selected"
  namespace              = "{NAMESPACE}"
  authentication_profile = "development"
"#
        );
        let mut resources =
            format!("resource \"nemoclaw_kubernetes_storage\" \"platform\" {{\n{target}}}\n");
        if stage != Stage::Teardown {
            resources.push_str(&format!(
                "resource \"nemoclaw_kubernetes_auth\" \"platform\" {{\n{target}  owner = nemoclaw_kubernetes_storage.platform.owner\n}}\n"
            ));
        }
        if stage == Stage::Installed {
            resources.push_str(&format!(
                "resource \"nemoclaw_kubernetes_gateway\" \"platform\" {{\n{target}  owner      = nemoclaw_kubernetes_storage.platform.owner\n  generation = nemoclaw_kubernetes_auth.platform.generation\n}}\n"
            ));
        }
        let destroy = if stage == Stage::Teardown {
            "destroy = true"
        } else {
            ""
        };
        fs::write(
            self.workspace.path().join("main.tf"),
            format!(
                r#"terraform {{
  required_version = "= 1.12.6"
  required_providers {{
    nemoclaw = {{ source = "registry.opentofu.org/nvidia/nemoclaw" }}
  }}
}}
provider "nemoclaw" {{ {destroy} }}
{resources}"#
            ),
        )
        .unwrap();
    }

    /// Run OpenTofu with the kubeconfig and receipt directory the SDK supplies.
    fn tofu(&self, args: &[&str], success: bool) -> String {
        let output = self
            .workspace
            .command()
            .args(args)
            .env(
                "TEST_CLUSTER_KUBECONFIG",
                self.workspace.path().join("cluster.kubeconfig"),
            )
            .env(
                nemoclaw_sdk::kubernetes::STATE_ENV,
                self.workspace.path().join("kubernetes"),
            )
            .output()
            .unwrap();
        let text = format!(
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.status.success(), success, "{args:?}: {text}");
        text
    }

    fn apply(&self, success: bool) -> String {
        self.tofu(
            &["apply", "-auto-approve", "-input=false", "-no-color"],
            success,
        )
    }

    fn state(&self) -> Vec<u8> {
        fs::read(self.workspace.path().join("terraform.tfstate")).unwrap()
    }

    /// Recorded attributes by resource address.
    fn resources(&self) -> BTreeMap<String, Value> {
        let state: Value = serde_json::from_slice(&self.state()).unwrap();
        state["resources"]
            .as_array()
            .unwrap()
            .iter()
            .map(|resource| {
                (
                    format!(
                        "{}.{}",
                        resource["type"].as_str().unwrap(),
                        resource["name"].as_str().unwrap()
                    ),
                    resource["instances"][0]["attributes"].clone(),
                )
            })
            .collect()
    }

    fn snapshot(&self) -> BTreeMap<String, Value> {
        self.objects.0.lock().unwrap().clone()
    }

    fn uid(&self, api_version: &str, kind: &str, name: &str) -> Option<String> {
        let namespace = if kind == "Namespace" { "" } else { NAMESPACE };
        self.objects
            .get(api_version, kind, namespace, name)
            .map(|object| object["metadata"]["uid"].as_str().unwrap().to_owned())
    }

    /// Storage, authentication, and a ready gateway, applied in the order a
    /// bundle applies them around the Helm release.
    async fn deployed() -> Self {
        let platform = Self::start().await;
        platform.configure(Stage::Prepared);
        platform.apply(true);
        install_release(&platform.objects, 1);
        platform.configure(Stage::Installed);
        platform.apply(true);
        platform
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; in-memory Kubernetes API"]
async fn kubernetes_resources_apply_observe_the_release_and_tear_down_keeping_storage() {
    let platform = Platform::start().await;
    platform.configure(Stage::Prepared);
    let empty = platform.snapshot();
    platform.tofu(
        &["plan", "-input=false", "-no-color", "-out=prepare.plan"],
        true,
    );
    assert_eq!(platform.snapshot(), empty, "planning changes nothing");
    platform.tofu(
        &["apply", "-input=false", "-no-color", "prepare.plan"],
        true,
    );

    // Storage creates the retained namespace and key; authentication creates
    // the issuer in it. Every object carries the generated owner.
    let resources = platform.resources();
    let (storage, auth) = (&resources[STORAGE], &resources[AUTH]);
    let owner = storage["owner"].as_str().unwrap();
    assert_eq!(auth["owner"], owner);
    let namespace = platform.uid("v1", "Namespace", NAMESPACE).unwrap();
    let key = platform
        .uid("v1", "Secret", &format!("{NAME}-kek"))
        .unwrap();
    assert_eq!(storage["id"], namespace);
    assert_eq!(storage["running"], "true");
    for (api_version, kind, name) in ISSUER {
        let object = platform
            .objects
            .get(api_version, kind, NAMESPACE, name)
            .unwrap_or_else(|| panic!("{kind} {name}"));
        assert_eq!(
            object["metadata"]["labels"]["nemoclaw.nvidia.com/uid"],
            owner
        );
    }
    let (api_version, kind, name) = ISSUER[0];
    assert_eq!(auth["id"], platform.uid(api_version, kind, name).unwrap());
    assert_eq!(auth["running"], "true");
    assert_eq!(auth["release_present"], "false");
    assert_eq!(auth["gateway_values"], "{}");

    // Helm installs the chart. The gateway records its StatefulSet before the
    // pod is ready, plans another observation, and reports it ready later.
    install_release(&platform.objects, 0);
    platform.configure(Stage::Installed);
    platform.apply(true);
    let statefulset = platform.uid("apps/v1", "StatefulSet", NAME).unwrap();
    let gateway = &platform.resources()[GATEWAY];
    assert_eq!(gateway["id"], statefulset);
    assert_eq!(gateway["running"], "false");
    let stopped = platform.tofu(&["plan", "-input=false", "-no-color"], true);
    assert!(
        stopped.contains(&format!("{GATEWAY} will be updated")),
        "{stopped}"
    );
    ready_release(&platform.objects);
    let installed = platform.snapshot();
    platform.apply(true);
    let resources = platform.resources();
    assert_eq!(resources[GATEWAY]["id"], statefulset);
    assert_eq!(resources[GATEWAY]["running"], "true");
    assert_eq!(resources[AUTH]["release_present"], "true");
    let unchanged = platform.tofu(&["plan", "-input=false", "-no-color"], true);
    assert!(unchanged.contains("No changes"), "{unchanged}");
    assert_eq!(
        platform.snapshot(),
        installed,
        "observation changes nothing"
    );

    // Teardown removes the gateway binding, but keeps the issuer while Helm
    // still holds the release.
    platform.configure(Stage::Teardown);
    let retained = platform.apply(false);
    assert!(retained.contains("observation is incomplete"), "{retained}");
    assert_eq!(platform.snapshot(), installed);
    assert_eq!(
        platform.resources().into_keys().collect::<Vec<_>>(),
        [AUTH, STORAGE]
    );

    // Once Helm removes the release, teardown deletes the issuer and keeps
    // the namespace and key.
    uninstall_release(&platform.objects);
    platform.apply(true);
    assert_eq!(
        platform.resources().into_keys().collect::<Vec<_>>(),
        [STORAGE]
    );
    for (api_version, kind, name) in ISSUER {
        assert_eq!(platform.uid(api_version, kind, name), None, "{kind} {name}");
    }
    assert_eq!(
        platform.uid("v1", "Namespace", NAMESPACE),
        Some(namespace.clone())
    );
    assert_eq!(
        platform.uid("v1", "Secret", &format!("{NAME}-kek")),
        Some(key)
    );

    // Storage outlives destroy.
    let bound = platform.state();
    let kept = platform.snapshot();
    let destroy = platform.tofu(
        &["destroy", "-auto-approve", "-input=false", "-no-color"],
        false,
    );
    assert!(destroy.contains(&format!("with {STORAGE}")), "{destroy}");
    crate::assert_same_managed_resources(&platform.state(), &bound);
    assert_eq!(platform.snapshot(), kept);

    // A later apply prepares a new issuer in the retained storage.
    platform.configure(Stage::Prepared);
    platform.apply(true);
    let resources = platform.resources();
    assert_eq!(resources[STORAGE]["id"], namespace);
    assert_eq!(resources[AUTH]["running"], "true");
    assert_eq!(
        resources[AUTH]["id"],
        platform.uid(api_version, kind, name).unwrap()
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "requires NEMOCLAW_TEST_TOFU and NEMOCLAW_TEST_PROVIDER; in-memory Kubernetes API"]
async fn kubernetes_resources_refuse_replaced_or_missing_objects_without_recreating_them() {
    let platform = Platform::deployed().await;
    let original = platform.snapshot();
    let bound = platform.state();
    let issuer = format!("{NAME}-oidc");
    let key = format!("{NAME}-kek");
    // (drift, removed rather than replaced, apiVersion, kind, name)
    let drifts = [
        ("deleted namespace", true, "v1", "Namespace", NAMESPACE),
        ("replaced key", false, "v1", "Secret", key.as_str()),
        (
            "deleted issuer",
            true,
            "apps/v1",
            "Deployment",
            issuer.as_str(),
        ),
        ("replaced issuer", false, "v1", "ConfigMap", issuer.as_str()),
        ("replaced gateway", false, "apps/v1", "StatefulSet", NAME),
    ];
    for (drift, removed, api_version, kind, name) in drifts {
        let namespace = if kind == "Namespace" { "" } else { NAMESPACE };
        if removed {
            let path = format!(
                "{}/{name}",
                crate::kube_api::collection(api_version, kind, namespace)
            );
            assert!(
                platform.objects.0.lock().unwrap().remove(&path).is_some(),
                "{path}"
            );
        } else {
            let mut object = platform
                .objects
                .get(api_version, kind, namespace, name)
                .unwrap();
            object["metadata"]["uid"] = json!("replacement-uid");
            platform.objects.insert(object);
        }
        let changed = platform.snapshot();
        for output in [
            platform.tofu(&["plan", "-input=false", "-no-color"], false),
            platform.apply(false),
        ] {
            assert!(output.contains(CHANGED), "{drift}: {output}");
        }
        assert_eq!(
            platform.snapshot(),
            changed,
            "{drift}: nothing is recreated or removed"
        );
        crate::assert_same_managed_resources(&platform.state(), &bound);
        *platform.objects.0.lock().unwrap() = original.clone();
    }
    let unchanged = platform.tofu(&["plan", "-input=false", "-no-color"], true);
    assert!(unchanged.contains("No changes"), "{unchanged}");
}
