// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! The deployment scenarios that `examples/scenarios.md` lists: each row an
//! example, the deployments it creates, named by the QA team's deployment
//! IDs, what a machine needs to run it, and whether it runs. The live case
//! registry ([`crate::hcl_cases`]) registers the rows that are on and whose
//! platform has a CI runner, and `nemoclaw-e2e`'s `scenarios::page` runs the
//! rows that the machine at hand can run.

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use std::{collections::BTreeSet, fs, path::Path};

/// The page, relative to the repository root.
pub const PAGE: &str = "examples/scenarios.md";
/// The columns, in order, that every table on the page has.
pub const HEADER: [&str; 6] = ["On", "ID", "Scenario", "Example", "Needs", "Model"];
/// The On cell that lets a row run, and the one that pauses it.
pub const ON: &str = "✅";
pub const PAUSED: &str = "⏸";
/// The platforms of the QA team's run IDs (`PLATFORM-HARNESS-NNN`), and
/// DOCKER for any host with a Docker engine, which their plan does not name.
pub const PLATFORMS: [&str; 5] = ["SPARK", "STATION", "RTXSPARKWSL2", "K8S", "DOCKER"];

/// The HARNESS part of a deployment ID for a harness kind, such as HERMES for
/// `nvidia.fabric.hermes`.
pub fn harness_id(kind: &str) -> String {
    kind.rsplit('.').next().unwrap_or_default().to_uppercase()
}

/// A deployment ID, `PLATFORM-HARNESS`, as the QA team's run IDs start.
pub fn deployment_id(text: &str) -> Result<String, String> {
    let (platform, harness) = text
        .split_once('-')
        .ok_or_else(|| format!("names `{text}`, not PLATFORM-HARNESS"))?;
    if !PLATFORMS.contains(&platform) {
        return Err(format!(
            "names the platform `{platform}`: use one of {}",
            PLATFORMS.join(", ")
        ));
    }
    if harness.is_empty() || !harness.chars().all(|c| c.is_ascii_uppercase()) {
        return Err(format!(
            "names the harness `{harness}`: use capital letters"
        ));
    }
    Ok(text.to_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    /// The deployment IDs, joined, which name the row in output.
    pub id: String,
    /// One deployment ID for each harness the example deploys.
    pub ids: Vec<String>,
    pub title: String,
    /// Whether the page lets the row run, by its On cell; a paused row never runs.
    pub on: bool,
    /// The example, relative to the page's directory.
    pub example: String,
    pub needs: Vec<Need>,
    /// Whether the runner serves the stub model in place of every endpoint.
    pub stub: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Need {
    Linux,
    Wsl2,
    Arm64,
    Amd64,
    Docker,
    Gpu(String),
    Kubernetes,
    Env(String),
}

impl Need {
    pub fn parse(text: &str) -> Result<Need, String> {
        Ok(match text {
            "linux" => Need::Linux,
            "wsl2" => Need::Wsl2,
            "arm64" => Need::Arm64,
            "amd64" => Need::Amd64,
            "docker" => Need::Docker,
            "kubernetes" => Need::Kubernetes,
            _ => {
                if let Some(name) = text.strip_prefix("gpu ").map(str::trim)
                    && !name.is_empty()
                {
                    Need::Gpu(name.to_owned())
                } else if let Some(name) = text.strip_prefix('$')
                    && !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
                {
                    Need::Env(name.to_owned())
                } else {
                    return Err(format!(
                        "unknown need `{text}`: use linux, wsl2, arm64, amd64, docker, kubernetes, `gpu NAME`, or `$NAME`"
                    ));
                }
            }
        })
    }
}

/// A table cell's text and the targets of its links.
type Cell = (String, Vec<String>);

/// Every row of every table on `page`. A table with other columns, an empty
/// cell, an unknown need, an Example cell without exactly one link, or a
/// repeated scenario fails, so that no row is dropped without a message.
pub fn parse(page: &str) -> Result<Vec<Row>, String> {
    let mut tables: Vec<Vec<Vec<Cell>>> = Vec::new();
    let mut cell: Option<Cell> = None;
    for event in Parser::new_ext(page, Options::ENABLE_TABLES) {
        match event {
            Event::Start(Tag::Table(_)) => tables.push(Vec::new()),
            Event::Start(Tag::TableHead | Tag::TableRow) => {
                tables.last_mut().unwrap().push(Vec::new());
            }
            Event::Start(Tag::TableCell) => cell = Some((String::new(), Vec::new())),
            Event::End(TagEnd::TableCell) => {
                let (text, links) = cell.take().unwrap();
                let row = tables.last_mut().unwrap().last_mut().unwrap();
                row.push((text.trim().to_owned(), links));
            }
            Event::Start(Tag::Link { dest_url, .. }) => {
                if let Some((_, links)) = cell.as_mut() {
                    links.push(dest_url.into_string());
                }
            }
            Event::Text(text) | Event::Code(text) => {
                if let Some((cell, _)) = cell.as_mut() {
                    cell.push_str(&text);
                }
            }
            _ => {}
        }
    }
    if tables.is_empty() {
        return Err("the page has no table".into());
    }
    let mut rows = Vec::new();
    let mut ids = BTreeSet::new();
    for table in tables {
        let mut lines = table.into_iter();
        let header: Vec<_> = lines.next().unwrap_or_default();
        let header: Vec<&str> = header.iter().map(|(text, _)| text.as_str()).collect();
        if header != HEADER {
            return Err(format!("a table's columns are {header:?}, not {HEADER:?}"));
        }
        for cells in lines {
            let row = row(&cells).map_err(|error| {
                format!(
                    "the row `{}` {error}",
                    cells
                        .get(HEADER.iter().position(|c| *c == "ID").unwrap())
                        .map_or("", |c| &c.0)
                )
            })?;
            for id in &row.ids {
                if !ids.insert(id.clone()) {
                    return Err(format!("the deployment {id} appears twice"));
                }
            }
            rows.push(row);
        }
    }
    Ok(rows)
}

fn row(cells: &[Cell]) -> Result<Row, String> {
    let column = |name: &str| {
        let index = HEADER.iter().position(|c| *c == name).unwrap();
        let (text, links) = &cells[index];
        if text.is_empty() {
            Err(format!("has no {name}"))
        } else {
            Ok((text.as_str(), links))
        }
    };
    let ids: Vec<String> = column("ID")?
        .0
        .split(',')
        .map(|id| deployment_id(id.trim()))
        .collect::<Result<_, _>>()?;
    let (title, _) = column("Scenario")?;
    // The emoji may carry the emoji-presentation selector.
    let on = match column("On")?.0.trim_end_matches('\u{fe0f}') {
        ON => true,
        PAUSED => false,
        other => {
            return Err(format!(
                "has `{other}` in On: write {ON} or {PAUSED}\u{fe0f}"
            ));
        }
    };
    let example = match column("Example")?.1.as_slice() {
        [link] => link.clone(),
        links => return Err(format!("links {} examples, not one", links.len())),
    };
    let needs = column("Needs")?
        .0
        .split(',')
        .map(|need| Need::parse(need.trim()))
        .collect::<Result<_, _>>()?;
    Ok(Row {
        id: ids.join(", "),
        ids,
        title: title.trim().to_owned(),
        on,
        example,
        needs,
        stub: column("Model")?.0 == "stub",
    })
}

impl Row {
    /// The row's platform, the first part of its deployment IDs.
    pub fn platform(&self) -> &str {
        self.ids[0]
            .split_once('-')
            .map_or("", |(platform, _)| platform)
    }

    /// The live case ID that registers the row: its deployment ID in
    /// lowercase, such as `station-hermes`, or for an example that creates
    /// several deployments, its platform and each harness, such as
    /// `k8s-openclaw-hermes`.
    pub fn case_id(&self) -> String {
        let harnesses: Vec<&str> = self
            .ids
            .iter()
            .filter_map(|id| id.split_once('-').map(|(_, harness)| harness))
            .collect();
        format!("{}-{}", self.platform(), harnesses.join("-")).to_lowercase()
    }

    /// The row's example, relative to the repository root.
    pub fn example_path(&self) -> String {
        let directory = Path::new(PAGE).parent().unwrap();
        directory.join(&self.example).to_string_lossy().into_owned()
    }
}

/// The page's rows under `root`.
pub fn read(root: &Path) -> Result<Vec<Row>, String> {
    let page = fs::read_to_string(root.join(PAGE))
        .map_err(|error| format!("cannot read {PAGE}: {error}"))?;
    parse(&page).map_err(|error| format!("{PAGE}: {error}"))
}
