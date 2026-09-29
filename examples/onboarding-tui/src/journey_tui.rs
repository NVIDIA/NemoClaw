// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Terminal frontend over the single sparse journey resolver.

use std::{io, time::Duration};

use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use nemoclaw_authoring::{
    AuthoringFacts, Capabilities, Diagnostics, DiscoveryEvidence, EndpointEvidence,
    GatewayEvidence, HardwareEvidence, JourneyQuestion, JourneyQuestionKind, JourneyState,
    discovery_key_for_document, inference_request_for_document,
};
use nemoclaw_sdk::{
    CancellationToken, Error,
    config::Document,
    discovery::DiscoveryRequest,
    discovery_session::{DiscoveryObservation, DiscoveryQuery, DiscoverySession},
    inference_discovery::EndpointRequest,
};
use ratatui::{
    Frame, Terminal, TerminalOptions, Viewport,
    backend::CrosstermBackend,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};
use serde_json::Value;

pub(crate) struct JourneyWizard {
    capabilities: Capabilities,
    state: JourneyState,
    history: Vec<JourneyState>,
    selected: usize,
    selection_changed: bool,
    custom_answer: bool,
    facts: AuthoringFacts,
    discovery: Option<DiscoveryEvidence>,
    input: String,
    error: Option<String>,
    started: bool,
    accepted: bool,
}

impl JourneyWizard {
    pub(crate) fn new(capabilities: Capabilities, state: JourneyState) -> Self {
        Self {
            capabilities,
            state,
            history: Vec::new(),
            selected: 0,
            selection_changed: false,
            custom_answer: false,
            facts: AuthoringFacts::default(),
            discovery: None,
            input: String::new(),
            error: None,
            started: false,
            accepted: false,
        }
    }

    #[cfg(test)]
    pub(crate) fn state(&self) -> &JourneyState {
        &self.state
    }

    pub(crate) fn question(&self) -> Option<JourneyQuestion> {
        self.state
            .resolve_with_evidence(&self.capabilities, &self.facts, self.discovery.as_ref())
            .ok()?
            .next_question()
            .cloned()
    }

    fn choice_index(&self, question: &JourneyQuestion) -> usize {
        if self.selection_changed {
            return self.selected;
        }
        question
            .suggestion()
            .and_then(|suggested| {
                question
                    .choices()
                    .iter()
                    .position(|choice| choice == suggested)
            })
            .unwrap_or_else(|| {
                if question.required() {
                    0
                } else {
                    question.choices().len()
                }
            })
    }

    pub(crate) fn submit(&mut self, answer: Option<Value>) -> Result<(), Diagnostics> {
        let question = self.question().expect("submit requires an active question");
        let previous = self.state.clone();
        self.state
            .answer(&self.capabilities, question.id(), answer)?;
        self.history.push(previous);
        self.selected = 0;
        self.selection_changed = false;
        self.custom_answer = false;
        self.input.clear();
        self.error = None;
        Ok(())
    }

    fn back(&mut self) {
        if let Some(previous) = self.history.pop() {
            self.state = previous;
            self.selected = 0;
            self.selection_changed = false;
            self.custom_answer = false;
            self.input.clear();
            self.error = None;
        } else {
            self.started = false;
        }
    }

    fn suggested_input(&self, question: &JourneyQuestion) -> String {
        question
            .suggestion()
            .map_or_else(String::new, display_value)
    }

    fn answer_from_input(&self, question: &JourneyQuestion) -> Result<Option<Value>, String> {
        if !question.choices().is_empty() {
            if question.allows_custom_answer() && self.custom_answer {
                return if self.input.trim().is_empty() {
                    Err("Enter a model identifier.".into())
                } else {
                    Ok(Some(Value::String(self.input.clone())))
                };
            }
            return Ok(question.choices().get(self.choice_index(question)).cloned());
        }
        let raw = if self.input.is_empty() {
            self.suggested_input(question)
        } else {
            self.input.clone()
        };
        if raw.trim().is_empty() {
            return if question.required() {
                Err("A value is required.".into())
            } else {
                Ok(None)
            };
        }
        if question.schema()["type"] == "string" || question.schema()["type"].is_null() {
            Ok(Some(Value::String(raw)))
        } else {
            serde_json::from_str(&raw)
                .map(Some)
                .map_err(|error| format!("Enter a JSON value: {error}"))
        }
    }

    fn advance(&mut self) {
        if !self.started {
            self.started = true;
            return;
        }
        let Some(question) = self.question() else {
            match self.state.resolve_with_evidence(
                &self.capabilities,
                &self.facts,
                self.discovery.as_ref(),
            ) {
                Ok(resolution) if resolution.ready_document().is_some() => self.accepted = true,
                Ok(resolution) => {
                    let issues = resolution
                        .assessment()
                        .issues()
                        .iter()
                        .map(|issue| format!("{}: {}", issue.path(), issue.rule()))
                        .collect::<Vec<_>>();
                    self.error = Some(format!(
                        "Cannot save yet: {} {} {}",
                        resolution.unverified().join("; "),
                        issues.join("; "),
                        resolution
                            .target_assessment()
                            .map(|assessment| assessment.reasons.join("; "))
                            .unwrap_or_default()
                    ));
                }
                Err(error) => self.error = Some(error.to_string()),
            }
            return;
        };
        if question.allows_custom_answer()
            && !question.choices().is_empty()
            && self.choice_index(&question) == question.choices().len()
            && !self.custom_answer
        {
            self.custom_answer = true;
            self.input.clear();
            return;
        }
        let result = self
            .answer_from_input(&question)
            .and_then(|value| self.submit(value).map_err(|error| error.to_string()));
        if let Err(error) = result {
            self.error = Some(error);
        }
    }

    fn render(&self, frame: &mut Frame<'_>) {
        let area = frame.area();
        frame.render_widget(
            Block::new().style(Style::new().bg(Color::Rgb(5, 10, 7))),
            area,
        );
        let body = Rect::new(
            area.x.saturating_add(2),
            area.y.saturating_add(1),
            area.width.saturating_sub(4),
            area.height.saturating_sub(2),
        );
        let rows = Layout::vertical([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(3),
        ])
        .split(body);
        frame.render_widget(
            Paragraph::new("NEMOCLAW  /  ONBOARDING").style(
                Style::new()
                    .fg(Color::Rgb(118, 185, 0))
                    .add_modifier(Modifier::BOLD),
            ),
            rows[0],
        );
        let mut lines = Vec::new();
        if !self.started {
            lines.push(Line::from("Create desired state from a guided journey."));
            lines.push(Line::from("Press Enter to begin."));
        } else if let Some(question) = self.question() {
            lines.push(Line::from(Span::styled(
                label(&question),
                Style::new().fg(Color::White).add_modifier(Modifier::BOLD),
            )));
            lines.push(Line::from(format!(
                "{}  ·  {}",
                if question.required() {
                    "Required"
                } else {
                    "Optional"
                },
                question.id()
            )));
            lines.push(Line::from(""));
            if question.choices().is_empty() || self.custom_answer {
                let input = if self.input.is_empty() {
                    self.suggested_input(&question)
                } else {
                    self.input.clone()
                };
                lines.push(Line::from(format!("> {input}")));
                if question.suggestion().is_some() {
                    lines.push(Line::from(
                        "Enter accepts the suggested value; typing replaces it.",
                    ));
                }
                if !question.required() {
                    lines.push(Line::from("Press Ctrl+O to omit."));
                }
            } else {
                for (index, value) in question.choices().iter().enumerate() {
                    lines.push(Line::from(format!(
                        "{} {}",
                        if index == self.choice_index(&question) {
                            "❯"
                        } else {
                            " "
                        },
                        display_value(value),
                    )));
                }
                if question.allows_custom_answer() {
                    lines.push(Line::from(format!(
                        "{} Type another model",
                        if self.choice_index(&question) == question.choices().len() {
                            "❯"
                        } else {
                            " "
                        }
                    )));
                }
                if !question.required() {
                    lines.push(Line::from(format!(
                        "{} Omit",
                        if self.choice_index(&question) == question.choices().len() {
                            "❯"
                        } else {
                            " "
                        }
                    )));
                }
            }
        } else {
            lines.push(Line::from(Span::styled(
                "Review desired state",
                Style::new().fg(Color::White).add_modifier(Modifier::BOLD),
            )));
            match self.state.resolve_with_evidence(
                &self.capabilities,
                &self.facts,
                self.discovery.as_ref(),
            ) {
                Ok(resolution) => {
                    if let Some(document) = resolution.materialized_document() {
                        if let Ok(yaml) = document.yaml() {
                            lines.extend(
                                yaml.lines()
                                    .take(rows[1].height.saturating_sub(4) as usize)
                                    .map(|line| Line::from(line.to_owned())),
                            );
                        }
                    } else {
                        lines.extend(
                            resolution
                                .unverified()
                                .iter()
                                .map(|warning| Line::from(warning.clone())),
                        );
                        lines.extend(resolution.assessment().issues().iter().take(5).map(
                            |issue| Line::from(format!("{}: {}", issue.path(), issue.rule())),
                        ));
                    }
                    if let Some(assessment) = resolution.target_assessment() {
                        lines.push(Line::from(format!("Target: {:?}", assessment.status)));
                        lines.extend(
                            assessment
                                .reasons
                                .iter()
                                .take(2)
                                .map(|reason| Line::from(reason.clone())),
                        );
                    }
                }
                Err(error) => lines.push(Line::from(error.to_string())),
            }
            lines.push(Line::from("Press Enter to save."));
        }
        frame.render_widget(
            Paragraph::new(lines)
                .block(Block::new().borders(Borders::ALL))
                .wrap(Wrap { trim: false }),
            rows[1],
        );
        let footer = self.error.as_deref().unwrap_or("Enter continue  ·  ↑↓ choose  ·  Ctrl+O omit  ·  Ctrl+D delegate  ·  ← back  ·  Esc cancel");
        frame.render_widget(
            Paragraph::new(footer)
                .style(Style::new().fg(if self.error.is_some() {
                    Color::Red
                } else {
                    Color::Gray
                }))
                .wrap(Wrap { trim: true }),
            rows[2],
        );
    }

    fn document(&self) -> Result<Document, Box<dyn std::error::Error>> {
        self.state
            .resolve_with_evidence(&self.capabilities, &self.facts, self.discovery.as_ref())?
            .ready_document()
            .cloned()
            .ok_or_else(|| "the journey is not complete".into())
    }
}

fn display_value(value: &Value) -> String {
    value
        .as_str()
        .map_or_else(|| value.to_string(), str::to_owned)
}

fn label(question: &JourneyQuestion) -> String {
    let id = question.id();
    if question.kind() == JourneyQuestionKind::StructuralForm {
        return format!(
            "Choose {} form",
            id.rsplit('/').next().unwrap_or("configuration")
        );
    }
    match id {
        "/metadata/name" => "Deployment name".into(),
        "/spec/sandboxes/0/harness/kind" => "Agent harness".into(),
        "/spec/sandboxes/0/runtime/provider" => "Container runtime".into(),
        "inference:preset" => "Inference provider".into(),
        "route:selection" => "Inference route".into(),
        _ => id.rsplit('/').next().unwrap_or(id).replace(['-', '_'], " "),
    }
}

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
    state: JourneyState,
    cancel: &CancellationToken,
    bundle: Option<&std::path::Path>,
) -> Result<Option<Document>, Box<dyn std::error::Error>> {
    let _guard = TerminalGuard::enter()?;
    let area = crossterm::terminal::size().map(|(width, height)| Rect::new(0, 0, width, height))?;
    let mut terminal = Terminal::with_options(
        CrosstermBackend::new(io::stderr()),
        TerminalOptions {
            viewport: Viewport::Fixed(area),
        },
    )?;
    let mut wizard = JourneyWizard::new(capabilities, state);
    let mut needs_render = true;
    let mut attempted_requests = Vec::new();
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled.into());
        }
        if let Some(bundle) = bundle
            && wizard
                .question()
                .as_ref()
                .is_some_and(|question| question.kind() == JourneyQuestionKind::InferenceModel)
            && let Some(document) = wizard
                .state
                .resolve(&wizard.capabilities)?
                .assessment()
                .document()
            && let Ok(request) =
                inference_request_for_document(document, wizard.state.current_route())
            && !attempted_requests.contains(&request)
        {
            attempted_requests.push(request.clone());
            if let Some(evidence) = observe_models(bundle, request, cancel).await? {
                wizard.facts.endpoint = Some(evidence);
                needs_render = true;
            }
        }
        if needs_render {
            terminal.draw(|frame| wizard.render(frame))?;
            needs_render = false;
        }
        if wizard.accepted {
            return Ok(Some(wizard.document()?));
        }
        if !crossterm::event::poll(Duration::from_millis(50))? {
            continue;
        }
        let event = crossterm::event::read()?;
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
            if let Some(question) = wizard.question() {
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
                    .resolve(&wizard.capabilities)?
                    .assessment()
                    .document()
                    .cloned();
                if let (Some(bundle), Some(document)) = (bundle, document) {
                    match observe_target(bundle, &document, wizard.state.current_route(), cancel)
                        .await
                    {
                        Ok(Some((evidence, facts))) => {
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
                        Ok(None) => {
                            wizard.error = Some(
                                "Target discovery is unavailable. Continue answering individually."
                                    .into(),
                            )
                        }
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
                    && wizard.question().is_none()
                    && let Some(bundle) = bundle
                    && let Some(document) = wizard
                        .state
                        .resolve(&wizard.capabilities)?
                        .materialized_document()
                        .cloned()
                {
                    match observe_target(bundle, &document, wizard.state.current_route(), cancel)
                        .await
                    {
                        Ok(Some((evidence, facts))) => {
                            wizard.facts = facts;
                            wizard.discovery = Some(evidence);
                        }
                        Ok(None) => {}
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
            KeyCode::Up => {
                if let Some(question) = wizard.question()
                    && !question.choices().is_empty()
                {
                    wizard.selected = wizard.choice_index(&question).saturating_sub(1);
                    wizard.selection_changed = true;
                }
            }
            KeyCode::Down => {
                if let Some(question) = wizard.question()
                    && !question.choices().is_empty()
                {
                    wizard.selected = (wizard.choice_index(&question) + 1).min(
                        question.choices().len()
                            - usize::from(question.required() && !question.allows_custom_answer()),
                    );
                    wizard.selection_changed = true;
                }
            }
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

async fn observe_models(
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
    let mut queries = Vec::new();
    if !key.engine.is_empty() {
        queries.push(DiscoveryQuery::Engine(DiscoveryRequest {
            engine: key.engine.clone(),
            compute_driver: key.compute_driver,
        }));
        queries.push(DiscoveryQuery::Fabric {
            engine: key.engine.clone(),
            image: key.image.clone(),
        });
        queries.push(DiscoveryQuery::Hardware {
            engine: key.engine.clone(),
        });
    }
    if request.validate().is_ok() {
        queries.push(DiscoveryQuery::Inference(request));
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Source, load_journey};
    use nemoclaw_authoring::{JourneyDefinition, PartialDocument, TargetPrerequisite};

    #[test]
    fn configured_target_prerequisite_blocks_save_until_observed() {
        let capabilities = Capabilities::available();
        let base =
            PartialDocument::from_yaml(include_bytes!("../../onboarding/openclaw.yaml")).unwrap();
        let state = JourneyDefinition::new("target-gated", base)
            .omit([
                "adapter:nvidia.fabric.openclaw:/agent_name",
                "adapter:nvidia.fabric.openclaw:/cli",
                "adapter:nvidia.fabric.openclaw:/home",
                "adapter:nvidia.fabric.openclaw:/native_config",
                "adapter:nvidia.fabric.openclaw:/timeout_seconds",
            ])
            .require_target([TargetPrerequisite::EngineAndImageCompatible])
            .start(&capabilities)
            .unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        wizard.started = true;
        assert!(wizard.question().is_none());
        wizard.advance();
        assert!(!wizard.accepted);
        assert!(
            wizard
                .error
                .as_deref()
                .unwrap()
                .contains("Target compatibility")
        );
    }

    #[test]
    fn wizard_uses_the_shared_resolver_for_an_sdk_form_choice() {
        let capabilities = Capabilities::available();
        let mut values: serde_json::Value =
            serde_saphyr::from_slice(include_bytes!("../../onboarding/openclaw.yaml")).unwrap();
        values["spec"]["sandboxes"][0]["agent"]
            .as_object_mut()
            .unwrap()
            .remove("inference");
        let base = PartialDocument::from_yaml(values.to_string().as_bytes()).unwrap();
        let state = JourneyDefinition::new("agent-form", base)
            .start(&capabilities)
            .unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        let question = wizard.question().unwrap();
        assert_eq!(question.id(), "form:/spec/sandboxes/0/agent");
        assert_eq!(label(&question), "Choose agent form");
        wizard
            .submit(Some(serde_json::json!("inferenceRef")))
            .unwrap();
        assert_eq!(
            wizard.question().unwrap().id(),
            "/spec/sandboxes/0/agent/inferenceRef"
        );
    }

    #[test]
    fn enter_uses_the_supplied_choice_suggestion() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        wizard.advance();
        wizard.advance();
        assert_eq!(
            wizard.question().unwrap().id(),
            "/spec/sandboxes/0/harness/kind"
        );
        wizard.advance();
        assert_eq!(
            wizard
                .state
                .values()
                .pointer("/spec/sandboxes/0/harness/kind"),
            Some(&serde_json::json!("nvidia.fabric.openclaw"))
        );
    }

    #[test]
    fn back_restores_the_previous_answer_without_rewriting_the_template() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let original_name = state.values().pointer("/metadata/name").cloned();
        let mut wizard = JourneyWizard::new(capabilities, state);
        wizard
            .submit(Some(serde_json::json!("chosen-name")))
            .unwrap();
        assert_eq!(
            wizard.question().unwrap().id(),
            "/spec/sandboxes/0/harness/kind"
        );
        wizard.back();
        assert_eq!(wizard.question().unwrap().id(), "/metadata/name");
        assert_eq!(
            wizard.state.values().pointer("/metadata/name"),
            original_name.as_ref()
        );
    }

    #[test]
    fn optional_question_can_be_omitted_through_the_new_wizard() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        for _ in 0..30 {
            if wizard
                .question()
                .is_some_and(|question| !question.required())
            {
                let id = wizard.question().unwrap().id().to_owned();
                wizard.submit(None).unwrap();
                assert!(
                    wizard
                        .state
                        .resolve(&wizard.capabilities)
                        .unwrap()
                        .omitted()
                        .contains(&id)
                );
                return;
            }
            wizard.advance();
            assert!(wizard.error.is_none(), "{:?}", wizard.error);
        }
        panic!("the default journey has no optional question");
    }

    #[test]
    fn default_path_reaches_a_valid_document_through_the_new_wizard() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        for _ in 0..40 {
            wizard.advance();
            if wizard.accepted {
                break;
            }
            assert!(
                wizard.error.is_none(),
                "question={:?} error={:?}",
                wizard.question().map(|question| question.id().to_owned()),
                wizard.error
            );
        }
        assert!(
            wizard.accepted,
            "remaining={:?}",
            wizard.question().map(|question| question.id().to_owned())
        );
        assert!(wizard.document().is_ok());
    }

    #[test]
    fn mixed_local_and_hosted_template_reaches_review_without_losing_routes() {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../spark/local-and-hosted.yaml");
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Template(&path), &capabilities).unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        for _ in 0..80 {
            wizard.advance();
            if wizard.accepted {
                break;
            }
            assert!(
                wizard.error.is_none(),
                "question={:?} error={:?}",
                wizard.question().map(|question| question.id().to_owned()),
                wizard.error
            );
        }
        assert!(
            wizard.accepted,
            "remaining={:?}",
            wizard.question().map(|question| question.id().to_owned())
        );
        let document = wizard.document().unwrap();
        assert_eq!(
            document.spec.sandboxes[0]
                .agent
                .inference
                .as_ref()
                .unwrap()
                .routes
                .len(),
            2
        );
    }

    #[test]
    fn single_sandbox_examples_reach_review_through_sparse_journey() {
        fn visit(directory: &std::path::Path, files: &mut Vec<std::path::PathBuf>) {
            for entry in std::fs::read_dir(directory).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(&path, files);
                } else if matches!(
                    path.extension().and_then(|extension| extension.to_str()),
                    Some("yaml" | "yml")
                ) {
                    files.push(path);
                }
            }
        }
        let mut files = Vec::new();
        visit(
            &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(".."),
            &mut files,
        );
        files.sort();
        for path in files {
            let bytes = std::fs::read(&path).unwrap();
            let Ok(document) = Document::parse(bytes.as_slice()) else {
                continue;
            };
            if document.spec.sandboxes.len() != 1 {
                continue;
            }
            let capabilities = Capabilities::available();
            let state = load_journey(Source::Template(&path), &capabilities)
                .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
            let mut wizard = JourneyWizard::new(capabilities, state);
            for _ in 0..100 {
                wizard.advance();
                if wizard.accepted || wizard.error.is_some() {
                    break;
                }
            }
            assert!(
                wizard.accepted,
                "{}: question={:?} error={:?}",
                path.display(),
                wizard.question().map(|question| question.id().to_owned()),
                wizard.error
            );
        }
    }

    #[test]
    fn existing_model_metadata_is_offered_as_an_editable_suggestion() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        let mut seen = Vec::new();
        for _ in 0..40 {
            if wizard
                .question()
                .is_some_and(|question| question.id() == "model:/model_metadata")
            {
                return;
            }
            seen.push(wizard.question().map(|question| question.id().to_owned()));
            wizard.advance();
            assert!(wizard.error.is_none(), "{:?}", wizard.error);
        }
        panic!("The supplied model metadata was skipped; seen={seen:?}");
    }

    #[test]
    fn discovered_model_menu_keeps_a_custom_text_answer() {
        use nemoclaw_sdk::{
            discovery::ObservationStatus,
            inference_discovery::{AuthenticationStatus, EndpointObservation},
        };
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        for _ in 0..12 {
            if wizard
                .question()
                .as_ref()
                .is_some_and(|question| question.allows_custom_answer())
            {
                break;
            }
            wizard.advance();
        }
        let document = wizard
            .state
            .resolve(&wizard.capabilities)
            .unwrap()
            .assessment()
            .document()
            .unwrap()
            .clone();
        wizard.facts.endpoint = Some(EndpointEvidence {
            request: inference_request_for_document(&document, wizard.state.current_route())
                .unwrap(),
            observation: EndpointObservation {
                status: ObservationStatus::Available,
                reason: None,
                source: "fixture".into(),
                reachable: Some(true),
                authentication: AuthenticationStatus::Accepted,
                models: vec!["vendor/discovered".into()],
                api_verified: false,
            },
        });
        let question = wizard.question().unwrap();
        assert!(
            question
                .choices()
                .contains(&serde_json::json!("vendor/discovered"))
        );
        wizard.selected = question.choices().len();
        wizard.selection_changed = true;
        wizard.advance();
        assert!(wizard.custom_answer);
        wizard.input = "private/custom".into();
        wizard.advance();
        assert_eq!(
            wizard.state.values().pointer(question.id()),
            Some(&serde_json::json!("private/custom"))
        );
    }

    #[test]
    fn tui_preserves_podman_as_an_authored_target_choice() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let mut wizard = JourneyWizard::new(capabilities, state);
        for _ in 0..5 {
            if wizard
                .question()
                .is_some_and(|question| question.id() == "/spec/sandboxes/0/runtime/provider")
            {
                break;
            }
            wizard.advance();
        }
        let question = wizard.question().unwrap();
        wizard.selected = question
            .choices()
            .iter()
            .position(|choice| choice == "podman")
            .unwrap();
        wizard.selection_changed = true;
        wizard.advance();
        assert!(wizard.error.is_none());
        assert_eq!(
            wizard.state.values().pointer(question.id()),
            Some(&serde_json::json!("podman"))
        );
    }

    #[test]
    fn review_uses_authoring_readiness_for_an_observed_target_conflict() {
        let capabilities = Capabilities::available();
        let base =
            PartialDocument::from_yaml(include_bytes!("../../onboarding/openclaw.yaml")).unwrap();
        let state = JourneyDefinition::new("conflicted-target", base)
            .omit([
                "adapter:nvidia.fabric.openclaw:/agent_name",
                "adapter:nvidia.fabric.openclaw:/cli",
                "adapter:nvidia.fabric.openclaw:/home",
                "adapter:nvidia.fabric.openclaw:/native_config",
                "adapter:nvidia.fabric.openclaw:/timeout_seconds",
            ])
            .start(&capabilities)
            .unwrap();
        let document = state
            .resolve(&capabilities)
            .unwrap()
            .materialized_document()
            .unwrap()
            .clone();
        let mut wizard = JourneyWizard::new(capabilities, state);
        wizard.discovery = Some(DiscoveryEvidence {
            key: discovery_key_for_document(&document).unwrap(),
            engine: Some(nemoclaw_sdk::discovery::EngineObservation {
                status: nemoclaw_sdk::discovery::ObservationStatus::Unavailable,
                reason: Some("target rejected engine".into()),
                source: "fixture".into(),
                server_version: None,
                architecture: None,
                operating_system: None,
                memory_bytes: None,
                cpus: None,
            }),
            fabric: None,
        });
        wizard.started = true;
        wizard.advance();

        assert!(!wizard.accepted);
        assert!(
            wizard
                .error
                .as_deref()
                .is_some_and(|error| error.contains("selected engine"))
        );
    }

    #[tokio::test]
    async fn unavailable_optional_bundle_keeps_model_discovery_unverified() {
        let capabilities = Capabilities::available();
        let state = load_journey(Source::Defaults, &capabilities).unwrap();
        let document = state
            .resolve(&capabilities)
            .unwrap()
            .assessment()
            .document()
            .unwrap()
            .clone();
        let request = inference_request_for_document(&document, state.current_route()).unwrap();
        let missing = std::path::Path::new("/definitely/missing/nemoclaw-bundle");
        let observed = observe_models(missing, request, &CancellationToken::new())
            .await
            .unwrap();
        assert!(observed.is_none());
    }
}
