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
  local: "Local compatible endpoint (experimental)",
  qualification: "Deterministic local qualification",
};

const providerDefaults = {
  nvidia: {
    endpoint: "https://integrate.api.nvidia.com/v1",
    model: "nvidia/nemotron-3-super-120b-a12b",
    credentialLabel: "NVIDIA API key",
    credentialPlaceholder: "nvapi-…",
    endpointHelp: "The reviewed NVIDIA API endpoint.",
    credentialRequired: true,
  },
  openrouter: {
    endpoint: "https://openrouter.ai/api/v1",
    model: "nvidia/nemotron-3-super-120b-a12b",
    credentialLabel: "OpenRouter API key",
    credentialPlaceholder: "sk-or-…",
    endpointHelp: "NemoClaw identifies itself to OpenRouter on every request.",
    credentialRequired: true,
  },
  compatible: {
    endpoint: "https://",
    model: "",
    credentialLabel: "API key",
    credentialPlaceholder: "Provider credential",
    endpointHelp: "Enter the HTTPS base URL ending at the provider's v1 API root.",
    credentialRequired: false,
  },
  local: {
    endpoint: "http://127.0.0.1:8000/v1",
    model: "",
    credentialLabel: "Bearer token (optional)",
    credentialPlaceholder: "Leave blank when the local endpoint has no auth",
    endpointHelp: "Connects to an already-running native OpenAI-compatible endpoint.",
    credentialRequired: false,
  },
};

const query = new URLSearchParams(window.location.search);
const qualification = query.get("qualification") === "1";
const requestedAgent = query.get("agent");
const sessionToken = query.get("session") ?? "";
const state = {
  step: 1,
  agent: Object.hasOwn(agentNames, requestedAgent) ? requestedAgent : "openclaw",
  inference: qualification ? "qualification" : "nvidia",
};
const panels = [...document.querySelectorAll("[data-step]")];
const steps = [...document.querySelectorAll("[data-step-target]")];
const next = document.querySelector("#next");
const back = document.querySelector("#back");
const launch = document.querySelector("#launch");
const form = document.querySelector("#onboarding-form");
const error = document.querySelector("#submit-error");
const inferenceError = document.querySelector("#inference-error");
const endpoint = document.querySelector("#endpoint");
const model = document.querySelector("#model");
const credential = document.querySelector("#credential");
const credentialField = document.querySelector("#credential-field");
const providerHeading = document.querySelector("#provider-heading");
const credentialLabel = document.querySelector("#credential-label");
const endpointHelp = document.querySelector("#endpoint-help");

function renderProvider() {
  const config = providerDefaults[state.inference];
  document.querySelector("#qualification-note").hidden = !qualification;
  document.querySelector("#inference-configuration").hidden = qualification;
  document.querySelector(".choice-grid").hidden = qualification;
  if (qualification) return;
  providerHeading.textContent = inferenceNames[state.inference];
  endpoint.value = config.endpoint;
  endpoint.readOnly = ["nvidia", "openrouter"].includes(state.inference);
  model.value = config.model;
  credential.value = "";
  credentialLabel.textContent = config.credentialLabel;
  credential.placeholder = config.credentialPlaceholder;
  credential.required = config.credentialRequired;
  endpointHelp.textContent = config.endpointHelp;
  credentialField.querySelector("small").textContent = config.credentialRequired
    ? "Stored for your Windows account in Credential Manager; never in MSI logs."
    : "Optional. If supplied, Windows Credential Manager protects it for this account.";
  inferenceError.hidden = true;
}

function validateInference() {
  if (qualification) return true;
  inferenceError.hidden = true;
  let parsed;
  try {
    parsed = new URL(endpoint.value.trim());
  } catch {
    inferenceError.textContent = "Enter a complete inference endpoint URL.";
    inferenceError.hidden = false;
    endpoint.focus();
    return false;
  }
  if (
    (state.inference === "local" && parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    (state.inference !== "local" && parsed.protocol !== "https:")
  ) {
    inferenceError.textContent =
      state.inference === "local"
        ? "The local endpoint must use HTTP or HTTPS."
        : "Hosted inference endpoints must use HTTPS.";
    inferenceError.hidden = false;
    endpoint.focus();
    return false;
  }
  if (!model.value.trim()) {
    inferenceError.textContent = "Enter the exact model ID served by this endpoint.";
    inferenceError.hidden = false;
    model.focus();
    return false;
  }
  if (providerDefaults[state.inference].credentialRequired && !credential.value.trim()) {
    inferenceError.textContent = `${providerDefaults[state.inference].credentialLabel} is required.`;
    inferenceError.hidden = false;
    credential.focus();
    return false;
  }
  return true;
}

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
  document.querySelector("#review-model").textContent = qualification
    ? "native-preview"
    : model.value.trim() || "Not selected";
  document.querySelector("#review-credential").textContent = qualification
    ? "No credential used"
    : credential.value.trim()
      ? "Windows Credential Manager"
      : "No credential required";
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
    if (card.disabled || card.getAttribute("aria-disabled") === "true") return;
    state.agent = card.dataset.agent;
    select("[data-agent]", "agent", state.agent);
  });
});

document.querySelectorAll("[data-inference]").forEach((choice) => {
  choice.addEventListener("click", () => {
    state.inference = choice.dataset.inference;
    select("[data-inference]", "inference", state.inference);
    renderProvider();
  });
});

next.addEventListener("click", () => {
  if (state.step === 2 && !validateInference()) return;
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
      headers: { "content-type": "application/json", "x-nemoclaw-session": sessionToken },
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

renderProvider();
select("[data-agent]", "agent", state.agent);
render();
