// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
#[cfg(target_os = "linux")]
mod backend;
#[cfg(target_os = "linux")]
mod hardware;
#[cfg(target_os = "linux")]
mod recipe;
#[cfg(target_os = "linux")]
mod runtime;
#[cfg(target_os = "linux")]
mod supervisor;

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    use nemoclaw_sdk::{CancellationToken, Error, config::Service};
    let cancel = CancellationToken::new();
    let trip = CancellationToken::new();
    let signals=async {
        let mut stop=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).map_err(|_|Error::State("cannot install runtime termination handler"))?;
        let mut interrupt=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt()).map_err(|_|Error::State("cannot install runtime interrupt handler"))?;
        let mut protection=tokio::signal::unix::signal(tokio::signal::unix::SignalKind::user_defined1()).map_err(|_|Error::State("cannot install protection handler"))?;
        let cancel=cancel.clone();let trip=trip.clone();
        Ok::<_,Error>(tokio::spawn(async move {
            tokio::select! { _=stop.recv()=>cancel.cancel(),_=interrupt.recv()=>cancel.cancel(),_=protection.recv()=>trip.cancel() }
        }))
    }.await;
    let result = async {
        let _signals = signals?;
        let read = |name| match std::env::var(name) {
            Ok(value) => Ok(Some(value)),
            Err(std::env::VarError::NotPresent) => Ok(None),
            Err(std::env::VarError::NotUnicode(_)) => {
                Err(Error::State("runtime specification is not UTF-8"))
            }
        };
        let current = read("NEMOCLAW_RUNTIME_SPEC")?;
        let legacy = read("NEMOCLAW_SPARK_SPEC")?;
        if current
            .as_ref()
            .zip(legacy.as_ref())
            .is_some_and(|(a, b)| a != b)
        {
            return Err(Error::Conflict("conflicting runtime specifications"));
        }
        let text = current
            .or(legacy)
            .ok_or(Error::State("missing runtime specification"))?;
        let spec: Service = serde_json::from_str(&text)
            .map_err(|_| Error::State("invalid pinned runtime specification"))?;
        spec.validate()?;
        runtime::run(&spec, &cancel, &trip).await
    }
    .await;
    if let Err(error) = result {
        eprintln!("{error}");
        return std::process::ExitCode::FAILURE;
    }
    std::process::ExitCode::SUCCESS
}
#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!(
        "the inference runtime requires Linux; hardware support depends on the selected recipe"
    );
    std::process::ExitCode::FAILURE
}
