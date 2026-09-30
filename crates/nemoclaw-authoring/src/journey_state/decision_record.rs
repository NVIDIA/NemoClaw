// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Records deliberate answers, omissions, and dependency invalidation.

use super::*;

/// The user's decisions about applicable questions, separate from supplied values.
#[derive(Clone, Debug, Default)]
pub(super) struct DecisionRecord {
    pub(super) accepted: BTreeSet<String>,
    pub(super) reopened_by: BTreeMap<String, String>,
    pub(super) omitted: BTreeSet<String>,
    pub(super) selected_presets: BTreeMap<usize, ProviderPreset>,
    pub(super) accepted_presets: BTreeSet<usize>,
    pub(super) accepted_model_settings: BTreeSet<(usize, String)>,
    pub(super) omitted_model_settings: BTreeSet<(usize, String)>,
}

impl DecisionRecord {
    pub(super) fn status(&self, id: &str, selected_route: Option<usize>) -> DecisionStatus {
        // Native model settings and the compound provider preset are decisions
        // about one route, even though their question IDs contain no route index.
        if id.starts_with("model:") {
            return selected_route.map_or(DecisionStatus::Unreviewed, |route| {
                let key = (route, id.to_owned());
                if self.omitted_model_settings.contains(&key) {
                    DecisionStatus::Omitted
                } else if self.accepted_model_settings.contains(&key) {
                    DecisionStatus::Accepted
                } else {
                    DecisionStatus::Unreviewed
                }
            });
        }
        if id == "inference:preset" {
            return if selected_route.is_some_and(|route| self.accepted_presets.contains(&route)) {
                DecisionStatus::Accepted
            } else {
                DecisionStatus::Unreviewed
            };
        }
        if let Some(because) = self.reopened_by.get(id) {
            DecisionStatus::Reopened {
                because: because.clone(),
            }
        } else if self.omitted.contains(id) {
            DecisionStatus::Omitted
        } else if self.accepted.contains(id) {
            DecisionStatus::Accepted
        } else {
            DecisionStatus::Unreviewed
        }
    }

    pub(super) fn record_answer(&mut self, id: &str, omitted: bool, selected_route: Option<usize>) {
        self.accepted.insert(id.into());
        self.reopened_by.remove(id);
        if id.starts_with("model:") {
            if let Some(route) = selected_route {
                let key = (route, id.to_owned());
                self.accepted_model_settings.insert(key.clone());
                if omitted {
                    self.omitted_model_settings.insert(key);
                } else {
                    self.omitted_model_settings.remove(&key);
                }
            }
        } else if id == "inference:preset" {
            if let Some(route) = selected_route {
                self.accepted_presets.insert(route);
            }
        } else if omitted {
            self.omitted.insert(id.into());
        } else {
            self.omitted.remove(id);
        }
    }

    pub(super) fn reopen(&mut self, id: &str, cause: &str) {
        if self.accepted.remove(id) || self.reopened_by.contains_key(id) {
            self.reopened_by.insert(id.into(), cause.into());
        }
    }

    pub(super) fn forget_model_settings(&mut self, route: usize) {
        self.accepted_model_settings
            .retain(|(index, _)| *index != route);
        self.omitted_model_settings
            .retain(|(index, _)| *index != route);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_and_preset_decisions_follow_the_selected_route() {
        let mut record = DecisionRecord::default();
        let setting = "model:/model_metadata/contextWindow";
        record.record_answer(setting, false, Some(0));
        record.record_answer("inference:preset", false, Some(0));
        assert_eq!(record.status(setting, Some(0)), DecisionStatus::Accepted);
        assert_eq!(
            record.status("inference:preset", Some(0)),
            DecisionStatus::Accepted
        );
        assert_eq!(record.status(setting, Some(1)), DecisionStatus::Unreviewed);
        assert_eq!(
            record.status("inference:preset", Some(1)),
            DecisionStatus::Unreviewed
        );
        record.omitted_model_settings.insert((1, setting.into()));
        assert_eq!(record.status(setting, Some(1)), DecisionStatus::Omitted);
    }
}
