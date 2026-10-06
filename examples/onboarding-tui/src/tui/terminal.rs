// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{app::JourneyWizard, logo::BrandImage};
use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use nemoclaw_authoring::{
    Capabilities, JourneyQuestionKind, JourneyState, discovery_queries,
    inference_request_for_document,
};
use nemoclaw_discovery::{Direct, DiscoveryObservations};
use nemoclaw_sdk::{
    CancellationToken, EnvironmentSecrets, Error, config::Document, discovery::DiscoveryQuery,
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
    discover: bool,
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
    let mut wizard = JourneyWizard::new(capabilities, state)
        .with_local_engine_candidates(nemoclaw_discovery::local_engine_candidates());
    let mut needs_render = true;
    let mut queued_events = VecDeque::new();
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled.into());
        }
        // Learn what this machine can run before the first question, so early
        // choices can use it. Each read is attempted once, even when it fails.
        if discover {
            let queries = local_engine_probe(&wizard);
            if !queries.is_empty() {
                terminal.draw(|frame| wizard.render_with_brand(frame, brand))?;
                if !ask_target(
                    &mut wizard,
                    read_target,
                    queries,
                    cancel,
                    &mut queued_events,
                    poll_pending_event,
                )
                .await?
                {
                    return Ok(None);
                }
                needs_render = true;
            }
        }
        // Resolver failures are rendered by the view; keep the loop alive so
        // the user can go back instead of exiting the TUI.
        if discover && let Some(query) = model_catalog_probe(&wizard) {
            if !ask_target(
                &mut wizard,
                read_target,
                vec![query],
                cancel,
                &mut queued_events,
                poll_pending_event,
            )
            .await?
            {
                return Ok(None);
            }
            needs_render = true;
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
                if let (true, Some(document)) = (discover, document) {
                    let discovery_cancel = cancel.child_token();
                    let observed = wait_for_discovery(
                        observe_target(&document, wizard.state.current_route(), &discovery_cancel),
                        cancel,
                        &discovery_cancel,
                        &mut queued_events,
                        poll_pending_event,
                    )
                    .await;
                    match observed {
                        Ok(Some(observations)) => {
                            wizard.remember(observations);
                            match wizard
                                .state
                                .delegate_remaining(&wizard.capabilities, &wizard.observations)
                            {
                                Ok(delegated) => {
                                    wizard.history.push(wizard.state.clone());
                                    wizard.state = delegated;
                                    wizard.error = None;
                                }
                                Err(error) => wizard.error = Some(error.to_string()),
                            }
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
                    && discover
                    && let Some(document) = wizard
                        .state
                        .resolve(&wizard.capabilities)
                        .ok()
                        .and_then(|resolution| resolution.materialized_document().cloned())
                {
                    let discovery_cancel = cancel.child_token();
                    let observed = wait_for_discovery(
                        observe_target(&document, wizard.state.current_route(), &discovery_cancel),
                        cancel,
                        &discovery_cancel,
                        &mut queued_events,
                        poll_pending_event,
                    )
                    .await;
                    match observed {
                        Ok(Some(observations)) => wizard.remember(observations),
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

/// This machine's candidate engines, until each has been asked about once.
pub(super) fn local_engine_probe(wizard: &JourneyWizard) -> Vec<DiscoveryQuery> {
    let queries: Vec<DiscoveryQuery> = wizard
        .local_engine_candidates
        .iter()
        .cloned()
        .map(DiscoveryQuery::Engine)
        .collect();
    wizard.observations.missing(&queries)
}

/// The model catalog of the route being asked about, once the journey is at its
/// model question and that catalog has not been read.
pub(super) fn model_catalog_probe(wizard: &JourneyWizard) -> Option<DiscoveryQuery> {
    if !wizard.question().is_ok_and(|question| {
        question.is_some_and(|question| question.kind() == JourneyQuestionKind::InferenceModel)
    }) {
        return None;
    }
    let resolution = wizard.state.resolve(&wizard.capabilities).ok()?;
    let document = resolution.assessment().document()?;
    let request = inference_request_for_document(document, wizard.state.current_route()).ok()??;
    let query = DiscoveryQuery::Inference(request);
    (!wizard.observations.contains(&query)).then_some(query)
}

/// Ask the target with `read` and keep what it says. `false` means the user
/// escaped while it was being read, which abandons the questionnaire.
pub(super) async fn ask_target(
    wizard: &mut JourneyWizard,
    read: impl AsyncFnOnce(
        Vec<DiscoveryQuery>,
        &CancellationToken,
    ) -> Result<DiscoveryObservations, Error>,
    queries: Vec<DiscoveryQuery>,
    cancel: &CancellationToken,
    queued_events: &mut VecDeque<Event>,
    poll: impl FnMut() -> io::Result<Option<Event>>,
) -> Result<bool, Error> {
    let discovery_cancel = cancel.child_token();
    let Some(observed) = wait_for_discovery(
        read(queries, &discovery_cancel),
        cancel,
        &discovery_cancel,
        queued_events,
        poll,
    )
    .await?
    else {
        return Ok(false);
    };
    wizard.remember(observed);
    Ok(true)
}

/// Read the target directly. A read that fails is an unknown observation,
/// never absence, so it is not asked again on every pass.
async fn read_target(
    queries: Vec<DiscoveryQuery>,
    cancel: &CancellationToken,
) -> Result<DiscoveryObservations, Error> {
    nemoclaw_discovery::observe(&queries, &Direct, &EnvironmentSecrets, cancel).await
}

/// Read again everything the journey needs about the target for `document`.
async fn observe_target(
    document: &Document,
    route: Option<&str>,
    cancel: &CancellationToken,
) -> Result<DiscoveryObservations, Error> {
    let queries = discovery_queries(document, route)
        .map_err(|_| Error::State("invalid discovery selection"))?;
    read_target(queries, cancel).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
