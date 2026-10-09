// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Steps for the configuration oaths.
//!
//! Varar keeps one state per step-definition file, so every step that reads
//! or edits the configuration under test must live in this file.

use std::collections::BTreeMap;

use ::varar::{HandlerError, Steps};
use nemoclaw_sdk::{
    compile::{Generations, compile, targets},
    config::Document,
};
use serde_json::{Value, json};

use super::{Ctx, read};

pub fn register(s: &mut Steps<Ctx>) {
    s.stimulus("Starting from `{code}`", |_ctx: Ctx, path: String| {
        Ok(Ctx {
            source: read(&path)?,
        })
    });
    register_diagnostics(s);
    register_sandboxes(s);
}

/// The parse failure as a user sees it, or a marker a mismatch makes obvious.
fn outcome(source: &str) -> String {
    match Document::parse(source.as_bytes()) {
        Ok(_) => "the configuration was accepted".to_owned(),
        Err(error) => error.to_string(),
    }
}

/// Steps for `config-diagnostics.md`.
fn register_diagnostics(s: &mut Steps<Ctx>) {
    s.stimulus(
        "Reading this configuration:",
        |_ctx: Ctx, source: String| Ok(Ctx { source }),
    );

    s.stimulus(
        "changing `{code}` to `{code}`",
        |ctx: Ctx, from: String, to: String| replace(ctx, &from, &to),
    );

    // A doc string ends with its newline; the message does not.
    s.sensor("fails with:", |ctx: Ctx, _expected: String| {
        Ok(format!("{}\n", outcome(&ctx.source)))
    });

    s.sensor(
        "Each input, written as a JSON string, fails with its message",
        |_ctx: Ctx, row: BTreeMap<String, String>| {
            let input: String = serde_json::from_str(&row["input"])
                .map_err(|e| HandlerError::new(format!("input is not a JSON string: {e}")))?;
            Ok(BTreeMap::from([("message".to_owned(), outcome(&input))]))
        },
    );

    // Varar runs only the sensor for each row of a header-bound table, and
    // compares the row only when the sensor returns nothing but the row, so
    // the document is spelled into the expression instead of a slot.
    s.sensor(
        r"Replacing each original in `examples\/fabric-openclaw.yaml` with its replacement fails with the message",
        |_ctx: Ctx, row: BTreeMap<String, String>| {
            let source = read("examples/fabric-openclaw.yaml")?;
            let edited = replace(Ctx { source }, &row["original"], &row["replacement"])?;
            Ok(BTreeMap::from([("message".to_owned(), outcome(&edited.source))]))
        },
    );

    s.sensor(
        "keeps these harness settings:",
        |ctx: Ctx, _expected: String| {
            let document = Document::parse(ctx.source.as_bytes())
                .map_err(|e| HandlerError::new(e.to_string()))?;
            let tree =
                serde_json::to_value(document).map_err(|e| HandlerError::new(e.to_string()))?;
            let settings = &tree["spec"]["sandboxes"][0]["harness"]["settings"];
            Ok(format!(
                "{}\n",
                serde_json::to_string_pretty(settings).unwrap()
            ))
        },
    );
}

/// Replaces the first occurrence, failing when the original is absent so a
/// stale example cannot pass on an unchanged document.
fn replace(ctx: Ctx, from: &str, to: &str) -> Result<Ctx, HandlerError> {
    if !ctx.source.contains(from) {
        return Err(HandlerError::new(format!("the document has no `{from}`")));
    }
    Ok(Ctx {
        source: ctx.source.replacen(from, to, 1),
    })
}

/// Steps for `multiple-sandboxes.md`.
fn register_sandboxes(s: &mut Steps<Ctx>) {
    s.param(
        "order",
        "sandboxes and providers|sandboxes|providers",
        |g: &[&str]| g[0].to_owned(),
        None,
    );
    s.param(
        "sameness",
        "the same|a different",
        |g: &[&str]| g[0].to_owned(),
        None,
    );

    s.stimulus("add a sandbox named {string}", |ctx: Ctx, name: String| {
        edit(ctx, |config| add_sandbox(config, &name))
    });

    s.stimulus("give it the {string} harness", |ctx: Ctx, kind: String| {
        edit(ctx, |config| {
            *last_sandbox(config, "harness") = json!({ "kind": kind })
        })
    });

    s.stimulus(
        "add a provider named {string} at {string}",
        |ctx: Ctx, name: String, endpoint: String| {
            edit(ctx, |config| {
                let mut provider = config["spec"]["inferenceProviders"][0].clone();
                provider["name"] = json!(name);
                provider["endpoint"] = json!(endpoint);
                push(&mut config["spec"]["inferenceProviders"], provider);
            })
        },
    );

    s.stimulus("route it to {string}", |ctx: Ctx, provider: String| {
        edit(ctx, |config| {
            last_sandbox(config, "agent")["inference"]["routes"][0]["providerRef"] = json!(provider)
        })
    });

    s.stimulus(
        "move the {string} provider into the first sandbox",
        |ctx: Ctx, name: String| {
            edit(ctx, |config| {
                let providers = config["spec"]["inferenceProviders"].as_array_mut().unwrap();
                let index = providers
                    .iter()
                    .position(|p| p["name"] == name.as_str())
                    .unwrap();
                let provider = providers.remove(index);
                config["spec"]["sandboxes"][0]["inferenceProviders"] = json!([provider]);
            })
        },
    );

    s.sensor(
        "compiles to {count} sandbox(es) and {count} provider registration(s)",
        |ctx: Ctx, _sandboxes: i64, _registrations: i64| {
            let graph = graph(&ctx.source)?;
            Ok((
                resources(&graph, "openshell_sandbox").len() as i64,
                resources(&graph, "openshell_provider_registration").len() as i64,
            ))
        },
    );

    s.sensor(
        "the registrations have {count} different names",
        |ctx: Ctx, _expected: i64| {
            let graph = graph(&ctx.source)?;
            let registrations = resources(&graph, "openshell_provider_registration");
            let names: std::collections::BTreeSet<_> = registrations
                .values()
                .map(|r| r["name"].to_string())
                .collect();
            Ok(names.len() as i64)
        },
    );

    s.sensor(
        "Reversing the {order} changes {count} compiled resource(s)",
        |ctx: Ctx, order: String, _expected: i64| {
            let reversed = reverse(&ctx.source, &order)?;
            Ok((
                order,
                changed(&graph(&ctx.source)?, &graph(&reversed)?, Scope::All) as i64,
            ))
        },
    );

    s.sensor(
        "Reversing the {order} gives {sameness} digest",
        |ctx: Ctx, order: String, _expected: String| {
            let same =
                parse(&ctx.source)?.digest() == parse(&reverse(&ctx.source, &order)?)?.digest();
            Ok((order, sameness(same)))
        },
    );

    s.sensor(
        "Exporting it and reading the export back gives {sameness} configuration",
        |ctx: Ctx, _expected: String| {
            let document = parse(&ctx.source)?;
            let export = document.yaml().map_err(error)?;
            Ok(sameness(parse(&export)? == document))
        },
    );

    // The oath explains why the discovery fields are excluded.
    s.sensor(
        "adding a sandbox named {string} changes {count} existing compiled resource(s)",
        |ctx: Ctx, name: String, _expected: i64| {
            let before = graph(&ctx.source)?;
            let after = edit(ctx, |config| add_sandbox(config, &name))?;
            let scope = Scope::Existing(&["runtime_json", "binaries_json"]);
            Ok((name, changed(&before, &graph(&after.source)?, scope) as i64))
        },
    );

    // Spelled into the expression for the same reason as the tag table.
    s.sensor(
        r"Compiling `examples\/multiple-sandboxes.yaml` gives each sandbox its harness, its agent, and the partner that shares its provider registration",
        |_ctx: Ctx, row: BTreeMap<String, String>| {
            let document = parse(&read("examples/multiple-sandboxes.yaml")?)?;
            let rows = targets(&document, &generations()).map_err(error)?;
            let find = |kind: &str, name: &str| {
                rows.iter()
                    .find(|r| r.kind == kind && r.values["name"] == name)
                    .ok_or_else(|| HandlerError::new(format!("no {kind} named {name}")))
            };
            let name = row["sandbox"].as_str();
            let sandbox = document.spec.sandboxes.iter().find(|s| s.name == name)
                .ok_or_else(|| HandlerError::new(format!("no sandbox named {name}")))?;
            let compiled = find("sandbox", name)?;
            let configuration: Value =
                serde_json::from_str(&find("agent_configuration", name)?.values["config_json"])
                    .map_err(error)?;
            // The agent name reaches the sandbox and its Fabric configuration.
            let agent = match configuration["metadata"]["name"].as_str() {
                Some(configured) if configured == compiled.values["agent_name"] => configured.to_owned(),
                other => format!("{} (configuration: {other:?})", compiled.values["agent_name"]),
            };
            let partners: Vec<_> = rows
                .iter()
                .filter(|r| r.kind == "sandbox" && r.values["name"] != name)
                .filter(|r| r.values["provider_names_json"] == compiled.values["provider_names_json"])
                .map(|r| r.values["name"].clone())
                .collect();
            let harness = document.sandbox_harness(sandbox).map_err(error)?;
            Ok(BTreeMap::from([
                ("harness".to_owned(), harness.kind.as_str().to_owned()),
                ("agent".to_owned(), agent),
                ("partner".to_owned(), if partners.is_empty() { "none".to_owned() } else { partners.join(", ") }),
            ]))
        },
    );
}

fn error(e: impl std::fmt::Display) -> HandlerError {
    HandlerError::new(e.to_string())
}

fn parse(source: &str) -> Result<Document, HandlerError> {
    Document::parse(source.as_bytes()).map_err(error)
}

/// Compilation needs a generation per resource kind; any fixed value works.
fn generations() -> Generations {
    [
        "workspace",
        "provider",
        "sandbox",
        "ollama",
        "managed_gateway",
        "inference_service",
    ]
    .map(|kind| (kind.into(), "a".repeat(32)))
    .into()
}

fn graph(source: &str) -> Result<Value, HandlerError> {
    compile(&parse(source)?, &generations(), "0.1.0").map_err(error)
}

fn resources<'a>(graph: &'a Value, kind: &str) -> &'a serde_json::Map<String, Value> {
    static EMPTY: std::sync::LazyLock<serde_json::Map<String, Value>> =
        std::sync::LazyLock::new(serde_json::Map::new);
    graph["resource"][kind].as_object().unwrap_or(&EMPTY)
}

/// Which resources a comparison counts.
#[derive(Clone, Copy, PartialEq)]
enum Scope {
    /// Changed, removed, and added resources.
    All,
    /// Only resources that existed before, ignoring the excluded fields.
    Existing(&'static [&'static str]),
}

/// Counts the resources that differ between two compiled graphs.
fn changed(before: &Value, after: &Value, scope: Scope) -> usize {
    let excluded: &[&str] = match scope {
        Scope::All => &[],
        Scope::Existing(fields) => fields,
    };
    let strip = |value: &Value| {
        let mut value = value.clone();
        if let Some(object) = value.as_object_mut() {
            for field in excluded {
                object.remove(*field);
            }
        }
        value
    };
    let mut count = 0;
    for (kind, instances) in before["resource"].as_object().into_iter().flatten() {
        for (name, instance) in instances.as_object().into_iter().flatten() {
            if strip(instance) != strip(&after["resource"][kind][name]) {
                count += 1;
            }
        }
    }
    if scope == Scope::All {
        for (kind, instances) in after["resource"].as_object().into_iter().flatten() {
            count += instances
                .as_object()
                .into_iter()
                .flatten()
                .filter(|(name, _)| before["resource"][kind][name.as_str()].is_null())
                .count();
        }
    }
    count
}

fn sameness(same: bool) -> String {
    if same { "the same" } else { "a different" }.to_owned()
}

fn edit(ctx: Ctx, change: impl FnOnce(&mut Value)) -> Result<Ctx, HandlerError> {
    let mut config: Value = serde_saphyr::from_str(&ctx.source).map_err(error)?;
    change(&mut config);
    Ok(Ctx {
        source: config.to_string(),
    })
}

/// Adds a copy of the first sandbox under a new name.
fn add_sandbox(config: &mut Value, name: &str) {
    let mut sandbox = config["spec"]["sandboxes"][0].clone();
    sandbox["name"] = json!(name);
    push(&mut config["spec"]["sandboxes"], sandbox);
}

fn push(list: &mut Value, item: Value) {
    list.as_array_mut().expect("a list").push(item);
}

fn last_sandbox<'a>(config: &'a mut Value, field: &str) -> &'a mut Value {
    let sandboxes = config["spec"]["sandboxes"]
        .as_array_mut()
        .expect("sandboxes");
    &mut sandboxes.last_mut().expect("a sandbox")[field]
}

fn reverse(source: &str, order: &str) -> Result<String, HandlerError> {
    let mut config: Value = serde_saphyr::from_str(source).map_err(error)?;
    if order.contains("sandboxes") {
        config["spec"]["sandboxes"]
            .as_array_mut()
            .expect("sandboxes")
            .reverse();
    }
    if order.contains("providers") {
        config["spec"]["inferenceProviders"]
            .as_array_mut()
            .expect("providers")
            .reverse();
    }
    Ok(config.to_string())
}
