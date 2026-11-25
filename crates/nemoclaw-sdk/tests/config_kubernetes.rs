// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, ManagedTarget, schema};
use serde_json::{Value, json};

fn external_document() -> Value {
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(document).unwrap();
    input["spec"]["gateway"]["target"] = json!({"kubernetes": {}});
    input["spec"]["sandboxes"]["assistant"]["image"]["metadata"] =
        json!({"env":"TEST_IMAGE_METADATA"});
    input
}

fn managed_document() -> Value {
    let mut input = external_document();
    input["spec"]["gateway"] = json!({
        "management": "managed",
        "target": {"kubernetes": {
            "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
            "context": "explicit-context",
            "namespace": "owned-gateway",
            "authentication": {"profile": "development"}
        }}
    });
    input
}

/// Sandbox pods' pull Secrets are OpenShell's driver setting, which passes
/// through `config`; the target holds no pull Secrets of its own.
#[test]
fn image_pull_secrets_are_openshells_driver_setting_not_a_target_field() {
    let mut input = managed_document();
    input["spec"]["gateway"]["config"] = json!({"openshell.drivers.kubernetes": {
        "image_pull_secrets": ["registry-credentials"]
    }});
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(serde_json::to_value(&document).unwrap(), input);

    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["imagePullSecrets"] =
        json!(["registry-credentials"]);
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn managed_kubernetes_preserves_explicit_target_and_has_no_local_engine_defaults() {
    {
        let input = managed_document();
        assert!(jsonschema::is_valid(&schema::input_schema(), &input));
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert!(document.has_runtime());
        assert!(document.spec.gateway.as_managed().is_some());
        assert!(document.spec.gateway.as_local_managed().is_none());
        assert_eq!(
            document.spec.gateway.as_kubernetes().unwrap().context,
            Some("explicit-context".into())
        );
        assert!(
            document
                .spec
                .gateway
                .as_managed()
                .unwrap()
                .bridge()
                .is_err()
        );
        assert_eq!(
            document.credential_names(),
            ["CLUSTER_KUBECONFIG", "TEST_IMAGE_METADATA"]
        );
        assert_eq!(serde_json::to_value(&document).unwrap(), input);
        assert_eq!(
            Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
            document
        );
    }
}

/// Editors and onboarding read a field's default from its own schema, and
/// each target's definition holds only its own fields: Docker's socket and the
/// default port, Podman's port without a socket, and no engine or port on a
/// cluster.
#[test]
fn each_target_definition_states_only_its_own_defaults() {
    let schema = schema::input_schema();
    let definition = |name: &str| schema["$defs"][name]["properties"].clone();
    let docker = definition("DockerTarget");
    assert_eq!(docker["engine"]["default"], "unix:///var/run/docker.sock");
    assert_eq!(docker["port"]["default"], 17681);
    let podman = definition("PodmanTarget");
    assert!(podman["engine"].get("default").is_none());
    assert_eq!(podman["port"]["default"], 17681);
    assert_eq!(
        schema["$defs"]["PodmanTarget"]["required"],
        json!(["engine"])
    );
    for cluster in ["ManagedKubernetes", "ManagedOpenShift"] {
        let properties = definition(cluster);
        for field in [
            "engine",
            "port",
            "networkCIDR",
            "imagePullPolicy",
            "endpoint",
        ] {
            assert!(properties.get(field).is_none(), "{cluster}.{field}");
        }
    }
}

/// A kubeconfig's exec plugin, such as a cloud CLI, may need the caller's
/// variables. OpenTofu passes only platform variables, so the author names
/// these, and they count as credentials.
#[test]
fn a_managed_target_names_the_variables_its_kubeconfig_needs() {
    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["environment"] =
        json!(["AWS_PROFILE", "AWS_REGION"]);
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(
        document.spec.gateway.as_kubernetes().unwrap().environment,
        ["AWS_PROFILE", "AWS_REGION"]
    );
    assert_eq!(
        document.credential_names(),
        [
            "AWS_PROFILE",
            "AWS_REGION",
            "CLUSTER_KUBECONFIG",
            "TEST_IMAGE_METADATA"
        ]
    );
    assert_eq!(serde_json::to_value(&document).unwrap(), input);
}

/// Without a kubeconfig and context, every cluster client uses the pod's
/// service account; nothing is resolved from the caller for the cluster.
#[test]
fn a_target_without_kubeconfig_and_context_uses_the_pods_service_account() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let mut input = managed_document();
    let kubernetes = input["spec"]["gateway"]["target"]["kubernetes"]
        .as_object_mut()
        .unwrap();
    kubernetes.remove("kubeconfig");
    kubernetes.remove("context");
    assert!(validator.is_valid(&input));
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(document.credential_names(), ["TEST_IMAGE_METADATA"]);
    assert_eq!(serde_json::to_value(&document).unwrap(), input);
    assert_eq!(
        Document::parse(document.yaml().unwrap().as_bytes()).unwrap(),
        document
    );

    // The listed variables serve a kubeconfig's exec plugin, so they need one.
    input["spec"]["gateway"]["target"]["kubernetes"]["environment"] = json!(["AWS_PROFILE"]);
    assert!(!validator.is_valid(&input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn listed_variables_cannot_shadow_process_or_runtime_controls() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for name in [
        "PATH",
        "KUBECONFIG",
        "HTTPS_PROXY",
        "TF_LOG",
        "HELM_DRIVER",
        "LD_PRELOAD",
        "lowercase",
        "AWS_PROFILE AWS_REGION",
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["environment"] = json!([name]);
        assert!(!validator.is_valid(&input), "{name}");
    }
    let mut repeated = managed_document();
    repeated["spec"]["gateway"]["target"]["kubernetes"]["environment"] =
        json!(["AWS_PROFILE", "AWS_PROFILE"]);
    assert!(!validator.is_valid(&repeated));
}

#[test]
fn kubernetes_sandboxes_must_name_their_image_metadata() {
    // No local engine can be inspected, so each image's metadata bundle is
    // required up front.
    let mut input = external_document();
    input["spec"]["sandboxes"]["assistant"]["image"]
        .as_object_mut()
        .unwrap()
        .remove("metadata");
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn agent_sandbox_is_a_platform_prerequisite_not_a_setting() {
    // Agent Sandbox must already be installed; the deployment never
    // installs it, so there is nothing to choose.
    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["prerequisites"] =
        json!({"agentSandbox": {"management": "existing"}});
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn managed_kubernetes_requires_explicit_target_and_authentication_choices() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (parent, field) in [
        ("/spec/gateway/target/kubernetes", "kubeconfig"),
        ("/spec/gateway/target/kubernetes/kubeconfig", "env"),
        ("/spec/gateway/target/kubernetes", "context"),
        ("/spec/gateway/target/kubernetes", "namespace"),
        ("/spec/gateway/target/kubernetes", "authentication"),
        ("/spec/gateway/target/kubernetes/authentication", "profile"),
    ] {
        let mut input = managed_document();
        input
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(
            !validator.is_valid(&input),
            "accepted omitted {parent}/{field}"
        );
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn managed_kubernetes_rejects_invalid_targets_and_implicit_authentication() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (path, value) in [
        ("/spec/gateway/target/kubernetes/context", json!("")),
        ("/spec/gateway/target/kubernetes/namespace", json!("")),
        (
            "/spec/gateway/target/kubernetes/namespace",
            json!("Invalid_Namespace"),
        ),
        ("/spec/gateway/target/kubernetes/kubeconfig/env", json!("")),
        (
            "/spec/gateway/target/kubernetes/kubeconfig/env",
            json!("/private/kubeconfig"),
        ),
        (
            "/spec/gateway/target/kubernetes/authentication/profile",
            json!("none"),
        ),
        (
            "/spec/gateway/target/kubernetes/authentication/profile",
            json!("production"),
        ),
    ] {
        let mut input = managed_document();
        *input.pointer_mut(path).unwrap() = value;
        assert!(!validator.is_valid(&input), "accepted invalid {path}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        if let Ok(document) = serde_json::from_value::<Document>(input) {
            assert!(
                document.validate().is_err(),
                "accepted direct Rust value at {path}"
            );
        }
    }
    // Local engine settings belong to the docker and podman targets, and a
    // managed gateway takes no endpoint, credential, or TLS of its own.
    for (parent, field, value) in [
        (
            "/spec/gateway/target/kubernetes",
            "engine",
            json!("unix:///var/run/docker.sock"),
        ),
        ("/spec/gateway/target/kubernetes", "port", json!(17681)),
        (
            "/spec/gateway/target/kubernetes",
            "networkCIDR",
            json!("172.30.1.0/24"),
        ),
        (
            "/spec/gateway/target/kubernetes",
            "imagePullPolicy",
            json!("Never"),
        ),
        (
            "/spec/gateway/target/kubernetes",
            "endpoint",
            json!("https://127.0.0.1:17671"),
        ),
        (
            "/spec/gateway",
            "endpoint",
            json!("https://127.0.0.1:17671"),
        ),
        (
            "/spec/gateway",
            "credential",
            json!({"env":"GATEWAY_TOKEN"}),
        ),
        (
            "/spec/gateway",
            "tls",
            json!({"ca":{"env":"CA"},"certificate":{"env":"CERT"},"key":{"env":"KEY"}}),
        ),
    ] {
        let mut input = managed_document();
        input.pointer_mut(parent).unwrap()[field] = value;
        assert!(!validator.is_valid(&input), "accepted {parent}/{field}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        assert!(serde_json::from_value::<Document>(input).is_err());
    }
}

/// Without expose, every command forwards its own free port, so the
/// document names none; with it, the endpoint is the address clients dial.
#[test]
fn an_exposed_endpoint_is_an_https_origin_with_a_host_and_an_explicit_port() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let exposed = |endpoint: Value| {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["expose"] =
            json!({"endpoint": endpoint, "service": {"type": "NodePort"}});
        input
    };
    for endpoint in [
        "https://127.0.0.1:1",
        "https://gateway.example.com:443",
        "https://10.0.0.5:65535",
    ] {
        let input = exposed(json!(endpoint));
        let document = Document::parse(input.to_string().as_bytes()).unwrap();
        assert_eq!(document.spec.gateway.endpoint().as_deref(), Some(endpoint));
    }
    for endpoint in [
        json!(""),
        json!("http://gateway.example.com:30080"),
        json!("https://Gateway.example.com:30080"),
        json!("https://gateway.example.com"),
        json!("https://gateway.example.com:0"),
        json!("https://gateway.example.com:65536"),
        json!("https://gateway.example.com:30080/"),
        json!("https://gateway.example.com:30080?token=value"),
        json!("https://user:password@gateway.example.com:30080"),
        json!(30080),
    ] {
        let input = exposed(endpoint.clone());
        assert!(!validator.is_valid(&input), "accepted {endpoint}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        if let Ok(document) = serde_json::from_value::<Document>(input) {
            assert!(document.validate().is_err(), "accepted direct {endpoint}");
        }
    }
    let mut missing = exposed(json!("https://gateway.example.com:30080"));
    missing["spec"]["gateway"]["target"]["kubernetes"]["expose"]
        .as_object_mut()
        .unwrap()
        .remove("endpoint");
    assert!(Document::parse(missing.to_string().as_bytes()).is_err());
    let document = Document::parse(managed_document().to_string().as_bytes()).unwrap();
    assert_eq!(document.spec.gateway.endpoint(), None);
}

#[test]
fn authored_credentials_cannot_shadow_managed_kubernetes_runtime_controls() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for name in [
        "HELM_DRIVER",
        "HELM_REGISTRY_CONFIG",
        "HELM_PLUGINS",
        "KUBE_HOST",
        "KUBE_TOKEN",
        "KUBE_CONFIG_PATH",
        "KUBE_CONFIG_PATHS",
        "KUBE_INSECURE",
        "NEMOCLAW_KUBERNETES_STATE",
        "NEMOCLAW_MANAGED_K8S_TOKEN",
        "NEMOCLAW_MANAGED_K8S_CA",
        // A pod's API server address reaches OpenTofu when no kubeconfig is
        // named, so no reference may carry these names.
        "KUBERNETES_SERVICE_HOST",
        "KUBERNETES_SERVICE_PORT",
        "KUBERNETES_SERVICE_PORT_HTTPS",
    ] {
        for path in [
            "/spec/gateway/target/kubernetes/kubeconfig",
            "/spec/inferenceProviders/local/credential",
        ] {
            let mut input = managed_document();
            input["spec"]["inferenceProviders"]["local"]["endpoint"] =
                json!("https://inference.example/v1");
            input["spec"]["inferenceProviders"]["local"]["credential"] =
                json!({"env":"HOSTED_API_KEY"});
            *input.pointer_mut(path).unwrap() = json!({"env":name});
            assert!(!validator.is_valid(&input));
            assert!(Document::parse(input.to_string().as_bytes()).is_err());
            assert!(
                serde_json::from_value::<Document>(input)
                    .unwrap()
                    .validate()
                    .is_err()
            );
        }
    }
}

#[test]
fn managed_kubeconfig_reference_cannot_override_process_controls() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "KUBECONFIG",
        "TMPDIR",
        "TMP",
        "TEMP",
        "SYSTEMROOT",
        "COMSPEC",
        "PATHEXT",
        "SHELL",
        "ENV",
        "BASH_ENV",
        "IFS",
        "CDPATH",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "PYTHONPATH",
        "PYTHONHOME",
        "HELM_PLUGINS",
        "HELM_KUBECONTEXT",
        "LD_PRELOAD",
        "DYLD_INSERT_LIBRARIES",
        "TF_CLI_CONFIG_FILE",
        "TOFU_DATA_DIR",
        "PLUGIN_PROTOCOL_VERSIONS",
        "NEMOCLAW_INTERNAL_HELPER",
        "NEMOCLAW_KUBERNETES_STATE",
        "NEMOCLAW_MANAGED_K8S_TOKEN",
        "KUBERNETES_MASTER",
        "KUBERNETES_SERVICE_HOST",
        "KUBERNETES_SERVICE_PORT",
        "KUBERNETES_SERVICE_PORT_HTTPS",
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["kubeconfig"]["env"] = json!(name);
        assert!(
            !validator.is_valid(&input),
            "accepted kubeconfig reference {name}"
        );
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        let direct = serde_json::from_value::<Document>(input).unwrap();
        assert!(direct.validate().is_err());
        assert!(
            direct
                .spec
                .gateway
                .as_managed()
                .unwrap()
                .validate_managed()
                .is_err()
        );
    }
    for name in [
        "CLUSTER_KUBECONFIG",
        "DEVELOPMENT_CLUSTER",
        "KUBECONFIG_PATH",
    ] {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["kubeconfig"]["env"] = json!(name);
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
}

#[test]
fn managed_kubeconfig_controls_do_not_restrict_other_credential_references() {
    for name in [
        "PATH",
        "HOME",
        "AWS_ACCESS_KEY_ID",
        "GOOGLE_APPLICATION_CREDENTIALS",
    ] {
        let mut input = external_document();
        input["spec"]["gateway"]["target"] = json!({"docker": {}});
        input["spec"]["sandboxes"]["assistant"]["image"]
            .as_object_mut()
            .unwrap()
            .remove("metadata");
        input["spec"]["inferenceProviders"]["local"]["endpoint"] =
            json!("https://inference.example/v1");
        input["spec"]["inferenceProviders"]["local"]["credential"] = json!({"env": name});
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
}

#[test]
fn a_kubernetes_target_cannot_enter_a_local_engine_spec() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!(
        "../../nemoclaw-provider/src/managed/reference.json"
    ))
    .unwrap();
    for fixture in fixtures {
        let mut raw: Value = serde_json::from_str(fixture["spec"].as_str().unwrap()).unwrap();
        let mut gateway = managed_document()["spec"]["gateway"].clone();
        gateway.as_object_mut().unwrap().remove("management");
        raw["gateway"] = gateway;
        let spec: nemoclaw_sdk::managed::Spec = serde_json::from_value(raw).unwrap();
        // A forged Docker driver must not route an otherwise valid Kubernetes target to an engine.
        assert!(spec.gateway.validate_managed().is_ok());
        assert!(spec.validate().is_err());
        assert!(spec.json().is_err());
        assert!(spec.container("/owned-data").is_err());
    }
}

#[test]
fn kubernetes_selects_the_gateway_driver_and_preserves_it_on_export() {
    let input = external_document();
    let document = Document::parse(input.to_string().as_bytes()).unwrap();
    assert_eq!(
        document.spec.gateway.compute_driver().as_str(),
        "kubernetes"
    );
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    let exported = document.yaml().unwrap();
    let imported = Document::parse(exported.as_bytes()).unwrap();
    assert_eq!(imported.digest(), document.digest());
    assert_eq!(
        imported.spec.gateway.compute_driver().to_string(),
        "kubernetes"
    );
}

#[test]
fn kubernetes_requires_an_explicit_nonempty_image_before_defaults() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for image in [None, Some(json!({})), Some(json!({"ref": ""}))] {
        let mut input = external_document();
        let sandbox = input["spec"]["sandboxes"]["assistant"]
            .as_object_mut()
            .unwrap();
        match image {
            Some(image) => {
                sandbox.insert("image".into(), image);
            }
            None => {
                sandbox.remove("image");
            }
        }
        assert!(!validator.is_valid(&input), "{input}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

#[test]
fn directly_constructed_kubernetes_sandboxes_never_default_their_image() {
    let mut document = Document::parse(external_document().to_string().as_bytes()).unwrap();
    document.spec.sandboxes.get_mut("assistant").unwrap().image = Default::default();
    assert!(document.validate().is_err());
    document.defaults();
    assert!(document.spec.sandboxes["assistant"].image.ref_.is_empty());
    assert!(document.validate().is_err());
}

#[test]
fn kubernetes_rejects_local_managed_gateways_without_an_explicit_target() {
    let mut input = external_document();
    input["spec"]["gateway"] = json!({"management": "managed"});
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));

    let mut document =
        Document::parse(include_bytes!("fixtures/config/managed-ollama.yaml").as_slice()).unwrap();
    let cluster = Document::parse(managed_document().to_string().as_bytes()).unwrap();
    document.spec.gateway.as_managed_mut().unwrap().target =
        cluster.spec.gateway.as_managed().unwrap().target.clone();
    assert!(matches!(
        document.spec.gateway.as_managed().unwrap().target,
        ManagedTarget::Kubernetes(_)
    ));
    assert!(document.validate().is_err());
}

#[test]
fn kubernetes_rejects_managed_services_even_when_no_route_selects_them() {
    let managed =
        Document::parse(include_bytes!("fixtures/config/managed-ollama.yaml").as_slice()).unwrap();
    for mut input in [external_document(), managed_document()] {
        let mut document = Document::parse(input.to_string().as_bytes()).unwrap();
        input["spec"]["services"] = serde_json::to_value(managed.spec.services.clone()).unwrap();
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
        document.spec.services = managed.spec.services.clone();
        assert!(document.validate().is_err());
    }
}

#[test]
fn kubernetes_does_not_relax_gateway_transport_or_credential_validation() {
    for endpoint in [
        "http://gateway.example.test:8080",
        "https://user:password@gateway.example.test",
        "https://gateway.example.test?token=secret",
    ] {
        let mut input = external_document();
        input["spec"]["gateway"]["endpoint"] = json!(endpoint);
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
    }
}

fn schema_error(input: &Value) -> String {
    Document::parse(input.to_string().as_bytes())
        .unwrap_err()
        .to_string()
}

#[test]
fn a_reserved_reference_name_states_whether_the_reference_holds_a_secret_or_a_file_path() {
    let secret = "secret reference must name a valid environment variable that does not shadow managed Kubernetes runtime controls";
    let file = "file reference must name a valid environment variable that does not shadow managed Kubernetes runtime controls";
    let mut external = external_document();
    external["spec"]["gateway"]["endpoint"] = json!("https://openshell.example.com");
    external["spec"]["gateway"]["credential"] = json!({"env": "GATEWAY_TOKEN"});
    external["spec"]["gateway"]["tls"] = json!({
        "ca": {"env": "GATEWAY_CA"},
        "certificate": {"env": "GATEWAY_CERT"},
        "key": {"env": "GATEWAY_KEY"}
    });
    external["spec"]["inferenceProviders"]["local"]["endpoint"] =
        json!("https://inference.example/v1");
    external["spec"]["inferenceProviders"]["local"]["credential"] =
        json!({"env": "HOSTED_API_KEY"});
    external["spec"]["sandboxes"]["assistant"]["integrations"] = json!({
        "search": {"kind": "webSearch", "provider": "brave", "credential": {"env": "SEARCH_KEY"}},
        "bookings": {
            "kind": "api",
            "endpoints": ["https://bookings.example.com/mcp"],
            "credential": {"env": "BOOKINGS_API_KEY"}
        }
    });
    external["spec"]["sandboxes"]["assistant"]["agent"]["integrationRefs"] =
        json!(["search", "bookings"]);
    Document::parse(external.to_string().as_bytes()).unwrap();
    let mut oidc = managed_document();
    oidc["spec"]["gateway"]["target"]["kubernetes"]["authentication"] = json!({
        "profile": "oidc",
        "token": {"env": "OPENSHELL_TOKEN"}
    });
    oidc["spec"]["gateway"]["config"] = json!({"openshell.gateway.oidc": {
        "issuer": "https://login.example.com/realms/openshell",
        "audience": "openshell"
    }});
    Document::parse(oidc.to_string().as_bytes()).unwrap();
    for (mut input, pointer, path, rule) in [
        (
            external.clone(),
            "/spec/gateway/credential",
            "spec.gateway.credential.env",
            secret,
        ),
        (
            external.clone(),
            "/spec/inferenceProviders/local/credential",
            "spec.inferenceProviders.local.credential.env",
            secret,
        ),
        (
            external.clone(),
            "/spec/sandboxes/assistant/integrations/search/credential",
            "spec.sandboxes.assistant.integrations.search.credential.env",
            secret,
        ),
        (
            external.clone(),
            "/spec/sandboxes/assistant/integrations/bookings/credential",
            "spec.sandboxes.assistant.integrations.bookings.credential.env",
            secret,
        ),
        (
            external.clone(),
            "/spec/gateway/tls/ca",
            "spec.gateway.tls.ca.env",
            file,
        ),
        (
            external.clone(),
            "/spec/gateway/tls/certificate",
            "spec.gateway.tls.certificate.env",
            file,
        ),
        (
            external.clone(),
            "/spec/gateway/tls/key",
            "spec.gateway.tls.key.env",
            file,
        ),
        (
            external,
            "/spec/sandboxes/assistant/image/metadata",
            "spec.sandboxes.assistant.image.metadata.env",
            file,
        ),
        (
            oidc,
            "/spec/gateway/target/kubernetes/authentication/token",
            "spec.gateway.target.kubernetes.authentication.token.env",
            secret,
        ),
        (
            managed_document(),
            "/spec/gateway/target/kubernetes/kubeconfig",
            "spec.gateway.target.kubernetes.kubeconfig.env",
            file,
        ),
    ] {
        *input.pointer_mut(pointer).unwrap() = json!({"env": "KUBE_TOKEN"});
        let error = schema_error(&input);
        assert!(
            error.contains(&format!("{path} (line")) && error.contains(rule),
            "{error}"
        );
        assert!(!error.contains("KUBE_TOKEN"), "{error}");
        let error = serde_json::from_value::<Document>(input)
            .unwrap()
            .validate()
            .unwrap_err()
            .to_string();
        assert!(error.contains(rule), "{error}");
    }
}

#[test]
fn an_exposed_endpoint_error_states_the_endpoint_rule() {
    let rule = "expose.endpoint must be https://HOST:PORT with a lowercase DNS name or IPv4 address, a nonzero port, and no path";
    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["expose"] =
        json!({"endpoint": "http://127.0.0.1:17671", "service": {"type": "NodePort"}});
    let error = schema_error(&input);
    assert!(
        error.contains("spec.gateway.target.kubernetes.expose.endpoint (line")
            && error.contains(rule),
        "{error}"
    );
}

#[test]
fn a_reserved_kubernetes_environment_name_states_the_naming_rule() {
    let mut input = managed_document();
    input["spec"]["gateway"]["target"]["kubernetes"]["environment"] =
        json!(["AWS_PROFILE", "KUBECONFIG"]);
    let error = schema_error(&input);
    assert!(
        error.contains("spec.gateway.target.kubernetes.environment[1] (line")
            && error.contains(
                "Kubernetes environment names must be unique variable names that do not shadow process, trust, proxy, or cluster controls"
            ),
        "{error}"
    );
    assert!(!error.contains("KUBECONFIG"), "{error}");
}

#[test]
fn managed_services_with_a_kubernetes_runtime_state_the_cluster_rule() {
    let managed =
        Document::parse(include_bytes!("fixtures/config/managed-ollama.yaml").as_slice()).unwrap();
    let mut input = external_document();
    input["spec"]["services"] = serde_json::to_value(managed.spec.services).unwrap();
    let error = schema_error(&input);
    assert!(
        error.contains("spec.services (line")
            && error.contains(
                "the kubernetes and openshift targets require external inference endpoints; managed services are not supported"
            ),
        "{error}"
    );
}

#[test]
fn an_oidc_profile_takes_openshells_oidc_table_and_development_takes_none() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    let oidc = json!({"profile": "oidc", "token": {"env": "OPENSHELL_TOKEN"}});
    let table = json!({
        "issuer": "https://login.example.com/realms/openshell",
        "audience": "openshell"
    });
    let input = |authentication: &Value, config: Option<Value>| {
        let mut input = managed_document();
        input["spec"]["gateway"]["target"]["kubernetes"]["authentication"] = authentication.clone();
        if let Some(config) = config {
            input["spec"]["gateway"]["config"] = config;
        }
        input
    };
    let valid = input(&oidc, Some(json!({"openshell.gateway.oidc": table})));
    let document =
        Document::parse(valid.to_string().as_bytes()).expect("a minimal oidc profile is valid");
    assert_eq!(serde_json::to_value(&document).unwrap(), valid);
    // The chart's nested form names the same table.
    let nested = input(&oidc, Some(json!({"openshell.gateway": {"oidc": table}})));
    Document::parse(nested.to_string().as_bytes()).expect("the nested form is valid");

    // Authentication keeps only the profile, token, and CA ConfigMap.
    let mut invalid: Vec<(&str, Value)> = Vec::new();
    let mut missing = oidc.clone();
    missing.as_object_mut().unwrap().remove("token");
    invalid.push(("token", missing));
    for (field, value) in [
        ("token", json!({"env": "KUBECONFIG"})),
        ("token", json!({"env": "lowercase"})),
        ("token", json!("OPENSHELL_TOKEN")),
        ("tokenEnv", json!("OPENSHELL_TOKEN")),
        ("caConfigMap", json!("Issuer_CA")),
        (
            "issuer",
            json!("https://login.example.com/realms/openshell"),
        ),
        ("audience", json!("openshell")),
        ("adminRole", json!("openshell-admins")),
    ] {
        let mut changed = oidc.clone();
        changed[field] = value;
        invalid.push((field, changed));
    }
    for field in ["token", "caConfigMap"] {
        let mut development = json!({"profile": "development"});
        development[field] = oidc["token"].clone();
        invalid.push(("development", development));
    }
    for (field, authentication) in invalid {
        let config =
            (authentication["profile"] == "oidc").then(|| json!({"openshell.gateway.oidc": table}));
        let input = input(&authentication, config);
        assert!(!validator.is_valid(&input), "accepted invalid {field}");
        assert!(
            Document::parse(input.to_string().as_bytes()).is_err(),
            "parsed invalid {field}"
        );
    }

    // The oidc profile requires OpenShell's table; development owns it.
    let development = json!({"profile": "development"});
    for (authentication, config) in [
        (&oidc, None),
        (
            &oidc,
            Some(json!({"openshell.gateway": {"log_level": "debug"}})),
        ),
        (&development, Some(json!({"openshell.gateway.oidc": table}))),
        (
            &development,
            Some(json!({"openshell.gateway": {"oidc": table}})),
        ),
    ] {
        let error = Document::parse(input(authentication, config.clone()).to_string().as_bytes())
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("openshell.gateway.oidc"),
            "{config:?}: {error}"
        );
    }
}
