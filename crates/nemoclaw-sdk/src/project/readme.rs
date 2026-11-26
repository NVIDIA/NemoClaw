// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! The written project's README: how to install the providers, which
//! credentials it reads, and how to tear it down while keeping retained data.

use super::lift::Variable;
use crate::config::Document;
use serde_json::Value;
use std::collections::BTreeMap;

/// What the README describes besides the document.
pub(crate) struct About<'a> {
    /// The document's file, as the command named it.
    pub source: &'a str,
    pub version: &'a str,
    pub opentofu: &'a str,
    pub bundle: &'a std::path::Path,
}

const FILES: [(&str, &str); 7] = [
    (
        "versions.tf",
        "The providers, pinned to the bundle that wrote this project, and their configuration.",
    ),
    (
        "variables.tf",
        "The deployment UID, images, and other values you may change.",
    ),
    (
        "gateway.tf",
        "The OpenShell gateway and the deployment's workspace.",
    ),
    (
        "inference.tf",
        "Inference registrations and the model servers behind them.",
    ),
    (
        "sandboxes.tf",
        "Sandboxes, their agents, and the images they run.",
    ),
    ("outputs.tf", "Outputs."),
    ("main.tf", "Everything else."),
];

pub(crate) fn readme(
    document: &Document,
    graph: &Value,
    variables: &[Variable],
    files: &BTreeMap<String, String>,
    about: &About<'_>,
) -> String {
    let mut text = format!("# {}\n\n", document.metadata.name);
    text.push_str(&format!(
        "`nemoclaw compile` wrote this OpenTofu project from `{}` with NemoClaw {}.\n\
         The project is yours: the NemoClaw CLI never reads, regenerates, or merges it, and later NemoClaw releases don't change it.\n\
         The [guide]({}) explains what the CLI does that plain OpenTofu doesn't.\n",
        about.source,
        about.version,
        crate::documentation_url("docs/build-deploy/opentofu-project.md"),
    ));

    text.push_str("\n## Files\n\n| File | Holds |\n|---|---|\n");
    for (file, holds) in FILES {
        if files.contains_key(file) {
            text.push_str(&format!("| `{file}` | {holds} |\n"));
        }
    }

    let sources: Vec<&str> = graph["terraform"]["required_providers"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(_, requirement)| requirement["source"].as_str())
        .collect();
    let mirror = about.bundle.join("providers");
    let list = sources
        .iter()
        .map(|source| format!("\"{source}\""))
        .collect::<Vec<_>>()
        .join(", ");
    text.push_str(&format!(
        "\n## Installing the Providers\n\n\
         The NemoClaw providers aren't in a registry yet, so OpenTofu installs this project's providers from the bundle that wrote it, and any others you add from their registries.\n\
         Write an OpenTofu CLI configuration file outside this directory, such as `nemoclaw.tfrc`:\n\n\
         ```hcl\n\
         provider_installation {{\n  filesystem_mirror {{\n    path    = {}\n    include = [{list}]\n  }}\n  direct {{\n    exclude = [{list}]\n  }}\n}}\n\
         ```\n\n\
         Then initialize the project:\n\n\
         ```sh\n\
         export TF_CLI_CONFIG_FILE=/absolute/path/to/nemoclaw.tfrc\n\
         tofu init\n\
         ```\n\n\
         The bundle's own OpenTofu, at `{}`, is version {}.\n\
         Commit `.terraform.lock.hcl` with the project.\n",
        serde_json::to_string(&mirror.to_string_lossy()).expect("string path"),
        about
            .bundle
            .join("libexec")
            .join(crate::bundle::executable("tofu"))
            .display(),
        about.opentofu,
    ));

    let credentials = document.credential_names();
    if !credentials.is_empty() {
        let plan = document.plan_credential_names();
        text.push_str(
            "\n## Credentials\n\n\
             Set these environment variables before running OpenTofu.\n\
             The project names them; it holds no credential values.\n\n\
             | Variable | Read by |\n|---|---|\n",
        );
        for name in credentials {
            let stage = if plan.contains(&name) {
                "plan and apply"
            } else {
                "apply"
            };
            text.push_str(&format!("| `{name}` | {stage} |\n"));
        }
    }

    text.push_str("\n## Variables\n\n| Variable | Default | Description |\n|---|---|---|\n");
    for variable in variables {
        text.push_str(&format!(
            "| `{}` | `{}` | {} |\n",
            variable.name,
            match &variable.default {
                Value::String(text) => text.clone(),
                value => value.to_string(),
            },
            variable.description,
        ));
    }

    let retained = retained(graph);
    text.push_str(
        "\n## Tearing It Down\n\n\
         The providers delete what they own only when `destroy` is true:\n\n\
         ```sh\n",
    );
    if retained.is_empty() {
        text.push_str("tofu destroy -var destroy=true\n```\n");
    } else {
        let excludes: String = retained
            .iter()
            .map(|address| format!(" \\\n  -exclude={address}"))
            .collect();
        text.push_str(&format!(
            "tofu destroy -var destroy=true{excludes}\n```\n\n\
             These resources hold the deployment's retained data and set `prevent_destroy`, so `tofu destroy` refuses to run unless it excludes them.\n\
             To delete one and its data afterwards, remove its `prevent_destroy` and destroy it alone:\n\n\
             ```sh\n\
             tofu destroy -var destroy=true -target={}\n\
             ```\n\n\
             Without `-target`, `tofu destroy` first plans the resources it already deleted as new ones, and with `destroy` set the providers refuse to create them.\n",
            retained[0],
        ));
    }
    text
}

/// The resources whose `lifecycle` sets `prevent_destroy`.
pub(crate) fn retained(graph: &Value) -> Vec<String> {
    let mut retained = Vec::new();
    for (kind, instances) in graph["resource"].as_object().into_iter().flatten() {
        for (name, body) in instances.as_object().into_iter().flatten() {
            if body["lifecycle"]["prevent_destroy"] == Value::Bool(true) {
                retained.push(format!("{kind}.{name}"));
            }
        }
    }
    retained
}
