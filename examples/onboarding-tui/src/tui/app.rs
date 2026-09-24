// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::labels;
use nemoclaw_authoring::{
    Capabilities, Draft, EditableField, FieldValue, GuidedEdit, RuntimeChoice,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Welcome,
    Harness,
    Runtime,
    Inference,
    Api,
    DeploymentName,
    Endpoint,
    Model,
    Setting(usize),
    Review,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Input {
    Continue,
    Back,
    Next,
    Previous,
    Character(char),
    Backspace,
    SelectAll,
    DelegateRemaining,
    Cancel,
}

pub(crate) struct Wizard {
    pub(super) capabilities: Capabilities,
    base_capabilities: Capabilities,
    pub(super) draft: Draft,
    pub(super) step: Step,
    pub(super) selected: usize,
    pub(super) input: String,
    pub(super) replace_input: bool,
    pub(super) custom_model: bool,
    pub(super) accepted: bool,
    pub(super) cancelled: bool,
    pub(super) error: Option<String>,
    pub(super) pending_edit: Option<GuidedEdit>,
    pub(super) target_status: Option<String>,
    pub(super) discovery: Option<nemoclaw_authoring::DiscoveryEvidence>,
    pub(super) facts: nemoclaw_authoring::AuthoringFacts,
    local_podman: bool,
    history: Vec<Step>,
}

impl Wizard {
    pub(crate) fn new(capabilities: Capabilities, draft: Draft) -> Self {
        Self::for_host(capabilities, draft, std::env::consts::OS)
    }

    pub(super) fn for_host(capabilities: Capabilities, draft: Draft, host_os: &str) -> Self {
        let capabilities = capabilities
            .preserving_draft(&draft)
            .expect("wizard receives a losslessly representable guided draft");
        Self {
            base_capabilities: capabilities.clone(),
            capabilities,
            draft,
            step: Step::Welcome,
            selected: 0,
            input: String::new(),
            replace_input: false,
            custom_model: false,
            accepted: false,
            cancelled: false,
            error: None,
            pending_edit: None,
            target_status: None,
            discovery: None,
            facts: Default::default(),
            local_podman: host_os == "linux",
            history: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(super) fn step(&self) -> Step {
        self.step
    }

    pub(crate) fn draft(&self) -> &Draft {
        &self.draft
    }

    #[cfg(test)]
    pub(super) fn input_value(&self) -> &str {
        &self.input
    }

    #[cfg(test)]
    pub(super) fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(crate) fn accepted(&self) -> bool {
        self.accepted
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.cancelled
    }

    pub(crate) fn handle(&mut self, input: Input) {
        self.refresh_catalog();
        if matches!(input, Input::Cancel) {
            self.cancelled = true;
            return;
        }
        if self.pending_edit.is_some() {
            match input {
                Input::Continue => {
                    self.draft = self.pending_edit.take().unwrap().accept();
                    self.advance_step();
                }
                Input::Back => {
                    self.pending_edit = None;
                }
                _ => {}
            }
            return;
        }
        match input {
            Input::Next if self.is_choice() => self.move_selection(1),
            Input::Previous if self.is_choice() => self.move_selection(-1),
            Input::Back => self.go_back(),
            Input::SelectAll if self.is_text() => self.replace_input = true,
            Input::Character(character) if self.is_text() => {
                self.error = None;
                if self.replace_input {
                    self.input.clear();
                    self.replace_input = false;
                }
                self.input.push(character);
            }
            Input::Backspace if self.is_text() => {
                self.error = None;
                if self.replace_input {
                    self.input.clear();
                    self.replace_input = false;
                } else {
                    self.input.pop();
                }
            }
            Input::DelegateRemaining if self.can_offer_delegation() => self.delegate_remaining(),
            Input::Continue => self.advance(),
            _ => {}
        }
    }

    fn current_catalog(&self) -> Option<&nemoclaw_sdk::fabric_catalog::FabricCatalog> {
        let key = self.draft.discovery_key().ok()?;
        let evidence = self.discovery.as_ref()?;
        if evidence.key.engine != key.engine || evidence.key.image != key.image {
            return None;
        }
        let observed = evidence.fabric.as_ref()?;
        if observed.status == nemoclaw_sdk::discovery::ObservationStatus::Unavailable {
            return None;
        }
        observed.catalog.as_ref()
    }

    pub(super) fn refresh_catalog(&mut self) {
        let setting = self.setting_question();
        let setting_value = setting
            .as_ref()
            .and_then(|question| question.choices.get(self.selected))
            .cloned();
        let custom_selection =
            self.step == Step::Model && self.selected == self.choice_values().len();
        let selected = self.choice_values().get(self.selected).cloned();
        self.capabilities = self
            .current_catalog()
            .map(Capabilities::from_catalog)
            .unwrap_or_else(|| self.base_capabilities.clone());
        if let Some(previous) = setting {
            if let Some(current) = self.setting_question()
                && previous.path == current.path
                && previous.schema == current.schema
            {
                if let Some(value) = setting_value {
                    self.selected = current
                        .choices
                        .iter()
                        .position(|choice| choice == &value)
                        .unwrap_or(0);
                }
                return;
            }
            self.set_step(self.step);
            return;
        }
        if custom_selection {
            self.selected = self.choice_values().len();
            return;
        }
        self.selected = selected
            .and_then(|value| {
                self.choice_values()
                    .iter()
                    .position(|choice| choice == &value)
            })
            .unwrap_or_else(|| self.current_choice_index());
    }

    pub(super) fn can_offer_delegation(&self) -> bool {
        self.pending_edit.is_none()
            && !matches!(self.step, Step::Welcome | Step::Harness | Step::Review)
            && self.draft.is_accepted(EditableField::Harness)
    }

    fn delegate_remaining(&mut self) {
        if let Some(field) = self.field_state() {
            let edited = if self.is_choice() {
                self.choice_values().get(self.selected) != Some(field.value())
            } else {
                match field.value() {
                    FieldValue::Text(value) | FieldValue::Model(value) => self.input != *value,
                    _ => false,
                }
            };
            if edited {
                self.error = Some(
                    "Press Enter to accept this answer before choosing remaining settings.".into(),
                );
                return;
            }
        }
        if let Ok(key) = self.draft.discovery_key()
            && let Some(reason) = self.runtime_unavailable_reason(key.compute_driver)
        {
            self.error = Some(format!(
                "Podman {reason}. Choose Docker before delegating settings."
            ));
            return;
        }
        match self.draft.delegate_remaining(
            &self.capabilities,
            self.discovery.as_ref(),
            &self.facts,
        ) {
            Ok(draft) => {
                self.draft = draft;
                self.advance_step();
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn advance(&mut self) {
        if self.step == Step::Welcome {
            self.advance_step();
            return;
        }
        if self.step == Step::Review {
            match self.draft.next_setting(&self.capabilities) {
                Ok(Some(_)) => {
                    self.advance_step();
                    return;
                }
                Err(error) => {
                    self.error = Some(error.to_string());
                    return;
                }
                _ => {}
            }
            if let Err(error) = self.draft.validate_settings(&self.capabilities) {
                self.error = Some(error.to_string());
                return;
            }
            if self.draft.has_delegated_answers()
                && let Err(error) = self.draft.check_delegation(
                    &self.capabilities,
                    self.discovery.as_ref(),
                    &self.facts,
                )
            {
                self.error = Some(error.to_string());
                return;
            }
            if let Some(evidence) = &self.discovery {
                match evidence.assessment(&self.draft) {
                    Ok(assessment)
                        if assessment.status
                            == nemoclaw_authoring::CompatibilityStatus::Conflict =>
                    {
                        self.error = Some(assessment.reasons.join(" "));
                        return;
                    }
                    Err(error) => {
                        self.error = Some(error.to_string());
                        return;
                    }
                    _ => {}
                }
            }
            match self.draft.next_question(&self.capabilities) {
                Ok(None) => self.accepted = true,
                Ok(Some(_)) => self.advance_step(),
                Err(error) => self.error = Some(error.to_string()),
            }
            return;
        }
        if let Some(question) = self.setting_question() {
            let value = if !question.choices.is_empty() {
                if self.selected < question.choices.len() {
                    Ok(Some(question.choices[self.selected].clone()))
                } else {
                    Ok(None)
                }
            } else if self.input.is_empty() && !question.required {
                Ok(None)
            } else {
                question.parse(&self.input).map(Some)
            };
            match value.and_then(|value| {
                self.draft
                    .answer_setting(&self.capabilities, &question.path, value)
            }) {
                Ok(()) => self.advance_step(),
                Err(error) => self.error = Some(error.to_string()),
            }
            return;
        }
        if self.step == Step::Model
            && !self.custom_model
            && self.selected == self.choice_values().len()
        {
            self.custom_model = true;
            self.input = self
                .field_state()
                .and_then(|field| match field.value() {
                    FieldValue::Model(value) => Some(value.clone()),
                    _ => None,
                })
                .unwrap_or_default();
            self.replace_input = true;
            return;
        }
        if self.is_choice()
            && let Some(reason) = self.choice_unavailable_reason(self.selected)
        {
            self.error = Some(reason.into());
            return;
        }
        let result = if self.is_choice() {
            self.commit_choice()
        } else if self.input.trim().is_empty() {
            return;
        } else {
            self.commit_text()
        };
        match result {
            Ok(edit) => {
                self.error = None;
                if !edit.conflicts().is_empty() {
                    self.pending_edit = Some(edit);
                    return;
                }
                self.draft = edit.accept();
            }
            Err(diagnostics) => {
                self.error = Some(diagnostics.to_string());
                return;
            }
        }
        self.advance_step();
    }

    fn advance_step(&mut self) {
        match self.draft.next_question(&self.capabilities) {
            Ok(question) => {
                let next = if let Some(step) = question.and_then(|field| step_for_field(field.id()))
                {
                    step
                } else {
                    match self.draft.next_setting(&self.capabilities) {
                        Ok(Some(question)) => {
                            let fields = self
                                .draft
                                .setting_questions(&self.capabilities)
                                .expect("question comes from active schema");
                            Step::Setting(
                                fields
                                    .iter()
                                    .position(|field| field.path == question.path)
                                    .unwrap(),
                            )
                        }
                        Ok(None) => Step::Review,
                        Err(error) => {
                            self.error = Some(error.to_string());
                            return;
                        }
                    }
                };
                if self.step != next {
                    self.history.push(self.step);
                }
                self.set_step(next);
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn go_back(&mut self) {
        if self.step == Step::Review {
            self.draft.revoke_delegation();
        }
        if self.step == Step::Welcome {
            self.cancelled = true;
            return;
        }
        if self.custom_model && !self.choice_values().is_empty() {
            self.custom_model = false;
            self.selected = self.current_choice_index();
            return;
        }
        let previous = self.history.pop().unwrap_or(Step::Welcome);
        self.set_step(previous);
    }

    fn set_step(&mut self, step: Step) {
        self.step = step;
        self.error = None;
        self.custom_model = step == Step::Model
            && self.field_state().is_some_and(|field| {
                field.choices().is_empty() || !field.choices().contains(field.value())
            });
        self.selected = self.current_choice_index();
        self.input = self
            .field_state()
            .and_then(|field| match field.value() {
                FieldValue::Text(value) | FieldValue::Model(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_default();
        if let Some(question) = self.setting_question() {
            self.selected = question
                .suggestion
                .as_ref()
                .and_then(|value| question.choices.iter().position(|choice| choice == value))
                .unwrap_or(if question.required {
                    0
                } else {
                    question.choices.len()
                });
            self.input = question
                .suggestion
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string())
                })
                .unwrap_or_default();
        }
        self.replace_input = self.is_text();
    }

    pub(super) fn setting_question(&self) -> Option<nemoclaw_authoring::SettingQuestion> {
        let Step::Setting(index) = self.step else {
            return None;
        };
        self.draft
            .setting_questions(&self.capabilities)
            .ok()?
            .get(index)
            .cloned()
    }

    pub(super) fn is_choice(&self) -> bool {
        if let Some(question) = self.setting_question() {
            return !question.choices.is_empty();
        }
        !self.custom_model
            && self.field().is_some_and(EditableField::is_choice)
            && !self.choice_values().is_empty()
    }

    fn is_text(&self) -> bool {
        if let Some(question) = self.setting_question() {
            return question.choices.is_empty();
        }
        self.custom_model || self.field().is_some_and(|field| !field.is_choice())
    }

    fn field(&self) -> Option<EditableField> {
        field_for_step(self.step)
    }

    pub(super) fn flow_steps(&self) -> Vec<Step> {
        let mut steps = self
            .draft
            .guided_fields(&self.capabilities)
            .expect("wizard retains a guided document")
            .into_iter()
            .filter(|field| {
                self.draft.answer_status(field.id()) != nemoclaw_authoring::AnswerStatus::Delegated
            })
            .filter(|field| {
                !field.is_choice()
                    || field.id() == EditableField::Model
                    || field.choices().len() > 1
            })
            .filter_map(|field| step_for_field(field.id()))
            .collect::<Vec<_>>();
        // Progress follows the questions actually visited, not the old field order.
        let mut visited = Vec::new();
        for step in self.history.iter().chain(std::iter::once(&self.step)) {
            if steps.contains(step) && !visited.contains(step) {
                visited.push(*step);
            }
        }
        steps.sort_by_key(|step| {
            visited
                .iter()
                .position(|seen| seen == step)
                .unwrap_or(visited.len())
        });
        if let Ok(settings) = self.draft.setting_questions(&self.capabilities) {
            steps.extend((0..settings.len()).map(Step::Setting));
        }
        steps.push(Step::Review);
        steps
    }

    fn field_state(&self) -> Option<nemoclaw_authoring::GuidedField> {
        let field = self.field()?;
        self.draft
            .guided_fields_with_facts(&self.capabilities, &self.facts)
            .ok()?
            .into_iter()
            .find(|state| state.id() == field)
    }

    fn move_selection(&mut self, delta: isize) {
        self.error = None;
        let count = self.choice_labels().len();
        if count == 0 {
            return;
        }
        for _ in 0..count {
            self.selected = (self.selected as isize + delta).rem_euclid(count as isize) as usize;
            if self.choice_unavailable_reason(self.selected).is_none() {
                break;
            }
        }
    }

    fn choice_values(&self) -> Vec<FieldValue> {
        let Some(field) = self.field_state() else {
            return Vec::new();
        };
        field.choices().to_vec()
    }

    pub(super) fn runtime_unavailable_reason(
        &self,
        runtime: RuntimeChoice,
    ) -> Option<&'static str> {
        // This preset uses a local Linux socket and native gateway process.
        // It does not configure Podman Machine or a remote Linux target.
        (runtime == RuntimeChoice::Podman && !self.local_podman).then_some("requires local Linux")
    }

    pub(super) fn choice_unavailable_reason(&self, index: usize) -> Option<&'static str> {
        match self.choice_values().get(index) {
            Some(choice)
                if self.current_catalog().is_some()
                    && Some(&self.capabilities).is_some_and(|offered| {
                        self.field()
                            .zip(self.draft.guided_answers(&self.capabilities).ok())
                            .is_some_and(|(field, answers)| {
                                !offered.offers(&answers, field, choice)
                            })
                    }) =>
            {
                Some("not advertised by the selected image")
            }
            Some(FieldValue::Runtime(runtime)) => self.runtime_unavailable_reason(*runtime),
            _ => None,
        }
    }

    pub(super) fn choice_labels(&self) -> Vec<String> {
        if let Some(question) = self.setting_question() {
            let mut labels: Vec<_> = question
                .choices
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string())
                })
                .collect();
            if !question.required {
                labels.push("Leave unset".into());
            }
            return labels;
        }
        let mut labels = self
            .choice_values()
            .iter()
            .map(labels::field_value)
            .map(str::to_owned)
            .collect::<Vec<_>>();
        if self.step == Step::Model
            && self
                .field_state()
                .is_some_and(|field| field.accepts_custom())
        {
            labels.push("Other model…".into());
        }
        labels
    }

    pub(super) fn conflict_message(&self) -> String {
        let Some(edit) = &self.pending_edit else {
            return String::new();
        };
        let mut message = String::from("This choice affects answers you already accepted:\n\n");
        for change in edit.conflicts() {
            let name = match change.field {
                EditableField::Harness => "Harness",
                EditableField::Runtime => "Runtime",
                EditableField::Inference => "Provider",
                EditableField::Api => "API",
                EditableField::Model => "Model",
                EditableField::Endpoint => "Endpoint",
                _ => "Answer",
            };
            if change.before == change.after {
                message.push_str(&format!(
                    "{name}: {} (confirm for the changed harness, API, provider, or endpoint)\n",
                    labels::field_value(&change.before)
                ));
            } else {
                message.push_str(&format!(
                    "{name}: {} → {}\n",
                    labels::field_value(&change.before),
                    labels::field_value(&change.after)
                ));
            }
        }
        message.push_str("\nContinue to revise these answers, or go back to keep them.");
        message
    }

    fn current_choice_index(&self) -> usize {
        let Some(field) = self.field_state() else {
            return 0;
        };
        let choices = self.choice_values();
        choices
            .iter()
            .position(|choice| choice == field.value())
            .unwrap_or(choices.len())
    }

    fn commit_choice(&mut self) -> Result<GuidedEdit, nemoclaw_authoring::Diagnostics> {
        let field = self.field().expect("answer screen has a field");
        let value = self.choice_values()[self.selected].clone();
        self.draft
            .propose_guided_edit(&self.capabilities, field, value)
    }

    fn commit_text(&mut self) -> Result<GuidedEdit, nemoclaw_authoring::Diagnostics> {
        let field = self.field().expect("answer screen has a field");
        let value = if field == EditableField::Model {
            FieldValue::Model(self.input.clone())
        } else {
            FieldValue::Text(self.input.clone())
        };
        self.draft
            .propose_guided_edit(&self.capabilities, field, value)
    }
}

fn field_for_step(step: Step) -> Option<EditableField> {
    Some(match step {
        Step::Harness => EditableField::Harness,
        Step::Runtime => EditableField::Runtime,
        Step::Inference => EditableField::Inference,
        Step::Api => EditableField::Api,
        Step::DeploymentName => EditableField::DeploymentName,
        Step::Endpoint => EditableField::Endpoint,
        Step::Model => EditableField::Model,
        Step::Welcome | Step::Review | Step::Setting(_) => return None,
    })
}

fn step_for_field(field: EditableField) -> Option<Step> {
    Some(match field {
        EditableField::Harness => Step::Harness,
        EditableField::Runtime => Step::Runtime,
        EditableField::Inference => Step::Inference,
        EditableField::Api => Step::Api,
        EditableField::DeploymentName => Step::DeploymentName,
        EditableField::Endpoint => Step::Endpoint,
        EditableField::Model => Step::Model,
        _ => return None,
    })
}
