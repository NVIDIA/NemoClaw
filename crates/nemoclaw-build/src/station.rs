// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Bind the manual Station case and independently observe its SDK cleanup.
//! HCL owns the scenario; these commands never install host tools or remove
//! Docker objects directly. Private deployment state survives the CI job.

use crate::ci::live;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{fs, path::Path, process::Command};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
pub const CASE: &str = "dgx-station-openclaw-nemotron";
const OWNER: &str = "nemoclaw.nvidia.com/uid";
const SANDBOX: &str = "openshell.ai/sandbox-namespace";

fn docker(args: &[&str]) -> Result<String> {
    let result = Command::new("docker")
        .args(["--host", "unix:///var/run/docker.sock"])
        .args(args)
        .output()?;
    if !result.status.success() {
        return Err("cannot observe the local Docker engine".into());
    }
    Ok(String::from_utf8(result.stdout)?.trim().to_owned())
}

fn image(tag: &str) -> Result<String> {
    let images: Value = serde_json::from_str(&docker(&["image", "inspect", tag])?)?;
    let image = &images[0];
    let id = image["Id"].as_str().ok_or("image has no identity")?;
    let digest = id.strip_prefix("sha256:").ok_or("image is not pinned")?;
    if image["Architecture"] != "arm64"
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Station requires immutable ARM64 candidate images".into());
    }
    Ok(format!("{}@{id}", tag.split(':').next().unwrap()))
}

pub fn prepare(root: &Path, run: &Path) -> Result<()> {
    if run.exists() {
        return Err("use a new run directory; retained deployment state must not be reused".into());
    }
    for label in [OWNER, SANDBOX] {
        if !docker(&[
            "container",
            "ls",
            "--quiet",
            "--filter",
            &format!("label={label}"),
        ])?
        .is_empty()
        {
            return Err(
                "a NemoClaw workload is still running; inspect it before another Station case"
                    .into(),
            );
        }
    }
    let openclaw = image("nc-fabric:openclaw")?;
    let runtime = image("nc-prototype-vllm:station")?;
    let mut used = Vec::new();
    for id in docker(&["network", "ls", "--quiet"])?.lines() {
        let networks: Value = serde_json::from_str(&docker(&["network", "inspect", id])?)?;
        for config in networks[0]["IPAM"]["Config"]
            .as_array()
            .into_iter()
            .flatten()
        {
            if let Some(subnet) = config["Subnet"].as_str() {
                used.push(subnet.to_owned());
            }
        }
    }
    let uid = live::uuid()?;
    let template = fs::read_to_string(root.join(crate::hcl_cases::files(CASE)[0].clone()))?;
    let mut document: Value = serde_saphyr::from_str(&template)?;
    document["metadata"]["uid"] = uid.clone().into();
    let gateway_port = live::free_port()?;
    let model_port = (0..8)
        .map(|_| live::free_port())
        .collect::<std::result::Result<Vec<_>, _>>()?
        .into_iter()
        .find(|port| *port != gateway_port)
        .ok_or("cannot select distinct gateway and model ports")?;
    document["spec"]["gateway"]["endpoint"] = format!("http://127.0.0.1:{gateway_port}").into();
    document["spec"]["gateway"]["networkCIDR"] = live::free_subnet(&used, &[])?.into();
    document["spec"]["services"]["super"]["serving"]["port"] = model_port.into();
    document["spec"]["services"]["super"]["image"] = runtime.clone().into();
    document["spec"]["sandboxes"]["assistant"]["image"]["ref"] = openclaw.clone().into();
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(run)?;
    for child in ["work", "reports"] {
        builder.create(run.join(child))?;
    }
    fs::write(run.join("case.json"), serde_json::to_vec_pretty(&document)?)?;
    let revision = Command::new("git")
        .current_dir(root)
        .args(["rev-parse", "HEAD"])
        .output()?;
    if !revision.status.success() {
        return Err("cannot record the candidate commit".into());
    }
    let identity = json!({
        "case": CASE,
        "candidate": String::from_utf8(revision.stdout)?.trim(),
        "deployment_uid": uid,
        "platform": "linux_arm64",
        "openclaw_image": openclaw,
        "runtime_image": runtime,
        "model": document["spec"]["services"]["super"]["model"],
        "model_cache": "fresh deployment-owned volume; no prior cache imported",
    });
    fs::write(
        run.join("reports/identity.json"),
        serde_json::to_vec_pretty(&identity)?,
    )?;
    Ok(())
}

/// A retained initializer may have exited successfully. Every other owned
/// container, including a stopped inference container, must have disappeared.
fn verify_containers(owner: &[Value], sandbox: &[Value], workspace: &str) -> Result<()> {
    if !sandbox.is_empty()
        || owner.iter().any(|container| {
            container["Name"] != format!("/{workspace}-gateway-initialize")
                || container["State"]["Status"] != "exited"
                || container["State"]["ExitCode"] != 0
        })
    {
        return Err("owned runtime containers remain after destroy".into());
    }
    Ok(())
}

fn containers(filter: &str) -> Result<Vec<Value>> {
    let ids = docker(&["container", "ls", "--all", "--quiet", "--filter", filter])?;
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["container", "inspect"];
    args.extend(ids.lines());
    let observed: Vec<Value> = serde_json::from_str(&docker(&args)?)?;
    if observed.len() != ids.lines().count() {
        return Err("Docker did not return every selected container".into());
    }
    Ok(observed)
}

fn verify_retained(names: &str, allowed: &[String]) -> Result<()> {
    if names
        .lines()
        .any(|name| !allowed.iter().any(|allowed| allowed == name))
    {
        return Err("unexpected owned storage or networks remain after destroy".into());
    }
    Ok(())
}

pub fn cleanup(run: &Path, bundle: &Path) -> Result<()> {
    let document: Value = serde_json::from_slice(&fs::read(run.join("case.json"))?)?;
    let identity: Value = serde_json::from_slice(&fs::read(run.join("reports/identity.json"))?)?;
    let uid = document["metadata"]["uid"]
        .as_str()
        .ok_or("missing deployment UID")?;
    if identity["deployment_uid"] != uid || identity["case"] != CASE {
        return Err("cleanup inputs differ from this run's identity".into());
    }
    let workspace = format!("nc-{}", &crate::hex(&Sha256::digest(uid.as_bytes()))[..16]);
    let result = (|| -> Result<()> {
        if run.join("deployment").exists() {
            // The SDK verifies its own record and resource ownership. Bind the
            // supplied state directory to this CI attempt before invoking it.
            let intent: Value = serde_json::from_slice(
                &fs::read(run.join("deployment/intent.json"))
                    .map_err(|_| "deployment intent is unavailable; retain state for recovery")?,
            )
            .map_err(|_| "deployment intent is unreadable; retain state for recovery")?;
            if intent["document"]["metadata"]["uid"] != uid
                || intent["document"]["spec"]["gateway"]["engine"] != "unix:///var/run/docker.sock"
            {
                return Err("deployment state does not belong to this Station run".into());
            }
            let output = Command::new(bundle.join("bin/nemoclaw"))
                .args([
                    "destroy",
                    "--output",
                    "json",
                    "--progress",
                    "off",
                    "--state-dir",
                ])
                .arg(run.join("deployment"))
                .output()?;
            fs::write(run.join("work/destroy.stdout"), &output.stdout)?;
            fs::write(run.join("work/destroy.stderr"), &output.stderr)?;
            if !output.status.success() {
                return Err("SDK destroy failed; private state and diagnostics retained".into());
            }
            let receipt: Value = serde_json::from_slice(&output.stdout)?;
            if receipt["outcome"] != "destroyed" {
                return Err("SDK did not confirm destroy".into());
            }
        }
        verify_containers(
            &containers(&format!("label={OWNER}={uid}"))?,
            &containers(&format!("label={SANDBOX}={workspace}-gateway"))?,
            &workspace,
        )?;
        let filter = format!("label={OWNER}={uid}");
        verify_retained(
            &docker(&[
                "network",
                "ls",
                "--format",
                "{{.Name}}",
                "--filter",
                &filter,
            ])?,
            &[format!("{workspace}-network")],
        )?;
        verify_retained(
            &docker(&["volume", "ls", "--format", "{{.Name}}", "--filter", &filter])?,
            &[
                format!("{workspace}-gateway-data"),
                format!("{workspace}-inference-super-data"),
                format!("{workspace}-inference-super-auth"),
            ],
        )
    })();
    fs::write(
        run.join("reports/cleanup.json"),
        serde_json::to_vec_pretty(&json!({
            "case": CASE,
            "succeeded": result.is_ok(),
            "retention": "model and gateway storage, credentials, images, and private run state",
        }))?,
    )?;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleanup_allows_only_the_exited_initializer_and_refuses_leftover_sandboxes() {
        let initializer =
            json!({"Name":"/nc-test-gateway-initialize","State":{"Status":"exited","ExitCode":0}});
        assert!(verify_containers(std::slice::from_ref(&initializer), &[], "nc-test").is_ok());
        for leftover in [
            json!({"Name":"/nc-test-inference-super","State":{"Status":"exited","ExitCode":0}}),
            json!({"Name":"/nc-test-gateway-initialize","State":{"Status":"running","ExitCode":0}}),
            json!({"Name":"/nc-test-gateway-initialize","State":{"Status":"exited","ExitCode":1}}),
        ] {
            assert!(verify_containers(&[leftover], &[], "nc-test").is_err());
        }
        assert!(verify_containers(&[], &[initializer], "nc-test").is_err());
    }

    #[test]
    fn cleanup_rejects_unexpected_retained_objects() {
        let allowed = ["gateway-storage".to_owned(), "model-cache".to_owned()];
        assert!(verify_retained("gateway-storage\nmodel-cache", &allowed).is_ok());
        assert!(verify_retained("", &allowed).is_ok());
        assert!(verify_retained("gateway-storage\nservice-network", &allowed).is_err());
    }
}
