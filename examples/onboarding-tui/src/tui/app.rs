// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::labels;
use nemoclaw_authoring::{Capabilities, Draft, EditableField, FieldValue};

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
}

impl Wizard {
    pub(crate) fn new(capabilities: Capabilities, draft: Draft) -> Self {
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
        let result = if self.is_choice() {
            self.commit_choice()
        } else if self.input.trim().is_empty() {
            return;
        } else {
            self.commit_text()
        };
        match result {
            Ok(()) => self.error = None,
            Err(diagnostics) => {
                self.error = Some(diagnostics.to_string());
                return;
            }
        }
        let steps = self.flow_steps();
        let index = steps.iter().position(|step| *step == self.step).unwrap();
        self.set_step(steps[index + 1]);
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
            && self
                .field_state()
                .is_some_and(|field| field.choices().is_empty());
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
        Some(match self.step {
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
        self.selected = (self.selected as isize + delta).rem_euclid(count as isize) as usize;
    }

    fn choice_values(&self) -> Vec<FieldValue> {
        self.field_state()
            .map(|field| field.choices().to_vec())
            .unwrap_or_default()
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

    fn current_choice_index(&self) -> usize {
        let Some(field) = self.field_state() else {
            return 0;
        };
        field
            .choices()
            .iter()
            .position(|choice| choice == field.value())
            .unwrap_or(0)
    }

    fn commit_choice(&mut self) -> Result<(), nemoclaw_authoring::Diagnostics> {
        let Some(field) = self.field() else {
            return Ok(());
        };
        let Some(value) = self.choice_values().get(self.selected).cloned() else {
            return Ok(());
        };
        self.draft
            .set_guided_field(&self.capabilities, field, value)
    }

    fn commit_text(&mut self) -> Result<(), nemoclaw_authoring::Diagnostics> {
        let Some(field) = self.field() else {
            return Ok(());
        };
        let value = if field == EditableField::Model {
            FieldValue::Model(self.input.clone())
        } else {
            FieldValue::Text(self.input.clone())
        };
        self.draft
            .set_guided_field(&self.capabilities, field, value)
    }
}
