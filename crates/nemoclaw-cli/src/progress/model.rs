// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Interpret SDK events once for both inline progress and plain transcripts.
//! Identities and stages track concurrent work; text and semantic tones are presentation only.

use crate::{
    formatting::{duration, resource_label, terminal_text},
    style::Tone,
};
use nemoclaw_sdk::{DownloadPhase, DownloadProgress, Progress, StepOutcome};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

// Keep the existing download/resource/step display order without encoding identity in text.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
enum Identity {
    Download(String, String, Option<String>),
    Resource(String, &'static str),
    Step(&'static str),
}

#[derive(PartialEq, Eq)]
enum Stage {
    Waiting,
    Resource(&'static str),
    Download(DownloadPhase),
}

pub(super) struct Milestone {
    pub(super) text: String,
    pub(super) tone: Tone,
    pub(super) durable: bool,
}

impl Milestone {
    fn new(text: String, tone: Tone, durable: bool) -> Self {
        Self {
            text: terminal_text(&text),
            tone,
            durable,
        }
    }
}

struct Update {
    identity: Identity,
    // None settles the operation, including hidden successful supporting steps.
    stage: Option<Stage>,
    elapsed: Duration,
    active_text: String,
    milestone: Option<Milestone>,
}

struct Active {
    stage: Stage,
    text: String,
    started: Instant,
}

#[derive(Default)]
pub(super) struct Model {
    active: BTreeMap<Identity, Active>,
    phase: Option<&'static str>,
}

impl Model {
    /// Byte and elapsed updates refresh active work without repeating transcript milestones.
    pub(super) fn observe(
        &mut self,
        event: Progress,
        verbose: bool,
        now: Instant,
    ) -> Option<Milestone> {
        let update = match event {
            Progress::Waiting { operation, elapsed } => {
                let label = operation_label(operation).or(verbose.then_some(operation));
                let visible = verbose || !infrastructure_step(operation);
                let text = label.map(|label| {
                    if elapsed.is_zero() {
                        label.to_owned()
                    } else {
                        format!("{label} ({})", duration(elapsed))
                    }
                });
                Update {
                    identity: Identity::Step(operation),
                    stage: Some(Stage::Waiting),
                    elapsed,
                    active_text: terminal_text(label.unwrap_or(operation)),
                    milestone: text
                        .filter(|_| visible)
                        .map(|text| Milestone::new(text, Tone::Muted, verbose)),
                }
            }
            Progress::Completed {
                operation,
                elapsed,
                outcome,
            } => {
                // A failed graph can stop before every resource sends a terminal event.
                if operation == "tofu.apply" {
                    self.active
                        .retain(|identity, _| matches!(identity, Identity::Step(_)));
                }
                let label = if verbose {
                    Some(operation)
                } else {
                    operation_label(operation)
                        .or((outcome != StepOutcome::Succeeded).then_some(operation))
                };
                let visible =
                    verbose || !infrastructure_step(operation) || outcome != StepOutcome::Succeeded;
                let (status, tone) = match outcome {
                    StepOutcome::Succeeded => ("complete", Tone::Success),
                    StepOutcome::Failed => ("failed", Tone::Error),
                    StepOutcome::Cancelled => ("cancelled", Tone::Warning),
                };
                Update {
                    identity: Identity::Step(operation),
                    stage: None,
                    elapsed,
                    active_text: String::new(),
                    milestone: label.filter(|_| visible).map(|label| {
                        Milestone::new(
                            format!("{label}: {status} ({})", duration(elapsed)),
                            tone,
                            true,
                        )
                    }),
                }
            }
            Progress::Resource {
                resource,
                address,
                action,
                status,
                elapsed,
            } => {
                let name = match address.as_deref() {
                    Some(address) if verbose => terminal_text(address),
                    Some(address) => resource_label(address),
                    None => terminal_text(resource),
                };
                let supporting = address.as_deref().is_some_and(|address| {
                    supporting_resource(address)
                        || (action == "refresh" && resource_label(address) != address)
                });
                let (complete, tone, durable, hide_supporting) = match status {
                    "started" | "in_progress" => (false, Tone::Muted, false, true),
                    "complete" => (true, Tone::Success, true, true),
                    "failed" | "errored" => (true, Tone::Error, true, false),
                    _ => (false, Tone::Muted, true, false),
                };
                let active_text = format!("{name}: {action} {status}");
                let text = if status == "started" {
                    active_text.clone()
                } else {
                    format!("{active_text} ({})", duration(elapsed))
                };
                Update {
                    identity: Identity::Resource(
                        address.unwrap_or_else(|| resource.into()),
                        action,
                    ),
                    stage: (!complete).then_some(Stage::Resource(status)),
                    elapsed,
                    active_text,
                    milestone: (verbose || !supporting || !hide_supporting)
                        .then(|| Milestone::new(text, tone, verbose || durable)),
                }
            }
            Progress::Download(download) => {
                let text = download_text(&download);
                let complete = download.phase == DownloadPhase::Complete;
                let durable = verbose || (complete && download.layer.is_none());
                Update {
                    identity: Identity::Download(
                        download.resource,
                        download.artifact,
                        download.layer,
                    ),
                    stage: (!complete).then_some(Stage::Download(download.phase)),
                    elapsed: Duration::ZERO,
                    active_text: text.clone(),
                    milestone: Some(Milestone::new(text, Tone::Muted, durable)),
                }
            }
            Progress::Validating => {
                return self.phase("Checking configuration", Tone::Muted, verbose);
            }
            Progress::Planning => return self.phase("Planning deployment", Tone::Muted, verbose),
            Progress::Applying => return self.phase("Applying deployment", Tone::Muted, verbose),
            Progress::Readiness => return self.phase("Checking readiness", Tone::Muted, verbose),
            Progress::Exporting => {
                return self.phase("Reading deployed configuration", Tone::Muted, verbose);
            }
            Progress::Destroying => {
                return self.phase("Destroying owned workloads", Tone::Warning, verbose);
            }
        };
        let Some(stage) = update.stage else {
            self.active.remove(&update.identity);
            return update.milestone;
        };
        let milestone = update.milestone?;
        let previous = self.active.get(&update.identity);
        let changed = previous.is_none_or(|entry| entry.stage != stage);
        let started = if update.elapsed.is_zero() {
            previous.map_or(now, |entry| entry.started)
        } else {
            now.checked_sub(update.elapsed).unwrap_or(now)
        };
        self.active.insert(
            update.identity,
            Active {
                stage,
                text: update.active_text,
                started,
            },
        );
        changed.then_some(milestone)
    }

    fn phase(&mut self, label: &'static str, tone: Tone, verbose: bool) -> Option<Milestone> {
        let changed = self.phase != Some(label);
        self.phase = Some(label);
        changed.then(|| Milestone::new(label.into(), tone, verbose))
    }

    pub(super) fn lines(&self, now: Instant) -> Vec<String> {
        if self.active.is_empty() {
            return self.phase.map(str::to_owned).into_iter().collect();
        }
        self.active
            .values()
            .map(|entry| {
                format!(
                    "{} · elapsed {}",
                    entry.text,
                    duration(now.saturating_duration_since(entry.started))
                )
            })
            .collect()
    }
}

fn infrastructure_step(operation: &str) -> bool {
    matches!(operation, "tofu.init" | "tofu.plan" | "tofu.apply")
}

fn supporting_resource(address: &str) -> bool {
    matches!(
        address,
        "nemoclaw_workspace.deployment"
            | "nemoclaw_gateway_storage.runtime"
            | "data.nemoclaw_gateway_capabilities.current"
            | "data.nemoclaw_gateway_capabilities.apply"
    ) || [
        "data.docker_image.image_",
        "docker_image.image_",
        "nemoclaw_provider_profile.inference_",
        "nemoclaw_provider.inference_",
    ]
    .iter()
    .any(|prefix| address.starts_with(prefix))
}

fn operation_label(operation: &str) -> Option<&str> {
    match operation {
        "tofu.init" => Some("Initializing infrastructure"),
        "tofu.plan" => Some("Planning infrastructure changes"),
        "tofu.apply" => Some("Applying infrastructure changes"),
        "runtime.ready" => Some("Waiting for gateway and inference readiness"),
        "sandbox.ready" => Some("Waiting for sandbox readiness"),
        "fabric.health" => Some("Checking hosted Fabric health"),
        _ => None,
    }
}

fn byte_count(bytes: u64) -> String {
    for (unit, divisor) in [("GiB", 1_u64 << 30), ("MiB", 1 << 20), ("KiB", 1 << 10)] {
        if bytes >= divisor {
            return format!("{:.1} {unit}", bytes as f64 / divisor as f64);
        }
    }
    format!("{bytes} B")
}

fn download_text(event: &DownloadProgress) -> String {
    let phase = match event.phase {
        DownloadPhase::Starting => "starting download of",
        DownloadPhase::Downloading => "downloading",
        DownloadPhase::Extracting => "extracting",
        DownloadPhase::Verifying => "verifying",
        DownloadPhase::Complete if event.layer.is_none() => "downloaded",
        DownloadPhase::Complete => "finished layer of",
    };
    let mut text = format!("{}: {phase} {}", event.resource, event.artifact);
    if let Some(layer) = &event.layer {
        text.push_str(&format!(" [{layer}]"));
    }
    if let Some(bytes) = &event.bytes {
        if let Some(total) = bytes
            .total
            .filter(|total| *total > 0 && bytes.completed <= *total)
        {
            let percent = u128::from(bytes.completed) * 100 / u128::from(total);
            text.push_str(&format!(
                " {percent}% ({} / {})",
                byte_count(bytes.completed),
                byte_count(total)
            ));
        } else {
            text.push_str(&format!(" {}", byte_count(bytes.completed)));
        }
    }
    terminal_text(&text)
}

#[cfg(test)]
mod tests;
