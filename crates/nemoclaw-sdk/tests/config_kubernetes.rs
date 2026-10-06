// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::config::{Document, Runtime, schema};
use serde_json::{Value, json};

fn external_document() -> Value {
    let document =
        Document::parse(include_bytes!("fixtures/config/local.yaml").as_slice()).unwrap();
    let mut input = serde_json::to_value(document).unwrap();
    input["spec"]["gateway"]["runtime"] = json!({"provider": "kubernetes"});
    input["spec"]["sandboxes"][0]["image"]["metadata"] = json!({"env":"TEST_IMAGE_METADATA"});
    input
}

fn managed_document() -> Value {
    let mut input = external_document();
    input["spec"]["gateway"] = json!({
        "management": "managed",
        "runtime": {"provider": "kubernetes"},
        "endpoint": "https://127.0.0.1:17671",
        "kubernetes": {
            "kubeconfig": {"env": "CLUSTER_KUBECONFIG"},
            "context": "explicit-context",
            "namespace": "owned-gateway",
            "authentication": {"profile": "development"}
        }
    });
    input
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
            "explicit-context"
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

/// Editors and onboarding read a field's default from its own schema, so a
/// managed local gateway's defaults stay there even though a Kubernetes
/// target excludes those fields.
#[test]
fn a_managed_gateway_schema_still_states_its_local_defaults() {
    let schema = schema::input_schema();
    let managed = schema["$defs"]["Gateway"]["oneOf"]
        .as_array()
        .unwrap()
        .iter()
        .find(|variant| variant["properties"]["management"]["const"] == "managed")
        .unwrap();
    assert_eq!(
        managed["properties"]["engine"]["default"],
        "unix:///var/run/docker.sock"
    );
    assert_eq!(
        managed["properties"]["endpoint"]["default"],
        "http://127.0.0.1:17681"
    );
    assert!(managed["properties"]["image"]["default"].is_string());
}

/// A kubeconfig's exec plugin, such as a cloud CLI, may need the caller's
/// variables. OpenTofu passes only platform variables, so the author names
/// these, and they count as credentials.
#[test]
fn a_managed_target_names_the_variables_its_kubeconfig_needs() {
    let mut input = managed_document();
    input["spec"]["gateway"]["kubernetes"]["environment"] = json!(["AWS_PROFILE", "AWS_REGION"]);
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
        input["spec"]["gateway"]["kubernetes"]["environment"] = json!([name]);
        assert!(!validator.is_valid(&input), "{name}");
    }
    let mut repeated = managed_document();
    repeated["spec"]["gateway"]["kubernetes"]["environment"] =
        json!(["AWS_PROFILE", "AWS_PROFILE"]);
    assert!(!validator.is_valid(&repeated));
}

#[test]
fn kubernetes_sandboxes_must_name_their_image_metadata() {
    // No local engine can be inspected, so each image's metadata bundle is
    // required up front.
    let mut input = external_document();
    input["spec"]["sandboxes"][0]["image"]
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
    input["spec"]["gateway"]["kubernetes"]["prerequisites"] =
        json!({"agentSandbox": {"management": "existing"}});
    assert!(!jsonschema::is_valid(&schema::input_schema(), &input));
    assert!(Document::parse(input.to_string().as_bytes()).is_err());
}

#[test]
fn managed_kubernetes_requires_explicit_target_and_authentication_choices() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (parent, field) in [
        ("/spec/gateway", "endpoint"),
        ("/spec/gateway/kubernetes", "kubeconfig"),
        ("/spec/gateway/kubernetes/kubeconfig", "env"),
        ("/spec/gateway/kubernetes", "context"),
        ("/spec/gateway/kubernetes", "namespace"),
        ("/spec/gateway/kubernetes", "authentication"),
        ("/spec/gateway/kubernetes/authentication", "profile"),
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
fn managed_kubernetes_rejects_other_transports_targets_and_implicit_authentication() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for (path, value) in [
        ("/spec/gateway/endpoint", json!("")),
        ("/spec/gateway/endpoint", json!("http://127.0.0.1:17671")),
        ("/spec/gateway/endpoint", json!("https://localhost:17671")),
        ("/spec/gateway/endpoint", json!("https://127.0.0.2:17671")),
        (
            "/spec/gateway/endpoint",
            json!("https://gateway.example:17671"),
        ),
        ("/spec/gateway/endpoint", json!("https://127.0.0.1")),
        ("/spec/gateway/endpoint", json!("https://127.0.0.1:0")),
        ("/spec/gateway/endpoint", json!("https://127.0.0.1:65536")),
        ("/spec/gateway/endpoint", json!("https://127.0.0.1:17671/")),
        (
            "/spec/gateway/endpoint",
            json!("https://127.0.0.1:17671?token=value"),
        ),
        (
            "/spec/gateway/endpoint",
            json!("https://user:password@127.0.0.1:17671"),
        ),
        ("/spec/gateway/kubernetes/context", json!("")),
        ("/spec/gateway/kubernetes/namespace", json!("")),
        (
            "/spec/gateway/kubernetes/namespace",
            json!("Invalid_Namespace"),
        ),
        ("/spec/gateway/kubernetes/kubeconfig/env", json!("")),
        (
            "/spec/gateway/kubernetes/kubeconfig/env",
            json!("/private/kubeconfig"),
        ),
        (
            "/spec/gateway/kubernetes/authentication/profile",
            json!("none"),
        ),
        (
            "/spec/gateway/kubernetes/authentication/profile",
            json!("production"),
        ),
        ("/spec/gateway/runtime/provider", json!("docker")),
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
    for (field, value) in [
        ("engine", json!("unix:///var/run/docker.sock")),
        ("engine", json!("")),
        ("networkCIDR", json!("172.30.1.0/24")),
        ("image", json!(nemoclaw_sdk::config::DEFAULT_GATEWAY_IMAGE)),
        ("imagePullPolicy", json!("Never")),
        ("credential", json!({"env":"GATEWAY_TOKEN"})),
        (
            "tls",
            json!({"ca":{"env":"CA"},"certificate":{"env":"CERT"},"key":{"env":"KEY"}}),
        ),
    ] {
        let mut input = managed_document();
        let empty_default = field == "engine" && value == json!("");
        input["spec"]["gateway"][field] = value;
        assert!(!validator.is_valid(&input), "accepted {field}");
        assert!(Document::parse(input.to_string().as_bytes()).is_err());
        if let Ok(document) = serde_json::from_value::<Document>(input)
            && !empty_default
        {
            assert!(document.validate().is_err(), "accepted direct Rust {field}");
        }
    }
}

#[test]
fn managed_kubernetes_accepts_explicit_port_boundaries() {
    for port in [1, 443, 65535] {
        let mut input = managed_document();
        input["spec"]["gateway"]["endpoint"] = json!(format!("https://127.0.0.1:{port}"));
        Document::parse(input.to_string().as_bytes()).unwrap();
    }
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
    ] {
        for path in [
            "/spec/gateway/kubernetes/kubeconfig",
            "/spec/inferenceProviders/0/credential",
        ] {
            let mut input = managed_document();
            input["spec"]["inferenceProviders"][0]["endpoint"] =
                json!("https://inference.example/v1");
            input["spec"]["inferenceProviders"][0]["credential"] = json!({"env":"HOSTED_API_KEY"});
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
        input["spec"]["gateway"]["kubernetes"]["kubeconfig"]["env"] = json!(name);
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
        input["spec"]["gateway"]["kubernetes"]["kubeconfig"]["env"] = json!(name);
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
        input["spec"]["gateway"]["runtime"]["provider"] = json!("docker");
        input["spec"]["sandboxes"][0]["image"]
            .as_object_mut()
            .unwrap()
            .remove("metadata");
        input["spec"]["inferenceProviders"][0]["endpoint"] = json!("https://inference.example/v1");
        input["spec"]["inferenceProviders"][0]["credential"] = json!({"env": name});
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
        document.spec.gateway.runtime().provider.as_str(),
        "kubernetes"
    );
    assert!(jsonschema::is_valid(&schema::input_schema(), &input));
    let exported = document.yaml().unwrap();
    let imported = Document::parse(exported.as_bytes()).unwrap();
    assert_eq!(imported.digest(), document.digest());
    assert_eq!(
        imported.spec.gateway.runtime().provider.to_string(),
        "kubernetes"
    );
}

#[test]
fn kubernetes_requires_an_explicit_nonempty_image_before_defaults() {
    let validator = jsonschema::validator_for(&schema::input_schema()).unwrap();
    for image in [None, Some(json!({})), Some(json!({"ref": ""}))] {
        let mut input = external_document();
        let sandbox = input["spec"]["sandboxes"][0].as_object_mut().unwrap();
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
    document.spec.sandboxes[0].image = Default::default();
    assert!(document.validate().is_err());
    document.defaults();
    assert!(document.spec.sandboxes[0].image.ref_.is_empty());
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
    *document.spec.gateway.runtime_mut() =
        serde_json::from_value::<Runtime>(json!({"provider": "kubernetes"})).unwrap();
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
