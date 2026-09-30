// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Terminal frontend over the single sparse journey resolver.

mod app;
mod labels;
mod logo;
mod terminal;
#[cfg(test)]
mod tests;
mod view;

#[cfg(test)]
pub(crate) use app::JourneyWizard;
pub(crate) use terminal::run;
