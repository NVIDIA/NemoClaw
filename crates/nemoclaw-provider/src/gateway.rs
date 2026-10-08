// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

mod process;
mod readiness;

pub(crate) use readiness::GatewayReadinessDataSource;

use openshell_provider::observe_with_wait;
