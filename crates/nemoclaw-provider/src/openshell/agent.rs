// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_sdk::backend::Row;

/// Fixed bridge interface packaged by image/fabric/Dockerfile.
pub(super) fn fabric_command(arguments: &[&str]) -> Vec<String> {
    ["/opt/fabric/bin/python", "/opt/nemoclaw/fabric.py"]
        .into_iter()
        .chain(arguments.iter().copied())
        .map(String::from)
        .collect()
}

pub fn command(runtime: &str) -> Vec<String> {
    if runtime == "fabric" {
        fabric_command(&["serve"])
    } else {
        Vec::new()
    }
}

pub fn environment(name: &str, runtime: &str) -> Row {
    if runtime == "fabric" {
        let env: Row = [
            ("ADAPTER_PYTHON", "/opt/fabric/bin/python"),
            ("HOME", "/sandbox"),
            ("TMPDIR", "/sandbox/tmp"),
            ("XDG_CACHE_HOME", "/sandbox/.cache"),
            ("NEMOCLAW_AGENT_NAME", name),
            ("NEMOCLAW_ANONYMOUS_API_KEY", "unused"),
            ("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt"),
            ("NODE_EXTRA_CA_CERTS", "/etc/ssl/certs/ca-certificates.crt"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("PATH", "/opt/fabric/bin:/usr/local/bin:/usr/bin:/bin"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        return env;
    }
    Row::new()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn runtime_launch_has_no_native_adapter_selector() {
        let env = environment("main", "fabric");
        assert!(!env.contains_key("NEMOCLAW_FABRIC_HARNESS"));
        assert!(!env.contains_key("NEMOCLAW_FABRIC_ADAPTER_ID"));
        assert_eq!(
            command("fabric"),
            ["/opt/fabric/bin/python", "/opt/nemoclaw/fabric.py", "serve"]
        );
        assert!(command("fabric-pi").is_empty());
    }
}
