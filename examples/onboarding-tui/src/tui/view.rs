// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    app::JourneyWizard,
    labels::{display_value, label, terminal_text},
    logo::BrandImage,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

impl JourneyWizard {
    #[cfg(test)]
    pub(super) fn render(&self, frame: &mut Frame<'_>) {
        self.render_with_brand(frame, None);
    }

    pub(super) fn render_with_brand(&self, frame: &mut Frame<'_>, brand: Option<BrandImage>) {
        let area = frame.area();
        frame.render_widget(
            Block::new().style(Style::new().bg(Color::Rgb(5, 10, 7))),
            area,
        );
        if area.width < 72 || area.height < 24 {
            frame.render_widget(
                Paragraph::new(
                    "NEMOCLAW\n\nThis experience needs a 72 × 24 terminal.\nResize to continue.",
                )
                .style(Style::new().fg(Color::Rgb(118, 185, 0))),
                area,
            );
            return;
        }
        let margin = if area.width >= 96 { 4 } else { 2 };
        let body = Rect::new(
            area.x.saturating_add(margin),
            area.y,
            area.width.saturating_sub(margin * 2),
            area.height,
        );
        let rows = Layout::vertical([
            Constraint::Length(8),
            Constraint::Min(10),
            Constraint::Length(2),
        ])
        .split(body);
        self.render_logo(frame, rows[0], brand.filter(|_| body.width >= 80));
        let mut lines = Vec::new();
        let current = self.question();
        let reviewing = self.started && matches!(&current, Ok(None));
        if !self.started {
            lines.push(Line::from("Welcome to NemoClaw"));
            lines.push(Line::from("Create desired state for an isolated sandbox."));
            lines.push(Line::from(
                "Review deployment settings and author deployment YAML.",
            ));
            lines.push(Line::from("Nothing is installed or started yet."));
            lines.push(Line::from("Press Enter to begin."));
        } else if let Err(error) = &current {
            lines.push(Line::from(terminal_text(&error.to_string())));
            lines.push(Line::from(
                "The questionnaire cannot continue. Press Esc to cancel.",
            ));
        } else if let Ok(Some(question)) = current {
            lines.push(Line::from(Span::styled(
                terminal_text(&label(&question)),
                Style::new().fg(Color::White).add_modifier(Modifier::BOLD),
            )));
            lines.push(Line::from(format!(
                "{}  ·  {}",
                if question.required() {
                    "Required"
                } else {
                    "Optional"
                },
                terminal_text(question.id())
            )));
            if let Some(cause) = question.reopened_because() {
                lines.push(Line::from(format!(
                    "Recheck this answer because {} changed.",
                    terminal_text(cause)
                )));
            }
            lines.push(Line::from(""));
            if question.choices().is_empty() || self.custom_answer {
                let input = if self.input.is_empty() {
                    self.suggested_input(&question)
                } else {
                    self.input.clone()
                };
                lines.push(Line::from(format!("> {}", terminal_text(&input))));
                if question.suggestion().is_some() {
                    lines.push(Line::from(
                        "Enter accepts the suggested value; typing replaces it.",
                    ));
                }
                if !question.required() {
                    lines.push(Line::from("Press Ctrl+O to omit."));
                }
            } else {
                for (index, value) in question.choices().iter().enumerate() {
                    lines.push(Line::from(format!(
                        "{} {}",
                        if index == self.choice_index(&question) {
                            "❯"
                        } else {
                            " "
                        },
                        terminal_text(&display_value(value)),
                    )));
                }
                if question.allows_custom_answer() {
                    lines.push(Line::from(format!(
                        "{} Type another model",
                        if self.choice_index(&question) == question.choices().len() {
                            "❯"
                        } else {
                            " "
                        }
                    )));
                }
                if !question.required() {
                    lines.push(Line::from(format!(
                        "{} Omit",
                        if self.choice_index(&question) == question.choices().len() {
                            "❯"
                        } else {
                            " "
                        }
                    )));
                }
            }
        } else {
            lines.push(Line::from(Span::styled(
                "Review desired state",
                Style::new().fg(Color::White).add_modifier(Modifier::BOLD),
            )));
            match self.state.resolve_with_evidence(
                &self.capabilities,
                &self.facts,
                self.discovery.as_ref(),
            ) {
                Ok(resolution) => {
                    if let Some(document) = resolution.materialized_document() {
                        if let Ok(yaml) = document.yaml() {
                            lines.extend(yaml.lines().map(|line| Line::from(terminal_text(line))));
                        }
                    } else {
                        lines.extend(
                            resolution
                                .unverified()
                                .iter()
                                .map(|warning| Line::from(terminal_text(warning))),
                        );
                        lines.extend(resolution.assessment().issues().iter().take(5).map(
                            |issue| {
                                Line::from(terminal_text(&format!(
                                    "{}: {}",
                                    issue.path(),
                                    issue.rule()
                                )))
                            },
                        ));
                    }
                    if let Some(assessment) = resolution.target_assessment() {
                        lines.push(Line::from(format!("Target: {:?}", assessment.status)));
                        lines.extend(
                            assessment
                                .reasons
                                .iter()
                                .take(2)
                                .map(|reason| Line::from(terminal_text(reason))),
                        );
                    }
                }
                Err(error) => lines.push(Line::from(terminal_text(&error.to_string()))),
            }
            lines.push(Line::from("Press Enter to save."));
        }
        let mut content = Paragraph::new(lines)
            .block(Block::new().borders(Borders::ALL))
            .wrap(Wrap { trim: false });
        if reviewing {
            content = content.scroll((self.review_scroll, 0));
        }
        frame.render_widget(content, rows[1]);
        let footer = if reviewing {
            "Enter save  ·  ↑↓ scroll  ·  ← back  ·  Esc cancel"
        } else {
            "Enter continue  ·  ↑↓ choose  ·  Ctrl+O omit  ·  Ctrl+D delegate  ·  ← back  ·  Esc cancel"
        };
        let footer = self.error.as_deref().unwrap_or(footer);
        frame.render_widget(
            Paragraph::new(terminal_text(footer))
                .style(Style::new().fg(if self.error.is_some() {
                    Color::Red
                } else {
                    Color::Gray
                }))
                .wrap(Wrap { trim: true }),
            rows[2],
        );
    }

    fn render_logo(&self, frame: &mut Frame<'_>, area: Rect, brand: Option<BrandImage>) {
        let rows = [
            "███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗",
            "████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║",
            "██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║",
            "██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║",
            "██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝",
            "╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
        ];
        let mut lines = vec![Line::from("")];
        for (index, row) in rows.into_iter().enumerate() {
            let mut spans = Vec::new();
            if let Some(brand) = brand {
                if (2..=3).contains(&index) {
                    spans.push(brand.placeholder(index - 2));
                } else {
                    spans.push(Span::raw("      "));
                }
                spans.push(Span::raw("  "));
            }
            spans.push(Span::styled(row, Style::new().fg(Color::Rgb(118, 185, 0))));
            lines.push(Line::from(spans));
        }
        frame.render_widget(Paragraph::new(lines), area);
    }
}
