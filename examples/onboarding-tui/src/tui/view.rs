// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use super::{
    app::JourneyWizard,
    labels::{self, terminal_text},
    logo::BrandImage,
};
use nemoclaw_authoring::JourneyQuestion;
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph, Wrap},
};

const NVIDIA_GREEN: Color = Color::Rgb(118, 185, 0);
const BRIGHT_GREEN: Color = Color::Rgb(163, 230, 53);
const DIM: Color = Color::Rgb(82, 121, 84);
const MUTED: Color = Color::Rgb(126, 145, 128);
const WHITE: Color = Color::Rgb(238, 245, 238);
const WARNING: Color = Color::Rgb(255, 170, 70);
const LOGO_GRADIENT: [Color; 6] = [
    Color::Rgb(180, 246, 72),
    Color::Rgb(154, 226, 51),
    Color::Rgb(128, 205, 31),
    Color::Rgb(105, 183, 24),
    Color::Rgb(82, 157, 28),
    Color::Rgb(61, 128, 31),
];
const TEXTURE_GRADIENT: [Color; 7] = [
    Color::Rgb(35, 75, 38),
    Color::Rgb(49, 105, 39),
    Color::Rgb(70, 139, 36),
    Color::Rgb(95, 174, 31),
    Color::Rgb(118, 185, 0),
    Color::Rgb(145, 213, 37),
    Color::Rgb(174, 238, 72),
];

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
                .style(Style::new().fg(NVIDIA_GREEN)),
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
            Constraint::Length(1),
            Constraint::Min(10),
            Constraint::Length(2),
        ])
        .split(body);
        self.render_logo(frame, rows[0], brand.filter(|_| body.width >= 80));
        let current = self.question();
        let reviewing = self.started && matches!(&current, Ok(None));
        let asking = self.started && matches!(&current, Ok(Some(_)));
        let lines = if !self.started {
            welcome()
        } else if let Err(error) = &current {
            vec![
                Line::from(Span::styled(
                    terminal_text(&error.to_string()),
                    Style::new().fg(WARNING),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "The questionnaire cannot continue. Press ← to go back or Esc to cancel.",
                    Style::new().fg(MUTED),
                )),
            ]
        } else if let Ok(Some(question)) = current.as_ref() {
            self.question_lines(question, rows[2].width)
        } else {
            self.review_lines()
        };
        let mut content = Paragraph::new(lines).wrap(Wrap { trim: false });
        if reviewing {
            content = content.scroll((self.review_scroll, 0));
        }
        frame.render_widget(content, rows[2]);
        let optional = matches!(&current, Ok(Some(question)) if !question.required());
        let choosing = matches!(&current, Ok(Some(question))
            if !question.choices().is_empty() && !self.custom_answer);
        self.render_footer(frame, rows[3], reviewing, asking, choosing, optional);
    }

    fn question_lines(&self, question: &JourneyQuestion, width: u16) -> Vec<Line<'static>> {
        let mut title = vec![Span::styled(
            terminal_text(&labels::title(question)),
            Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
        )];
        // The resolver reveals later questions as answers arrive, so there is
        // no stable total to show.
        title.extend([
            Span::raw("  "),
            Span::styled(
                format!("⟦ {} ⟧", self.history.len() + 1),
                Style::new().fg(DIM),
            ),
        ]);
        let mut lines = vec![Line::from(title)];
        if let Some(service) = labels::service(question) {
            lines.push(Line::from(Span::styled(
                format!("Service: {}", terminal_text(service)),
                Style::new().fg(MUTED),
            )));
        }
        lines.push(Line::from(""));
        if let Some(description) = labels::description(question) {
            lines.push(Line::from(Span::styled(
                terminal_text(&description),
                Style::new().fg(MUTED),
            )));
        }
        lines.push(Line::from(Span::styled(
            format!(
                "{}  ·  {}",
                if question.required() {
                    "Required"
                } else {
                    "Optional"
                },
                terminal_text(question.id())
            ),
            Style::new().fg(DIM),
        )));
        if let Some(cause) = question.reopened_because() {
            lines.push(Line::from(Span::styled(
                format!(
                    "Recheck this answer because {} changed.",
                    terminal_text(cause)
                ),
                Style::new().fg(WARNING),
            )));
        }
        lines.push(Line::from(""));
        if question.choices().is_empty() || self.custom_answer {
            let input = if self.input.is_empty() {
                self.suggested_input(question)
            } else {
                self.input.clone()
            };
            lines.push(Line::from(vec![
                Span::styled(terminal_text(&input), Style::new().fg(WHITE)),
                Span::styled("▌", Style::new().fg(BRIGHT_GREEN)),
            ]));
            lines.push(Line::from(Span::styled(
                "─".repeat(width as usize),
                Style::new().fg(BRIGHT_GREEN),
            )));
            if question.suggestion().is_some() {
                lines.push(Line::from(Span::styled(
                    "Enter accepts the suggested value; typing replaces it.",
                    Style::new().fg(MUTED),
                )));
            }
        } else {
            let selected = self.choice_index(question);
            let mut choices = question
                .choices()
                .iter()
                .map(|value| labels::choice(question, value))
                .collect::<Vec<_>>();
            if question.allows_custom_answer() {
                choices.push("Type another model".into());
            }
            if !question.required() {
                choices.push("Omit".into());
            }
            lines.extend(
                choices
                    .iter()
                    .enumerate()
                    .map(|(index, value)| choice_line(value, index == selected)),
            );
        }
        lines
    }

    fn review_lines(&self) -> Vec<Line<'static>> {
        let mut lines = vec![
            Line::from(Span::styled(
                "Review desired state",
                Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
            )),
            Line::from(""),
        ];
        match self.state.resolve_with_evidence(
            &self.capabilities,
            &self.facts,
            self.discovery.as_ref(),
        ) {
            Ok(resolution) => {
                if let Some(document) = resolution.materialized_document() {
                    if let Ok(yaml) = document.yaml() {
                        lines.extend(yaml.lines().map(yaml_line));
                    }
                } else {
                    lines.extend(resolution.unverified().iter().map(|warning| {
                        Line::from(Span::styled(
                            terminal_text(warning),
                            Style::new().fg(WARNING),
                        ))
                    }));
                    lines.extend(
                        resolution
                            .assessment()
                            .issues()
                            .iter()
                            .take(5)
                            .map(|issue| {
                                Line::from(Span::styled(
                                    terminal_text(&format!("{}: {}", issue.path(), issue.rule())),
                                    Style::new().fg(WARNING),
                                ))
                            }),
                    );
                }
                if let Some(assessment) = resolution.target_assessment() {
                    lines.push(Line::from(""));
                    lines.push(Line::from(Span::styled(
                        format!("Target: {:?}", assessment.status),
                        Style::new().fg(MUTED),
                    )));
                    lines.extend(assessment.reasons.iter().take(2).map(|reason| {
                        Line::from(Span::styled(terminal_text(reason), Style::new().fg(MUTED)))
                    }));
                }
            }
            Err(error) => lines.push(Line::from(Span::styled(
                terminal_text(&error.to_string()),
                Style::new().fg(WARNING),
            ))),
        }
        lines.push(Line::from(""));
        lines.push(Line::from(Span::styled(
            "Press Enter to save.",
            Style::new().fg(MUTED),
        )));
        lines
    }

    fn render_footer(
        &self,
        frame: &mut Frame<'_>,
        area: Rect,
        reviewing: bool,
        asking: bool,
        choosing: bool,
        optional: bool,
    ) {
        let rows = Layout::vertical([Constraint::Length(1); 2]).split(area);
        let controls = if !self.started {
            "Enter  begin     Esc  exit".to_owned()
        } else if reviewing {
            "Enter  save     ↑/↓  scroll     ←  back     Esc  exit".to_owned()
        } else {
            format!(
                "{}     Enter  continue     ←  back     Esc  exit{}",
                if choosing {
                    "↑/↓  choose"
                } else {
                    "Type to replace"
                },
                if optional { "     Ctrl+O  omit" } else { "" }
            )
        };
        let (controls, color) = match &self.error {
            Some(error) => (terminal_text(error), WARNING),
            None => (controls, MUTED),
        };
        frame.render_widget(
            Paragraph::new(controls).style(Style::new().fg(color)),
            rows[0],
        );
        if asking {
            frame.render_widget(
                Paragraph::new("Ctrl+D  choose remaining settings and review")
                    .style(Style::new().fg(MUTED)),
                rows[1],
            );
        }
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
            spans.push(Span::styled(row, Style::new().fg(LOGO_GRADIENT[index])));
            lines.push(Line::from(spans));
        }
        lines.push(texture_line(area.width as usize));
        frame.render_widget(Paragraph::new(lines), area);
    }
}

fn welcome() -> Vec<Line<'static>> {
    let muted = |text: &'static str| Line::from(Span::styled(text, Style::new().fg(MUTED)));
    vec![
        Line::from(Span::styled(
            "Welcome to NemoClaw",
            Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
        muted("Create desired state for an isolated sandbox."),
        Line::from(""),
        muted("Review deployment settings and author deployment YAML."),
        muted("Nothing is installed or started yet."),
        Line::from(""),
        muted("Press Enter to begin."),
    ]
}

fn choice_line(value: &str, active: bool) -> Line<'static> {
    Line::from(vec![
        Span::styled(
            if active { "  ●  " } else { "  ○  " },
            Style::new().fg(if active { BRIGHT_GREEN } else { MUTED }),
        ),
        Span::styled(
            terminal_text(value),
            if active {
                Style::new().fg(WHITE).add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(MUTED)
            },
        ),
    ])
}

/// Mute YAML keys so the authored values stand out.
fn yaml_line(line: &str) -> Line<'static> {
    let line = terminal_text(line);
    let body = line.trim_start().trim_start_matches("- ");
    let key_end = body
        .find(": ")
        .or_else(|| body.ends_with(':').then(|| body.len() - 1))
        .filter(|&end| {
            body[..end]
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        });
    match key_end {
        Some(end) => {
            let split = line.len() - body.len() + end + 1;
            Line::from(vec![
                Span::styled(line[..split].to_owned(), Style::new().fg(MUTED)),
                Span::styled(line[split..].to_owned(), Style::new().fg(WHITE)),
            ])
        }
        None => Line::from(Span::styled(line, Style::new().fg(WHITE))),
    }
}

fn texture_line(width: usize) -> Line<'static> {
    const CELLS: [char; 14] = [
        '⠁', '⠃', '⠇', '⡇', '⣇', '⣧', '⣷', '⣿', '⣾', '⣼', '⣸', '⢸', '⠸', '⠘',
    ];
    Line::from(
        (0..width)
            .map(|column| {
                let wave = column % CELLS.len();
                let color = TEXTURE_GRADIENT[(column / 7) % TEXTURE_GRADIENT.len()];
                Span::styled(CELLS[wave].to_string(), Style::new().fg(color))
            })
            .collect::<Vec<_>>(),
    )
}
