// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::app::{Input, Wizard};
use nemoclaw_authoring::{
    Capabilities, CompatibilityStatus, DiscoveryEvidence, DiscoveryQuery, Draft,
};
use nemoclaw_sdk::{
    CancellationToken, Error,
    discovery::{DiscoveryRequest, ObservationStatus},
    discovery_session::DiscoverySession,
};
use ratatui::{Terminal, TerminalOptions, Viewport, backend::CrosstermBackend, layout::Rect};
use std::{io, time::Duration};

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        crossterm::terminal::enable_raw_mode()?;
        if let Err(error) = crossterm::execute!(
            io::stderr(),
            crossterm::terminal::EnterAlternateScreen,
            crossterm::cursor::Hide
        ) {
            let _ = crossterm::terminal::disable_raw_mode();
            return Err(error);
        }
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = crossterm::execute!(
            io::stderr(),
            crossterm::terminal::LeaveAlternateScreen,
            crossterm::cursor::Show
        );
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

pub(crate) async fn run(
    capabilities: Capabilities,
    draft: Draft,
    cancel: &CancellationToken,
    bundle: Option<&std::path::Path>,
) -> Result<Option<Draft>, Box<dyn std::error::Error>> {
    let _guard = TerminalGuard::enter()?;
    let area = terminal_area();
    let mut terminal = Terminal::with_options(
        CrosstermBackend::new(io::stderr()),
        TerminalOptions {
            viewport: Viewport::Fixed(area),
        },
    )?;
    let mut wizard = Wizard::new(capabilities, draft);
    let mut discovery = bundle.and_then(|path| DiscoverySession::new(path).ok());
    let mut last_target = None;
    let mut was_review = false;
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled.into());
        }
        let target = wizard.draft().discovery_key()?;
        let is_review = wizard.step == super::app::Step::Review;
        if last_target.as_ref() != Some(&target) || (is_review && !was_review) {
            if let Some(reason) = wizard.runtime_unavailable_reason(target.compute_driver) {
                wizard.target_status = Some(format!(
                    "The template's Podman preset {reason}. Choose Docker to continue on this host."
                ));
            } else {
                wizard.target_status =
                    Some("Discovering the selected engine and Fabric image…".into());
                terminal.draw(|frame| wizard.render(frame))?;
                let evidence = check_target(
                    discovery.as_mut(),
                    wizard.draft(),
                    wizard.discovery.clone(),
                    is_review,
                    cancel,
                )
                .await?;
                wizard.target_status = Some(discovery_status(
                    &evidence,
                    wizard.draft(),
                    discovery.is_some(),
                ));
                wizard.discovery = Some(evidence);
            }
            last_target = Some(target);
        }
        was_review = is_review;
        terminal.draw(|frame| wizard.render(frame))?;
        if wizard.accepted() {
            return Ok(Some(wizard.draft().clone()));
        }
        if wizard.cancelled() {
            return Ok(None);
        }
        if !crossterm::event::poll(Duration::from_millis(50))? {
            continue;
        }
        let event = crossterm::event::read()?;
        if let crossterm::event::Event::Resize(width, height) = event {
            terminal.resize(Rect::new(0, 0, width, height))?;
            continue;
        }
        let crossterm::event::Event::Key(key) = event else {
            continue;
        };
        if key.kind != crossterm::event::KeyEventKind::Press {
            continue;
        }
        use crossterm::event::{KeyCode, KeyModifiers};
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Err(Error::Cancelled.into());
        }
        let input = match (key.code, key.modifiers) {
            (KeyCode::Esc, _) => Input::Cancel,
            (KeyCode::Enter, _) => Input::Continue,
            (KeyCode::Up, _) => Input::Previous,
            (KeyCode::Down, _) => Input::Next,
            (KeyCode::Left, _) => Input::Back,
            (KeyCode::Backspace, _) => Input::Backspace,
            (KeyCode::Char('a'), modifiers) if modifiers.contains(KeyModifiers::CONTROL) => {
                Input::SelectAll
            }
            (KeyCode::Char(character), modifiers)
                if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                Input::Character(character)
            }
            _ => continue,
        };
        wizard.handle(input);
    }
}

#[cfg(unix)]
fn terminal_area() -> Rect {
    let size = rustix::termios::tcgetwinsize(std::io::stdin()).ok();
    let width = size.map_or(80, |size| nonzero_or(size.ws_col, 80));
    let height = size.map_or(24, |size| nonzero_or(size.ws_row, 24));
    Rect::new(0, 0, width, height)
}

#[cfg(not(unix))]
fn terminal_area() -> Rect {
    let (width, height) = crossterm::terminal::size().unwrap_or((80, 24));
    Rect::new(0, 0, nonzero_or(width, 80), nonzero_or(height, 24))
}

const fn nonzero_or(value: u16, fallback: u16) -> u16 {
    if value == 0 { fallback } else { value }
}

async fn check_target(
    session: Option<&mut DiscoverySession>,
    draft: &Draft,
    prior: Option<DiscoveryEvidence>,
    refresh: bool,
    cancel: &CancellationToken,
) -> Result<DiscoveryEvidence, Error> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let key = draft
        .discovery_key()
        .map_err(|_| Error::State("invalid discovery selection"))?;
    let mut evidence = prior.unwrap_or_else(|| DiscoveryEvidence {
        key: key.clone(),
        engine: None,
        fabric: None,
    });
    evidence.retarget(key);
    if refresh {
        evidence.engine = None;
        evidence.fabric = None;
    }
    let Some(session) = session else {
        return Ok(evidence);
    };
    // The dependency graph schedules the engine first and the image only when
    // engine evidence permits it. Completed unknown reads are not retried here.
    for _ in 0..2 {
        let assessment = evidence
            .assessment(draft)
            .map_err(|_| Error::State("invalid discovery selection"))?;
        match assessment.pending.first() {
            Some(DiscoveryQuery::Engine) => {
                evidence.engine = Some(
                    match session
                        .engine(
                            &DiscoveryRequest {
                                engine: evidence.key.engine.clone(),
                                compute_driver: evidence.key.compute_driver,
                            },
                            cancel,
                        )
                        .await
                    {
                        Ok(observed) => observed,
                        Err(Error::Cancelled) => return Err(Error::Cancelled),
                        Err(_) => nemoclaw_sdk::discovery::EngineObservation {
                            status: ObservationStatus::Unknown,
                            reason: Some("provider discovery failed".into()),
                            source: "opentofu".into(),
                            server_version: None,
                            architecture: None,
                            operating_system: None,
                            memory_bytes: None,
                            cpus: None,
                        },
                    },
                );
            }
            Some(DiscoveryQuery::Fabric) => {
                evidence.fabric = Some(
                    match session
                        .fabric(&evidence.key.engine, &evidence.key.image, cancel)
                        .await
                    {
                        Ok(observed) => observed,
                        Err(Error::Cancelled) => return Err(Error::Cancelled),
                        Err(_) => nemoclaw_sdk::discovery::FabricObservation {
                            status: ObservationStatus::Unknown,
                            reason: Some("provider discovery failed".into()),
                            source: "opentofu".into(),
                            image_id: None,
                            catalog: None,
                            image: Default::default(),
                            compatibility: None,
                            adapters: Vec::new(),
                        },
                    },
                );
            }
            None => break,
        }
    }
    Ok(evidence)
}

fn discovery_status(evidence: &DiscoveryEvidence, draft: &Draft, has_bundle: bool) -> String {
    if !has_bundle {
        return "Target unverified: a verified native bundle is needed for discovery. Choices use bundled Fabric metadata; you can save for later.".into();
    }
    match evidence.assessment(draft) {
        Ok(assessment) if assessment.status == CompatibilityStatus::Compatible =>
            "Engine prerequisites and advertised Fabric adapter match. Deployment readiness still needs plan/apply.".into(),
        Ok(assessment) if assessment.status == CompatibilityStatus::Conflict =>
            format!("{} Go back to revise the configuration before saving.", assessment.reasons.join(" ")),
        _ => "Target unverified. Choices use bundled Fabric metadata; you can save for later and plan will check again.".into(),
    }
}

#[cfg(test)]
mod target_tests {
    use super::*;

    fn draft() -> Draft {
        crate::load(crate::Source::Defaults, &Capabilities::available()).unwrap()
    }

    #[tokio::test]
    async fn no_bundle_keeps_target_unknown_and_allows_offline_authoring() {
        let draft = draft();
        let evidence = check_target(None, &draft, None, false, &CancellationToken::new())
            .await
            .unwrap();
        let result = discovery_status(&evidence, &draft, false);
        assert!(result.contains("unverified"));
        assert!(result.contains("bundled Fabric"));
        assert_eq!(
            evidence.assessment(&draft).unwrap().status,
            CompatibilityStatus::Unverified
        );
    }

    #[tokio::test]
    async fn cancelling_discovery_stops_authoring_even_without_a_bundle() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            check_target(None, &draft(), None, false, &cancel).await,
            Err(Error::Cancelled)
        ));
    }
}
