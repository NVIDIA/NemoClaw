// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! A deployment's YAML written out once as an OpenTofu project in HCL, for a
//! team to own. The project is the graph the SDK compiles for `apply`, with
//! new ownership generations, rendered with the providers' schemas and
//! formatted by `tofu fmt`. The CLI never reads it back.
//!
//! A managed Kubernetes or OpenShift gateway is refused: its graph depends on
//! the state directory, ownership receipt, and kubeconfig that the SDK
//! supplies around it.

mod lift;
mod readme;
mod render;
mod template;

pub use render::Schemas;

use crate::{CancellationToken, Error, bundle::Bundle, config::Document};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

/// A written project's files, by name relative to its directory.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Project {
    pub files: BTreeMap<String, String>,
}

/// Why a project was not written.
#[derive(Debug)]
pub enum ProjectError {
    Sdk(Error),
    /// The document's gateway is a managed Kubernetes or OpenShift gateway.
    ManagedCluster,
    /// The graph has a construct the renderer can't write in HCL.
    Render(String),
    /// The output directory exists and has files.
    NotEmpty(PathBuf),
    Io {
        path: PathBuf,
        error: std::io::Error,
    },
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Sdk(error) => error.fmt(formatter),
            Self::ManagedCluster => write!(
                formatter,
                "a managed Kubernetes or OpenShift gateway's configuration depends on the state directory, ownership receipt, and kubeconfig that the CLI supplies, so nemoclaw compile writes projects only for Docker, Podman, and external gateways; to manage this gateway from your own OpenTofu project, write it against the providers as {} describes",
                crate::documentation_url("docs/build-deploy/opentofu-project.md")
            ),
            Self::Render(reason) => write!(
                formatter,
                "cannot write the compiled configuration as HCL: {reason}; nothing was written"
            ),
            Self::NotEmpty(path) => write!(
                formatter,
                "{} already has files; nemoclaw compile writes a project only into a new or empty directory",
                path.display()
            ),
            Self::Io { path, error } => {
                write!(formatter, "cannot write {}: {error}", path.display())
            }
        }
    }
}

impl std::error::Error for ProjectError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Sdk(error) => Some(error),
            Self::Io { error, .. } => Some(error),
            _ => None,
        }
    }
}

impl From<Error> for ProjectError {
    fn from(error: Error) -> Self {
        Self::Sdk(error)
    }
}

/// Refuse a document whose project would need what only the SDK supplies.
pub fn check(document: &Document) -> Result<(), ProjectError> {
    if document.spec.gateway.as_kubernetes().is_some() {
        return Err(ProjectError::ManagedCluster);
    }
    Ok(())
}

/// The project's HCL files, unformatted, for `graph` compiled from `document`.
pub fn render(
    document: &Document,
    graph: &Value,
    schemas: &Schemas,
) -> Result<Project, ProjectError> {
    rendered(document, graph, schemas).map(|(project, _, _)| project)
}

/// `graph`, compiled from `document`, with the project's variables and
/// locals, in the JSON syntax: the configuration the project's HCL writes.
pub fn lifted(document: &Document, graph: &Value) -> Result<Value, ProjectError> {
    check(document)?;
    let mut graph = graph.clone();
    let lifted = lift::lift(document, &mut graph)
        .map_err(|unsupported| ProjectError::Render(unsupported.0.into()))?;
    for variable in &lifted.variables {
        graph["variable"][&variable.name] = json!({
            "description": variable.description,
            "type": variable.kind,
            "default": variable.default,
        });
    }
    for (name, value) in lifted.locals {
        graph["locals"][name] = value;
    }
    Ok(graph)
}

fn rendered(
    document: &Document,
    graph: &Value,
    schemas: &Schemas,
) -> Result<(Project, lift::Lifted, Value), ProjectError> {
    check(document)?;
    let mut graph = graph.clone();
    let lifted = lift::lift(document, &mut graph)
        .map_err(|unsupported| ProjectError::Render(unsupported.0.into()))?;
    let files = render::render(&graph, &lifted, schemas).map_err(ProjectError::Render)?;
    Ok((Project { files }, lifted, graph))
}

/// The schemas of the providers `graph` requires, read from `bundle`, which
/// installs them.
pub async fn schemas(
    bundle: &Bundle,
    graph: &Value,
    cancel: &CancellationToken,
) -> Result<Schemas, ProjectError> {
    let directory = scratch()?;
    let path = directory.path();
    let requirements = json!({"terraform": {
        "required_providers": graph["terraform"]["required_providers"].clone()
    }});
    write_file(&path.join("main.tf.json"), &requirements.to_string())?;
    let mirror = serde_json::to_string(&bundle.directory.join("providers").to_string_lossy())
        .expect("string path");
    write_file(
        &path.join("providers.tfrc"),
        &format!("provider_installation {{\n filesystem_mirror {{ path = {mirror} }}\n}}\n"),
    )?;
    let environment = crate::state::schema_environment(path);
    let tofu = bundle.tofu();
    crate::process::run(
        path,
        &tofu,
        &["init", "-input=false", "-no-color"],
        &environment,
        cancel,
    )
    .await?;
    let schemas = crate::process::run(
        path,
        &tofu,
        &["providers", "schema", "-json"],
        &environment,
        cancel,
    )
    .await?;
    let schemas: Value = serde_json::from_slice(&schemas)
        .map_err(|_| Error::State("OpenTofu reported unreadable provider schemas"))?;
    Ok(Schemas::new(schemas))
}

/// Format each `.tf` file with the bundle's `tofu fmt`, which also refuses
/// HCL it can't parse.
pub async fn format(
    bundle: &Bundle,
    project: &mut Project,
    cancel: &CancellationToken,
) -> Result<(), ProjectError> {
    let directory = scratch()?;
    let path = directory.path();
    let configuration: Vec<&String> = project
        .files
        .keys()
        .filter(|name| name.ends_with(".tf"))
        .collect();
    for name in &configuration {
        write_file(&path.join(name), &project.files[*name])?;
    }
    let environment = BTreeMap::from([
        ("TF_IN_AUTOMATION".to_owned(), "1".to_owned()),
        ("CHECKPOINT_DISABLE".to_owned(), "1".to_owned()),
    ]);
    crate::process::run(
        path,
        &bundle.tofu(),
        &["fmt", "-no-color", "-list=false"],
        &environment,
        cancel,
    )
    .await?;
    let mut formatted = BTreeMap::new();
    for name in configuration {
        let file = path.join(name);
        let text = fs::read_to_string(&file).map_err(|error| ProjectError::Io {
            path: file.clone(),
            error,
        })?;
        formatted.insert(name.clone(), text);
    }
    project.files.extend(formatted);
    Ok(())
}

/// Compile `document` with new ownership generations and write its project,
/// with a README, into `output`, which must be new or empty. `source` names
/// the document's file in the README.
pub async fn write(
    bundle_directory: &Path,
    document: &Document,
    source: &str,
    output: &Path,
    cancel: &CancellationToken,
) -> Result<Project, ProjectError> {
    check(document)?;
    match fs::read_dir(output) {
        Ok(mut entries) => {
            if entries.next().is_some() {
                return Err(ProjectError::NotEmpty(output.into()));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(ProjectError::Io {
                path: output.into(),
                error,
            });
        }
    }
    let bundle = Bundle::open(bundle_directory)?;
    let generations = crate::state::Record::new(document.clone())?.generations;
    let graph = crate::compile::compile(document, &generations, &bundle.manifest.version)?;
    let schemas = schemas(&bundle, &graph, cancel).await?;
    let (mut project, lifted, lifted_graph) = rendered(document, &graph, &schemas)?;
    format(&bundle, &mut project, cancel).await?;
    let about = readme::About {
        source,
        version: &bundle.manifest.version,
        opentofu: &bundle.manifest.opentofu,
        bundle: &bundle.directory,
    };
    let readme = readme::readme(
        document,
        &lifted_graph,
        &lifted.variables,
        &project.files,
        &about,
    );
    project.files.insert("README.md".into(), readme);
    fs::create_dir_all(output).map_err(|error| ProjectError::Io {
        path: output.into(),
        error,
    })?;
    for (name, text) in &project.files {
        write_file(&output.join(name), text)?;
    }
    Ok(project)
}

fn scratch() -> Result<tempfile::TempDir, ProjectError> {
    tempfile::tempdir().map_err(|error| ProjectError::Io {
        path: std::env::temp_dir(),
        error,
    })
}

fn write_file(path: &Path, text: &str) -> Result<(), ProjectError> {
    fs::write(path, text).map_err(|error| ProjectError::Io {
        path: path.into(),
        error,
    })
}
