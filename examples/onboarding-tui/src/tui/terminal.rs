// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::app::{Input, Wizard};
use nemoclaw_authoring::{Capabilities, Draft};
use nemoclaw_sdk::{CancellationToken, Error};
use ratatui::{Terminal, TerminalOptions, Viewport, backend::CrosstermBackend, layout::Rect};
use std::{io, time::Duration};

struct TerminalGuard;

impl TerminalGuard {
    fn enter() -> io::Result<Self> {
        crossterm::terminal::enable_raw_mode()?;
        if let Err(error) = crossterm::execute!(
            io::stderr(),
            crossterm::terminal::EnterAlternateScreen,
            crossterm::cursor::Hide
        ) {
            let _ = crossterm::terminal::disable_raw_mode();
            return Err(error);
        }
        Ok(Self)
    }
}

impl Drop for TerminalGuard {
    fn drop(&mut self) {
        let _ = crossterm::execute!(
            io::stderr(),
            crossterm::terminal::LeaveAlternateScreen,
            crossterm::cursor::Show
        );
        let _ = crossterm::terminal::disable_raw_mode();
    }
}

pub(crate) async fn run(
    capabilities: Capabilities,
    draft: Draft,
    cancel: &CancellationToken,
) -> Result<Option<Draft>, Box<dyn std::error::Error>> {
    let _guard = TerminalGuard::enter()?;
    let area = terminal_area();
    let mut terminal = Terminal::with_options(
        CrosstermBackend::new(io::stderr()),
        TerminalOptions {
            viewport: Viewport::Fixed(area),
        },
    )?;
    let mut wizard = Wizard::new(capabilities, draft);
    let mut last_target = None;
    let mut was_review = false;
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled.into());
        }
        let gateway = wizard
            .draft()
            .document()
            .spec
            .gateway
            .as_managed()
            .expect("guided managed gateway");
        let driver = wizard.draft().document().spec.sandboxes[0].runtime.provider;
        let target = (gateway.engine.clone(), driver);
        let is_review = wizard.step == super::app::Step::Review;
        if last_target.as_ref() != Some(&target) || (is_review && !was_review) {
            if let Some(reason) = wizard.runtime_unavailable_reason(driver) {
                wizard.target_status = Some(format!(
                    "The template's Podman preset {reason}. Choose Docker to continue on this host."
                ));
            } else {
                wizard.target_status = Some("Checking the configured container engine…".into());
                terminal.draw(|frame| wizard.render(frame))?;
                wizard.target_status = Some(check_target(&target.0, target.1, cancel).await?);
            }
            last_target = Some(target);
        }
        was_review = is_review;
        terminal.draw(|frame| wizard.render(frame))?;
        if wizard.accepted() {
            return Ok(Some(wizard.draft().clone()));
        }
        if wizard.cancelled() {
            return Ok(None);
        }
        if !crossterm::event::poll(Duration::from_millis(50))? {
            continue;
        }
        let event = crossterm::event::read()?;
        if let crossterm::event::Event::Resize(width, height) = event {
            terminal.resize(Rect::new(0, 0, width, height))?;
            continue;
        }
        let crossterm::event::Event::Key(key) = event else {
            continue;
        };
        if key.kind != crossterm::event::KeyEventKind::Press {
            continue;
        }
        use crossterm::event::{KeyCode, KeyModifiers};
        if key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL) {
            return Err(Error::Cancelled.into());
        }
        let input = match (key.code, key.modifiers) {
            (KeyCode::Esc, _) => Input::Cancel,
            (KeyCode::Enter, _) => Input::Continue,
            (KeyCode::Up, _) => Input::Previous,
            (KeyCode::Down, _) => Input::Next,
            (KeyCode::Left, _) => Input::Back,
            (KeyCode::Backspace, _) => Input::Backspace,
            (KeyCode::Char('a'), modifiers) if modifiers.contains(KeyModifiers::CONTROL) => {
                Input::SelectAll
            }
            (KeyCode::Char(character), modifiers)
                if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
            {
                Input::Character(character)
            }
            _ => continue,
        };
        wizard.handle(input);
    }
}

#[cfg(unix)]
fn terminal_area() -> Rect {
    let size = rustix::termios::tcgetwinsize(std::io::stdin()).ok();
    let width = size.map_or(80, |size| nonzero_or(size.ws_col, 80));
    let height = size.map_or(24, |size| nonzero_or(size.ws_row, 24));
    Rect::new(0, 0, width, height)
}

#[cfg(not(unix))]
fn terminal_area() -> Rect {
    let (width, height) = crossterm::terminal::size().unwrap_or((80, 24));
    Rect::new(0, 0, nonzero_or(width, 80), nonzero_or(height, 24))
}

const fn nonzero_or(value: u16, fallback: u16) -> u16 {
    if value == 0 { fallback } else { value }
}

async fn check_target(
    endpoint: &str,
    driver: nemoclaw_sdk::config::ComputeDriver,
    cancel: &CancellationToken,
) -> Result<String, Error> {
    let check = async {
        let engine = nemoclaw_sdk::docker::Engine::connect(endpoint)?;
        engine.gateway_engine_info(driver).await?;
        Ok::<_, Error>(())
    };
    let observed = tokio::select! {
        biased;
        () = cancel.cancelled() => return Err(Error::Cancelled),
        result = tokio::time::timeout(Duration::from_secs(5), check) => result,
    };
    Ok(match observed {
        Ok(Ok(())) => "Engine check passed. Deployment readiness still needs plan/apply.".into(),
        Ok(Err(Error::Conflict(reason))) => format!("Engine requirement not met: {reason}. Change the runtime or save for later."),
        Ok(Err(error)) => format!("Engine unverified: {error}. You can save for later; plan/apply will check again."),
        Err(_) => "Engine unverified: check timed out. You can save for later; plan/apply will check again.".into(),
    })
}

#[cfg(test)]
mod target_tests {
    use super::*;
    use nemoclaw_sdk::config::ComputeDriver;

    #[tokio::test]
    async fn an_unreachable_engine_remains_unverified_and_does_not_block_authoring() {
        let directory = tempfile::tempdir().unwrap();
        let endpoint = format!("unix://{}", directory.path().join("missing.sock").display());
        let result = check_target(&endpoint, ComputeDriver::Docker, &CancellationToken::new())
            .await
            .unwrap();
        assert!(result.contains("unverified"));
        assert!(result.contains("save for later"));
        assert!(!result.contains("passed"));
    }

    #[tokio::test]
    async fn cancelling_an_engine_check_stops_authoring() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(matches!(
            check_target("unix:///unavailable.sock", ComputeDriver::Docker, &cancel).await,
            Err(Error::Cancelled)
        ));
    }
}
