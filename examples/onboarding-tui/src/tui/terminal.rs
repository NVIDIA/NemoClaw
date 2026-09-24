// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::app::{Input, Wizard};
use nemoclaw_authoring::{
    AuthoringFacts, Capabilities, CompatibilityStatus, DiscoveryEvidence, Draft, EndpointEvidence,
    GatewayEvidence, HardwareEvidence,
};
use nemoclaw_sdk::{
    CancellationToken, Error,
    discovery::{DiscoveryRequest, ObservationStatus},
    discovery_session::{DiscoveryObservation, DiscoveryQuery, DiscoverySession},
};
use ratatui::{Terminal, TerminalOptions, Viewport, backend::CrosstermBackend, layout::Rect};
use std::{collections::VecDeque, io, time::Duration};

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
    let mut last_inputs = None;
    let mut queued_events = VecDeque::new();
    let mut was_review = false;
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled.into());
        }
        let target = wizard.draft().discovery_key()?;
        let endpoint = wizard.draft().inference_request(&wizard.capabilities)?;
        let inputs = (
            target.clone(),
            endpoint,
            wizard.draft().document().spec.gateway.clone(),
            wizard
                .draft()
                .document()
                .credential_names()
                .into_iter()
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        );
        let is_review = wizard.step == super::app::Step::Review;
        if last_inputs.as_ref() != Some(&inputs) || (is_review && !was_review) {
            wizard.target_status =
                Some("Discovering target hardware, image, gateway, and model catalog…".into());
            terminal.draw(|frame| wizard.render(frame))?;
            let discovery_cancel = cancel.child_token();
            let future = check_discovery(
                discovery.as_mut(),
                wizard.draft(),
                &wizard.capabilities,
                wizard.discovery.clone(),
                wizard.facts.clone(),
                is_review,
                &discovery_cancel,
            );
            let Some((evidence, facts)) = wait_for_discovery(
                future,
                cancel,
                &discovery_cancel,
                &mut queued_events,
                || {
                    if crossterm::event::poll(Duration::ZERO)? {
                        crossterm::event::read().map(Some)
                    } else {
                        Ok(None)
                    }
                },
            )
            .await?
            else {
                return Ok(None);
            };
            let mut status = discovery_status(&evidence, wizard.draft(), discovery.is_some());
            if let Some(reason) = wizard.runtime_unavailable_reason(target.compute_driver) {
                status = format!("Podman {reason}. Choose Docker to continue on this host.");
            }
            status.push('\n');
            status.push_str(&facts_status(&facts));
            wizard.target_status = Some(status);
            wizard.discovery = Some(evidence);
            wizard.facts = facts;
            last_inputs = Some(inputs);
        }
        was_review = is_review;
        terminal.draw(|frame| wizard.render(frame))?;
        if wizard.accepted() {
            return Ok(Some(wizard.draft().clone()));
        }
        if wizard.cancelled() {
            return Ok(None);
        }
        let event = if let Some(event) = queued_events.pop_front() {
            event
        } else {
            if !crossterm::event::poll(Duration::from_millis(50))? {
                continue;
            }
            crossterm::event::read()?
        };
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

/// Keep raw-mode cancellation responsive and preserve keys typed during reads.
async fn wait_for_discovery<T>(
    future: impl std::future::Future<Output = Result<T, Error>>,
    cancel: &CancellationToken,
    discovery_cancel: &CancellationToken,
    queue: &mut VecDeque<crossterm::event::Event>,
    mut poll: impl FnMut() -> io::Result<Option<crossterm::event::Event>>,
) -> Result<Option<T>, Error> {
    use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
    tokio::pin!(future);
    let mut interval = tokio::time::interval(Duration::from_millis(25));
    loop {
        tokio::select! {
            biased;
            () = cancel.cancelled() => {
                discovery_cancel.cancel();
                let _ = future.await;
                return Err(Error::Cancelled);
            }
            result = &mut future => return result.map(Some),
            _ = interval.tick() => {
                let event = match poll() {
                    Ok(Some(event)) => event,
                    Ok(None) => continue,
                    Err(_) => {
                        discovery_cancel.cancel();
                        let _ = future.await;
                        return Err(Error::State("terminal input could not be read"));
                    }
                };
                if let Event::Key(key) = event && key.kind == KeyEventKind::Press {
                    let interrupted = key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL);
                    if key.code == KeyCode::Esc || interrupted {
                        discovery_cancel.cancel();
                        // The process owner observes cancellation and reaps its process tree.
                        let _ = future.await;
                        return if interrupted { Err(Error::Cancelled) } else { Ok(None) };
                    }
                }
                queue.push_back(event);
            }
        }
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

async fn check_discovery(
    session: Option<&mut DiscoverySession>,
    draft: &Draft,
    capabilities: &Capabilities,
    prior: Option<DiscoveryEvidence>,
    mut facts: AuthoringFacts,
    refresh: bool,
    cancel: &CancellationToken,
) -> Result<(DiscoveryEvidence, AuthoringFacts), Error> {
    if cancel.is_cancelled() {
        return Err(Error::Cancelled);
    }
    let key = draft
        .discovery_key()
        .map_err(|_| Error::State("invalid discovery selection"))?;
    let request = draft
        .inference_request(capabilities)
        .map_err(|_| Error::State("invalid inference discovery selection"))?;
    let mut evidence = prior.unwrap_or_else(|| DiscoveryEvidence {
        key: key.clone(),
        engine: None,
        fabric: None,
    });
    evidence.retarget(key.clone());
    facts
        .retarget(draft, capabilities)
        .map_err(|_| Error::State("invalid discovery selection"))?;
    if refresh {
        evidence.engine = None;
        evidence.fabric = None;
        facts = AuthoringFacts::default();
    }
    // Credential availability stays a direct read and never enters OpenTofu state.
    facts.credentials = nemoclaw_sdk::inference_discovery::observe_credentials(
        draft.document(),
        &nemoclaw_sdk::openshell::EnvironmentSecrets,
    )?;
    let Some(session) = session else {
        return Ok((evidence, facts));
    };
    let mut queries = Vec::new();
    if evidence.engine.is_none() {
        queries.push(DiscoveryQuery::Engine(DiscoveryRequest {
            engine: key.engine.clone(),
            compute_driver: key.compute_driver,
        }));
    }
    if evidence.fabric.is_none() {
        queries.push(DiscoveryQuery::Fabric {
            engine: key.engine.clone(),
            image: key.image.clone(),
        });
    }
    if facts.hardware.is_none() {
        queries.push(DiscoveryQuery::Hardware {
            engine: key.engine.clone(),
        });
    }
    if facts.endpoint.is_none() && request.validate().is_ok() {
        queries.push(DiscoveryQuery::Inference(request));
    }
    if queries.is_empty() {
        return Ok((evidence, facts));
    }
    let observations = match session.batch(&queries, cancel).await {
        Ok(observations) => observations,
        Err(Error::Cancelled) => return Err(Error::Cancelled),
        Err(_) => return Ok((evidence, facts)),
    };
    for (query, observation) in queries.into_iter().zip(observations) {
        match (query, observation) {
            (DiscoveryQuery::Engine(_), DiscoveryObservation::Engine(observed)) => {
                evidence.engine = Some(observed)
            }
            (DiscoveryQuery::Fabric { .. }, DiscoveryObservation::Fabric(observed)) => {
                evidence.fabric = Some(observed)
            }
            (DiscoveryQuery::Hardware { engine }, DiscoveryObservation::Hardware(observation)) => {
                facts.hardware = Some(HardwareEvidence {
                    engine,
                    observation,
                })
            }
            (DiscoveryQuery::Inference(request), DiscoveryObservation::Inference(observation)) => {
                facts.endpoint = Some(EndpointEvidence {
                    request,
                    observation,
                })
            }
            _ => {
                return Err(Error::State(
                    "provider returned a different discovery observation",
                ));
            }
        }
    }
    // Gateway lifecycle reads remain strict and separate: a new managed gateway
    // can be absent without discarding successful engine or model observations.
    if refresh {
        match session
            .gateway(
                &draft.document().spec.gateway,
                &[key.compute_driver],
                cancel,
            )
            .await
        {
            Ok(observation) => {
                facts.gateway = Some(GatewayEvidence {
                    gateway: draft.document().spec.gateway.clone(),
                    compute_driver: key.compute_driver,
                    observation,
                })
            }
            Err(Error::Cancelled) => return Err(Error::Cancelled),
            Err(_) => {}
        }
    }
    Ok((evidence, facts))
}

fn facts_status(facts: &AuthoringFacts) -> String {
    let hardware = facts
        .hardware
        .as_ref()
        .map(|evidence| &evidence.observation);
    let architecture = hardware
        .and_then(|observed| observed.architecture.as_deref())
        .filter(|value| value.len() < 24 && !value.chars().any(char::is_control))
        .unwrap_or("architecture unknown");
    let memory = hardware
        .and_then(|observed| observed.memory_bytes)
        .map(|bytes| format!("{} GiB RAM", bytes / (1 << 30)))
        .unwrap_or_else(|| "RAM unknown".into());
    let models = match facts
        .endpoint
        .as_ref()
        .map(|evidence| &evidence.observation)
    {
        Some(observed) if observed.status == ObservationStatus::Available => {
            format!("{} advertised models", observed.models.len())
        }
        _ => "model catalog unverified".into(),
    };
    let available = facts
        .credentials
        .iter()
        .filter(|observed| observed.status == ObservationStatus::Available)
        .count();
    let gateway = match facts
        .gateway
        .as_ref()
        .map(|evidence| evidence.observation.status)
    {
        Some(ObservationStatus::Available) => "gateway compatible",
        Some(ObservationStatus::Unavailable) => "gateway incompatible",
        _ => "gateway unverified",
    };
    let gpu = hardware
        .filter(|observed| observed.gpu_inventory_complete)
        .map(|observed| format!("{} GPUs", observed.gpus.len()))
        .unwrap_or_else(|| "GPU details unknown".into());
    let missing = facts
        .credentials
        .iter()
        .filter(|observed| observed.status == ObservationStatus::Unavailable)
        .map(|observed| observed.reference.as_str())
        .take(2)
        .collect::<Vec<_>>();
    let missing = if missing.is_empty() {
        String::new()
    } else {
        format!("; missing {}", missing.join(", "))
    };
    format!(
        "{architecture}, {memory}, {gpu}.\n{models}; {gateway}.\nCredentials: {available}/{} available{missing}.",
        facts.credentials.len()
    )
}

fn discovery_status(evidence: &DiscoveryEvidence, draft: &Draft, has_bundle: bool) -> String {
    if !has_bundle {
        return "Target unverified; bundled Fabric metadata. Save for later.".into();
    }
    match evidence.assessment(draft) {
        Ok(assessment) if assessment.status == CompatibilityStatus::Compatible => {
            "Engine and image match. Plan/apply still checks readiness.".into()
        }
        Ok(assessment) if assessment.status == CompatibilityStatus::Conflict => format!(
            "{} Go back to revise the configuration before saving.",
            assessment.reasons.join(" ")
        ),
        _ => "Target unverified; bundled Fabric choices. Plan checks again.".into(),
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
        let (evidence, _) = check_discovery(
            None,
            &draft,
            &Capabilities::available(),
            None,
            AuthoringFacts::default(),
            false,
            &CancellationToken::new(),
        )
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
    async fn escape_cancels_discovery_and_preserves_unrelated_input() {
        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
        let cancel = CancellationToken::new();
        let child = cancel.child_token();
        let mut queue = std::collections::VecDeque::new();
        let mut events = [
            Event::Key(KeyEvent::new(KeyCode::Char('x'), KeyModifiers::NONE)),
            Event::Key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        ]
        .into_iter();
        let completed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = completed.clone();
        let future = async {
            child.cancelled().await;
            observed.store(true, std::sync::atomic::Ordering::SeqCst);
            Err::<(), _>(Error::Cancelled)
        };
        let result = wait_for_discovery(future, &cancel, &child, &mut queue, || Ok(events.next()))
            .await
            .unwrap();
        assert!(result.is_none());
        assert!(!cancel.is_cancelled());
        assert!(completed.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(queue.len(), 1);
        assert!(matches!(
            queue[0],
            Event::Key(KeyEvent {
                code: KeyCode::Char('x'),
                ..
            })
        ));
    }

    #[tokio::test]
    async fn control_c_interrupts_discovery_without_waiting_for_the_network_timeout() {
        use crossterm::event::{Event, KeyCode, KeyEvent, KeyModifiers};
        let cancel = CancellationToken::new();
        let child = cancel.child_token();
        let mut queue = std::collections::VecDeque::new();
        let future = async {
            child.cancelled().await;
            Err::<(), _>(Error::Cancelled)
        };
        let result = tokio::time::timeout(
            Duration::from_secs(1),
            wait_for_discovery(future, &cancel, &child, &mut queue, || {
                Ok(Some(Event::Key(KeyEvent::new(
                    KeyCode::Char('c'),
                    KeyModifiers::CONTROL,
                ))))
            }),
        )
        .await
        .unwrap();
        assert!(matches!(result, Err(Error::Cancelled)));
    }

    #[test]
    fn missing_facts_do_not_become_zero_hardware_or_valid_credentials() {
        let facts = AuthoringFacts {
            credentials: vec![nemoclaw_sdk::inference_discovery::CredentialObservation {
                reference: "NVIDIA_INFERENCE_API_KEY".into(),
                status: ObservationStatus::Unavailable,
                reason: None,
            }],
            ..Default::default()
        };
        let status = facts_status(&facts);
        assert!(status.contains("architecture unknown"));
        assert!(status.contains("GPU details unknown"));
        assert!(status.contains("missing NVIDIA_INFERENCE_API_KEY"));
        assert!(!status.contains("0 GPUs"));
    }

    #[tokio::test]
    async fn cancelling_discovery_stops_authoring_even_without_a_bundle() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            check_discovery(
                None,
                &draft(),
                &Capabilities::available(),
                None,
                AuthoringFacts::default(),
                false,
                &cancel
            )
            .await,
            Err(Error::Cancelled)
        ));
    }
}
