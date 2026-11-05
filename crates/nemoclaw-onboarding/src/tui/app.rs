// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::labels::display_value;
use nemoclaw_authoring::{
    Capabilities, Diagnostics, JourneyQuestion, JourneyResolution, JourneyState,
};
use nemoclaw_sdk::discovery::DiscoveryObservations;
use nemoclaw_sdk::{config::Document, discovery::DiscoveryRequest};
use serde_json::Value;
use std::cell::{Cell, RefCell};

pub(crate) struct JourneyWizard {
    pub(super) capabilities: Capabilities,
    /// Private, with `observations`, so every change clears `resolution`.
    state: JourneyState,
    pub(super) history: Vec<JourneyState>,
    pub(super) selected: usize,
    pub(super) selection_changed: bool,
    pub(super) custom_answer: bool,
    observations: DiscoveryObservations,
    /// The last resolution of `state` with `observations`. Resolving
    /// validates and parses the whole document, and the view, the next
    /// question, and each step ask for it again.
    resolution: RefCell<Option<Result<JourneyResolution, Diagnostics>>>,
    resolutions: Cell<usize>,
    /// The configuration of the cached resolution, once built. Building it
    /// serializes, reads back, and validates the whole document.
    configuration: RefCell<Option<Option<Result<String, String>>>>,
    configurations: Cell<usize>,
    /// The engines this machine's environment names, read before the first question.
    pub(super) local_engine_candidates: Vec<DiscoveryRequest>,
    pub(super) input: String,
    pub(super) error: Option<String>,
    pub(super) started: bool,
    pub(super) accepted: bool,
    pub(super) review_scroll: u16,
    /// The furthest the review can scroll, as of its last render: the view
    /// alone knows how its wrapped text fits.
    pub(super) review_scroll_limit: Cell<u16>,
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
            observations: DiscoveryObservations::new(),
            resolution: RefCell::new(None),
            resolutions: Cell::new(0),
            configuration: RefCell::new(None),
            configurations: Cell::new(0),
            local_engine_candidates: Vec::new(),
            input: String::new(),
            error: None,
            started: false,
            accepted: false,
            review_scroll: 0,
            review_scroll_limit: Cell::new(0),
        }
    }

    /// Read `candidates` as this machine's engines.
    pub(crate) fn with_local_engine_candidates(
        mut self,
        candidates: Vec<DiscoveryRequest>,
    ) -> Self {
        self.local_engine_candidates = candidates;
        self
    }

    /// Keep what the target said, and which of this machine's engines answered.
    pub(super) fn remember(&mut self, observed: DiscoveryObservations) {
        self.observations.merge(observed);
        self.state
            .use_local_engines(&self.local_engine_candidates, &self.observations);
        self.changed();
    }

    /// Keep one observation of the target.
    #[cfg(test)]
    pub(super) fn record(
        &mut self,
        query: nemoclaw_sdk::discovery::DiscoveryQuery,
        observation: nemoclaw_sdk::discovery::DiscoveryObservation,
    ) {
        self.observations.record(query, observation);
        self.changed();
    }

    pub(crate) fn state(&self) -> &JourneyState {
        &self.state
    }

    pub(super) fn observations(&self) -> &DiscoveryObservations {
        &self.observations
    }

    /// The journey resolved with what the target said, reused until the
    /// state or observations change.
    pub(super) fn resolution(&self) -> Result<JourneyResolution, Diagnostics> {
        if let Some(resolved) = self.resolution.borrow().as_ref() {
            return resolved.clone();
        }
        let resolved = self
            .state
            .resolve_with_observations(&self.capabilities, &self.observations);
        self.resolutions.set(self.resolutions.get() + 1);
        *self.resolution.borrow_mut() = Some(resolved.clone());
        resolved
    }

    /// How many times the journey was resolved.
    #[cfg(test)]
    pub(super) fn resolutions(&self) -> usize {
        self.resolutions.get()
    }

    /// How many times the saved configuration was built.
    #[cfg(test)]
    pub(super) fn configurations(&self) -> usize {
        self.configurations.get()
    }

    /// Make the current configuration unsaveable for `reason`, a failure no
    /// supported document produces.
    #[cfg(test)]
    pub(super) fn fail_configuration(&self, reason: &str) {
        *self.configuration.borrow_mut() = Some(Some(Err(reason.into())));
    }

    fn changed(&mut self) {
        *self.resolution.get_mut() = None;
        *self.configuration.get_mut() = None;
        // A changed review starts at its target verdict again.
        self.review_scroll = 0;
    }

    /// Whether the journey is complete, its target allows saving, and its
    /// configuration can be written.
    pub(super) fn saveable(&self) -> bool {
        self.resolution()
            .is_ok_and(|resolution| resolution.ready_document().is_some())
            && matches!(self.configuration(), Some(Ok(_)))
    }

    pub(crate) fn question(&self) -> Result<Option<JourneyQuestion>, Diagnostics> {
        Ok(self.resolution()?.next_question().cloned())
    }

    /// Every question is answered and the review is open.
    pub(super) fn reviewing(&self) -> bool {
        self.started && matches!(self.question(), Ok(None))
    }

    pub(super) fn choice_index(&self, question: &JourneyQuestion) -> usize {
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
        let question = self
            .question()?
            .expect("submit requires an active question");
        let previous = self.state.clone();
        let answered = self.state.answer(&self.capabilities, question.id(), answer);
        self.changed();
        answered?;
        self.history.push(previous);
        self.selected = 0;
        self.selection_changed = false;
        self.custom_answer = false;
        self.input.clear();
        self.error = None;
        Ok(())
    }

    pub(super) fn delegate(&mut self) {
        match self
            .state
            .delegate_remaining(&self.capabilities, &self.observations)
        {
            Ok(delegated) => {
                self.history.push(self.state.clone());
                self.state = delegated;
                self.changed();
                self.error = None;
            }
            // The resolver already supplies a catalog credential note. Keep
            // its deferred model check separate from compatibility failures.
            Err(error)
                if error
                    .items()
                    .iter()
                    .all(|item| item.field() == "inference:catalog:credential") =>
            {
                self.error = None;
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    pub(super) fn back(&mut self) {
        if let Some(previous) = self.history.pop() {
            self.state = previous;
            self.changed();
            self.selected = 0;
            self.selection_changed = false;
            self.custom_answer = false;
            self.input.clear();
            self.error = None;
        } else {
            self.started = false;
        }
    }

    // A resolver failure has no choices to move through; the view shows it.
    pub(super) fn previous(&mut self) {
        match self.question() {
            Ok(None) if self.started => {
                self.review_scroll = self
                    .review_scroll
                    .min(self.review_scroll_limit.get())
                    .saturating_sub(1);
            }
            Ok(Some(question)) if !question.choices().is_empty() => {
                self.selected = self.choice_index(&question).saturating_sub(1);
                self.selection_changed = true;
            }
            _ => {}
        }
    }

    pub(super) fn next(&mut self) {
        match self.question() {
            Ok(None) if self.started => {
                self.review_scroll = self
                    .review_scroll
                    .saturating_add(1)
                    .min(self.review_scroll_limit.get());
            }
            Ok(Some(question)) if !question.choices().is_empty() => {
                self.selected = (self.choice_index(&question) + 1).min(
                    question.choices().len()
                        - usize::from(question.required() && !question.allows_custom_answer()),
                );
                self.selection_changed = true;
            }
            _ => {}
        }
    }

    pub(super) fn suggested_input(&self, question: &JourneyQuestion) -> String {
        question
            .suggestion()
            .map_or_else(String::new, display_value)
    }

    pub(super) fn answer_from_input(
        &self,
        question: &JourneyQuestion,
    ) -> Result<Option<Value>, String> {
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
        if question.schema()["type"] == "string"
            || (question.schema()["type"].is_null()
                && question.schema().get("oneOf").is_none()
                && question.schema().get("anyOf").is_none())
        {
            Ok(Some(Value::String(raw)))
        } else {
            serde_json::from_str(&raw)
                .map(Some)
                .map_err(|error| format!("Enter a JSON value: {error}"))
        }
    }

    pub(super) fn advance(&mut self) {
        if !self.started {
            self.started = true;
            return;
        }
        let resolution = match self.resolution() {
            Ok(resolution) => resolution,
            Err(error) => {
                self.error = Some(error.to_string());
                return;
            }
        };
        let Some(question) = resolution.next_question().cloned() else {
            // A review that cannot be saved already says why, so Enter does nothing.
            if self.saveable() {
                self.accepted = true;
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

    pub(super) fn document(&self) -> Result<Document, Box<dyn std::error::Error>> {
        self.resolution()?
            .ready_document()
            .cloned()
            .ok_or_else(|| "the journey is not complete".into())
    }

    /// The configuration the journey saves: the reviewed deployment's
    /// authored values, leaving what nobody chose to the SDK's defaults.
    pub(crate) fn saved_yaml(&self) -> Result<String, Box<dyn std::error::Error>> {
        self.document()?;
        Ok(self
            .configuration()
            .ok_or("the journey is not complete")??)
    }

    /// The YAML the review shows and saving writes, once the document is
    /// complete, or why it cannot be written.
    pub(super) fn configuration(&self) -> Option<Result<String, String>> {
        if let Some(built) = self.configuration.borrow().as_ref() {
            return built.clone();
        }
        let built = self.resolution().ok().and_then(|resolution| {
            let document = resolution.materialized_document()?;
            self.configurations.set(self.configurations.get() + 1);
            Some(
                super::saved::authored_yaml(document, self.state.values())
                    .map_err(|error| error.to_string()),
            )
        });
        *self.configuration.borrow_mut() = Some(built.clone());
        built
    }
}
