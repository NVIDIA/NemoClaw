// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::backend::Row;
use openshell_core::proto;
use serde_json::json;

pub fn command(runtime: &str) -> Vec<String> {
    if runtime.starts_with("fabric-") {
        vec![
            "/opt/fabric/bin/python".into(),
            "/opt/nemoclaw/fabric.py".into(),
            "serve".into(),
        ]
    } else {
        vec!["node".into(), "-e".into(), BOOTSTRAP.into()]
    }
}
pub fn environment(name: &str, runtime: &str) -> Row {
    if let Some(harness) = runtime.strip_prefix("fabric-") {
        let mut env: Row = [
            ("ADAPTER_PYTHON", "/opt/fabric/bin/python"),
            ("HOME", "/sandbox"),
            ("TMPDIR", "/sandbox/tmp"),
            ("XDG_CACHE_HOME", "/sandbox/.cache"),
            ("NEMOCLAW_AGENT_NAME", name),
            ("OPENAI_API_KEY", "openshell-placeholder"),
            ("SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt"),
            ("NODE_EXTRA_CA_CERTS", "/etc/ssl/certs/ca-certificates.crt"),
            ("PYTHONDONTWRITEBYTECODE", "1"),
            ("PATH", "/opt/fabric/bin:/usr/local/bin:/usr/bin:/bin"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect();
        if harness != "deepagents" {
            env.insert("NEMOCLAW_FABRIC_HARNESS".into(), harness.into());
        }
        if harness == "openclaw" {
            env.insert("PYTHONPATH".into(), "/opt/nemoclaw".into());
        }
        if harness == "mini-swe-agent" {
            env.insert("MSWEA_COST_TRACKING".into(), "ignore_errors".into());
        }
        return env;
    }
    let config = json!({
        "gateway":{"mode":"local","bind":"loopback","port":18789,"auth":{"mode":"none"},"controlUi":{"enabled":false}},
        "models":{"mode":"replace","providers":{"openshell":{"baseUrl":"https://inference.local/v1","api":"openai-completions","apiKey":"openshell-placeholder","models":[{"id":"primary","name":"OpenShell route","contextWindow":32768,"maxTokens":2048,"input":["text"],"reasoning":false}]}}},
        "agents":{"defaults":{"model":{"primary":"openshell/primary"},"workspace":"/sandbox/workspace","sandbox":{"mode":"off"}},"entries":{name:{}}},
        "tools":{"profile":"coding"}
    });
    let mut env: Row = [
        ("TMPDIR", "/sandbox/tmp"),
        ("OPENCLAW_HOME", "/sandbox"),
        ("XDG_CACHE_HOME", "/sandbox/.cache"),
        ("OPENCLAW_CONFIG_PATH", "/sandbox/.openclaw/openclaw.json"),
        ("OPENCLAW_STATE_DIR", "/sandbox/.openclaw"),
        ("NODE_EXTRA_CA_CERTS", "/etc/ssl/certs/ca-certificates.crt"),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect();
    env.insert("NEMOCLAW_AGENT_CONFIG".into(), config.to_string());
    env
}
pub fn policy() -> proto::SandboxPolicy {
    proto::SandboxPolicy {
        version: 1,
        filesystem: Some(proto::FilesystemPolicy {
            read_only: [
                "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc", "/app", "/opt", "/proc",
            ]
            .map(String::from)
            .to_vec(),
            read_write: [
                "/sandbox",
                "/tmp",
                "/dev/null",
                "/dev/urandom",
                "/home/node",
            ]
            .map(String::from)
            .to_vec(),
            include_workdir: false,
        }),
        landlock: Some(proto::LandlockPolicy {
            compatibility: "best_effort".into(),
        }),
        process: Some(proto::ProcessPolicy {
            run_as_user: "1000".into(),
            run_as_group: "1000".into(),
        }),
        ..Default::default()
    }
}
pub fn policy_matches(actual: &proto::SandboxPolicy) -> bool {
    let expected = policy();
    let Some(filesystem) = &actual.filesystem else {
        return false;
    };
    let mut filesystem = filesystem.clone();
    filesystem.read_only.sort();
    filesystem.read_write.sort();
    let mut expected_filesystem = expected.filesystem.unwrap();
    expected_filesystem.read_only.sort();
    expected_filesystem.read_write.sort();
    actual.process == expected.process
        && actual.landlock == expected.landlock
        && filesystem == expected_filesystem
        && actual.network_policies.is_empty()
        && actual.network_middlewares.is_empty()
}

const BOOTSTRAP: &str = r###"const fs=require('node:fs');
const cp=require('node:child_process');
fs.mkdirSync('/sandbox/.openclaw',{recursive:true,mode:0o700});
fs.mkdirSync('/sandbox/tmp',{recursive:true,mode:0o700});
fs.mkdirSync('/sandbox/workspace',{recursive:true,mode:0o700});
const p=process.env.OPENCLAW_CONFIG_PATH;
fs.writeFileSync(p+'.tmp',process.env.NEMOCLAW_AGENT_CONFIG,{mode:0o600});
fs.renameSync(p+'.tmp',p);
const child=cp.spawn('openclaw',['gateway'],{stdio:'inherit',cwd:'/sandbox'});
for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));
child.on('error',()=>process.exit(1));
child.on('exit',code=>process.exit(code??1));"###;
