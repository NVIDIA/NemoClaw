// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Navigation through the active form and inference route.

use super::*;

/// The branch currently being visited; this is not part of desired state.
#[derive(Clone, Debug)]
pub(super) struct JourneyPosition {
    pub(super) selected_forms: BTreeMap<String, String>,
    pub(super) selected_route: Option<usize>,
    pub(super) completed_routes: BTreeSet<usize>,
}

impl JourneyPosition {
    pub(super) fn new(selected_route: Option<usize>) -> Self {
        Self {
            selected_forms: BTreeMap::new(),
            selected_route,
            completed_routes: BTreeSet::new(),
        }
    }

    pub(super) fn select_route(&mut self, route: usize) {
        if let Some(current) = self.selected_route {
            self.completed_routes.insert(current);
        }
        self.selected_route = Some(route);
    }
}
