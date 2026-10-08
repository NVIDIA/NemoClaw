// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Image-owned launch and executable metadata, independent of Fabric
//! descriptors, and the sandbox policy a retained image layout grants.
use crate::policy::{ExplicitPolicy, PolicyBinary, PolicyRule};
use nemoclaw_backend::ObservationError;
use openshell_sdk::raw::proto;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ImageRuntime {
    pub schema_version: u32,
    /// Prefix prepended to a packaged bridge operation.
    pub command: Vec<String>,
    pub environment: BTreeMap<String, String>,
    pub required_paths: Vec<String>,
    pub policy: ExplicitPolicy,
    /// Resolved host interpreter and descriptor-required executables for each installed adapter.
    pub binaries: BTreeMap<String, Vec<String>>,
}

fn absolute(path: &str) -> bool {
    path.starts_with('/') && !path.contains('\0') && !path.split('/').any(|part| part == "..")
}

/// Check lexical containment under Linux sandbox grants on every client platform.
/// Callers select the grants that allow the required read or write access.
pub fn path_is_granted(path: &str, grants: &[String]) -> bool {
    absolute(path)
        && grants.iter().any(|grant| {
            if !absolute(grant) {
                return false;
            }
            let mut required = path
                .split('/')
                .filter(|part| !part.is_empty() && *part != ".");
            grant
                .split('/')
                .filter(|part| !part.is_empty() && *part != ".")
                .all(|part| required.next() == Some(part))
        })
}

impl ImageRuntime {
    /// Whether the launch command, environment, paths, policy, and executables are well formed.
    pub fn valid_layout(&self) -> bool {
        self.schema_version == 1
            && self.command.first().is_some_and(|path| absolute(path))
            && self
                .command
                .iter()
                .all(|part| !part.is_empty() && !part.contains('\0'))
            && self.environment.iter().all(|(key, value)| {
                !key.is_empty()
                    && !key.contains(['=', '\0'])
                    && !value.contains('\0')
                    && !matches!(
                        key.as_str(),
                        "NEMOCLAW_AGENT_NAME" | "NEMOCLAW_PROVIDER_NAMES"
                    )
            })
            && self
                .environment
                .get("ADAPTER_PYTHON")
                .is_some_and(|path| absolute(path))
            && !self.required_paths.is_empty()
            && self.required_paths.iter().all(|path| absolute(path))
            && self.policy.to_proto().is_ok_and(|policy| {
                policy.filesystem.is_some()
                    && policy.process.is_some()
                    && policy.network_policies.is_empty()
                    && policy.network_middlewares.is_empty()
            })
            && self
                .binaries
                .values()
                .all(|paths| !paths.is_empty() && paths.iter().all(|path| absolute(path)))
    }
}

/// Observed image layout retained with its sandbox for refresh and teardown.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RuntimeBinding {
    pub runtime: Box<ImageRuntime>,
    pub adapter_id: String,
}

/// Authored policy and deployment-owned endpoint grants before image resolution.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyInput {
    pub explicit: Option<ExplicitPolicy>,
    pub managed: BTreeMap<String, PolicyRule>,
}
impl RuntimeBinding {
    pub fn from_json(encoded: &str) -> Result<Self, ObservationError> {
        let binding: Self =
            serde_json::from_str(encoded).map_err(|_| ObservationError::Incomplete)?;
        if !binding.runtime.valid_layout()
            || !binding.runtime.binaries.contains_key(&binding.adapter_id)
        {
            return Err(ObservationError::Incomplete);
        }
        Ok(binding)
    }
    pub fn command(&self, operation: &str, arguments: &[&str]) -> Vec<String> {
        self.runtime
            .command
            .iter()
            .cloned()
            .chain(std::iter::once(operation.into()))
            .chain(arguments.iter().map(|value| (*value).into()))
            .collect()
    }
    pub fn environment(&self, name: &str) -> BTreeMap<String, String> {
        let mut environment = self.runtime.environment.clone();
        environment.insert("NEMOCLAW_AGENT_NAME".into(), name.into());
        environment
    }
    pub fn binaries(&self) -> &[String] {
        &self.runtime.binaries[&self.adapter_id]
    }
    pub fn policy(&self, input: &PolicyInput) -> Result<proto::SandboxPolicy, ObservationError> {
        let mut policy = input
            .explicit
            .as_ref()
            .unwrap_or(&self.runtime.policy)
            .clone();
        let binaries = self
            .runtime
            .binaries
            .get(&self.adapter_id)
            .ok_or(ObservationError::Incomplete)?;
        for (name, rule) in &input.managed {
            if policy.network_policies.contains_key(name) {
                return Err(ObservationError::BindingMismatch);
            }
            let mut rule = rule.clone();
            rule.binaries = binaries
                .iter()
                .map(|path| PolicyBinary { path: path.clone() })
                .collect();
            policy.network_policies.insert(name.clone(), rule);
        }
        policy.to_proto().map_err(|_| ObservationError::Incomplete)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn sandbox_paths_use_linux_grant_components_on_every_client_platform() {
        for (path, grant, expected) in [
            ("/sandbox", "/sandbox", true),
            ("/work/tmp", "/work", true),
            ("/work/./tmp/", "/work//.", true),
            ("/work", "/", true),
            ("/", "//./", true),
            ("/work/..cache", "/work", true),
            (r"/work\tmp", r"/work\tmp", true),
            ("/work", "/work/tmp", false),
            ("/work-other", "/work", false),
            ("/work/../elsewhere", "/work", false),
            ("/work/..", "/", false),
            ("/work", "/other/../work", false),
            ("work", "/", false),
            ("/work", "work", false),
            ("", "/", false),
            ("/work", "", false),
            (r"C:\work", r"C:\work", false),
            (r"\\server\work", "/", false),
            (r"/work\tmp", "/work", false),
            ("/work\0file", "/work", false),
            ("/work", "/work\0", false),
            ("/work\0", "/work\0", false),
        ] {
            assert_eq!(
                path_is_granted(path, &[grant.into()]),
                expected,
                "{path:?} in {grant:?}"
            );
        }
        assert!(!path_is_granted("/work", &[]));
        assert!(path_is_granted(
            "/work/file",
            &["/work\0".into(), "relative".into(), "/work".into()]
        ));
    }

    #[test]
    fn retained_image_layout_controls_launch_user_and_managed_executables() {
        let binding = RuntimeBinding::from_json(&serde_json::json!({
            "adapter_id":"org.fixture.bun", "runtime":{
                "schema_version":1,"command":["/srv/python3.99","-I","/srv/bridge.py"],
                "environment":{"ADAPTER_PYTHON":"/srv/python3.99","HOME":"/work","PATH":"/srv"},
                "required_paths":["/srv"],
                "policy":{"version":1,"filesystem_policy":{"read_only":["/srv"],"read_write":["/work"]},"process":{"run_as_user":"1234","run_as_group":"1234"},"network_policies":{}},
                "binaries":{"org.fixture.bun":["/srv/python3.99","/srv/bun"]}
            }
        }).to_string()).unwrap();
        assert_eq!(
            binding.command("configure", &["main", "{}"]),
            [
                "/srv/python3.99",
                "-I",
                "/srv/bridge.py",
                "configure",
                "main",
                "{}"
            ]
        );
        assert_eq!(binding.environment("main")["HOME"], "/work");
        assert_eq!(binding.environment("main")["NEMOCLAW_AGENT_NAME"], "main");
        let input: PolicyInput = serde_json::from_value(serde_json::json!({"explicit":null,"managed":{"model":{"name":"model","endpoints":[{"host":"api.example.com","port":443}],"binaries":[]}}})).unwrap();
        let policy = binding.policy(&input).unwrap();
        assert_eq!(policy.process.unwrap().run_as_user, "1234");
        assert_eq!(policy.filesystem.unwrap().read_write, ["/work"]);
        assert_eq!(
            policy.network_policies["model"]
                .binaries
                .iter()
                .map(|binary| binary.path.as_str())
                .collect::<Vec<_>>(),
            ["/srv/python3.99", "/srv/bun"]
        );
        let mut explicit = input;
        explicit.explicit = Some(serde_json::from_value(serde_json::json!({"version":1,"filesystem_policy":{"read_only":["/srv"],"read_write":["/mine"]},"process":{"run_as_user":"4321","run_as_group":"4321"},"network_policies":{}})).unwrap());
        let policy = binding.policy(&explicit).unwrap();
        assert_eq!(policy.process.unwrap().run_as_user, "4321");
        assert_eq!(policy.filesystem.unwrap().read_write, ["/mine"]);
        assert!(RuntimeBinding::from_json("{}").is_err());
    }
}
