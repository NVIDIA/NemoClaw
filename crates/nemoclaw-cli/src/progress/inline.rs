// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

//! Own the inline viewport, its cursor/resize lifecycle, and Ratatui widgets.
//! No SDK events or deployment policy cross this boundary.

use super::{logo, model::Milestone};

mod backend;
use crate::{
    formatting::duration,
    style::{Palette, Tone},
};
use backend::OutputBackend;
use ratatui::{
    Terminal, TerminalOptions, Viewport,
    backend::Backend,
    text::{Line, Span, Text},
    widgets::{Paragraph, Widget, Wrap},
};
use std::{
    io,
    time::{Duration, Instant},
};

const PANEL_HEIGHT: u16 = 8;
const FRAME_INTERVAL: Duration = Duration::from_millis(250);

pub(super) struct Inline {
    terminal: Terminal<OutputBackend>,
    palette: Palette,
    next_frame: Instant,
}

impl Inline {
    pub(super) fn new(header: &str) -> io::Result<Self> {
        let palette = Palette::detect(true);
        let image_brand = logo::write_brand(&mut io::stderr(), palette).unwrap_or(false);
        let mut display = Self {
            terminal: new_terminal(1)?,
            palette,
            next_frame: Instant::now(),
        };
        insert_header(&mut display.terminal, header, palette, image_brand)?;
        Ok(display)
    }

    /// Reanchor before inserting milestones, including between throttled frames.
    pub(super) fn prepare(&mut self, lines: &[String], now: Instant) -> io::Result<()> {
        let size = self.terminal.backend().current_size()?;
        let height = panel_height(lines, size.width, size.height);
        if size != self.terminal.size()? || height != self.terminal.get_frame().area().height {
            // Ratatui 0.30 clears the whole screen on horizontal shrink. Reanchor only
            // our owned panel instead, preserving shell output and durable milestones.
            clear_panel(&mut self.terminal)?;
            self.terminal = new_terminal(height)?;
            self.next_frame = now;
        }
        Ok(())
    }

    pub(super) fn insert(&mut self, milestone: &Milestone) -> io::Result<()> {
        insert_line(
            &mut self.terminal,
            &milestone.text,
            self.palette,
            milestone.tone,
        )
    }

    pub(super) fn draw(
        &mut self,
        lines: &[String],
        now: Instant,
        elapsed: Duration,
    ) -> io::Result<()> {
        draw_due(
            &mut self.terminal,
            lines,
            self.palette,
            now,
            elapsed,
            &mut self.next_frame,
        )
    }

    pub(super) fn timeout(&self) -> Duration {
        self.next_frame.saturating_duration_since(Instant::now())
    }
}

impl Drop for Inline {
    fn drop(&mut self) {
        let _ = clear_panel(&mut self.terminal);
        let _ = self.terminal.show_cursor();
    }
}

fn new_terminal(height: u16) -> io::Result<Terminal<OutputBackend>> {
    Terminal::with_options(
        OutputBackend::new()?,
        TerminalOptions {
            viewport: Viewport::Inline(height),
        },
    )
}

pub(super) fn clear_panel<B: Backend>(terminal: &mut Terminal<B>) -> Result<(), B::Error> {
    // insert_before can leave the backend cursor below the panel between capped frames.
    let origin = terminal.get_frame().area().as_position();
    terminal.set_cursor_position(origin)?;
    terminal.clear()?;
    terminal.backend_mut().flush()
}

pub(super) fn panel_height(lines: &[String], width: u16, height: u16) -> u16 {
    let lines: usize = lines
        .iter()
        .map(|line| {
            Paragraph::new(format!("› {line}"))
                .wrap(Wrap { trim: false })
                .line_count(width.max(1))
        })
        .sum();
    (lines.saturating_add(1).min(PANEL_HEIGHT as usize) as u16)
        .min(height)
        .max(1)
}

pub(super) fn insert_line<B: Backend>(
    terminal: &mut Terminal<B>,
    line: &str,
    palette: Palette,
    tone: Tone,
) -> Result<(), B::Error> {
    let marker = match tone {
        Tone::Success => "✓ ",
        Tone::Error => "✗ ",
        Tone::Warning => "! ",
        _ => "· ",
    };
    let paragraph = Paragraph::new(Line::from(vec![
        Span::styled(marker, palette.style(tone)),
        Span::raw(line),
    ]));
    insert_paragraph(terminal, paragraph)
}

pub(super) fn insert_header<B: Backend>(
    terminal: &mut Terminal<B>,
    header: &str,
    palette: Palette,
    image_brand: bool,
) -> Result<(), B::Error> {
    let mut lines = if image_brand {
        Vec::new()
    } else {
        vec![
            Line::from(vec![
                Span::styled("NVIDIA", palette.style(Tone::Accent)),
                Span::raw(" / NemoClaw"),
            ]),
            Line::default(),
        ]
    };
    lines.extend(header.lines().map(Line::raw));
    insert_paragraph(terminal, Paragraph::new(Text::from(lines)))
}

fn insert_paragraph<B: Backend>(
    terminal: &mut Terminal<B>,
    paragraph: Paragraph<'_>,
) -> Result<(), B::Error> {
    let paragraph = paragraph.wrap(Wrap { trim: false });
    let width = terminal.size()?.width.max(1);
    let height = paragraph.line_count(width).min(u16::MAX as usize) as u16;
    terminal.insert_before(height.max(1), |buffer| {
        paragraph.render(buffer.area, buffer)
    })?;
    // Leave a stable origin even when the next frame is throttled or the terminal resizes.
    let origin = terminal.get_frame().area().as_position();
    terminal.set_cursor_position(origin)?;
    terminal.backend_mut().flush()
}

pub(super) fn draw_due<B: Backend>(
    terminal: &mut Terminal<B>,
    lines: &[String],
    palette: Palette,
    now: Instant,
    elapsed: Duration,
    next_frame: &mut Instant,
) -> Result<(), B::Error> {
    if now < *next_frame {
        return Ok(());
    }
    *next_frame = now + FRAME_INTERVAL;
    draw(terminal, lines, palette, elapsed)
}

pub(super) fn draw<B: Backend>(
    terminal: &mut Terminal<B>,
    lines: &[String],
    palette: Palette,
    elapsed: Duration,
) -> Result<(), B::Error> {
    let size = terminal.size()?;
    if size.width == 0 || size.height == 0 {
        return Ok(());
    }
    terminal
        .draw(|frame| {
            let area = frame.area();
            let mut remaining = area.height.saturating_sub(1);
            let mut y = area.y;
            for (index, line) in lines.iter().enumerate() {
                let paragraph = Paragraph::new(Line::from(vec![
                    Span::styled("› ", palette.style(Tone::Accent)),
                    Span::raw(line.as_str()),
                ]))
                .wrap(Wrap { trim: false });
                let height = paragraph
                    .line_count(area.width)
                    .max(1)
                    .min(u16::MAX as usize) as u16;
                if height > remaining || (height == remaining && index + 1 < lines.len()) {
                    if remaining > 0 {
                        frame.render_widget(
                            Paragraph::new(format!(
                                "{} more active; see milestones above",
                                lines.len() - index
                            )),
                            ratatui::layout::Rect::new(area.x, y, area.width, 1),
                        );
                    }
                    break;
                }
                frame.render_widget(
                    paragraph,
                    ratatui::layout::Rect::new(area.x, y, area.width, height),
                );
                y += height;
                remaining -= height;
            }
            if area.height > 0 {
                frame.render_widget(
                    Paragraph::new(format!("Elapsed: {}", duration(elapsed)))
                        .style(palette.style(Tone::Muted)),
                    ratatui::layout::Rect::new(area.x, area.bottom() - 1, area.width, 1),
                );
            }
            frame.set_cursor_position((area.x, area.y));
        })
        .map(|_| ())
}

#[cfg(all(test, unix))]
mod tests;
