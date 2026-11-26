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
    /// What `nemoclaw destroy` keeps: the deployment's data.
    pub retained: &'a std::collections::BTreeSet<String>,
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

    // Like `nemoclaw destroy`, teardown keeps only the deployment's data. The
    // other resources that set `prevent_destroy` are released first: a
    // managed gateway's workspace depends on the gateway, so excluding it
    // would keep the gateway running.
    let released: Vec<String> = protected(graph)
        .into_iter()
        .filter(|address| !about.retained.contains(address))
        .collect();
    text.push_str(
        "\n## Tearing It Down\n\n\
         The providers delete what they own only when `destroy` is true.\n\
         Like `nemoclaw destroy`, this teardown deletes everything except the deployment's retained data.\n",
    );
    if !released.is_empty() {
        let names = released
            .iter()
            .map(|address| format!("`{address}`"))
            .collect::<Vec<_>>()
            .join(" and ");
        let them = if released.len() == 1 { "it" } else { "them" };
        text.push_str(&format!(
            "`prevent_destroy` on {names} stops an apply from replacing {them}.\n\
             Teardown deletes {them}, so first remove that `prevent_destroy`.\n"
        ));
    }
    let excludes: String = about
        .retained
        .iter()
        .map(|address| format!(" \\\n  -exclude={address}"))
        .collect();
    text.push_str(&format!(
        "{}:\n\n```sh\ntofu destroy -var destroy=true{excludes}\n```\n",
        if released.is_empty() {
            "Run"
        } else {
            "Then run"
        }
    ));
    if !about.retained.is_empty() {
        text.push_str(&format!(
            "\nThe excluded resources hold the deployment's retained data, such as the managed gateway's database and keys, and the providers never delete them.\n\
             To delete that data, follow [Removing Retained Resources]({}) for your engine, then delete the project's state.\n",
            crate::documentation_url("docs/build-deploy/usage.md#removing-retained-resources"),
        ));
    }
    text.push_str(
        "\nIf a destroy stops partway, finish it with a `-target=` for each resource that `tofu state list` still shows.\n\
         A full `tofu destroy` first plans the resources it already deleted as new ones, and with `destroy` set the providers refuse to create them.\n",
    );
    text
}

/// The resources whose `lifecycle` sets `prevent_destroy`.
pub(crate) fn protected(graph: &Value) -> Vec<String> {
    let mut protected = Vec::new();
    for (kind, instances) in graph["resource"].as_object().into_iter().flatten() {
        for (name, body) in instances.as_object().into_iter().flatten() {
            if body["lifecycle"]["prevent_destroy"] == Value::Bool(true) {
                protected.push(format!("{kind}.{name}"));
            }
        }
    }
    protected
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    /// The teardown's command and the resources it says to release.
    fn teardown(text: &str) -> (BTreeSet<String>, String) {
        let section = text.split("## Tearing It Down").nth(1).unwrap();
        let command = section
            .split("```sh\n")
            .nth(1)
            .and_then(|rest| rest.split("```").next())
            .unwrap();
        let excluded = command
            .split_whitespace()
            .filter_map(|word| word.strip_prefix("-exclude="))
            .map(String::from)
            .collect();
        (excluded, section.split("```sh\n").next().unwrap().into())
    }

    /// Like `nemoclaw destroy`, the README's teardown keeps only the
    /// deployment's data: it excludes exactly what the SDK's teardown keeps,
    /// and releases every other resource that sets `prevent_destroy`.
    #[test]
    fn teardown_keeps_what_nemoclaw_destroy_keeps() {
        for fixture in [
            include_bytes!("../../tests/fixtures/config/managed-ollama.yaml").as_slice(),
            include_bytes!("../../tests/fixtures/config/local.yaml").as_slice(),
        ] {
            let document = Document::parse(fixture).unwrap();
            let generations = crate::state::Record::new(document.clone())
                .unwrap()
                .generations;
            let graph = crate::compile::compile(&document, &generations, "0.1.0").unwrap();
            let kept = super::super::retained(&document, &generations, "0.1.0", &graph).unwrap();
            let about = About {
                source: "deployment.yaml",
                version: "0.1.0",
                opentofu: "1.0.0",
                bundle: std::path::Path::new("/bundle"),
                retained: &kept,
            };
            let text = readme(&document, &graph, &[], &BTreeMap::new(), &about);
            let (excluded, before) = teardown(&text);
            assert_eq!(excluded, kept, "{}", document.metadata.name);
            for address in protected(&graph) {
                if !kept.contains(&address) {
                    assert!(
                        before.contains(&format!("`{address}`")),
                        "{address} isn't released in:\n{before}"
                    );
                }
            }
        }
    }
}
