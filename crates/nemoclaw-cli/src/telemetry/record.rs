// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The 5.0 record as Rust types. Every closed list of words is an enum with
//! `other`, and the JSON schema is generated from these types, so the code and
//! the schema cannot drift.

use schemars::JsonSchema;
use serde::Serialize;
use std::collections::BTreeSet;

/// A lowercase random UUID (v4), or `unknown` when the install ID file cannot be written.
pub const INSTALL_ID_PATTERN: &str =
    "^(?:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|unknown)$";
/// Empty, or `qa-<run>:<case>:attempt-<n>`, the rule NemoClaw Classic uses.
pub const TEST_LABEL_PATTERN: &str =
    "^(?:|qa-[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,39}:attempt-[1-9][0-9]{0,2})$";

/// Whether `value` matches one of the patterns above.
pub fn matches(pattern: &str, value: &str) -> bool {
    regex::Regex::new(pattern).is_ok_and(|regex| regex.is_match(value))
}

/// One finished `apply`, `destroy`, or configuration-writing `onboard`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
#[schemars(deny_unknown_fields, title = "nemoclaw_deployment_finished")]
pub struct Record {
    pub nvidia_source: NvidiaSource,
    #[schemars(regex(pattern = INSTALL_ID_PATTERN))]
    pub install_id: String,
    pub first_run: bool,
    #[schemars(length(max = 96), regex(pattern = TEST_LABEL_PATTERN))]
    pub test_label: String,
    pub build_kind: BuildKind,
    #[schemars(length(max = 128))]
    pub version: String,
    #[schemars(length(max = 128))]
    pub previous_version: String,
    pub operation: Operation,
    pub outcome: Outcome,
    pub effect: Effect,
    pub failure_stage: FailureStage,
    pub duration_ms: u64,
    pub os: Os,
    pub arch: Arch,
    pub host_context: HostContext,
    pub deployment_source: DeploymentSource,
    pub cloud: Cloud,
    pub hardware: Hardware,
    /// A set, so the list is sent sorted with no duplicates.
    #[schemars(inner(length(max = 64)))]
    pub harnesses: BTreeSet<String>,
    #[schemars(inner(length(max = 64)))]
    pub models: BTreeSet<String>,
    pub inference_hosts: BTreeSet<InferenceHost>,
    pub compute_driver: ComputeDriver,
    pub sandbox_count: u64,
    pub agent_count: u64,
    pub web_search: WebSearch,
    pub mcp_configured: bool,
}

/// Declares a closed list of words. Variants are in the order the words sort,
/// so a set of them is sent sorted.
macro_rules! words {
    ($name:ident { $($variant:ident = $word:literal),+ $(,)? }) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, JsonSchema)]
        pub enum $name {
            $(#[serde(rename = $word)] $variant),+
        }
    };
}

words!(NvidiaSource { Nemoclaw = "nemoclaw" });
words!(BuildKind { Dev = "dev", Other = "other", Release = "release" });
words!(Operation { Apply = "apply", Destroy = "destroy", Onboard = "onboard", Other = "other" });
words!(Outcome { Cancelled = "cancelled", Failed = "failed", Other = "other", Succeeded = "succeeded" });
words!(Effect {
    Authored = "authored",
    Initial = "initial",
    None = "none",
    Other = "other",
    Teardown = "teardown",
    Update = "update",
});
words!(FailureStage {
    Apply = "apply",
    Destroy = "destroy",
    Finish = "finish",
    Initialize = "initialize",
    None = "none",
    Other = "other",
    Plan = "plan",
    Validate = "validate",
});
words!(Os { Linux = "linux", Macos = "macos", Other = "other", Windows = "windows" });
words!(Arch { Arm64 = "arm64", Other = "other", X86_64 = "x86_64" });
words!(HostContext { Native = "native", Other = "other", Unknown = "unknown", Wsl = "wsl" });
words!(DeploymentSource {
    Brev = "brev",
    Colossus = "colossus",
    None = "none",
    Omnistation = "omnistation",
    Other = "other",
});
words!(Cloud { Aws = "aws", Azure = "azure", Gcp = "gcp", None = "none", Other = "other", Unknown = "unknown" });
words!(Hardware {
    DgxSpark = "dgx-spark",
    DgxStation = "dgx-station",
    Jetson = "jetson",
    Mac = "mac",
    NvidiaGpu = "nvidia-gpu",
    Other = "other",
    RtxSpark = "rtx-spark",
    Unknown = "unknown",
});
words!(InferenceHost {
    Anthropic = "anthropic",
    BuildNvidiaCom = "build.nvidia.com",
    InferenceNvidiaCom = "inference.nvidia.com",
    Local = "local",
    Openai = "openai",
    Other = "other",
});
words!(ComputeDriver {
    Docker = "docker",
    Kubernetes = "kubernetes",
    Openshift = "openshift",
    Other = "other",
    Podman = "podman",
    Unknown = "unknown",
});
words!(WebSearch { Brave = "brave", None = "none", Other = "other", Tavily = "tavily", Unknown = "unknown" });

/// The record's `version` and `buildKind` from the bundle version stamp.
pub fn build() -> (&'static str, BuildKind) {
    build_of(option_env!("NEMOCLAW_BUNDLE_VERSION"))
}

/// The rule of `build_kind` in `nemoclaw-build`: a pre-release part (a `-`
/// before any `+`) is `dev`. A build without a stamp is `dev` too.
fn build_of(stamp: Option<&'static str>) -> (&'static str, BuildKind) {
    match stamp {
        Some(version) if !version.split('+').next().unwrap_or_default().contains('-') => {
            (version, BuildKind::Release)
        }
        Some(version) => (version, BuildKind::Dev),
        None => (env!("CARGO_PKG_VERSION"), BuildKind::Dev),
    }
}

/// The record's JSON schema (draft-07, every type inlined), generated from [`Record`].
pub fn schema() -> serde_json::Value {
    schemars::generate::SchemaSettings::draft07()
        .with(|settings| settings.inline_subschemas = true)
        .into_generator()
        .into_root_schema_for::<Record>()
        .to_value()
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use serde_json::{Value, json};

    /// The schema registered with the collector in TEST on 2026-11-20.
    fn registered() -> Value {
        serde_json::from_str(include_str!("registered-schema-5.0.json")).unwrap()
    }

    fn registered_event() -> Value {
        registered()["definitions"]["events"]["nemoclaw_deployment_finished"].clone()
    }

    /// A succeeded `apply` with every field read.
    pub fn sample() -> Record {
        Record {
            nvidia_source: NvidiaSource::Nemoclaw,
            install_id: "0f8fad5b-d9cb-469f-a165-70867728950e".into(),
            first_run: true,
            test_label: "qa-1120a:onboard-hermes:attempt-2".into(),
            build_kind: BuildKind::Release,
            version: "1.0.0-412".into(),
            previous_version: "none".into(),
            operation: Operation::Apply,
            outcome: Outcome::Succeeded,
            effect: Effect::Initial,
            failure_stage: FailureStage::None,
            duration_ms: 51_200,
            os: Os::Linux,
            arch: Arch::Arm64,
            host_context: HostContext::Native,
            deployment_source: DeploymentSource::Brev,
            cloud: Cloud::Gcp,
            hardware: Hardware::DgxSpark,
            harnesses: ["openclaw".to_string(), "other".to_string()].into(),
            models: ["nvidia/nemotron-3-super-120b-a12b".to_string()].into(),
            inference_hosts: [InferenceHost::Local, InferenceHost::BuildNvidiaCom].into(),
            compute_driver: ComputeDriver::Docker,
            sandbox_count: 2,
            agent_count: 3,
            web_search: WebSearch::None,
            mcp_configured: false,
        }
    }

    /// Records that between them use every word of every closed list.
    fn every_word() -> Vec<Value> {
        let event = registered_event();
        (0..8)
            .map(|index| {
                let mut value = serde_json::to_value(sample()).unwrap();
                for (field, words) in event["properties"].as_object().unwrap() {
                    if let Some(words) = words["enum"].as_array() {
                        value[field] = words[index % words.len()].clone();
                    }
                }
                let hosts = event["properties"]["inferenceHosts"]["items"]["enum"].clone();
                value["inferenceHosts"] = json!([hosts[index % 6]]);
                value
            })
            .collect()
    }

    #[test]
    fn only_a_stamped_version_without_pre_release_is_a_release() {
        assert_eq!(build_of(Some("1.0.0")), ("1.0.0", BuildKind::Release));
        assert_eq!(build_of(Some("1.0.0+abc")).1, BuildKind::Release);
        for dev in [
            "1.0.0-rc.1",
            "1.0.0-8700",
            "1.0.0-rc.1.8870",
            "1.0.0-dev.1a2b3c",
        ] {
            assert_eq!(build_of(Some(dev)), (dev, BuildKind::Dev));
        }
        assert_eq!(build_of(None), (env!("CARGO_PKG_VERSION"), BuildKind::Dev));
    }

    #[test]
    fn records_validate_against_the_generated_and_registered_schemas() {
        let generated = jsonschema::validator_for(&schema()).unwrap();
        let registered = jsonschema::validator_for(&registered()).unwrap();
        let mut records = every_word();
        records.push(serde_json::to_value(sample()).unwrap());
        let mut unread = sample();
        (unread.install_id, unread.test_label) = ("unknown".into(), String::new());
        (unread.harnesses, unread.models, unread.inference_hosts) = Default::default();
        records.push(serde_json::to_value(unread).unwrap());
        for record in records {
            assert!(generated.is_valid(&record), "generated rejects {record}");
            assert!(registered.is_valid(&record), "registered rejects {record}");
        }
    }

    #[test]
    fn generated_schema_holds_every_registered_rule() {
        let generated = schema();
        let event = registered_event();
        let required = |schema: &Value| {
            let mut fields: Vec<_> = schema["required"].as_array().unwrap().clone();
            fields.sort_by_key(|field| field.to_string());
            fields
        };
        assert_eq!(required(&generated), required(&event));
        assert_eq!(generated["additionalProperties"], json!(false));
        let generated = generated["properties"].as_object().unwrap();
        let registered = event["properties"].as_object().unwrap();
        assert_eq!(
            generated.keys().collect::<Vec<_>>(),
            registered.keys().collect::<Vec<_>>()
        );
        for (field, rules) in registered {
            for (rule, value) in rules.as_object().unwrap() {
                let ours = &generated[field][rule];
                if rule == "items" {
                    for (rule, value) in value.as_object().unwrap() {
                        assert_same(&ours[rule], value, field);
                    }
                } else {
                    assert_same(ours, value, field);
                }
            }
        }
    }

    /// Equal, treating an `enum` list as a set.
    fn assert_same(ours: &Value, theirs: &Value, field: &str) {
        let set = |value: &Value| match value.as_array() {
            Some(words) => words.iter().map(Value::to_string).collect::<BTreeSet<_>>(),
            None => [value.to_string()].into(),
        };
        assert_eq!(set(ours), set(theirs), "{field}");
    }

    #[test]
    fn schema_rejects_free_text_and_extra_fields() {
        let generated = jsonschema::validator_for(&schema()).unwrap();
        let mut record = serde_json::to_value(sample()).unwrap();
        for (field, bad) in [
            ("testLabel", json!("qa-/home/user:case:attempt-1")),
            ("installId", json!("ABC")),
            ("cloud", json!("oracle")),
            ("models", json!(["x".repeat(65)])),
            ("inferenceHosts", json!(["10.0.0.1"])),
        ] {
            let good = std::mem::replace(&mut record[field], bad);
            assert!(!generated.is_valid(&record), "{field}");
            record[field] = good;
        }
        record["hostName"] = json!("box");
        assert!(!generated.is_valid(&record));
    }
}
