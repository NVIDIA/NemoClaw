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
    Cancel,
}

pub(crate) struct Wizard {
    pub(super) capabilities: Capabilities,
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
    local_podman: bool,
}

impl Wizard {
    pub(crate) fn new(capabilities: Capabilities, draft: Draft) -> Self {
        Self::for_host(capabilities, draft, std::env::consts::OS)
    }

    pub(super) fn for_host(capabilities: Capabilities, draft: Draft, host_os: &str) -> Self {
        Self {
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
            local_podman: host_os == "linux",
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
            Input::Continue => self.advance(),
            _ => {}
        }
    }

    fn advance(&mut self) {
        if self.step == Step::Welcome {
            self.set_step(self.flow_steps()[0]);
            return;
        }
        if self.step == Step::Review {
            self.accepted = true;
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
        let steps = self.flow_steps();
        let index = steps.iter().position(|step| *step == self.step).unwrap();
        let next = steps[index + 1..]
            .iter()
            .copied()
            .find(|step| field_for_step(*step).is_none_or(|field| !self.draft.is_accepted(field)))
            .unwrap_or(Step::Review);
        self.set_step(next);
    }

    fn go_back(&mut self) {
        if self.step == Step::Welcome {
            self.cancelled = true;
            return;
        }
        if self.custom_model && !self.choice_values().is_empty() {
            self.custom_model = false;
            self.selected = self.current_choice_index();
            return;
        }
        let steps = self.flow_steps();
        let index = steps.iter().position(|step| *step == self.step).unwrap();
        self.set_step(if index == 0 {
            Step::Welcome
        } else {
            steps[index - 1]
        });
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
        self.replace_input = self.is_text();
    }

    pub(super) fn is_choice(&self) -> bool {
        !self.custom_model
            && self.field().is_some_and(EditableField::is_choice)
            && !self.choice_values().is_empty()
    }

    fn is_text(&self) -> bool {
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
                !field.is_choice()
                    || field.id() == EditableField::Model
                    || field.choices().len() > 1
            })
            .filter_map(|field| match field.id() {
                EditableField::Harness => Some(Step::Harness),
                EditableField::Runtime => Some(Step::Runtime),
                EditableField::Inference => Some(Step::Inference),
                EditableField::Api => Some(Step::Api),
                EditableField::DeploymentName => Some(Step::DeploymentName),
                EditableField::Endpoint => Some(Step::Endpoint),
                EditableField::Model => Some(Step::Model),
                _ => None,
            })
            .collect::<Vec<_>>();
        steps.push(Step::Review);
        steps
    }

    fn field_state(&self) -> Option<nemoclaw_authoring::GuidedField> {
        let field = self.field()?;
        self.draft
            .guided_fields(&self.capabilities)
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
        self.field_state()
            .map(|field| field.choices().to_vec())
            .unwrap_or_default()
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
            Some(FieldValue::Runtime(runtime)) => self.runtime_unavailable_reason(*runtime),
            _ => None,
        }
    }

    pub(super) fn choice_labels(&self) -> Vec<String> {
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
                    "{name}: {} (confirm for the changed provider or endpoint)\n",
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
        field
            .choices()
            .iter()
            .position(|choice| choice == field.value())
            .unwrap_or(field.choices().len())
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
        Step::Welcome | Step::Review => return None,
    })
}
