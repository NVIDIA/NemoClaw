// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{app::JourneyWizard, logo::BrandImage};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use nemoclaw_authoring::{
    AuthoringFacts, Capabilities, DiscoveryEvidence, DiscoveryKey, EndpointEvidence,
    GatewayEvidence, HardwareEvidence, JourneyQuestionKind, JourneyState,
    discovery_key_for_document, inference_request_for_document,
};
use nemoclaw_sdk::{
    CancellationToken, Error,
    config::Document,
    discovery::DiscoveryRequest,
    discovery_session::{DiscoveryObservation, DiscoveryQuery, DiscoverySession},
    inference_discovery::EndpointRequest,
};
use ratatui::{Terminal, TerminalOptions, Viewport, backend::CrosstermBackend, layout::Rect};
use std::{collections::VecDeque, io, time::Duration};

struct TerminalGuard {
    brand: Option<BrandImage>,
}

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
        Ok(Self { brand: None })
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        if let Some(brand) = self.brand {
            let _ = brand.delete(&mut io::stderr());
        }
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
    state: JourneyState,
    cancel: &CancellationToken,
    bundle: Option<&std::path::Path>,
) -> Result<Option<Document>, Box<dyn std::error::Error>> {
    let mut guard = TerminalGuard::enter()?;
    let area = crossterm::terminal::size().map(|(width, height)| Rect::new(0, 0, width, height))?;
    let brand =
        BrandImage::detect(area.width).filter(|brand| brand.transmit(&mut io::stderr()).is_ok());
    guard.brand = brand;
    let mut terminal = Terminal::with_options(
        CrosstermBackend::new(io::stderr()),
        TerminalOptions {
            viewport: Viewport::Fixed(area),
        },
    )?;
    let mut wizard = JourneyWizard::new(capabilities, state);
    let mut needs_render = true;
    let mut attempted_requests = Vec::new();
    let mut queued_events = VecDeque::new();
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled.into());
        }
        // Resolver failures are rendered by the view; keep the loop alive so
        // the user can go back instead of exiting the TUI.
        if let Some(bundle) = bundle
            && wizard.question().is_ok_and(|question| {
                question
                    .is_some_and(|question| question.kind() == JourneyQuestionKind::InferenceModel)
            })
            && let Ok(resolution) = wizard.state.resolve(&wizard.capabilities)
            && let Some(document) = resolution.assessment().document()
            && let Ok(request) =
                inference_request_for_document(document, wizard.state.current_route())
            && !attempted_requests.contains(&request)
        {
            attempted_requests.push(request.clone());
            let discovery_cancel = cancel.child_token();
            let Some(observed) = wait_for_discovery(
                observe_models(bundle, request, &discovery_cancel),
                cancel,
                &discovery_cancel,
                &mut queued_events,
                poll_pending_event,
            )
            .await?
            else {
                return Ok(None);
            };
            if let Some(evidence) = observed {
                wizard.facts.endpoint = Some(evidence);
                needs_render = true;
            }
        }
        if needs_render {
            terminal.draw(|frame| wizard.render_with_brand(frame, brand))?;
            needs_render = false;
        }
        if wizard.accepted {
            return Ok(Some(wizard.document()?));
        }
        let event = if let Some(event) = queued_events.pop_front() {
            event
        } else {
            if !crossterm::event::poll(Duration::from_millis(50))? {
                continue;
            }
            crossterm::event::read()?
        };
        if let Event::Resize(width, height) = event {
            terminal.resize(Rect::new(0, 0, width, height))?;
            needs_render = true;
            continue;
        }
        let Event::Key(key) = event else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        needs_render = true;
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Err(Error::Cancelled.into());
        }
        if key.code == KeyCode::Char('o') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if let Ok(Some(question)) = wizard.question() {
                if question.required() {
                    wizard.error = Some("This question is required.".into());
                } else if let Err(error) = wizard.submit(None) {
                    wizard.error = Some(error.to_string());
                }
            }
            continue;
        }
        if key.code == KeyCode::Char('d') && key.modifiers.contains(KeyModifiers::CONTROL) {
            if wizard.input.is_empty() && !wizard.selection_changed && !wizard.custom_answer {
                let document = wizard
                    .state
                    .resolve(&wizard.capabilities)
                    .ok()
                    .and_then(|resolution| resolution.assessment().document().cloned());
                if let (Some(bundle), Some(document)) = (bundle, document) {
                    let discovery_cancel = cancel.child_token();
                    let observed = wait_for_discovery(
                        observe_target(
                            bundle,
                            &document,
                            wizard.state.current_route(),
                            &discovery_cancel,
                        ),
                        cancel,
                        &discovery_cancel,
                        &mut queued_events,
                        poll_pending_event,
                    )
                    .await;
                    match observed {
                        Ok(Some(Some((evidence, facts)))) => {
                            wizard.discovery = Some(evidence);
                            wizard.facts = facts;
                            match wizard.state.delegate_remaining(
                                &wizard.capabilities,
                                wizard.discovery.as_ref(),
                                &wizard.facts,
                            ) {
                                Ok(delegated) => {
                                    wizard.history.push(wizard.state.clone());
                                    wizard.state = delegated;
                                    wizard.error = None;
                                }
                                Err(error) => wizard.error = Some(error.to_string()),
                            }
                        }
                        Ok(Some(None)) => {
                            wizard.error = Some(
                                "Target discovery is unavailable. Continue answering individually."
                                    .into(),
                            )
                        }
                        Ok(None) => return Ok(None),
                        Err(Error::Cancelled) => return Err(Error::Cancelled.into()),
                        Err(error) => wizard.error = Some(error.to_string()),
                    }
                } else {
                    wizard.error = Some(
                        "Target discovery is unavailable. Continue answering individually.".into(),
                    );
                }
            } else {
                wizard.error =
                    Some("Press Enter to accept the current answer before delegating.".into());
            }
            continue;
        }
        match key.code {
            KeyCode::Esc => return Ok(None),
            KeyCode::Enter => {
                if wizard.started
                    && matches!(wizard.question(), Ok(None))
                    && let Some(bundle) = bundle
                    && let Some(document) = wizard
                        .state
                        .resolve(&wizard.capabilities)
                        .ok()
                        .and_then(|resolution| resolution.materialized_document().cloned())
                {
                    let discovery_cancel = cancel.child_token();
                    let observed = wait_for_discovery(
                        observe_target(
                            bundle,
                            &document,
                            wizard.state.current_route(),
                            &discovery_cancel,
                        ),
                        cancel,
                        &discovery_cancel,
                        &mut queued_events,
                        poll_pending_event,
                    )
                    .await;
                    match observed {
                        Ok(Some(Some((evidence, facts)))) => {
                            wizard.facts = facts;
                            wizard.discovery = Some(evidence);
                        }
                        Ok(Some(None)) => {}
                        Ok(None) => return Ok(None),
                        Err(Error::Cancelled) => return Err(Error::Cancelled.into()),
                        Err(error) => {
                            wizard.error = Some(error.to_string());
                            continue;
                        }
                    }
                }
                wizard.advance();
            }
            KeyCode::Left => wizard.back(),
            KeyCode::Up => wizard.previous(),
            KeyCode::Down => wizard.next(),
            KeyCode::Backspace => {
                wizard.input.pop();
            }
            KeyCode::Char('a') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                wizard.input.clear()
            }
            KeyCode::Char(character)
                if !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                wizard.input.push(character)
            }
            _ => {}
        }
    }
}

fn poll_pending_event() -> io::Result<Option<Event>> {
    if crossterm::event::poll(Duration::ZERO)? {
        crossterm::event::read().map(Some)
    } else {
        Ok(None)
    }
}

/// Keep raw-mode cancellation responsive and queue keys typed during discovery.
async fn wait_for_discovery<T>(
    future: impl std::future::Future<Output = Result<T, Error>>,
    cancel: &CancellationToken,
    discovery_cancel: &CancellationToken,
    queue: &mut VecDeque<Event>,
    mut poll: impl FnMut() -> io::Result<Option<Event>>,
) -> Result<Option<T>, Error> {
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
                    let interrupted = key.code == KeyCode::Char('c')
                        && key.modifiers.contains(KeyModifiers::CONTROL);
                    if key.code == KeyCode::Esc || interrupted {
                        discovery_cancel.cancel();
                        let _ = future.await;
                        return if interrupted { Err(Error::Cancelled) } else { Ok(None) };
                    }
                }
                queue.push_back(event);
            }
        }
    }
}

pub(super) async fn observe_models(
    bundle: &std::path::Path,
    request: EndpointRequest,
    cancel: &CancellationToken,
) -> Result<Option<EndpointEvidence>, Error> {
    let Ok(mut session) = DiscoverySession::new(bundle) else {
        return Ok(None);
    };
    let observations = match session
        .batch(&[DiscoveryQuery::Inference(request.clone())], cancel)
        .await
    {
        Ok(observations) => observations,
        Err(Error::Cancelled) => return Err(Error::Cancelled),
        Err(_) => return Ok(None),
    };
    Ok(observations
        .into_iter()
        .find_map(|observation| match observation {
            DiscoveryObservation::Inference(observation) => Some(EndpointEvidence {
                request: request.clone(),
                observation,
            }),
            _ => None,
        }))
}

async fn observe_target(
    bundle: &std::path::Path,
    document: &Document,
    route: Option<&str>,
    cancel: &CancellationToken,
) -> Result<Option<(DiscoveryEvidence, AuthoringFacts)>, Error> {
    let Ok(mut session) = DiscoverySession::new(bundle) else {
        return Ok(None);
    };
    let key = discovery_key_for_document(document)
        .map_err(|_| Error::State("invalid discovery selection"))?;
    let request = inference_request_for_document(document, route)
        .map_err(|_| Error::State("invalid inference selection"))?;
    let mut evidence = DiscoveryEvidence {
        key: key.clone(),
        engine: None,
        fabric: None,
    };
    let mut facts = AuthoringFacts {
        credentials: nemoclaw_sdk::inference_discovery::observe_credentials(
            document,
            &nemoclaw_sdk::EnvironmentSecrets,
        )?,
        ..Default::default()
    };
    let queries = discovery_queries(&key, request);
    match session.batch(&queries, cancel).await {
        Ok(observations) => {
            for (query, observation) in queries.into_iter().zip(observations) {
                match (query, observation) {
                    (DiscoveryQuery::Engine(_), DiscoveryObservation::Engine(observed)) => {
                        evidence.engine = Some(observed)
                    }
                    (DiscoveryQuery::Fabric { .. }, DiscoveryObservation::Fabric(observed)) => {
                        evidence.fabric = Some(observed)
                    }
                    (
                        DiscoveryQuery::Hardware { engine },
                        DiscoveryObservation::Hardware(observation),
                    ) => {
                        facts.hardware = Some(HardwareEvidence {
                            engine,
                            observation,
                        })
                    }
                    (
                        DiscoveryQuery::Inference(request),
                        DiscoveryObservation::Inference(observation),
                    ) => {
                        facts.endpoint = Some(EndpointEvidence {
                            request,
                            observation,
                        })
                    }
                    _ => {}
                }
            }
        }
        Err(Error::Cancelled) => return Err(Error::Cancelled),
        Err(_) => {}
    }
    match session
        .gateway(&document.spec.gateway, &[key.compute_driver], cancel)
        .await
    {
        Ok(observation) => {
            facts.gateway = Some(GatewayEvidence {
                gateway: document.spec.gateway.clone(),
                compute_driver: key.compute_driver,
                observation,
            })
        }
        Err(Error::Cancelled) => return Err(Error::Cancelled),
        Err(_) => {}
    }
    Ok(Some((evidence, facts)))
}

fn discovery_queries(
    key: &DiscoveryKey,
    request: nemoclaw_sdk::inference_discovery::EndpointRequest,
) -> Vec<DiscoveryQuery> {
    let mut queries = Vec::new();
    // An external gateway's engine only stores images: read their metadata,
    // but do not probe it as the gateway's engine or hardware.
    if key.managed_gateway && !key.engine.is_empty() {
        queries.push(DiscoveryQuery::Engine(DiscoveryRequest {
            engine: key.engine.clone(),
            compute_driver: key.compute_driver,
        }));
    }
    if !key.engine.is_empty() {
        queries.push(DiscoveryQuery::Fabric {
            engine: key.engine.clone(),
            image: key.image.clone(),
        });
    }
    if key.managed_gateway && !key.engine.is_empty() {
        queries.push(DiscoveryQuery::Hardware {
            engine: key.engine.clone(),
        });
    }
    if request.validate().is_ok() {
        queries.push(DiscoveryQuery::Inference(request));
    }
    queries
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_gateway_does_not_guess_a_local_engine_for_discovery() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../spark/remote-vllm.yaml");
        let document = Document::parse(std::fs::File::open(path).unwrap()).unwrap();
        let key = discovery_key_for_document(&document).unwrap();
        assert!(key.engine.is_empty());
        let queries = discovery_queries(
            &key,
            inference_request_for_document(&document, None).unwrap(),
        );
        assert!(
            queries
                .iter()
                .all(|query| matches!(query, DiscoveryQuery::Inference(_))),
            "unresolved engine must not target the local daemon: {queries:?}"
        );
    }

    #[test]
    fn external_gateway_queries_its_image_store_without_gateway_or_hardware_probes() {
        let mut document =
            Document::parse(&include_bytes!("../../../onboarding/openclaw.yaml")[..]).unwrap();
        document.spec.gateway = serde_json::from_value(serde_json::json!({
            "management": "external",
            "endpoint": "https://gateway.example:8080",
            "engine": "ssh://images@example.com",
        }))
        .unwrap();
        document.spec.sandboxes[0].runtime.provider = nemoclaw_sdk::config::ComputeDriver::Podman;
        let key = discovery_key_for_document(&document).unwrap();
        let request = inference_request_for_document(&document, None).unwrap();
        assert_eq!(
            discovery_queries(&key, request.clone()),
            vec![
                DiscoveryQuery::Fabric {
                    engine: "ssh://images@example.com".into(),
                    image: key.image.clone(),
                },
                DiscoveryQuery::Inference(request),
            ]
        );
    }

    #[tokio::test]
    async fn escape_cancels_discovery_and_restores_the_questionnaire() {
        let cancel = CancellationToken::new();
        let discovery_cancel = cancel.child_token();
        let mut queue = std::collections::VecDeque::new();
        let future = async {
            discovery_cancel.cancelled().await;
            Err::<(), _>(Error::Cancelled)
        };
        let result = wait_for_discovery(future, &cancel, &discovery_cancel, &mut queue, || {
            Ok(Some(Event::Key(crossterm::event::KeyEvent::new(
                KeyCode::Esc,
                KeyModifiers::NONE,
            ))))
        })
        .await;
        assert!(matches!(result, Ok(None)));
        assert!(discovery_cancel.is_cancelled());
        assert!(queue.is_empty());
    }
}
