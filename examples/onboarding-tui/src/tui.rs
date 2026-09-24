// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod app;
mod labels;
#[cfg(test)]
mod template_tests;
mod terminal;
#[cfg(test)]
mod tests;
mod view;

pub(crate) use terminal::run;
