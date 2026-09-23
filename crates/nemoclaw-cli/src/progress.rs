// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use crate::{
    args::ProgressMode,
    formatting::{duration, resource_label, terminal_text},
    style::{Palette, Tone},
};
use nemoclaw_sdk::{DownloadPhase, Progress, StepOutcome};
use ratatui::{
    Terminal, TerminalOptions, Viewport,
    backend::Backend,
    text::{Line, Span, Text},
    widgets::{Paragraph, Widget, Wrap},
};
use std::{
    collections::BTreeMap,
    io::{self, IsTerminal, Write},
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

mod backend;
mod logo;
use backend::OutputBackend;

const HEARTBEAT: Duration = Duration::from_secs(30);
const PANEL_HEIGHT: u16 = 8;

/// One owner for stderr while an operation runs. Construction does not touch the terminal:
/// credential prompts may still run before the first SDK progress event.
pub(crate) struct Reporter {
    sender: Option<mpsc::Sender<Option<Progress>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Reporter {
    pub(crate) fn new(mode: ProgressMode, verbose: bool, header: String) -> Self {
        if matches!(mode, ProgressMode::Off) {
            return Self {
                sender: None,
                worker: None,
            };
        }
        let (sender, receiver) = mpsc::channel();
        let inline = matches!(mode, ProgressMode::Auto)
            && io::stderr().is_terminal()
            && std::env::var("TERM").is_ok_and(|term| term != "dumb");
        let worker = thread::spawn(move || run(receiver, inline, verbose, header));
        Self {
            sender: Some(sender),
            worker: Some(worker),
        }
    }

    pub(crate) fn callback(&self) -> Arc<dyn Fn(Progress) + Send + Sync> {
        let sender = self.sender.clone();
        Arc::new(move |event| {
            if let Some(sender) = &sender {
                let _ = sender.send(Some(event));
            }
        })
    }

    pub(crate) fn finish(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(None);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Reporter {
    fn drop(&mut self) {
        self.finish();
    }
}

struct Active {
    stage: String,
    text: String,
    started: Instant,
}
#[derive(Default)]
struct Model {
    active: BTreeMap<String, Active>,
    palette: Palette,
    phase: Option<&'static str>,
}

impl Model {
    /// Return durable observations only when the stage changes. Byte/elapsed updates remain
    /// visible in the panel and periodic plain heartbeat without flooding redirected logs.
    fn observe(&mut self, event: Progress, verbose: bool, now: Instant) -> Option<String> {
        if let Some(phase) = phase_label(&event) {
            let changed = self.phase != Some(phase);
            self.phase = Some(phase);
            return changed.then(|| phase.to_owned());
        }
        let text = render(event.clone(), verbose);
        let (key, stage, elapsed, complete) = match &event {
            Progress::Waiting { operation, elapsed } => (
                format!("step:{operation}"),
                operation.to_string(),
                *elapsed,
                false,
            ),
            Progress::Completed {
                operation, elapsed, ..
            } => (format!("step:{operation}"), String::new(), *elapsed, true),
            Progress::Resource {
                resource,
                address,
                action,
                status,
                elapsed,
            } => (
                format!(
                    "resource:{}:{action}",
                    address.as_deref().unwrap_or(resource)
                ),
                format!("{action}:{status}"),
                *elapsed,
                matches!(*status, "complete" | "failed" | "errored"),
            ),
            Progress::Download(download) => (
                format!(
                    "download:{}:{}:{:?}",
                    download.resource, download.artifact, download.layer
                ),
                format!("{:?}", download.phase),
                Duration::ZERO,
                download.phase == DownloadPhase::Complete,
            ),
            _ => return text,
        };
        if complete {
            self.active.remove(&key);
            // A failed graph can end before every resource produces a terminal event.
            if matches!(
                event,
                Progress::Completed {
                    operation: "tofu.apply",
                    ..
                }
            ) {
                self.active.retain(|key, _| {
                    !key.starts_with("resource:") && !key.starts_with("download:")
                });
            }
            return text;
        }
        let text = text?;
        let active_text = match event {
            Progress::Waiting { operation, .. } => {
                operation_label(operation).unwrap_or(operation).to_string()
            }
            Progress::Resource {
                resource,
                address,
                action,
                status,
                ..
            } => {
                let name = resource_name(resource, address.as_deref(), verbose);
                format!("{name}: {action} {status}")
            }
            _ => text.clone(),
        };
        let changed = self
            .active
            .get(&key)
            .is_none_or(|entry| entry.stage != stage);
        let started = if elapsed.is_zero() {
            self.active.get(&key).map_or(now, |entry| entry.started)
        } else {
            now.checked_sub(elapsed).unwrap_or(now)
        };
        self.active.insert(
            key,
            Active {
                stage,
                text: active_text,
                started,
            },
        );
        changed.then_some(text)
    }

    fn lines(&self, now: Instant) -> Vec<String> {
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

fn run(receiver: mpsc::Receiver<Option<Progress>>, inline: bool, verbose: bool, header: String) {
    let Ok(Some(first)) = receiver.recv() else {
        return;
    };
    let mut output = io::stderr();
    let palette = Palette::detect(inline);
    let image_brand = logo::write_brand(&mut output, palette).unwrap_or(false);
    let mut terminal = inline
        .then(|| {
            OutputBackend::new()
                .and_then(|backend| {
                    Terminal::with_options(
                        backend,
                        TerminalOptions {
                            viewport: Viewport::Inline(1),
                        },
                    )
                })
                .ok()
        })
        .flatten();
    if let Some(display) = terminal.as_mut() {
        if insert_header(display, &header, palette, image_brand).is_err() {
            finish_terminal(&mut terminal);
            let _ = writeln!(output, "{header}");
        }
    } else {
        let _ = writeln!(output, "{header}");
    }
    let mut terminal_size = terminal.as_ref().and_then(|terminal| terminal.size().ok());
    let mut model = Model {
        palette,
        ..Model::default()
    };
    let started = Instant::now();
    let mut heartbeat = started;
    let mut next_frame = started;
    let mut next = Some(first);
    loop {
        let now = Instant::now();
        let milestone = next.take().and_then(|event| {
            let tone = event_tone(&event);
            let durable = verbose || durable_event(&event);
            model
                .observe(event, verbose, now)
                .map(|line| (line, tone, durable))
        });
        // Recreate only the owned viewport on size/height changes; Ratatui's automatic
        // horizontal shrink would otherwise clear unrelated screen contents.
        if let Some(display) = terminal.as_mut() {
            let size = display.backend().current_size().ok();
            let height = size.map(|size| panel_height(&model, now, size.width, size.height));
            if size != terminal_size || height != Some(display.get_frame().area().height) {
                finish_terminal(&mut terminal);
                terminal = OutputBackend::new()
                    .and_then(|backend| {
                        Terminal::with_options(
                            backend,
                            TerminalOptions {
                                viewport: Viewport::Inline(height.unwrap_or(1)),
                            },
                        )
                    })
                    .ok();
                terminal_size = terminal.as_ref().and_then(|display| display.size().ok());
                next_frame = now;
            }
        }
        if let Some((line, tone, durable)) = milestone
            && (terminal.is_none() || durable)
        {
            if let Some(display) = terminal.as_mut() {
                if insert_line(display, &line, palette, tone).is_err() {
                    finish_terminal(&mut terminal);
                    let _ = writeln!(output, "{line}");
                }
            } else {
                let _ = writeln!(output, "{line}");
            }
        }
        if let Some(display) = terminal.as_mut() {
            if draw_due(
                display,
                &model,
                now,
                now.duration_since(started),
                &mut next_frame,
            )
            .is_err()
            {
                finish_terminal(&mut terminal);
            }
        } else if now.duration_since(heartbeat) >= HEARTBEAT {
            let _ = writeln!(
                output,
                "Still working · elapsed {}",
                duration(now.duration_since(started))
            );
            for line in model.lines(now) {
                let _ = writeln!(output, "  {line}");
            }
            heartbeat = now;
        }
        let timeout = if terminal.is_some() {
            next_frame.saturating_duration_since(Instant::now())
        } else {
            Duration::from_millis(250)
        };
        match receiver.recv_timeout(timeout) {
            Ok(Some(event)) => next = Some(event),
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    finish_terminal(&mut terminal);
}

fn finish_terminal(terminal: &mut Option<Terminal<OutputBackend>>) {
    if let Some(mut terminal) = terminal.take() {
        let _ = clear_panel(&mut terminal);
        let _ = terminal.show_cursor();
    }
}

fn clear_panel<B: Backend>(terminal: &mut Terminal<B>) -> Result<(), B::Error> {
    // insert_before can leave the backend cursor below the panel between capped frames.
    let origin = terminal.get_frame().area().as_position();
    terminal.set_cursor_position(origin)?;
    terminal.clear()?;
    terminal.backend_mut().flush()
}

fn panel_height(model: &Model, now: Instant, width: u16, height: u16) -> u16 {
    let lines: usize = model
        .lines(now)
        .iter()
        .map(|line| {
            Paragraph::new(format!("› {line}"))
                .wrap(Wrap { trim: false })
                .line_count(width.max(1))
        })
        .sum();
    (lines.saturating_add(1).min(PANEL_HEIGHT as usize) as u16)
        .min(height)
        .max(1)
}

fn phase_label(event: &Progress) -> Option<&'static str> {
    match event {
        Progress::Validating => Some("Checking configuration"),
        Progress::Planning => Some("Planning deployment"),
        Progress::Applying => Some("Applying deployment"),
        Progress::Readiness => Some("Checking readiness"),
        Progress::Exporting => Some("Reading deployed configuration"),
        Progress::Destroying => Some("Destroying owned workloads"),
        _ => None,
    }
}

fn durable_event(event: &Progress) -> bool {
    match event {
        Progress::Waiting { .. } => false,
        Progress::Resource {
            status: "started" | "in_progress",
            ..
        } => false,
        Progress::Download(download) => {
            download.layer.is_none() && download.phase == DownloadPhase::Complete
        }
        _ => phase_label(event).is_none(),
    }
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

fn event_tone(event: &Progress) -> Tone {
    match event {
        Progress::Completed {
            outcome: StepOutcome::Failed,
            ..
        }
        | Progress::Resource {
            status: "failed" | "errored",
            ..
        } => Tone::Error,
        Progress::Completed {
            outcome: StepOutcome::Cancelled,
            ..
        }
        | Progress::Destroying => Tone::Warning,
        Progress::Completed {
            outcome: StepOutcome::Succeeded,
            ..
        }
        | Progress::Resource {
            status: "complete", ..
        } => Tone::Success,
        _ => Tone::Muted,
    }
}

fn insert_line<B: Backend>(
    terminal: &mut Terminal<B>,
    line: &str,
    palette: Palette,
    tone: Tone,
) -> Result<(), B::Error> {
    let marker = match tone {
        Tone::Success => "✓ ",
        Tone::Error => "✗ ",
        Tone::Warning => "! ",
        _ => "· ",
    };
    let paragraph = Paragraph::new(Line::from(vec![
        Span::styled(marker, palette.style(tone)),
        Span::raw(line),
    ]));
    insert_paragraph(terminal, paragraph)
}

fn insert_header<B: Backend>(
    terminal: &mut Terminal<B>,
    header: &str,
    palette: Palette,
    image_brand: bool,
) -> Result<(), B::Error> {
    let mut lines = if image_brand {
        Vec::new()
    } else {
        vec![
            Line::from(vec![
                Span::styled("NVIDIA", palette.style(Tone::Accent)),
                Span::raw(" / NemoClaw"),
            ]),
            Line::default(),
        ]
    };
    lines.extend(header.lines().map(Line::raw));
    insert_paragraph(terminal, Paragraph::new(Text::from(lines)))
}

fn insert_paragraph<B: Backend>(
    terminal: &mut Terminal<B>,
    paragraph: Paragraph<'_>,
) -> Result<(), B::Error> {
    let paragraph = paragraph.wrap(Wrap { trim: false });
    let width = terminal.size()?.width.max(1);
    let height = paragraph.line_count(width).min(u16::MAX as usize) as u16;
    terminal.insert_before(height.max(1), |buffer| {
        paragraph.render(buffer.area, buffer)
    })?;
    // Leave a stable origin even when the next frame is throttled or the terminal resizes.
    let origin = terminal.get_frame().area().as_position();
    terminal.set_cursor_position(origin)?;
    terminal.backend_mut().flush()
}

fn draw_due<B: Backend>(
    terminal: &mut Terminal<B>,
    model: &Model,
    now: Instant,
    elapsed: Duration,
    next_frame: &mut Instant,
) -> Result<(), B::Error> {
    if now < *next_frame {
        return Ok(());
    }
    *next_frame = now + Duration::from_millis(250);
    draw(terminal, model, now, elapsed)
}

fn draw<B: Backend>(
    terminal: &mut Terminal<B>,
    model: &Model,
    now: Instant,
    elapsed: Duration,
) -> Result<(), B::Error> {
    let size = terminal.size()?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    terminal
        .draw(|frame| {
            let area = frame.area();
            let mut remaining = area.height.saturating_sub(1);
            let mut y = area.y;
            let lines = model.lines(now);
            for (index, line) in lines.iter().enumerate() {
                let paragraph = Paragraph::new(Line::from(vec![
                    Span::styled("› ", model.palette.style(Tone::Accent)),
                    Span::raw(line.as_str()),
                ]))
                .wrap(Wrap { trim: false });
                let height = paragraph
                    .line_count(area.width)
                    .max(1)
                    .min(u16::MAX as usize) as u16;
                if height > remaining || (height == remaining && index + 1 < lines.len()) {
                    if remaining > 0 {
                        frame.render_widget(
                            Paragraph::new(format!(
                                "{} more active; see milestones above",
                                lines.len() - index
                            )),
                            ratatui::layout::Rect::new(area.x, y, area.width, 1),
                        );
                    }
                    break;
                }
                frame.render_widget(
                    paragraph,
                    ratatui::layout::Rect::new(area.x, y, area.width, height),
                );
                y += height;
                remaining -= height;
            }
            if area.height > 0 {
                frame.render_widget(
                    Paragraph::new(format!("Elapsed: {}", duration(elapsed)))
                        .style(model.palette.style(Tone::Muted)),
                    ratatui::layout::Rect::new(area.x, area.bottom() - 1, area.width, 1),
                );
            }
            frame.set_cursor_position((area.x, area.y));
        })
        .map(|_| ())
}

fn resource_name(resource: &str, address: Option<&str>, verbose: bool) -> String {
    match address {
        Some(address) if verbose => terminal_text(address),
        Some(address) => resource_label(address),
        None => terminal_text(resource),
    }
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

pub(crate) fn render(event: Progress, verbose: bool) -> Option<String> {
    if !verbose {
        match &event {
            Progress::Resource {
                address: Some(address),
                action,
                status,
                ..
            } if (supporting_resource(address)
                || (*action == "refresh" && resource_label(address) != *address))
                && matches!(*status, "started" | "complete" | "in_progress") =>
            {
                return None;
            }
            Progress::Waiting {
                operation: "tofu.init" | "tofu.plan" | "tofu.apply",
                ..
            }
            | Progress::Completed {
                operation: "tofu.init" | "tofu.plan" | "tofu.apply",
                outcome: StepOutcome::Succeeded,
                ..
            } => return None,
            _ => {}
        }
    }
    let text = match event {
        Progress::Download(event) => {
            let phase = match event.phase {
                DownloadPhase::Starting => "starting download of",
                DownloadPhase::Downloading => "downloading",
                DownloadPhase::Extracting => "extracting",
                DownloadPhase::Verifying => "verifying",
                DownloadPhase::Complete if event.layer.is_none() => "downloaded",
                DownloadPhase::Complete => "finished layer of",
            };
            let mut text = format!("{}: {phase} {}", event.resource, event.artifact);
            if let Some(layer) = event.layer {
                text.push_str(&format!(" [{layer}]"));
            }
            if let Some(bytes) = event.bytes {
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
            text
        }
        Progress::Resource {
            resource,
            address,
            action,
            status,
            elapsed,
        } => {
            let name = resource_name(resource, address.as_deref(), verbose);
            if status == "started" {
                return Some(format!("{name}: {action} {status}"));
            }
            return Some(format!("{name}: {action} {status} ({})", duration(elapsed)));
        }
        Progress::Waiting { operation, elapsed } => {
            let label = operation_label(operation).or(verbose.then_some(operation))?;
            if elapsed.is_zero() {
                label.into()
            } else {
                format!("{label} ({})", duration(elapsed))
            }
        }
        Progress::Completed {
            operation,
            elapsed,
            outcome,
        } => {
            let label = if verbose {
                operation
            } else {
                operation_label(operation)
                    .or((outcome != StepOutcome::Succeeded).then_some(operation))?
            };
            let status = match outcome {
                StepOutcome::Succeeded => "complete",
                StepOutcome::Failed => "failed",
                StepOutcome::Cancelled => "cancelled",
            };
            format!("{label}: {status} ({})", duration(elapsed))
        }
        Progress::Validating => "Checking deployment configuration".into(),
        Progress::Planning => "Planning deployment".into(),
        Progress::Applying => "Applying deployment".into(),
        Progress::Readiness => "Checking deployment readiness".into(),
        Progress::Exporting => "Reading deployed configuration".into(),
        Progress::Destroying => "Destroying owned workloads".into(),
    };
    Some(terminal_text(&text))
}

#[cfg(test)]
mod tests;
