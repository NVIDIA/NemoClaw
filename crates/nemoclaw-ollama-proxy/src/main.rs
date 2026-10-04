// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//! Run the Ollama proxy from the specification in `NEMOCLAW_OLLAMA_PROXY`.

#[cfg(target_os = "linux")]
#[tokio::main]
async fn main() -> std::process::ExitCode {
    use nemoclaw_ollama_proxy::{Proxy, Settings};
    use std::path::Path;
    use tokio::signal::unix::{SignalKind, signal};

    let started = async {
        let settings = std::env::var("NEMOCLAW_OLLAMA_PROXY").map_err(|_| ())?;
        let settings = Settings::parse(&settings).map_err(|_| ())?;
        Proxy::start(settings, Path::new("/data"), Path::new("/proc/net"))
            .await
            .map_err(|_| ())
    };
    let (Ok((proxy, listener)), Ok(mut terminate)) =
        (started.await, signal(SignalKind::terminate()))
    else {
        eprintln!("Ollama proxy startup failed; retained resources require inspection");
        return std::process::ExitCode::FAILURE;
    };
    // As PID 1 the process receives no default SIGTERM handling, so stop explicitly.
    tokio::select! {
        () = proxy.serve(listener) => {}
        _ = terminate.recv() => {}
    }
    std::process::ExitCode::SUCCESS
}

#[cfg(not(target_os = "linux"))]
fn main() -> std::process::ExitCode {
    eprintln!("The Ollama proxy runs only on Linux, inside its container image.");
    std::process::ExitCode::FAILURE
}
