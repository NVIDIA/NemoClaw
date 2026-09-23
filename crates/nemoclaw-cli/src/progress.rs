// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Progress has three boundaries: the reporter owns event delivery, the model
//! interprets SDK observations, and the inline display owns terminal mechanics.

use crate::{args::ProgressMode, formatting::duration};
use nemoclaw_sdk::Progress;
use std::{
    io::{self, IsTerminal, Write},
    sync::{Arc, mpsc},
    thread,
    time::{Duration, Instant},
};

mod inline;
mod logo;
mod model;
use inline::Inline;
use model::Model;

const HEARTBEAT: Duration = Duration::from_secs(30);

/// One owner for stderr while an operation runs. Construction does not touch the terminal:
/// credential prompts may still run before the first SDK progress event.
pub(crate) struct Reporter {
    sender: Option<mpsc::Sender<Option<Progress>>>,
    worker: Option<thread::JoinHandle<()>>,
}

impl Reporter {
    pub(crate) fn new(mode: ProgressMode, verbose: bool, header: String) -> Self {
        if matches!(mode, ProgressMode::Off) {
            return Self {
                sender: None,
                worker: None,
            };
        }
        let (sender, receiver) = mpsc::channel();
        let inline = matches!(mode, ProgressMode::Auto)
            && io::stderr().is_terminal()
            && std::env::var("TERM").is_ok_and(|term| term != "dumb");
        let worker = thread::spawn(move || run(receiver, inline, verbose, header));
        Self {
            sender: Some(sender),
            worker: Some(worker),
        }
    }

    pub(crate) fn callback(&self) -> Arc<dyn Fn(Progress) + Send + Sync> {
        let sender = self.sender.clone();
        Arc::new(move |event| {
            if let Some(sender) = &sender {
                let _ = sender.send(Some(event));
            }
        })
    }

    pub(crate) fn finish(&mut self) {
        if let Some(sender) = self.sender.take() {
            let _ = sender.send(None);
        }
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Reporter {
    fn drop(&mut self) {
        self.finish();
    }
}

fn run(receiver: mpsc::Receiver<Option<Progress>>, inline: bool, verbose: bool, header: String) {
    let Ok(Some(first)) = receiver.recv() else {
        return;
    };
    let mut output = io::stderr();
    let mut display = inline.then(|| Inline::new(&header).ok()).flatten();
    if display.is_none() {
        let _ = writeln!(output, "{header}");
    }
    let mut model = Model::default();
    let started = Instant::now();
    let mut heartbeat = started;
    let mut next = Some(first);
    loop {
        let now = Instant::now();
        let milestone = next
            .take()
            .and_then(|event| model.observe(event, verbose, now));
        let lines = model.lines(now);
        if let Some(inline) = display.as_mut()
            && inline.prepare(&lines, now).is_err()
        {
            display = None;
        }
        if let Some(milestone) = milestone
            && (display.is_none() || milestone.durable)
        {
            let inserted = display
                .as_mut()
                .is_some_and(|inline| inline.insert(&milestone).is_ok());
            if !inserted {
                display = None;
                let _ = writeln!(output, "{}", milestone.text);
            }
        }
        if let Some(inline) = display.as_mut() {
            if inline
                .draw(&lines, now, now.duration_since(started))
                .is_err()
            {
                display = None;
            }
        } else if now.duration_since(heartbeat) >= HEARTBEAT {
            let _ = writeln!(
                output,
                "Still working · elapsed {}",
                duration(now.duration_since(started))
            );
            for line in &lines {
                let _ = writeln!(output, "  {line}");
            }
            heartbeat = now;
        }
        let timeout = display
            .as_ref()
            .map_or(Duration::from_millis(250), Inline::timeout);
        match receiver.recv_timeout(timeout) {
            Ok(Some(event)) => next = Some(event),
            Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
}

#[cfg(test)]
mod tests;
