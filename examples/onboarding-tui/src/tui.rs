// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

use nemoclaw_authoring::{
    ApiChoice, Capabilities, Draft, EditableField, FieldValue, HarnessChoice, InferenceChoice,
    RuntimeChoice,
};
use nemoclaw_sdk::{CancellationToken, Error};
use ratatui::{
    Frame, Terminal, TerminalOptions, Viewport,
    backend::CrosstermBackend,
    layout::{Alignment, Constraint, Flex, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span, Text},
    widgets::{Block, BorderType, Borders, Clear, Gauge, Paragraph, Wrap},
};
use std::{io, time::Duration};

const NVIDIA_GREEN: Color = Color::Rgb(118, 185, 0);
const BRIGHT_GREEN: Color = Color::Rgb(163, 230, 53);
const DEEP_GREEN: Color = Color::Rgb(15, 35, 18);
const MUTED: Color = Color::Rgb(126, 145, 128);
const WHITE: Color = Color::Rgb(238, 245, 238);
const STEPS: [Step; 11] = [
    Step::Harness,
    Step::Runtime,
    Step::Inference,
    Step::Api,
    Step::DeploymentName,
    Step::SandboxName,
    Step::AgentName,
    Step::ProviderName,
    Step::Model,
    Step::CredentialEnv,
    Step::Review,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Step {
    Welcome,
    Harness,
    Runtime,
    Inference,
    Api,
    DeploymentName,
    SandboxName,
    AgentName,
    ProviderName,
    Model,
    CredentialEnv,
    Review,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Input {
    Continue,
    Back,
    Next,
    Previous,
    Character(char),
    Backspace,
    SelectAll,
    Cancel,
}

pub(crate) struct Wizard {
    capabilities: Capabilities,
    draft: Draft,
    step: Step,
    selected: usize,
    input: String,
    replace_input: bool,
    tick: u64,
    accepted: bool,
    cancelled: bool,
    error: Option<String>,
}

impl Wizard {
    pub(crate) fn new(capabilities: Capabilities, draft: Draft) -> Self {
        Self {
            capabilities,
            draft,
            step: Step::Welcome,
            selected: 0,
            input: String::new(),
            replace_input: false,
            tick: 0,
            accepted: false,
            cancelled: false,
            error: None,
        }
    }

    #[cfg(test)]
    fn step(&self) -> Step {
        self.step
    }

    pub(crate) fn draft(&self) -> &Draft {
        &self.draft
    }

    #[cfg(test)]
    fn input_value(&self) -> &str {
        &self.input
    }

    #[cfg(test)]
    fn error(&self) -> Option<&str> {
        self.error.as_deref()
    }

    pub(crate) fn accepted(&self) -> bool {
        self.accepted
    }

    pub(crate) fn cancelled(&self) -> bool {
        self.cancelled
    }

    pub(crate) fn tick(&mut self) {
        self.tick = self.tick.wrapping_add(1);
    }

    pub(crate) fn handle(&mut self, input: Input) {
        if matches!(input, Input::Cancel) {
            self.cancelled = true;
            return;
        }
        match input {
            Input::Next if self.is_choice() => self.move_selection(1),
            Input::Previous if self.is_choice() => self.move_selection(-1),
            Input::Back => self.go_back(),
            Input::SelectAll if self.is_text() => self.replace_input = true,
            Input::Character(character) if self.is_text() => {
                self.error = None;
                if self.replace_input {
                    self.input.clear();
                    self.replace_input = false;
                }
                self.input.push(character);
            }
            Input::Backspace if self.is_text() => {
                self.error = None;
                if self.replace_input {
                    self.input.clear();
                    self.replace_input = false;
                } else {
                    self.input.pop();
                }
            }
            Input::Continue => self.advance(),
            _ => {}
        }
    }

    fn advance(&mut self) {
        if self.step == Step::Welcome {
            self.set_step(Step::Harness);
            return;
        }
        if self.step == Step::Review {
            self.accepted = true;
            return;
        }
        let result = if self.is_choice() {
            self.commit_choice()
        } else if self.input.trim().is_empty() {
            return;
        } else {
            self.commit_text()
        };
        match result {
            Ok(()) => self.error = None,
            Err(diagnostics) => {
                self.error = Some(diagnostics.to_string());
                return;
            }
        }
        let index = STEPS.iter().position(|step| *step == self.step).unwrap();
        self.set_step(STEPS[index + 1]);
    }

    fn go_back(&mut self) {
        if self.step == Step::Welcome {
            self.cancelled = true;
            return;
        }
        let index = STEPS.iter().position(|step| *step == self.step).unwrap();
        self.set_step(if index == 0 {
            Step::Welcome
        } else {
            STEPS[index - 1]
        });
    }

    fn set_step(&mut self, step: Step) {
        self.step = step;
        self.error = None;
        self.selected = self.current_choice_index();
        self.input = self
            .field_state()
            .and_then(|field| match field.value() {
                FieldValue::Text(value) => Some(value.clone()),
                _ => None,
            })
            .unwrap_or_default();
        self.replace_input = self.is_text();
    }

    fn is_choice(&self) -> bool {
        self.field().is_some_and(EditableField::is_choice)
    }

    fn is_text(&self) -> bool {
        self.field().is_some_and(|field| !field.is_choice())
    }

    fn field(&self) -> Option<EditableField> {
        Some(match self.step {
            Step::Harness => EditableField::Harness,
            Step::Runtime => EditableField::Runtime,
            Step::Inference => EditableField::Inference,
            Step::Api => EditableField::Api,
            Step::DeploymentName => EditableField::DeploymentName,
            Step::SandboxName => EditableField::SandboxName,
            Step::AgentName => EditableField::AgentName,
            Step::ProviderName => EditableField::ProviderName,
            Step::Model => EditableField::Model,
            Step::CredentialEnv => EditableField::CredentialEnv,
            Step::Welcome | Step::Review => return None,
        })
    }

    fn field_state(&self) -> Option<nemoclaw_authoring::GuidedField> {
        let field = self.field()?;
        self.draft
            .guided_fields(&self.capabilities)
            .ok()?
            .into_iter()
            .find(|state| state.id() == field)
    }

    fn move_selection(&mut self, delta: isize) {
        self.error = None;
        let count = self.choice_labels().len();
        if count == 0 {
            return;
        }
        self.selected = (self.selected as isize + delta).rem_euclid(count as isize) as usize;
    }

    fn choice_values(&self) -> Vec<FieldValue> {
        self.field_state()
            .map(|field| field.choices().to_vec())
            .unwrap_or_default()
    }

    fn choice_labels(&self) -> Vec<String> {
        self.choice_values()
            .iter()
            .map(field_value_label)
            .map(str::to_owned)
            .collect()
    }

    fn current_choice_index(&self) -> usize {
        let Some(field) = self.field_state() else {
            return 0;
        };
        field
            .choices()
            .iter()
            .position(|choice| choice == field.value())
            .unwrap_or(0)
    }

    fn commit_choice(&mut self) -> Result<(), nemoclaw_authoring::Diagnostics> {
        let Some(field) = self.field() else {
            return Ok(());
        };
        let Some(value) = self.choice_values().get(self.selected).cloned() else {
            return Ok(());
        };
        self.draft
            .set_guided_field(&self.capabilities, field, value)
    }

    fn commit_text(&mut self) -> Result<(), nemoclaw_authoring::Diagnostics> {
        let Some(field) = self.field() else {
            return Ok(());
        };
        self.draft.set_guided_field(
            &self.capabilities,
            field,
            FieldValue::Text(self.input.clone()),
        )
    }

    pub(crate) fn render(&self, frame: &mut Frame<'_>) {
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
                .alignment(Alignment::Center)
                .style(Style::new().fg(NVIDIA_GREEN)),
                area,
            );
            return;
        }
        let [body] = Layout::horizontal([Constraint::Max(92)])
            .flex(Flex::Center)
            .areas(area);
        let rows = Layout::vertical([
            Constraint::Length(8),
            Constraint::Length(2),
            Constraint::Min(11),
            Constraint::Length(2),
        ])
        .split(body);
        self.render_brand(frame, rows[0]);
        self.render_progress(frame, rows[1]);
        self.render_question(frame, rows[2]);
        self.render_footer(frame, rows[3]);
    }

    fn render_brand(&self, frame: &mut Frame<'_>, area: Rect) {
        let banner = Text::from(vec![
            Line::from("███╗   ██╗███████╗███╗   ███╗ ██████╗  ██████╗██╗      █████╗ ██╗    ██╗"),
            Line::from("████╗  ██║██╔════╝████╗ ████║██╔═══██╗██╔════╝██║     ██╔══██╗██║    ██║"),
            Line::from("██╔██╗ ██║█████╗  ██╔████╔██║██║   ██║██║     ██║     ███████║██║ █╗ ██║"),
            Line::from("██║╚██╗██║██╔══╝  ██║╚██╔╝██║██║   ██║██║     ██║     ██╔══██║██║███╗██║"),
            Line::from("██║ ╚████║███████╗██║ ╚═╝ ██║╚██████╔╝╚██████╗███████╗██║  ██║╚███╔███╔╝"),
            Line::from("╚═╝  ╚═══╝╚══════╝╚═╝     ╚═╝ ╚═════╝  ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ "),
            Line::from(Span::styled(
                "NEMOCLAW  //  DEPLOYMENT STUDIO",
                Style::new().fg(BRIGHT_GREEN).add_modifier(Modifier::BOLD),
            )),
        ]);
        frame.render_widget(
            Paragraph::new(banner)
                .alignment(Alignment::Center)
                .style(Style::new().fg(NVIDIA_GREEN)),
            area,
        );
    }

    fn render_progress(&self, frame: &mut Frame<'_>, area: Rect) {
        if self.step == Step::Welcome {
            return;
        }
        let position = STEPS.iter().position(|step| *step == self.step).unwrap() + 1;
        let ratio = position as f64 / STEPS.len() as f64;
        frame.render_widget(
            Gauge::default()
                .gauge_style(Style::new().fg(NVIDIA_GREEN).bg(DEEP_GREEN))
                .label(format!("{position} / {}", STEPS.len()))
                .ratio(ratio),
            area,
        );
    }

    fn render_question(&self, frame: &mut Frame<'_>, area: Rect) {
        let [card] = Layout::horizontal([Constraint::Percentage(84)])
            .flex(Flex::Center)
            .areas(area);
        frame.render_widget(Clear, card);
        let inner = Block::new()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(NVIDIA_GREEN))
            .style(Style::new().bg(Color::Rgb(8, 18, 10)))
            .padding(ratatui::widgets::Padding::horizontal(3));
        let content = inner.inner(card);
        frame.render_widget(inner, card);
        if self.step == Step::Welcome {
            self.render_welcome(frame, content);
        } else if self.step == Step::Review {
            self.render_review(frame, content);
        } else {
            let rows = Layout::vertical([
                Constraint::Length(2),
                Constraint::Length(3),
                Constraint::Min(4),
            ])
            .split(content);
            frame.render_widget(
                Paragraph::new(self.title())
                    .style(Style::new().fg(WHITE).add_modifier(Modifier::BOLD)),
                rows[0],
            );
            frame.render_widget(
                Paragraph::new(self.help())
                    .style(Style::new().fg(MUTED))
                    .wrap(Wrap { trim: true }),
                rows[1],
            );
            if self.is_choice() {
                self.render_choices(frame, rows[2]);
            } else {
                self.render_input(frame, rows[2]);
            }
        }
    }

    fn render_welcome(&self, frame: &mut Frame<'_>, area: Rect) {
        let braille = braille_wave(self.tick, area.width.saturating_sub(2) as usize);
        frame.render_widget(
            Paragraph::new(vec![
                Line::from(Span::styled(braille, Style::new().fg(NVIDIA_GREEN))),
                Line::from(""),
                Line::from(Span::styled(
                    "Build an isolated AI sandbox, beautifully.",
                    Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
                )),
                Line::from(""),
                Line::from(Span::styled(
                    "One focused decision at a time. You can go back before anything is written.",
                    Style::new().fg(MUTED),
                )),
            ])
            .alignment(Alignment::Center),
            area,
        );
    }

    fn render_choices(&self, frame: &mut Frame<'_>, area: Rect) {
        let lines = self
            .choice_labels()
            .into_iter()
            .enumerate()
            .map(|(index, label)| {
                let active = index == self.selected;
                Line::from(vec![
                    Span::styled(
                        if active { "  ●  " } else { "  ○  " },
                        Style::new().fg(if active { BRIGHT_GREEN } else { MUTED }),
                    ),
                    Span::styled(
                        label,
                        Style::new()
                            .fg(if active { WHITE } else { MUTED })
                            .add_modifier(if active {
                                Modifier::BOLD
                            } else {
                                Modifier::empty()
                            }),
                    ),
                ])
            })
            .collect::<Vec<_>>();
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn render_input(&self, frame: &mut Frame<'_>, area: Rect) {
        let field = Rect::new(area.x, area.y, area.width, 3.min(area.height));
        frame.render_widget(
            Paragraph::new(self.input.as_str())
                .style(Style::new().fg(WHITE))
                .block(
                    Block::new()
                        .borders(Borders::BOTTOM)
                        .border_style(Style::new().fg(BRIGHT_GREEN)),
                ),
            field,
        );
        let cursor_x = field
            .x
            .saturating_add(self.input.chars().count().min(field.width as usize - 1) as u16);
        frame.set_cursor_position((cursor_x, field.y));
        if let Some(error) = &self.error {
            let error_area = Rect::new(
                area.x,
                area.y.saturating_add(3),
                area.width,
                area.height.saturating_sub(3),
            );
            frame.render_widget(
                Paragraph::new(format!("▲ {error}"))
                    .style(Style::new().fg(Color::Rgb(255, 170, 70)))
                    .wrap(Wrap { trim: true }),
                error_area,
            );
        }
    }

    fn render_review(&self, frame: &mut Frame<'_>, area: Rect) {
        let answers = self
            .draft
            .guided_answers(&self.capabilities)
            .expect("wizard retains a guided document");
        let lines = vec![
            Line::from(Span::styled(
                "Ready to author your deployment",
                Style::new().fg(WHITE).add_modifier(Modifier::BOLD),
            )),
            review_line(
                "DEPLOYMENT",
                &answers.deployment_name,
                Some(("SANDBOX", &answers.sandbox_name)),
            ),
            review_line(
                "AGENT",
                &answers.agent_name,
                Some(("HARNESS", harness_label(answers.harness))),
            ),
            review_line(
                "RUNTIME",
                runtime_label(answers.runtime),
                Some(("INFERENCE", inference_label(answers.inference))),
            ),
            review_line("API", api_label(answers.api), None),
            review_line("MODEL", &answers.model, None),
            review_line("PROVIDER", &answers.provider_name, None),
            review_line("CREDENTIAL", &answers.credential_env, None),
        ];
        frame.render_widget(Paragraph::new(lines), area);
    }

    fn render_footer(&self, frame: &mut Frame<'_>, area: Rect) {
        let controls = match self.step {
            Step::Welcome => "Enter  begin     Esc  exit",
            Step::Review => "Enter  author YAML     ←  back     Esc  exit",
            _ if self.is_choice() => "↑/↓  choose     Enter  continue     ←  back     Esc  exit",
            _ => "Type to replace     Enter  continue     ←  back     Esc  exit",
        };
        frame.render_widget(
            Paragraph::new(controls)
                .alignment(Alignment::Center)
                .style(Style::new().fg(MUTED)),
            area,
        );
    }

    fn title(&self) -> &'static str {
        match self.step {
            Step::Harness => "Choose your agent harness",
            Step::Runtime => "Where should the sandbox run?",
            Step::Inference => "How should your agent reach its model?",
            Step::Api => "Which inference API should the harness speak?",
            Step::DeploymentName => "Name this deployment",
            Step::SandboxName => "Name the isolated sandbox",
            Step::AgentName => "Name the agent inside it",
            Step::ProviderName => "Name the inference connection",
            Step::Model => "Choose the model",
            Step::CredentialEnv => "Reference the API credential",
            _ => "",
        }
    }

    fn help(&self) -> &'static str {
        match self.step {
            Step::Harness => "The harness is the agent environment NemoClaw installs and isolates.",
            Step::Runtime => "The runtime owns the gateway and local sandbox resources.",
            Step::Inference => "Hosted inference keeps model compute outside the sandbox.",
            Step::Api => "Only APIs compatible with the selected harness are shown.",
            Step::DeploymentName => "A human-readable DNS label for this desired-state document.",
            Step::SandboxName => "The stable name used to identify the isolated workspace.",
            Step::AgentName => "The agent identity configured inside the sandbox.",
            Step::ProviderName => "A local label for this endpoint and credential reference.",
            Step::Model => "Models are curated by the authoring library for this scenario.",
            Step::CredentialEnv => {
                "Enter an environment-variable name, never the secret value itself."
            }
            _ => "",
        }
    }
}

fn review_line<'a>(label: &'a str, value: &'a str, second: Option<(&'a str, &'a str)>) -> Line<'a> {
    let mut spans = vec![
        Span::styled(format!("{label:<12}"), Style::new().fg(NVIDIA_GREEN)),
        Span::styled(value, Style::new().fg(WHITE)),
    ];
    if let Some((second_label, second_value)) = second {
        spans.extend([
            Span::styled("  •  ", Style::new().fg(MUTED)),
            Span::styled(format!("{second_label} "), Style::new().fg(NVIDIA_GREEN)),
            Span::styled(second_value, Style::new().fg(WHITE)),
        ]);
    }
    Line::from(spans)
}

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
        wizard.tick();
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

fn harness_label(choice: HarnessChoice) -> &'static str {
    match choice {
        HarnessChoice::OpenClaw => "OpenClaw",
        HarnessChoice::Hermes => "Hermes",
        _ => choice.as_str(),
    }
}

fn runtime_label(choice: RuntimeChoice) -> &'static str {
    match choice {
        RuntimeChoice::Docker => "Docker",
        RuntimeChoice::Podman => "Podman",
    }
}

fn inference_label(choice: InferenceChoice) -> &'static str {
    match choice {
        InferenceChoice::NvidiaHosted => "NVIDIA hosted inference",
    }
}

fn api_label(choice: ApiChoice) -> &'static str {
    match choice {
        ApiChoice::OpenaiCompletions => "OpenAI chat completions",
        ApiChoice::OpenaiResponses => "OpenAI Responses",
        ApiChoice::AnthropicMessages => "Anthropic Messages",
    }
}

fn field_value_label(value: &FieldValue) -> &str {
    match value {
        FieldValue::Harness(value) => harness_label(*value),
        FieldValue::Runtime(value) => runtime_label(*value),
        FieldValue::Inference(value) => inference_label(*value),
        FieldValue::Api(value) => api_label(*value),
        FieldValue::Text(value) | FieldValue::Model(value) => value,
    }
}

fn braille_wave(tick: u64, width: usize) -> String {
    const CELLS: [char; 8] = ['⠁', '⠂', '⠄', '⡀', '⢀', '⠠', '⠐', '⠈'];
    (0..width.min(72))
        .map(|column| CELLS[(column + tick as usize) % CELLS.len()])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use nemoclaw_authoring::{Answers, Capabilities, HarnessChoice, Session};
    use ratatui::{Terminal, backend::TestBackend};

    fn wizard() -> Wizard {
        let capabilities = Capabilities::available();
        let authored = Session::new()
            .unwrap()
            .project(&capabilities, &Answers::onboarding_defaults())
            .unwrap();
        let draft = Draft::from_document(authored.document().clone()).unwrap();
        Wizard::new(capabilities, draft)
    }

    #[test]
    fn wizard_guides_every_authoring_choice_and_filters_invalid_apis() {
        let mut wizard = wizard();
        assert_eq!(wizard.step(), Step::Welcome);
        wizard.handle(Input::Continue);
        assert_eq!(wizard.step(), Step::Harness);

        wizard.handle(Input::Next);
        wizard.handle(Input::Continue);
        assert_eq!(
            wizard
                .draft()
                .guided_answers(&wizard.capabilities)
                .unwrap()
                .harness,
            HarnessChoice::Hermes
        );
        assert_eq!(wizard.step(), Step::Runtime);

        wizard.handle(Input::Continue);
        wizard.handle(Input::Continue);
        assert_eq!(wizard.choice_labels(), ["OpenAI chat completions"]);
        wizard.handle(Input::Continue);
        assert_eq!(wizard.step(), Step::DeploymentName);
    }

    #[test]
    fn focused_screen_renders_brand_progress_context_and_controls() {
        let mut wizard = wizard();
        wizard.handle(Input::Continue);
        let backend = TestBackend::new(100, 30);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| wizard.render(frame)).unwrap();
        let rendered = terminal.backend().to_string();
        for expected in [
            "NEMOCLAW",
            "Choose your agent harness",
            "OpenClaw",
            "Hermes",
            "1 / 11",
            "Enter",
        ] {
            assert!(
                rendered.contains(expected),
                "missing {expected:?}\n{rendered}"
            );
        }
    }

    #[test]
    fn text_entry_is_local_to_the_active_question_and_back_preserves_it() {
        let mut wizard = wizard();
        for _ in 0..5 {
            wizard.handle(Input::Continue);
        }
        assert_eq!(wizard.step(), Step::DeploymentName);
        wizard.handle(Input::SelectAll);
        for character in "demo-fleet".chars() {
            wizard.handle(Input::Character(character));
        }
        wizard.handle(Input::Continue);
        assert_eq!(
            wizard
                .draft()
                .guided_answers(&wizard.capabilities)
                .unwrap()
                .deployment_name,
            "demo-fleet"
        );
        wizard.handle(Input::Back);
        assert_eq!(wizard.input_value(), "demo-fleet");
    }

    #[test]
    fn invalid_answer_stays_focused_and_explains_the_authoring_rule() {
        let mut wizard = wizard();
        for _ in 0..5 {
            wizard.handle(Input::Continue);
        }
        wizard.handle(Input::SelectAll);
        for character in "Not a DNS name".chars() {
            wizard.handle(Input::Character(character));
        }
        wizard.handle(Input::Continue);

        assert_eq!(wizard.step(), Step::DeploymentName);
        assert!(wizard.error().unwrap().contains("must be a lowercase name"));
    }

    #[test]
    fn minimum_supported_terminal_review_contains_every_answer() {
        let mut wizard = wizard();
        for _ in 0..11 {
            wizard.handle(Input::Continue);
        }
        assert_eq!(wizard.step(), Step::Review);
        let backend = TestBackend::new(80, 24);
        let mut terminal = Terminal::new(backend).unwrap();
        terminal.draw(|frame| wizard.render(frame)).unwrap();
        let rendered = terminal.backend().to_string();
        for expected in ["DEPLOYMENT", "HARNESS", "MODEL", "CREDENTIAL"] {
            assert!(
                rendered.contains(expected),
                "missing {expected:?}\n{rendered}"
            );
        }
    }
}
