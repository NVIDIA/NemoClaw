// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! A managed gateway authenticating through an existing OIDC issuer: the
//! SDK's development issuer image, run in its own namespace as a stand-in for
//! an identity provider.
use super::*;
use k8s_openapi::api::{
    apps::v1::Deployment as KubeDeployment,
    core::v1::{ConfigMap, Service},
};
use kube::api::PostParams;
use nemoclaw_sdk::kubernetes::{
    auth::{ADMIN_ROLE, Development, USER_ROLE},
    issuer,
};

const TOKEN_ENV: &str = "NEMOCLAW_TEST_OIDC_TOKEN";
const CA_CONFIG_MAP: &str = "existing-issuer-ca";

fn random_hex(bytes: usize) -> String {
    let mut buffer = vec![0u8; bytes];
    getrandom::fill(&mut buffer).unwrap();
    buffer.iter().map(|byte| format!("{byte:02x}")).collect()
}

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

/// Create one of the development issuer's objects. Its NetworkPolicy admits
/// only a gateway in its own namespace, so an existing issuer omits it.
async fn create(client: &kube::Client, object: Value) {
    let namespace = object["metadata"]["namespace"].as_str().unwrap().to_owned();
    let post = PostParams::default();
    match object["kind"].as_str().unwrap() {
        "ConfigMap" => {
            Api::<ConfigMap>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        "Secret" => {
            Api::<Secret>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        "Service" => {
            Api::<Service>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        "Deployment" => {
            Api::<KubeDeployment>::namespaced(client.clone(), &namespace)
                .create(&post, &serde_json::from_value(object).unwrap())
                .await
                .unwrap();
        }
        "NetworkPolicy" => {}
        other => panic!("unexpected issuer object {other}"),
    }
}

fn document(uid: &str, namespace: &str, issuer: &str, audience: &str) -> Document {
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let harness = required("NEMOCLAW_TEST_AGENT_HARNESS");
    let extensions = if harness == "nvidia.fabric.pi" {
        "\n                extensions:\n                  context_window: 8192"
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
    assistant:
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

/// What the deployment's namespace shows when apply fails: each pod's phase
/// and container states, recent events, and the end of each container's log.
/// Live failures otherwise leave only the SDK's summary in CI logs.
async fn namespace_diagnostics(client: &kube::Client, namespace: &str) -> String {
    use k8s_openapi::api::core::v1::{Event, Pod};
    use kube::api::LogParams;
    let mut out = format!("diagnostics for namespace {namespace}:\n");
    let pods = Api::<Pod>::namespaced(client.clone(), namespace);
    match pods.list(&ListParams::default()).await {
        Ok(list) => {
            for pod in list.items {
                let name = pod.metadata.name.clone().unwrap_or_default();
                let status = pod.status.clone().unwrap_or_default();
                out += &format!("pod {name}: {}\n", status.phase.unwrap_or_default());
                for container in status.container_statuses.unwrap_or_default() {
                    let state = container.state.as_ref().map(|state| {
                        if let Some(waiting) = &state.waiting {
                            format!(
                                "waiting {} {}",
                                waiting.reason.clone().unwrap_or_default(),
                                waiting.message.clone().unwrap_or_default()
                            )
                        } else if let Some(done) = &state.terminated {
                            format!(
                                "terminated {} exit {}",
                                done.reason.clone().unwrap_or_default(),
                                done.exit_code
                            )
                        } else {
                            "running".into()
                        }
                    });
                    out += &format!(
                        "  container {}: ready={} restarts={} {}\n",
                        container.name,
                        container.ready,
                        container.restart_count,
                        state.unwrap_or_default()
                    );
                    let params = LogParams {
                        container: Some(container.name.clone()),
                        tail_lines: Some(40),
                        ..LogParams::default()
                    };
                    if let Ok(log) = pods.logs(&name, &params).await {
                        for line in log.lines() {
                            out += &format!("    | {line}\n");
                        }
                    }
                }
            }
        }
        Err(error) => out += &format!("cannot list pods: {error}\n"),
    }
    if let Ok(list) = Api::<Event>::namespaced(client.clone(), namespace)
        .list(&ListParams::default())
        .await
    {
        let mut events = list.items;
        events.sort_by_key(|event| event.last_timestamp.clone().map(|time| time.0));
        for event in events.iter().rev().take(15).rev() {
            out += &format!(
                "event {} {}: {}\n",
                event.reason.clone().unwrap_or_default(),
                event.involved_object.name.clone().unwrap_or_default(),
                event
                    .message
                    .clone()
                    .unwrap_or_default()
                    .chars()
                    .take(240)
                    .collect::<String>()
            );
        }
    }
    out
}

#[tokio::test]
#[ignore = "needs a Kubernetes cluster with Agent Sandbox and a loaded agent image; run through cargo ci live-kind"]
async fn a_managed_gateway_accepts_an_existing_issuers_tokens_and_refuses_another_audience() {
    use nemoclaw_sdk::{CancellationToken, Deployment};
    let client = cluster_client().await;

    // The existing issuer, in its own namespace.
    let issuer_namespace = format!("nc-issuer-{}", random_hex(6));
    Api::<Namespace>::all(client.clone())
        .create(
            &PostParams::default(),
            &serde_json::from_value(json!({"metadata": {"name": issuer_namespace}})).unwrap(),
        )
        .await
        .unwrap();
    let keys = tempfile::tempdir().unwrap();
    let audience = uuid();
    let material = Development::new(keys.path().into(), "existing", &issuer_namespace, &audience)
        .ensure()
        .unwrap();
    for object in issuer::objects(&material, "existing", &issuer_namespace) {
        create(&client, object).await;
    }
    let deployments = Api::<KubeDeployment>::namespaced(client.clone(), &issuer_namespace);
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
    let foreign = Development::new(keys.path().into(), "existing", &issuer_namespace, &uuid())
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
    let deployment = Deployment::new(state.path(), &bundle).with_secrets(credentials(&token));
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
    // Stop waiting for the namespace if apply ends first, so its error shows.
    let apply = deployment.apply(&document, &cancel);
    tokio::pin!(apply);
    let applied = tokio::select! {
        result = &mut apply => result,
        () = provision => apply.await,
    };
    if let Err(error) = &applied {
        eprintln!("{}", namespace_diagnostics(&client, &namespace).await);
        panic!("the gateway accepts the existing issuer's token: {error:?}");
    }
    eprintln!("applied with the issuer's token");

    // No development issuer runs in the deployment's namespace.
    let issuers = Api::<KubeDeployment>::namespaced(client.clone(), &namespace)
        .list(&ListParams::default().labels("app.kubernetes.io/name=nemoclaw-development-issuer"))
        .await
        .unwrap();
    assert!(
        issuers.items.is_empty(),
        "the oidc profile runs no development issuer"
    );

    // A token for another audience is refused, and not echoed.
    let refused = Deployment::new(state.path(), &bundle)
        .with_secrets(credentials(&foreign))
        .plan(&document, &cancel)
        .await;
    let error = refused.expect_err("a token for another audience must be refused");
    eprintln!("refused the other audience");
    assert!(!format!("{error:?}").contains(&foreign));

    // The deployment exports its authored configuration, and destroy keeps
    // the gateway's storage.
    let exported = deployment.export(&cancel).await;
    let destroyed = deployment
        .destroy(&cancel)
        .await
        .expect("destroy with the issuer's token");
    for change in &destroyed.changes {
        assert!(
            !change.resource.contains("kubernetes_storage"),
            "destroy keeps the gateway's storage: {}",
            change.resource
        );
    }
    assert_eq!(
        exported.expect("export of the applied deployment must succeed"),
        document
    );
    let _ = Api::<Namespace>::all(client.clone())
        .delete(&issuer_namespace, &Default::default())
        .await;
}
