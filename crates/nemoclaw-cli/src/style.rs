// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use ratatui::style::{Color, Modifier, Style};

#[derive(Clone, Copy)]
pub(crate) enum Tone {
    Accent,
    Success,
    Warning,
    Error,
    Muted,
}

#[derive(Clone, Copy, Default)]
pub(crate) struct Palette {
    pub(crate) enabled: bool,
}

impl Palette {
    pub(crate) fn detect(terminal: bool) -> Self {
        Self {
            enabled: terminal
                && std::env::var("TERM").is_ok_and(|term| term != "dumb")
                && std::env::var_os("NO_COLOR").is_none_or(|value| value.is_empty()),
        }
    }

    pub(crate) fn paint(self, text: &str, tone: Tone) -> String {
        if !self.enabled {
            return text.into();
        }
        let code = match tone {
            Tone::Accent | Tone::Success => "38;2;118;185;0",
            Tone::Warning => "33",
            Tone::Error => "31",
            Tone::Muted => "2",
        };
        format!("\x1b[{code}m{text}\x1b[0m")
    }

    pub(crate) fn style(self, tone: Tone) -> Style {
        if !self.enabled {
            return Style::default();
        }
        match tone {
            Tone::Accent | Tone::Success => Style::default().fg(Color::Rgb(118, 185, 0)),
            Tone::Warning => Style::default().fg(Color::Yellow),
            Tone::Error => Style::default().fg(Color::Red),
            Tone::Muted => Style::default().add_modifier(Modifier::DIM),
        }
    }
}
