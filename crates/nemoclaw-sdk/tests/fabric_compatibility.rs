// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use nemoclaw_sdk::fabric_catalog::{FabricAdapter, FabricCatalog};
use serde_json::json;

fn catalog() -> FabricCatalog {
    FabricCatalog {
        schema_version: 2,
        fabric_revision: FabricCatalog::bundled().fabric_revision,
        source_sha256: "b".repeat(64),
        targets: Vec::new(),
        adapters: vec![FabricAdapter {
            provenance: json!([{"source":"explicit_local","path":"/image/fixture.fabric-adapter.json","root":"/image"}]),
            descriptor: json!({"contract_version":"fabric.adapter/v1alpha2","adapter_id":"org.fixture.new-adapter","adapter_kind":"python","runner":{"module":"never_imported"},
            "settings_schema":{"type":"object","required":["mode"],"properties":{"mode":{"enum":["simple","advanced"]},"budget":{"type":"integer","minimum":1,"maximum":8}},"if":{"properties":{"mode":{"const":"advanced"}}},"then":{"required":["budget"]}},
            "model_schema":{"type":"object","properties":{"provider":{"const":"openai"},"model":{"pattern":"^fixture-"}},"required":["provider","model"]},
            "config":{"accepts":["models"]}}),
        }],
        runtime_files: Default::default(),
        runtime: None,
    }
}
fn config() -> serde_json::Value {
    json!({"schema_version":"fabric.agent/v1alpha1","metadata":{"name":"agent"},"harness":{"adapter_id":"org.fixture.new-adapter","settings":{"mode":"advanced","budget":4}},"runtime":{},"models":{"default":{"provider":"openai","model":"fixture-model"}}})
}

/// An image without the selected harness can never run it, so the image is
/// unsupported for the configuration rather than unverified.
#[test]
fn an_image_without_the_selected_adapter_is_unsupported_on_the_adapter_id() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut configuration = config();
    configuration["harness"]["adapter_id"] = "org.fixture.absent-adapter".into();
    let report = assess_fabric(
        &catalog(),
        &FabricRequirements {
            configuration,
            filesystem_read: None,
            provenance: Default::default(),
        },
    );
    assert_eq!(report.status, Support::Unsupported);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.status == Support::Unsupported
                && check.reason.starts_with("harness.adapter_id:")),
        "{:?}",
        report.checks
    );
}

#[test]
fn public_fabric_configuration_passes_through_without_overriding_deployment_bindings() {
    use nemoclaw_sdk::config::Document;
    let mut input: serde_json::Value =
        serde_saphyr::from_str(include_str!("fixtures/config/local.yaml")).unwrap();
    let agent = &mut input["spec"]["sandboxes"]["assistant"]["agent"];
    agent["mcp"] = json!({"servers":{"custom":{"transport":"stdio","url":"owned-fixture","exposure":"harness_native"}}});
    agent["skills"] = json!({"paths":["/sandbox/workspace/skills/supplied-skill"]});
    agent["tools"] = json!({"enabled":["read"],"blocked":["exec"]});
    let harness = &mut input["spec"]["sandboxes"]["assistant"]["harness"];
    harness["relay"] = json!({"plugins":{"dynamic":[{"manifest":"/plugins/example/relay-plugin.toml","config":{"mode":"route"}}]}});
    harness["telemetry"] = json!({"providers":{"relay":{}}});
    harness["runtime"] = json!({"max_turns":3,"timeout_seconds":900});
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    let actual =
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandbox("assistant").unwrap()).unwrap();
    assert_eq!(actual["runtime"]["max_turns"], 3);
    assert_eq!(actual["runtime"]["timeout_seconds"], 900);
    assert_eq!(actual["runtime"]["artifacts"], "/sandbox/artifacts");
    for (owner, section) in [
        ("agent", "mcp"),
        ("agent", "tools"),
        ("harness", "relay"),
        ("harness", "telemetry"),
    ] {
        assert_eq!(
            actual[section], input["spec"]["sandboxes"]["assistant"][owner][section],
            "{section} reaches Fabric unchanged"
        );
    }
    assert_eq!(
        actual["skills"], input["spec"]["sandboxes"]["assistant"]["agent"]["skills"],
        "skills must pass through without driverConfig"
    );
    input["spec"]["sandboxes"]["assistant"]["driverConfig"] = json!({"docker": {"mounts": [
        {"type": "volume", "source": "caller-workspace", "target": "/sandbox/workspace", "read_only": false}
    ]}});
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    let actual =
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandbox("assistant").unwrap()).unwrap();
    assert_eq!(
        actual["skills"], input["spec"]["sandboxes"]["assistant"]["agent"]["skills"],
        "workspace mounts must not add or replace skill paths"
    );
    input["spec"]["sandboxes"]["assistant"]["harness"]["runtime"]["artifacts"] =
        json!("/elsewhere");
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    assert!(
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandbox("assistant").unwrap()).is_err(),
        "an authored section cannot change a deployment-owned field"
    );
}

#[test]
fn a_different_fabric_revision_is_left_to_fabric() {
    // The image's own Fabric reports an incompatible runtime when the agent
    // starts; NemoClaw doesn't compare revisions.
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut catalog = catalog();
    catalog.fabric_revision = "0".repeat(40);
    let report = assess_fabric(
        &catalog,
        &FabricRequirements {
            configuration: config(),
            filesystem_read: None,
            provenance: Default::default(),
        },
    );
    assert_eq!(report.status, Support::Supported, "{report:?}");
    assert!(
        report
            .checks
            .iter()
            .all(|check| check.requirement != "fabric_contract")
    );
}

#[test]
fn explicit_filesystem_policy_must_allow_the_image_runtime_directory() {
    use nemoclaw_sdk::fabric_capabilities::{
        CapabilityCheck, FabricRequirements, Support, assess_fabric,
    };
    let mut catalog = catalog();
    catalog
        .runtime_files
        .insert("org.fixture.new-adapter".into(), vec!["/opt/hermes".into()]);
    let grants = |grants: Vec<&str>| FabricRequirements {
        configuration: config(),
        filesystem_read: Some(grants.into_iter().map(str::to_owned).collect()),
        provenance: Default::default(),
    };
    let report = assess_fabric(
        &catalog,
        &grants(vec!["/usr", "/opt/fabric", "/opt/nemoclaw"]),
    );
    assert_eq!(report.status, Support::Unsupported);
    assert!(report.checks.contains(&CapabilityCheck {
        requirement: "deployment_filesystem_grant".into(),
        status: Support::Unsupported,
        reason: "explicit filesystem policy must grant read access to /opt/hermes".into(),
    }));
    assert_eq!(
        assess_fabric(&catalog, &grants(vec!["/opt/hermes/web"])).status,
        Support::Unsupported
    );
    assert_eq!(
        assess_fabric(&catalog, &grants(vec!["/usr", "/opt"])).status,
        Support::Supported
    );
    let without_policy = FabricRequirements {
        configuration: config(),
        filesystem_read: None,
        provenance: Default::default(),
    };
    assert_eq!(
        assess_fabric(&catalog, &without_policy).status,
        Support::Supported
    );
}

/// Images run Fabric's own `fabric-agent-ctl`, which reports interface
/// mismatches itself, so compatibility needs no bridge record.
#[test]
fn image_compatibility_needs_no_bridge_record() {
    use nemoclaw_sdk::fabric_capabilities::{
        FabricRequirements, ImageMetadata, Support, assess_image,
    };
    let reference = format!("fixture@sha256:{}", "a".repeat(64));
    let image = ImageMetadata {
        repo_digests: vec![reference.clone()],
        ..Default::default()
    };
    let request = FabricRequirements {
        configuration: config(),
        filesystem_read: None,
        provenance: Default::default(),
    };
    let catalog = catalog();
    assert_eq!(
        assess_image(Some(&catalog), &request, &image, &reference, None, None).status,
        Support::Supported
    );
}

#[test]
fn relocated_image_runtime_read_requirements_replace_client_layout_assumptions() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut catalog = catalog();
    let mut runtime: serde_json::Value =
        serde_json::from_str(include_str!("../../../image/fabric/runtime.json")).unwrap();
    runtime["required_paths"] = json!(["/srv/runtime"]);
    runtime["binaries"] = json!({"org.fixture.new-adapter":["/srv/runtime/python3.99"]});
    catalog.runtime = Some(serde_json::from_value(runtime).unwrap());
    for (paths, expected) in [
        (
            vec!["/usr", "/opt/fabric", "/opt/nemoclaw"],
            Support::Unsupported,
        ),
        (vec!["/srv/runtime-other"], Support::Unsupported),
        (vec!["/srv/runtime/../other"], Support::Unsupported),
        (vec!["/srv"], Support::Supported),
        (vec!["/srv/runtime"], Support::Supported),
    ] {
        let report = assess_fabric(
            &catalog,
            &FabricRequirements {
                configuration: config(),
                filesystem_read: Some(paths.into_iter().map(String::from).collect()),
                provenance: Default::default(),
            },
        );
        assert_eq!(report.status, expected, "{:?}", report.checks);
    }
}

#[test]
fn explicit_filesystem_grants_reject_nul_in_required_paths_and_grants() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    for (path, grant) in [
        ("/opt/hermes\0private", "/opt"),
        ("/opt\0private/hermes", "/opt\0private"),
    ] {
        let mut catalog = catalog();
        catalog
            .runtime_files
            .insert("org.fixture.new-adapter".into(), vec![path.into()]);
        let report = assess_fabric(
            &catalog,
            &FabricRequirements {
                configuration: config(),
                filesystem_read: Some(vec![grant.into()]),
                provenance: Default::default(),
            },
        );
        assert_eq!(report.status, Support::Unsupported, "{path:?} in {grant:?}");
        assert!(report.checks.iter().any(|check| {
            check.requirement == "deployment_filesystem_grant"
                && check.status == Support::Unsupported
        }));
    }
}

/// Fabric decides whether an adapter accepts a configuration, and planning asks
/// it: a setting that its settings schema refuses fails the plan, naming the field.
#[test]
fn planning_reports_settings_the_adapters_schema_refuses() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut configuration = config();
    // The adapter's settings schema allows a budget of at most 8.
    configuration["harness"]["settings"]["budget"] = 9.into();
    let report = assess_fabric(
        &catalog(),
        &FabricRequirements {
            configuration,
            filesystem_read: None,
            provenance: Default::default(),
        },
    );
    assert_eq!(report.status, Support::Unsupported, "{:?}", report.checks);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.status == Support::Unsupported
                && check.reason.starts_with("harness.settings.budget:")),
        "{:?}",
        report.checks
    );
}

/// The interface checks of a report: the rejected setting paths, in order.
fn rejected_interfaces(
    catalog: &FabricCatalog,
    adapter_id: &str,
    interfaces: serde_json::Value,
) -> Vec<String> {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut configuration = config();
    configuration["harness"]["adapter_id"] = adapter_id.into();
    configuration["models"]["default"]["api_key_env"] = "FIXTURE_API_KEY".into();
    configuration["harness"]["settings"] = json!({ "interfaces": interfaces });
    if adapter_id == "org.fixture.new-adapter" {
        // The fixture's settings schema requires a mode.
        configuration["harness"]["settings"]["mode"] = "simple".into();
    }
    let report = assess_fabric(
        catalog,
        &FabricRequirements {
            configuration,
            filesystem_read: None,
            provenance: Default::default(),
        },
    );
    let rejected: Vec<String> = report
        .checks
        .iter()
        .filter(|check| check.status == Support::Unsupported)
        .map(|check| {
            assert_eq!(check.requirement, "fabric_configuration", "{check:?}");
            check
                .reason
                .split_once(':')
                .map(|(path, _)| path.to_owned())
                .unwrap_or_default()
        })
        .collect();
    assert_eq!(
        report.status == Support::Unsupported,
        !rejected.is_empty(),
        "{:?}",
        report.checks
    );
    rejected
}

/// The fixture adapter with an interface declaration like a P0 adapter's:
/// `dashboard`, taking `enabled` and `port`.
fn catalog_with_interfaces() -> FabricCatalog {
    let mut catalog = catalog();
    catalog.adapters[0].descriptor["settings_schema"]["properties"]["interfaces"] = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {"dashboard": {
            "type": "object",
            "additionalProperties": false,
            "required": ["port"],
            "properties": {
                "enabled": {"type": "boolean"},
                "port": {"type": "integer", "minimum": 1, "maximum": 65535}
            }
        }}
    });
    catalog
}

/// Planning rejects an interface or interface field that the image's adapter
/// doesn't declare, naming the setting, so the plan fails before apply.
#[test]
fn planning_rejects_interfaces_and_fields_the_adapter_does_not_declare() {
    let catalog = catalog_with_interfaces();
    let adapter = "org.fixture.new-adapter";
    assert!(
        rejected_interfaces(&catalog, adapter, json!({"dashboard": {"port": 9119}})).is_empty()
    );
    assert!(
        rejected_interfaces(
            &catalog,
            adapter,
            json!({"dashboard": {"enabled": false, "port": 9119}})
        )
        .is_empty()
    );
    assert_eq!(
        rejected_interfaces(&catalog, adapter, json!({"terminal": {}})),
        ["harness.settings.interfaces.terminal"]
    );
    // Fabric stops at the first refused setting, so each is tried alone.
    assert_eq!(
        rejected_interfaces(
            &catalog,
            adapter,
            json!({"dashboard": {"port": 9119, "public_origins": ["https://a.example"]}})
        ),
        ["harness.settings.interfaces.dashboard.public_origins"]
    );
    assert_eq!(
        rejected_interfaces(&catalog, adapter, json!({"api": {"port": 8642}})),
        ["harness.settings.interfaces.api"]
    );
}

/// Planning checks each interface against its own schema in the image's
/// descriptor: a missing required field, a wrong type or an out-of-range value
/// fails the plan, naming the field.
#[test]
fn planning_rejects_interface_values_their_schema_refuses() {
    let catalog = catalog_with_interfaces();
    let adapter = "org.fixture.new-adapter";
    let port = "harness.settings.interfaces.dashboard.port";
    for (interfaces, rejected) in [
        (json!({"dashboard": {}}), port),
        (json!({"dashboard": {"enabled": true}}), port),
        (json!({"dashboard": {"port": "9119"}}), port),
        (json!({"dashboard": {"port": 0}}), port),
        (json!({"dashboard": {"port": 65536}}), port),
        (
            json!({"dashboard": {"port": 9119, "enabled": "yes"}}),
            "harness.settings.interfaces.dashboard.enabled",
        ),
        (
            json!({"dashboard": true}),
            "harness.settings.interfaces.dashboard",
        ),
    ] {
        assert_eq!(
            rejected_interfaces(&catalog, adapter, interfaces.clone()),
            [rejected],
            "{interfaces}"
        );
    }
}

/// Settings that satisfy an interface's schema pass, including an interface,
/// such as a terminal, whose schema requires no field.
#[test]
fn interface_settings_their_schema_accepts_pass() {
    let mut catalog = catalog_with_interfaces();
    catalog.adapters[0].descriptor["settings_schema"]["properties"]["interfaces"]["properties"]["terminal"] = json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {"enabled": {"type": "boolean"}}
    });
    let adapter = "org.fixture.new-adapter";
    for interfaces in [
        json!({"dashboard": {"port": 9119}}),
        json!({"dashboard": {"port": 1, "enabled": false}}),
        json!({"terminal": {}}),
        json!({"terminal": {"enabled": true}, "dashboard": {"port": 65535}}),
    ] {
        assert!(
            rejected_interfaces(&catalog, adapter, interfaces.clone()).is_empty(),
            "{interfaces}"
        );
    }
}

/// A rejected value is never echoed: the reason names the field only.
#[test]
fn a_rejected_interface_value_is_not_echoed() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, assess_fabric};
    let mut configuration = config();
    configuration["harness"]["settings"] =
        json!({"interfaces": {"dashboard": {"port": "\u{1b}[31mPRIVATE"}}});
    configuration["harness"]["settings"]["mode"] = "simple".into();
    let report = assess_fabric(
        &catalog_with_interfaces(),
        &FabricRequirements {
            configuration,
            filesystem_read: None,
            provenance: Default::default(),
        },
    );
    let reasons: Vec<&str> = report
        .checks
        .iter()
        .map(|check| check.reason.as_str())
        .collect();
    assert!(
        reasons
            .iter()
            .any(|reason| reason.starts_with("harness.settings.interfaces.dashboard.port:")),
        "{reasons:?}"
    );
    assert!(
        reasons
            .iter()
            .all(|reason| !reason.contains("PRIVATE") && !reason.contains('\u{1b}')),
        "{reasons:?}"
    );
}

/// Conditions across settings, such as OpenClaw's port_range with a dashboard
/// port inside it, are Fabric's rules, and planning applies them.
#[test]
fn planning_applies_fabric_conditions_across_settings() {
    use nemoclaw_sdk::fabric_capabilities::{FabricRequirements, Support, assess_fabric};
    let mut configuration = config();
    configuration["harness"]["adapter_id"] = "nvidia.fabric.openclaw".into();
    configuration["harness"]["settings"] = json!({
        "port_range": {"start": 18789, "end": 18899},
        "interfaces": {"dashboard": {"port": 18789}}
    });
    let report = assess_fabric(
        &FabricCatalog::bundled(),
        &FabricRequirements {
            configuration,
            filesystem_read: None,
            provenance: Default::default(),
        },
    );
    assert_eq!(report.status, Support::Unsupported, "{:?}", report.checks);
}

/// A name that isn't safe to print is reported without echoing it.
#[test]
fn an_unsupported_interface_name_is_never_echoed_unsafely() {
    let rejected = rejected_interfaces(
        &catalog_with_interfaces(),
        "org.fixture.new-adapter",
        json!({"\u{1b}[31mPRIVATE": {}}),
    );
    assert_eq!(rejected, ["harness.settings.interfaces"]);
}

/// The bundled OpenClaw and Hermes adapters declare their P0 interfaces.
#[test]
fn the_bundled_adapters_accept_their_p0_interfaces_only() {
    let catalog = FabricCatalog::bundled();
    let openclaw = "nvidia.fabric.openclaw";
    let hermes = "nvidia.fabric.hermes";
    assert!(
        rejected_interfaces(
            &catalog,
            openclaw,
            json!({"dashboard": {"enabled": true, "port": 18789}})
        )
        .is_empty()
    );
    assert_eq!(
        rejected_interfaces(&catalog, openclaw, json!({"api": {"port": 8642}})),
        ["harness.settings.interfaces.api"]
    );
    assert!(
        rejected_interfaces(
            &catalog,
            hermes,
            json!({"api": {"port": 8642}, "dashboard": {"enabled": true, "port": 9119}})
        )
        .is_empty()
    );
    assert_eq!(
        rejected_interfaces(
            &catalog,
            hermes,
            json!({"dashboard": {"port": 9119, "public_origins": ["https://h.example"]}})
        ),
        ["harness.settings.interfaces.dashboard.public_origins"]
    );
    assert_eq!(
        rejected_interfaces(&catalog, "nvidia.fabric.pi", json!({"terminal": {}})),
        ["harness.settings.interfaces"]
    );
    // Each HTTP interface needs its exact port, within the adapter's range.
    for (adapter, interfaces, rejected) in [
        (
            hermes,
            json!({"api": {}}),
            "harness.settings.interfaces.api.port",
        ),
        (
            hermes,
            json!({"dashboard": {"enabled": true}}),
            "harness.settings.interfaces.dashboard.port",
        ),
        (
            openclaw,
            json!({"dashboard": {}}),
            "harness.settings.interfaces.dashboard.port",
        ),
        (
            openclaw,
            json!({"dashboard": {"port": 65426}}),
            "harness.settings.interfaces.dashboard.port",
        ),
        (
            hermes,
            json!({"api": {"port": "8642"}}),
            "harness.settings.interfaces.api.port",
        ),
    ] {
        assert_eq!(
            rejected_interfaces(&catalog, adapter, interfaces.clone()),
            [rejected],
            "{adapter} {interfaces}"
        );
    }
}

#[test]
fn agents_keep_their_state_where_the_adapter_accepts_it() {
    // Fabric gives every runtime of an agent one state folder when asked, and
    // rejects the request for an adapter that doesn't accept it, so the SDK asks
    // only where the descriptor accepts `runtime.keep_state`.
    let project = |text: &[u8]| {
        let doc = nemoclaw_sdk::config::Document::parse(text).unwrap();
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandboxes().next().unwrap()).unwrap()
    };
    let hermes = project(include_bytes!("../../../examples/fabric-hermes.yaml"));
    assert_eq!(hermes["runtime"]["keep_state"], true, "{hermes}");
    let openclaw = project(include_bytes!("../../../examples/openclaw.yaml"));
    assert_eq!(openclaw["runtime"]["keep_state"], true, "{openclaw}");
    let remote = project(include_bytes!("../../../examples/fabric-remote-agent.yaml"));
    assert!(remote["runtime"].get("keep_state").is_none(), "{remote}");
}

#[test]
fn generated_base_urls_go_only_to_adapters_that_accept_them() {
    // Fabric rejects a normalized field an adapter does not accept, so the SDK
    // sends its generated base URL only where the descriptor accepts one.
    let remote = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/fabric-remote-agent.yaml").as_slice(),
    )
    .unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&remote, remote.sandbox("assistant").unwrap())
            .unwrap();
    assert!(
        config["models"]["default"].get("base_url").is_none(),
        "{config}"
    );
    assert!(
        config["models"]["default"]["api_key_env"].is_string(),
        "{config}"
    );

    let openclaw = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/openclaw.yaml").as_slice(),
    )
    .unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&openclaw, openclaw.sandbox("assistant").unwrap())
            .unwrap();
    assert_eq!(
        config["models"]["default"]["base_url"],
        "https://inference.example.com/v1"
    );
}

#[test]
fn opencode_trusts_the_plain_http_model_hosts_the_deployment_names() {
    // Fabric's OpenCode adapter refuses a plain-HTTP model endpoint outside
    // loopback unless its harness settings list the host, so the deployment
    // lists the hosts of the endpoints it sends.
    let text = include_str!("../../../examples/fabric-opencode.yaml");
    let project = |text: &str| {
        let doc = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandboxes().next().unwrap()).unwrap()
    };
    let config = project(text);
    assert_eq!(
        config["models"]["default"]["base_url"],
        "http://172.20.0.1:11446/v1"
    );
    assert_eq!(
        config["harness"]["settings"]["insecure_http_model_hosts"],
        json!(["172.20.0.1"]),
        "{config}"
    );

    // An authored host stays beside the endpoint's.
    let authored = text.replace(
        "        kind: nvidia.fabric.opencode\n",
        "        kind: nvidia.fabric.opencode\n        settings:\n          insecure_http_model_hosts: [models.example.com]\n",
    );
    assert_ne!(authored, text);
    let config = project(&authored);
    assert_eq!(
        config["harness"]["settings"]["insecure_http_model_hosts"],
        json!(["models.example.com", "172.20.0.1"]),
        "{config}"
    );

    // An HTTPS endpoint needs no trust.
    let https = text.replace(
        "http://172.20.0.1:11446/v1",
        "https://inference.example.com/v1",
    );
    assert_ne!(https, text);
    let config = project(&https);
    assert_eq!(config["harness"]["settings"], json!({}), "{config}");

    // Pi declares the setting too, for its Relay gateway.
    let pi = project(include_str!("../../../examples/fabric-pi.yaml"));
    assert_eq!(
        pi["harness"]["settings"]["insecure_http_model_hosts"],
        json!(["172.20.0.1"]),
        "{pi}"
    );

    // Hermes declares no such setting, and Fabric rejects undeclared settings.
    let hermes = project(include_str!("../../../examples/fabric-hermes.yaml"));
    assert!(
        hermes["models"]["default"]["base_url"]
            .as_str()
            .is_some_and(|url| url.starts_with("http://")),
        "{hermes}"
    );
    assert_eq!(hermes["harness"]["settings"], json!({}), "{hermes}");
}

#[test]
fn openclaw_fetches_hosts_that_policy_dns_answers() {
    // OpenShell's policy DNS answers every name from 198.18.0.0/15 and decides
    // each connection itself; OpenClaw's fetch tools refuse that range unless
    // told it belongs to such a proxy.
    let text = include_str!("../../../examples/openclaw.yaml");
    let project = |text: &str| {
        let doc = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
        nemoclaw_sdk::fabric_config::for_sandbox(&doc, doc.sandboxes().next().unwrap()).unwrap()
    };
    let config = project(text);
    assert_eq!(
        config["harness"]["settings"]["tools"]["web"]["fetch"]["ssrfPolicy"],
        json!({"allowRfc2544BenchmarkRange": true}),
        "{config}"
    );

    // An authored value stays, beside the harness's other tools settings.
    let authored = text.replace(
        "        kind: nvidia.fabric.openclaw\n",
        "        kind: nvidia.fabric.openclaw\n        settings:\n          tools:\n            toolSearch: false\n            web:\n              fetch:\n                ssrfPolicy:\n                  allowRfc2544BenchmarkRange: false\n",
    );
    assert_ne!(authored, text);
    let config = project(&authored);
    assert_eq!(
        config["harness"]["settings"]["tools"],
        json!({"toolSearch": false, "web": {"fetch": {"ssrfPolicy": {"allowRfc2544BenchmarkRange": false}}}}),
        "{config}"
    );

    // Hermes declares no such setting, and Fabric rejects undeclared settings.
    let hermes = project(include_str!("../../../examples/fabric-hermes.yaml"));
    assert_eq!(hermes["harness"]["settings"], json!({}), "{hermes}");
}

#[test]
fn declared_model_extensions_get_the_provider_api_and_authored_fields() {
    // Pi declares `api`, `context_window`, and `max_tokens` as model extensions.
    let pi = nemoclaw_sdk::config::Document::parse(
        include_bytes!("../../../examples/fabric-pi.yaml").as_slice(),
    )
    .unwrap();
    let model = &nemoclaw_sdk::fabric_config::for_sandbox(&pi, pi.sandbox("assistant").unwrap())
        .unwrap()["models"]["default"];
    assert_eq!(model["api"], "openai-completions", "{model}");
    assert_eq!(model["context_window"], 32768, "{model}");
    assert_eq!(model["max_tokens"], 4096, "{model}");

    // OpenClaw declares a model `api` too, so it calls each provider with
    // the API the provider declares: an anthropic provider gets the Messages
    // API, which carries the key in x-api-key where OpenShell places it.
    let text = include_str!("../../../examples/openclaw.yaml");
    let openclaw = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&openclaw, openclaw.sandbox("assistant").unwrap())
            .unwrap();
    assert_eq!(
        config["models"]["default"]["api"], "openai-responses",
        "{config}"
    );
    let anthropic = text.replace(
        "      provider: openai\n      api: openai-responses\n",
        "      provider: anthropic\n      api: anthropic-messages\n",
    );
    assert_ne!(anthropic, text);
    let anthropic = nemoclaw_sdk::config::Document::parse(anthropic.as_bytes()).unwrap();
    let config = nemoclaw_sdk::fabric_config::for_sandbox(
        &anthropic,
        anthropic.sandbox("assistant").unwrap(),
    )
    .unwrap();
    assert_eq!(
        config["models"]["default"]["api"], "anthropic-messages",
        "{config}"
    );

    // Extensions cannot replace a field the deployment sets.
    let reserved = text.replace(
        "                maxTokens: 8192\n",
        "                maxTokens: 8192\n                extensions:\n                  base_url: https://elsewhere.example.com/v1\n",
    );
    assert_ne!(reserved, text);
    let reserved = nemoclaw_sdk::config::Document::parse(reserved.as_bytes()).unwrap();
    assert!(
        nemoclaw_sdk::fabric_config::for_sandbox(&reserved, reserved.sandbox("assistant").unwrap())
            .is_err()
    );
}

#[test]
fn routes_set_the_harness_provider_and_sampling() {
    let text = include_str!("../../../examples/openclaw.yaml");
    let plain = nemoclaw_sdk::config::Document::parse(text.as_bytes()).unwrap();
    let model =
        &nemoclaw_sdk::fabric_config::for_sandbox(&plain, plain.sandbox("assistant").unwrap())
            .unwrap()["models"]["default"];
    // Without them, the provider is the inference provider's API family and
    // no sampling is sent.
    assert_eq!(model["provider"], "openai", "{model}");
    assert!(model.get("temperature").is_none(), "{model}");
    assert!(model.get("top_p").is_none(), "{model}");

    let tuned = text.replace(
        "                maxTokens: 8192\n",
        "                maxTokens: 8192\n                harnessProvider: custom\n                temperature: 0.2\n                topP: 0.9\n",
    ).replace("example-reasoning-model", "example-reasoning-model:Q4_K_M");
    assert_ne!(tuned, text);
    let tuned = nemoclaw_sdk::config::Document::parse(tuned.as_bytes()).unwrap();
    let model =
        &nemoclaw_sdk::fabric_config::for_sandbox(&tuned, tuned.sandbox("assistant").unwrap())
            .unwrap()["models"]["default"];
    assert_eq!(model["provider"], "custom", "{model}");
    assert_eq!(model["model"], "example-reasoning-model:Q4_K_M", "{model}");
    assert_eq!(model["temperature"], 0.2, "{model}");
    assert_eq!(model["top_p"], 0.9, "{model}");
    assert_eq!(model["max_tokens"], 8192, "{model}");
}

/// A bundled adapter that accepts none of the tuning fields: Codex's descriptor
/// accepts only `models.base_url` among model fields and declares no model
/// extension. Pi's model extension declares `max_tokens`, which planning
/// accepts as a legacy extension field.
const NO_TUNING: &str = "nvidia.fabric.codex";

/// What planning reports as unsupported for the document's sandboxes: the
/// error that stops the queries from being built, or the reasons of every
/// unsupported check on the bundled catalog. Plan fails on either, before any
/// resource changes.
fn plan_rejections(input: &serde_json::Value) -> Vec<String> {
    use nemoclaw_sdk::{
        discovery::{DiscoveryQuery, plan_queries},
        fabric_capabilities::{Support, assess_fabric},
    };
    let document = nemoclaw_sdk::config::Document::parse(input.to_string().as_bytes()).unwrap();
    let queries = match plan_queries(&document) {
        Ok(queries) => queries,
        Err(error) => return vec![error.to_string()],
    };
    queries
        .into_iter()
        .filter_map(|query| match query {
            DiscoveryQuery::Fabric(request) => Some(request),
            _ => None,
        })
        .flat_map(|request| {
            assess_fabric(FabricCatalog::bundled_ref(), &request.requirements)
                .checks
                .into_iter()
                .filter(|check| check.status == Support::Unsupported)
                .map(|check| check.reason)
        })
        .collect()
}

/// The shipped example with its harness replaced.
fn example_with_harness(kind: &str) -> serde_json::Value {
    let mut input: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../examples/openclaw.yaml")).unwrap();
    input["spec"]["sandboxes"]["assistant"]["harness"]["kind"] = json!(kind);
    input
}

const ROUTE: &str = "spec.sandboxes[assistant].agent.inference.routes[primary]";

#[test]
fn planning_rejects_model_tuning_the_adapter_does_not_accept() {
    for (authored, value) in [
        ("maxTokens", json!(8192)),
        ("temperature", json!(0.2)),
        ("topP", json!(0.9)),
    ] {
        let mut input = example_with_harness(NO_TUNING);
        input["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"] =
            json!({"model":"test-model", authored:value});
        let rejections = plan_rejections(&input);
        assert!(
            rejections
                .iter()
                .any(|reason| reason.contains(&format!("{ROUTE}.overrides.{authored}"))),
            "{authored}: {rejections:?}"
        );
    }
}

#[test]
fn planning_rejects_extension_tuning_the_adapter_does_not_accept() {
    for (field, value) in [
        ("max_tokens", json!(8192)),
        ("temperature", json!(0.2)),
        ("top_p", json!(0.9)),
    ] {
        let mut input = example_with_harness(NO_TUNING);
        input["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"] =
            json!({"model":"test-model", "extensions": {field:value}});
        let rejections = plan_rejections(&input);
        assert!(
            rejections
                .iter()
                .any(|reason| reason.contains(&format!("{ROUTE}.overrides.extensions.{field}"))),
            "{field}: {rejections:?}"
        );
    }
}

#[test]
fn rejected_tuning_names_the_referenced_inference_definition() {
    for shared in [false, true] {
        let mut input = example_with_harness(NO_TUNING);
        let sandbox = &mut input["spec"]["sandboxes"]["assistant"];
        let mut inference = sandbox["agent"]
            .as_object_mut()
            .unwrap()
            .remove("inference")
            .unwrap();
        inference["routes"][0]["overrides"] = json!({"model":"test-model", "maxTokens":8192});
        sandbox["agent"]["inferenceRef"] = json!("shared");
        let expected = if shared {
            input["spec"]["inferences"]["shared"] = inference;
            "spec.inferences[shared].routes[primary].overrides.maxTokens"
        } else {
            sandbox["inferences"]["shared"] = inference;
            "spec.sandboxes[assistant].inferences[shared].routes[primary].overrides.maxTokens"
        };
        let rejections = plan_rejections(&input);
        assert!(
            rejections.iter().any(|reason| reason.contains(expected)),
            "{rejections:?}"
        );
    }
}

/// Codex's descriptor accepts neither `tools.enabled` nor `tools.blocked`.
#[test]
fn planning_rejects_tool_settings_the_adapter_does_not_accept() {
    let mut input = example_with_harness(NO_TUNING);
    input["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"] =
        json!({"model":"test-model"});
    input["spec"]["sandboxes"]["assistant"]["agent"]["tools"] = json!({"enabled": ["bash"]});
    let rejections = plan_rejections(&input);
    assert!(
        rejections
            .iter()
            .any(|reason| reason.contains("spec.sandboxes[assistant].agent.tools.enabled")),
        "{rejections:?}"
    );
}

/// OpenClaw declares no `api` interface.
#[test]
fn planning_names_the_authored_interface_setting_the_adapter_does_not_declare() {
    let mut input = example_with_harness("nvidia.fabric.openclaw");
    input["spec"]["sandboxes"]["assistant"]["harness"]["settings"] =
        json!({"interfaces": {"api": {"port": 8642}}});
    let rejections = plan_rejections(&input);
    assert!(
        rejections
            .iter()
            .any(|reason| reason
                .contains("spec.sandboxes[assistant].harness.settings.interfaces.api")),
        "{rejections:?}"
    );
}

#[test]
fn a_configuration_the_adapter_accepts_plans() {
    let mut input = example_with_harness("nvidia.fabric.openclaw");
    input["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"] =
        json!({"model":"test-model", "maxTokens":8192, "temperature":0.2});
    input["spec"]["sandboxes"]["assistant"]["agent"]["tools"] = json!({"enabled": ["read"]});
    input["spec"]["sandboxes"]["assistant"]["harness"]["settings"] =
        json!({"interfaces": {"dashboard": {"enabled": true, "port": 18789}}});
    assert_eq!(plan_rejections(&input), Vec::<String>::new());
}

#[test]
fn null_sampling_extensions_remain_unset_for_adapter_acceptance() {
    let mut input: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../examples/openclaw.yaml")).unwrap();
    input["spec"]["sandboxes"]["assistant"]["harness"]["kind"] = json!(NO_TUNING);
    input["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"] = json!({"model":"test-model", "extensions": {"max_tokens":null,"temperature":null,"top_p":null}});
    let document = nemoclaw_sdk::config::Document::parse(input.to_string().as_bytes()).unwrap();
    let config =
        nemoclaw_sdk::fabric_config::for_sandbox(&document, document.sandbox("assistant").unwrap())
            .expect("Fabric treats null optional sampling fields as unset");
    for field in ["max_tokens", "temperature", "top_p"] {
        assert!(config["models"]["primary"][field].is_null());
    }
}

/// Fabric refuses an invalid value before it checks the adapter; planning still
/// names the field the user wrote.
#[test]
fn planning_names_the_authored_field_of_an_invalid_model_value() {
    let mut input = example_with_harness("nvidia.fabric.openclaw");
    input["spec"]["sandboxes"]["assistant"]["agent"]["inference"]["routes"][0]["overrides"] =
        json!({"model":"test-model", "topP": 1.5});
    let rejections = plan_rejections(&input);
    assert!(
        rejections
            .iter()
            .any(|reason| reason.starts_with(&format!("{ROUTE}.overrides.topP:"))),
        "{rejections:?}"
    );
}

/// The NOOA example's sandbox, edited by `edit`, assessed against `catalog`:
/// each check's status and reason.
fn assess_nooa_example(
    catalog: &FabricCatalog,
    edit: impl FnOnce(&mut serde_json::Value),
) -> nemoclaw_sdk::fabric_capabilities::CompatibilityReport {
    use nemoclaw_sdk::config::Document;
    use nemoclaw_sdk::fabric_capabilities::{assess_fabric, requirements_for_sandbox};
    let mut input: serde_json::Value =
        serde_saphyr::from_str(include_str!("../../../examples/fabric-nooa.yaml")).unwrap();
    edit(&mut input["spec"]["sandboxes"]["assistant"]);
    let doc = Document::parse(input.to_string().as_bytes()).unwrap();
    let requirements = requirements_for_sandbox(&doc, doc.sandbox("assistant").unwrap()).unwrap();
    assess_fabric(catalog, &requirements)
}

fn unsupported_reasons(
    report: &nemoclaw_sdk::fabric_capabilities::CompatibilityReport,
) -> Vec<&str> {
    use nemoclaw_sdk::fabric_capabilities::Support;
    report
        .checks
        .iter()
        .filter(|check| check.status == Support::Unsupported)
        .map(|check| check.reason.as_str())
        .collect()
}

/// A sandbox with a workflow is checked like any other: NOOA's adapter takes
/// no `max_tokens`, so a route's `maxTokens` fails the plan, naming the route.
#[test]
fn planning_rejects_a_field_a_workflow_sandboxs_adapter_refuses() {
    use nemoclaw_sdk::fabric_capabilities::Support;
    let catalog = FabricCatalog::bundled();
    let unchanged = assess_nooa_example(&catalog, |_| {});
    assert_eq!(
        unchanged.status,
        Support::Supported,
        "{:?}",
        unchanged.checks
    );
    let report = assess_nooa_example(&catalog, |sandbox| {
        sandbox["agent"]["inference"]["routes"][0]["overrides"]["maxTokens"] = 64.into();
    });
    let reasons = unsupported_reasons(&report);
    assert!(
        reasons.iter().any(|reason| reason.starts_with(
            "spec.sandboxes[assistant].agent.inference.routes[primary].overrides.maxTokens:"
        )),
        "{reasons:?}"
    );
}

/// A workflow target the image doesn't register can't run, so the plan fails
/// on the field that selects it.
#[test]
fn planning_rejects_a_workflow_target_the_image_does_not_register() {
    let report = assess_nooa_example(&FabricCatalog::bundled(), |sandbox| {
        sandbox["agent"]["workflow"]["target_id"] = "nvidia.nooa.unregistered".into();
    });
    let reasons = unsupported_reasons(&report);
    assert!(
        reasons
            .iter()
            .any(|reason| reason.starts_with("spec.sandboxes[assistant].agent.workflow.target_id:")),
        "{reasons:?}"
    );
}

/// An image whose catalog records no workflow targets may predate them, so
/// its workflow is left to Fabric when the agent starts instead of failing.
#[test]
fn a_catalog_without_workflow_targets_leaves_the_workflow_unverified() {
    use nemoclaw_sdk::fabric_capabilities::Support;
    let mut catalog = FabricCatalog::bundled();
    catalog.targets.clear();
    let report = assess_nooa_example(&catalog, |_| {});
    assert_eq!(report.status, Support::Unknown, "{:?}", report.checks);
    assert!(
        report
            .checks
            .iter()
            .any(|check| check.status == Support::Unknown
                && check
                    .reason
                    .starts_with("spec.sandboxes[assistant].agent.workflow.target_id:")),
        "{:?}",
        report.checks
    );
}

/// A workflow on an adapter that takes no workflow targets fails the plan on
/// the target, rather than asking for an image that registers it.
#[test]
fn planning_rejects_a_workflow_on_an_adapter_that_takes_none() {
    let report = assess_nooa_example(&FabricCatalog::bundled(), |sandbox| {
        sandbox["harness"]["kind"] = "nvidia.fabric.nooa.bench-agent".into();
    });
    let reasons = unsupported_reasons(&report);
    assert_eq!(
        reasons,
        [
            "spec.sandboxes[assistant].agent.workflow.target_id: the selected adapter takes no workflow targets"
        ],
        "{:?}",
        report.checks
    );
}

/// Whether a catalog predates workflow targets is decided per adapter: an
/// image that registers targets only for other adapters leaves this one's
/// workflow unverified.
#[test]
fn targets_of_other_adapters_leave_the_workflow_unverified() {
    use nemoclaw_sdk::fabric_capabilities::Support;
    let mut catalog = FabricCatalog::bundled();
    for target in &mut catalog.targets {
        target["descriptor"]["adapter_id"] = "org.fixture.other-adapter".into();
    }
    let report = assess_nooa_example(&catalog, |_| {});
    assert_eq!(report.status, Support::Unknown, "{:?}", report.checks);
}
