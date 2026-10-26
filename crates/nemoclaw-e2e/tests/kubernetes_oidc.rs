// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed gateway authenticating through an existing OIDC issuer: the
//! SDK's development issuer image, run in its own namespace as a stand-in for
//! an identity provider.
use super::*;
use k8s_openapi::api::{apps::v1::Deployment as KubeDeployment, core::v1::ConfigMap};
use kube::api::PostParams;
use nemoclaw_sdk::kubernetes::{
    auth::{ADMIN_ROLE, Development, USER_ROLE},
    issuer,
};

const TOKEN_ENV: &str = "NEMOCLAW_TEST_OIDC_TOKEN";
const CA_CONFIG_MAP: &str = "existing-issuer-ca";

fn uuid() -> String {
    let mut uid = [0u8; 16];
    getrandom::fill(&mut uid).unwrap();
    uid[6] = (uid[6] & 0x0f) | 0x40;
    uid[8] = (uid[8] & 0x3f) | 0x80;
    let hex: String = uid.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

async fn cluster_client() -> kube::Client {
    let kubeconfig =
        kube::config::Kubeconfig::read_from(required("NEMOCLAW_TEST_KUBECONFIG")).unwrap();
    let options = kube::config::KubeConfigOptions {
        context: Some(required("NEMOCLAW_TEST_KUBE_CONTEXT")),
        ..Default::default()
    };
    nemoclaw_sdk::kubernetes::client(
        kube::Config::from_custom_kubeconfig(kubeconfig, &options)
            .await
            .unwrap(),
    )
    .unwrap()
}

/// A namespace the test created, deleted without waiting for its contents
/// when dropped, including when the test panics.
struct OwnedNamespace(String);
impl Drop for OwnedNamespace {
    fn drop(&mut self) {
        // A panic may be unwinding the runtime that drives the test's client,
        // so the deletion gets its own thread, runtime and client. The client
        // has no read timeout, so the request gets one: an unresponsive
        // cluster must not turn a failure into a time-limit kill.
        let name = self.0.clone();
        let _ = std::thread::spawn(move || {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap()
                .block_on(async {
                    let _ = tokio::time::timeout(Duration::from_secs(15), async {
                        Api::<Namespace>::all(cluster_client().await)
                            .delete(&name, &Default::default())
                            .await
                    })
                    .await;
                });
        })
        .join();
    }
}

/// The regular files under `directory`, without following symbolic links:
/// OpenTofu links its provider directories to the bundle.
fn regular_files(directory: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut pending = vec![directory.to_path_buf()];
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                pending.push(entry.path());
            } else if kind.is_file() {
                files.push(entry.path());
            }
        }
    }
    files
}

/// The deployment's state, by path: its intent record, its OpenTofu state
/// and backup, and the Kubernetes receipt and gateway client material.
/// Generated configuration, plans, caches and diagnostics are left out.
fn deployment_state(directory: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files: Vec<PathBuf> = [
        "intent.json",
        "terraform.tfstate",
        "terraform.tfstate.backup",
    ]
    .into_iter()
    .map(|name| directory.join(name))
    .filter(|path| path.exists())
    .collect();
    files.extend(regular_files(&directory.join("kubernetes")));
    files
        .into_iter()
        .map(|path| (path.clone(), fs::read(path).unwrap()))
        .collect()
}

/// The files under `directory` whose bytes contain any of `values`.
fn files_holding(directory: &Path, values: &[&str]) -> BTreeSet<PathBuf> {
    regular_files(directory)
        .into_iter()
        .filter(|path| {
            let bytes = fs::read(path).unwrap();
            values.iter().any(|value| {
                bytes
                    .windows(value.len())
                    .any(|window| window == value.as_bytes())
            })
        })
        .collect()
}

fn document(uid: &str, namespace: &str, issuer: &str, audience: &str) -> Document {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let harness = required("NEMOCLAW_TEST_AGENT_HARNESS");
    // Pi needs a context window, input types and cost for a model it does not ship.
    let extensions = if harness == "nvidia.fabric.pi" {
        "\n                extensions:\n                  context_window: 8192\n                  input: [text]\n                  cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}"
    } else {
        ""
    };
    let yaml = format!(
        "apiVersion: nemoclaw.nvidia.com/v1alpha1
kind: NemoClawConfig
metadata:
  name: live-kind-oidc
  uid: {uid}
spec:
  gateway:
    management: managed
    runtime:
      provider: kubernetes
    endpoint: https://127.0.0.1:{port}
    kubernetes:
      kubeconfig: {{env: NEMOCLAW_TEST_KUBECONFIG}}
      context: {context}
      namespace: {namespace}
      authentication:
        profile: oidc
        caConfigMap: {CA_CONFIG_MAP}
        token:
          env: {TOKEN_ENV}
    config:
      openshell.gateway.oidc:
        issuer: {issuer}
        audience: {audience}
        roles_claim: roles
        admin_role: {ADMIN_ROLE}
        user_role: {USER_ROLE}
        scopes_claim: scope
  inferenceProviders:
    hosted:
      provider: openai
      endpoint: https://inference.example.test/v1
  sandboxes:
    - name: assistant
      image:
        ref: {image}
        metadata: {{env: NEMOCLAW_TEST_AGENT_METADATA}}
      network:
        tier: isolated
      harness:
        kind: {harness}
      agent:
        name: main
        inference:
          routes:
            - name: primary
              providerRef: hosted
              overrides:
                model: fixture-model
                maxTokens: 2048{extensions}
",
        context = required("NEMOCLAW_TEST_KUBE_CONTEXT"),
        image = required("NEMOCLAW_TEST_AGENT_IMAGE"),
    );
    Document::parse(yaml.as_bytes()).unwrap()
}

#[tokio::test]
#[ignore = "needs a Kubernetes cluster with Agent Sandbox and a loaded agent image; run through cargo ci live-kind"]
async fn a_managed_gateway_accepts_an_existing_issuers_tokens_and_refuses_another_audience() {
    use nemoclaw_sdk::{CancellationToken, Deployment};
    let client = cluster_client().await;

    // The existing issuer, in its own namespace, which goes on every path.
    let owned = OwnedNamespace(format!("nc-issuer-{}", random_hex(6)));
    let issuer_namespace = owned.0.as_str();
    Api::<Namespace>::all(client.clone())
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({"metadata": {"name": issuer_namespace}})).unwrap(),
        )
        .await
        .unwrap();
    let keys = tempfile::tempdir().unwrap();
    let audience = uuid();
    let material = Development::new(keys.path().into(), "existing", issuer_namespace, &audience)
        .ensure()
        .unwrap();
    // The issuer's NetworkPolicy admits only a gateway in its own namespace,
    // so an existing issuer omits it.
    for object in issuer::objects(&material, "existing", issuer_namespace) {
        if object["kind"] != "NetworkPolicy" {
            create(&client, object).await;
        }
    }
    let deployments = Api::<KubeDeployment>::namespaced(client.clone(), issuer_namespace);
    let deadline = std::time::Instant::now() + Duration::from_secs(180);
    loop {
        let ready = deployments
            .get("existing-oidc")
            .await
            .ok()
            .and_then(|deployment| deployment.status)
            .and_then(|status| status.ready_replicas)
            .unwrap_or(0);
        if ready > 0 {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the existing issuer never became ready"
        );
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    eprintln!("existing issuer ready in {issuer_namespace}");
    let now = time::OffsetDateTime::now_utc().unix_timestamp();
    let token = material.token(now);
    // The same signing key, for another audience.
    let foreign = Development::new(keys.path().into(), "existing", issuer_namespace, &uuid())
        .ensure()
        .unwrap()
        .token(now);

    let namespace = format!("nc-live-{}", random_hex(6));
    let document = document(&uuid(), &namespace, material.issuer(), &audience);
    let state = tempfile::tempdir().unwrap();
    let caller = std::env::current_dir().unwrap();
    let from_root: PathBuf = caller.ancestors().skip(1).map(|_| "..").collect();
    let kubeconfig = std::path::absolute(required("NEMOCLAW_TEST_KUBECONFIG")).unwrap();
    let relative = from_root.join(kubeconfig.strip_prefix("/").unwrap());
    let credentials = |token: &str| {
        Arc::new(Values(BTreeMap::from([
            (
                "NEMOCLAW_TEST_KUBECONFIG".into(),
                relative.to_string_lossy().into_owned(),
            ),
            (
                "NEMOCLAW_TEST_AGENT_METADATA".into(),
                required("NEMOCLAW_TEST_AGENT_METADATA"),
            ),
            (TOKEN_ENV.into(), token.to_owned()),
        ])))
    };
    let bundle = PathBuf::from(required("NEMOCLAW_TEST_BUNDLE"));
    let cancel = CancellationToken::new();

    // The issuer's CA goes into the namespace NemoClaw creates, as soon as it
    // exists; the gateway waits for it.
    let ca = material.ca_pem().to_owned();
    let provision = async {
        let namespaces = Api::<Namespace>::all(client.clone());
        let deadline = std::time::Instant::now() + Duration::from_secs(240);
        while namespaces.get_opt(&namespace).await.unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "the namespace never appeared"
            );
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        Api::<ConfigMap>::namespaced(client.clone(), &namespace)
            .create(
                &PostParams::default(),
                &serde_json::from_value(json!({
                    "metadata": {"name": CA_CONFIG_MAP, "namespace": namespace},
                    "data": {"ca.crt": ca},
                }))
                .unwrap(),
            )
            .await
            .unwrap();
        eprintln!("issuer CA provisioned in {namespace}");
    };
    // Only this Deployment holds the first token. Stop waiting for the
    // namespace if apply ends first, so its error shows.
    let applied = {
        let deployment = Deployment::new(state.path(), &bundle).with_secrets(credentials(&token));
        let apply = deployment.apply(&document, &cancel);
        tokio::pin!(apply);
        tokio::select! {
            result = &mut apply => result,
            () = provision => apply.await,
        }
    };
    if let Err(error) = &applied {
        eprintln!("{}", namespace_diagnostics(&client, &namespace).await);
        panic!("the gateway accepts the existing issuer's token: {error:?}");
    }
    eprintln!("applied with the issuer's token");

    // Every assertion below waits until destroy has run, so a failed one
    // still removes the deployment.
    let issuers = Api::<KubeDeployment>::namespaced(client.clone(), &namespace)
        .list(&ListParams::default().labels("app.kubernetes.io/name=nemoclaw-development-issuer"))
        .await
        .unwrap();

    // A token for another audience, signed with the same key.
    let before = deployment_state(state.path());
    let refused = Deployment::new(state.path(), &bundle)
        .with_secrets(credentials(&foreign))
        .plan(&document, &cancel)
        .await;
    let after = deployment_state(state.path());

    // The documented renewal: a new token from the issuer, for the next
    // commands. One second later, its iat and exp differ from the first.
    let renewed = material.token(now + 1);
    let deployment = Deployment::new(state.path(), &bundle).with_secrets(credentials(&renewed));
    let planned = deployment.plan(&document, &cancel).await;
    let exported = deployment.export(&cancel).await;
    let tokens = [token.as_str(), renewed.as_str(), foreign.as_str()];
    let mut holding = files_holding(state.path(), &tokens);
    let destroyed = match deployment.destroy(&cancel).await {
        Ok(destroyed) => destroyed,
        // A refused renewed token is the failure this test looks for, so a
        // separate Deployment destroys with the first token before reporting it.
        Err(error) => {
            let cleanup = Deployment::new(state.path(), &bundle)
                .with_secrets(credentials(&token))
                .destroy(&cancel)
                .await
                .map(|_| ());
            panic!(
                "destroy with the renewed token: {error:?}; destroy with the first token: {cleanup:?}"
            );
        }
    };
    holding.extend(files_holding(state.path(), &tokens));

    assert!(
        issuers.items.is_empty(),
        "the oidc profile runs no development issuer"
    );
    let error = refused.expect_err("a token for another audience must be refused");
    eprintln!("refused the other audience");
    // The refusal is an OpenTofu execution error; its wording is not checked.
    let text = format!("{error} {error:?}");
    assert!(
        tokens.iter().all(|token| !text.contains(token)),
        "the refusal echoes no token"
    );
    let changed: Vec<_> = before
        .keys()
        .chain(after.keys())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| before.get(*path) != after.get(*path))
        .collect();
    assert!(
        changed.is_empty(),
        "a refused plan leaves the deployment's state unchanged: {changed:?}"
    );
    assert!(renewed != token, "the renewed token differs from the first");
    let planned = planned.expect("a plan with the renewed token must succeed");
    assert!(
        planned.changes.is_empty(),
        "a plan with the renewed token changes nothing: {:?}",
        planned.changes
    );
    assert_eq!(
        exported.expect("export with the renewed token must succeed"),
        document
    );
    for change in &destroyed.changes {
        assert!(
            !change.resource.contains("kubernetes_storage"),
            "destroy keeps the gateway's storage: {}",
            change.resource
        );
    }
    assert!(
        holding.is_empty(),
        "no file in the state directory holds a token: {holding:?}"
    );
}
