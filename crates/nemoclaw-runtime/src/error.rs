// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("memory protection failed: {0}")]
    Protection(String),
    #[error("{0}")]
    Observation(#[from] crate::ObservationError),
    #[error("managed service connection refused; inventory is unknown")]
    ServiceStarting,
    #[error("{0}")]
    Configuration(#[from] crate::config::ConfigError),
    #[error("{0}")]
    Hardware(#[from] crate::hardware::HardwareDiagnostic),
    #[error("{0}")]
    State(&'static str),
    #[error("{0}")]
    Conflict(&'static str),
    #[error("operation interrupted; retain state and reapply the same configuration")]
    Cancelled,
    /// The managed service process exited by itself. The text is the end of
    /// its output, when the runtime kept it.
    #[error("managed service process exited; {}", exited_guidance(.0.as_deref()))]
    Exited(Option<String>),
}

fn exited_guidance(output: Option<&str>) -> String {
    match output {
        Some(output) => format!(
            "its final output follows, and the container log has all of it; correct the cause and reapply:\n{output}"
        ),
        None => "inspect retained logs and reapply".into(),
    }
}
