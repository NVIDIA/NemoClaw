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

pub(crate) fn run(
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
    loop {
        if cancel.is_cancelled() {
            return Err(Error::Cancelled.into());
        }
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
