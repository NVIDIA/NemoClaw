// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
use super::*;
pub(super) const PROVIDERS_ENV: &str = "NEMOCLAW_PROVIDER_NAMES";

/// The registrations a sandbox attaches; an omitted list attaches none.
pub(super) fn provider_names(text: &str) -> Result<Vec<String>, ObservationError> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let names: Vec<String> = serde_json::from_str(text).map_err(|_| ObservationError::Query)?;
    let unique: std::collections::BTreeSet<_> = names.iter().collect();
    if names.len() > 128
        || unique.len() != names.len()
        || names
            .iter()
            .any(|name| !nemoclaw_openshell::valid_name(name))
    {
        return Err(ObservationError::Query);
    }
    Ok(names)
}

pub(super) fn inference_environment(row: &Row) -> Result<Row, ObservationError> {
    let text = row
        .get("provider_names_json")
        .map(String::as_str)
        .unwrap_or("");
    provider_names(text)?;
    let mut env = agent::launch(row)?.environment;
    // Record the attachment list as written, so it reads back unchanged; an
    // omitted list leaves nothing to record.
    if !text.is_empty() {
        env.insert(PROVIDERS_ENV.into(), text.into());
    }
    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_attachments_are_deployment_references_not_fabric_transports() {
        assert_eq!(
            provider_names(r#"["owned-registration"]"#).unwrap(),
            ["owned-registration"]
        );
        for invalid in [
            r#"["duplicate","duplicate"]"#,
            r#"["bad name"]"#,
            r#"{"provider":"openai"}"#,
        ] {
            assert!(provider_names(invalid).is_err());
        }
    }

    #[test]
    fn a_sandbox_may_attach_no_providers() {
        // Omitted and empty both attach nothing.
        assert!(provider_names("").unwrap().is_empty());
        assert!(provider_names("[]").unwrap().is_empty());
        let launch = r#"{"command":["/usr/local/bin/fabric-agent","serve","--agent","assistant"],"environment":{"ADAPTER_PYTHON":"/opt/fabric/bin/python","HOME":"/sandbox","NEMOCLAW_ANONYMOUS_API_KEY":"unused","NODE_EXTRA_CA_CERTS":"/etc/ssl/certs/ca-certificates.crt","PATH":"/opt/fabric/bin:/usr/local/bin:/usr/bin:/bin","PYTHONDONTWRITEBYTECODE":"1","SSL_CERT_FILE":"/etc/ssl/certs/ca-certificates.crt","TMPDIR":"/sandbox/tmp","XDG_CACHE_HOME":"/sandbox/.cache","NEMOCLAW_AGENT_NAME":"assistant"},"policy":{"version":1,"filesystem_policy":{"include_workdir":false,"read_only":["/usr","/bin","/sbin","/lib","/lib64","/etc","/app","/opt","/proc"],"read_write":["/sandbox","/tmp","/dev/null","/dev/urandom","/home/node"]},"landlock":{"compatibility":"best_effort"},"process":{"run_as_user":"10001","run_as_group":"10001"},"network_policies":{}},"binaries":["/usr/local/bin/python3.99"],"metadata":{"nemoclaw.nvidia.com/agent":"assistant","nemoclaw.nvidia.com/agent-runtime":"fabric","nemoclaw.nvidia.com/runtime":"{\"runtime\":{\"schema_version\":1,\"command\":[\"/usr/local/bin/fabric-agent\"],\"environment\":{\"ADAPTER_PYTHON\":\"/opt/fabric/bin/python\",\"HOME\":\"/sandbox\",\"NEMOCLAW_ANONYMOUS_API_KEY\":\"unused\",\"NODE_EXTRA_CA_CERTS\":\"/etc/ssl/certs/ca-certificates.crt\",\"PATH\":\"/opt/fabric/bin:/usr/local/bin:/usr/bin:/bin\",\"PYTHONDONTWRITEBYTECODE\":\"1\",\"SSL_CERT_FILE\":\"/etc/ssl/certs/ca-certificates.crt\",\"TMPDIR\":\"/sandbox/tmp\",\"XDG_CACHE_HOME\":\"/sandbox/.cache\"},\"required_paths\":[\"/opt/fabric\",\"/opt/nemoclaw\"],\"policy\":{\"version\":1,\"filesystem_policy\":{\"include_workdir\":false,\"read_only\":[\"/usr\",\"/bin\",\"/sbin\",\"/lib\",\"/lib64\",\"/etc\",\"/app\",\"/opt\",\"/proc\"],\"read_write\":[\"/sandbox\",\"/tmp\",\"/dev/null\",\"/dev/urandom\",\"/home/node\"]},\"landlock\":{\"compatibility\":\"best_effort\"},\"process\":{\"run_as_user\":\"10001\",\"run_as_group\":\"10001\"},\"network_policies\":{}},\"binaries\":{\"nvidia.fabric.pi\":[\"/usr/local/bin/python3.99\"]}},\"adapter_id\":\"nvidia.fabric.pi\"}"}}"#;
        let row = |providers: Option<&str>| {
            let mut row = Row::from([("launch_json".into(), launch.into())]);
            if let Some(providers) = providers {
                row.insert("provider_names_json".into(), providers.into());
            }
            row
        };
        // Without providers, no record of them is added to the environment,
        // so reading the sandbox back reports none.
        assert!(
            !inference_environment(&row(None))
                .unwrap()
                .contains_key(PROVIDERS_ENV)
        );
        // An explicit list, empty or not, is recorded as written.
        assert_eq!(
            inference_environment(&row(Some("[]"))).unwrap()[PROVIDERS_ENV],
            "[]"
        );
    }
}
