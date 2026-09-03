// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const agentNames = {
  openclaw: "OpenClaw",
  hermes: "Hermes Agent",
  "langchain-deepagents-code": "Deep Agents Code",
  pi: "Pi",
  nemocua: "NemoCUA",
};

const inferenceNames = {
  nvidia: "NVIDIA hosted inference",
  openrouter: "OpenRouter",
  compatible: "Compatible endpoint",
  local: "Local NVIDIA GPU",
};

const state = { step: 1, agent: "openclaw", inference: "nvidia" };
const panels = [...document.querySelectorAll("[data-step]")];
const steps = [...document.querySelectorAll("[data-step-target]")];
const next = document.querySelector("#next");
const back = document.querySelector("#back");
const launch = document.querySelector("#launch");
const form = document.querySelector("#onboarding-form");
const error = document.querySelector("#submit-error");

function render() {
  for (const panel of panels)
    panel.classList.toggle("active", Number(panel.dataset.step) === state.step);
  for (const step of steps)
    step.classList.toggle("active", Number(step.dataset.stepTarget) === state.step);
  back.disabled = state.step === 1;
  next.hidden = state.step === 4;
  launch.hidden = state.step !== 4;
  document.querySelector("#review-agent").textContent = agentNames[state.agent];
  document.querySelector("#review-inference").textContent = inferenceNames[state.inference];
  document.querySelector("#experimental-notice").hidden = !["pi", "nemocua"].includes(state.agent);
}

function select(selector, attribute, value) {
  for (const card of document.querySelectorAll(selector)) {
    const selected = card.dataset[attribute] === value;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-checked", String(selected));
  }
}

document.querySelectorAll("[data-agent]").forEach((card) => {
  card.addEventListener("click", () => {
    state.agent = card.dataset.agent;
    select("[data-agent]", "agent", state.agent);
  });
});

document.querySelectorAll("[data-inference]").forEach((choice) => {
  choice.addEventListener("click", () => {
    state.inference = choice.dataset.inference;
    select("[data-inference]", "inference", state.inference);
  });
});

next.addEventListener("click", () => {
  state.step = Math.min(4, state.step + 1);
  render();
});

back.addEventListener("click", () => {
  state.step = Math.max(1, state.step - 1);
  render();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.hidden = true;
  launch.disabled = true;
  launch.textContent = "Preparing…";
  const options = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch("/api/configure", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...state, options }),
    });
    const result = await response.json();
    if (!response.ok || typeof result.redirect !== "string")
      throw new Error(result.message || "Setup could not continue.");
    window.location.assign(result.redirect);
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : "Setup could not continue.";
    error.hidden = false;
    launch.disabled = false;
    launch.textContent = "Finish & launch";
  }
});

render();
