// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Opt-in hardware test support. Observations do not apply, repair, or destroy resources.
mod state;
pub use state::{ResourceIdentities, StateSnapshot};
mod evidence;
mod inference;
mod inputs;
pub use evidence::Evidence;
pub use inference::{InferenceRuntime, PreparedObservation, ReceiptObservation};
pub use inputs::LiveInputs;
