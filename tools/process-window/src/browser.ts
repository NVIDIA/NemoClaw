// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { guidanceOrigin, otherOrigin, type Origin } from "./origins.js";
import type { Input, Mechanism, Usage, Requirement } from "./model.js";
type Named = { id: string; name: string };
type Data = {
  origins: Origin[];
  stages: Named[];
  categories: Named[];
  branches: {
    id: string;
    name: string;
    color: string;
    revision?: string;
    inputs: (Input & { url: string | null })[];
    mechanisms: (Omit<Mechanism, "usages"> & {
      usages: (Omit<Usage, "requirements"> & {
        url: string | null;
        requirements?: (Requirement & { url: string })[];
      })[];
    })[];
  }[];
};
const data: Data = JSON.parse(document.querySelector("#mapping")!.textContent!);
const selector = document.querySelector<HTMLSelectElement>("#branch")!;
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}
for (const branch of data.branches) {
  const option = el("option", branch.name);
  option.value = branch.id;
  selector.append(option);
}
const selected = new URLSearchParams(location.hash.slice(1)).get("branch");
if (data.branches.some((b) => b.id === selected)) selector.value = selected!;
const originOrder = [...data.origins, otherOrigin];
const selectedOrigins = new Set<string>(); // Empty means all sources.

function matchesOrigin(path: string): boolean {
  return !selectedOrigins.size || selectedOrigins.has(guidanceOrigin(path, data.origins).id);
}
function drawFilter(): void {
  const branch = data.branches.find((b) => b.id === selector.value)!;
  const nav = document.querySelector("#source-filter")!;
  nav.replaceChildren(el("strong", "Sources"));
  const all = el("button", "All sources", "source-option");
  all.type = "button";
  all.setAttribute("aria-pressed", String(!selectedOrigins.size));
  all.addEventListener("click", () => {
    selectedOrigins.clear();
    drawFilter();
    draw();
  });
  nav.append(all);
  for (const origin of originOrder) {
    if (!branch.inputs.some((i) => guidanceOrigin(i.source.path, data.origins).id === origin.id))
      continue;
    const button = el("button", origin.name, "source-option");
    button.type = "button";
    button.dataset.origin = origin.id;
    button.title = origin.paths.join(", ") || "Paths not matched by a configured origin";
    button.setAttribute("aria-pressed", String(selectedOrigins.has(origin.id)));
    button.addEventListener("click", () => {
      if (selectedOrigins.has(origin.id)) selectedOrigins.delete(origin.id);
      else selectedOrigins.add(origin.id);
      drawFilter();
      draw();
    });
    nav.append(button);
  }
}
function draw(): void {
  const branch = data.branches.find((b) => b.id === selector.value)!;
  document.documentElement.style.setProperty("--origin", branch.color);
  const revision = document.querySelector("#revision")!;
  revision.textContent = branch.revision
    ? `Analyzed revision · ${branch.revision}`
    : "This branch has not been analyzed yet.";
  const lifecycle = document.querySelector("#lifecycle")!;
  lifecycle.replaceChildren();
  document.querySelector("#focus-panel")?.remove();
  const focusPanel = el("section");
  focusPanel.id = "focus-panel";
  focusPanel.hidden = true;
  focusPanel.setAttribute("aria-label", "Selected guidance group");
  const focusHeader = el("div", undefined, "focus-header");
  const focusTitle = el("h2");
  focusTitle.tabIndex = -1;
  const close = el("button", "Close details", "close-focus");
  close.type = "button";
  focusHeader.append(focusTitle, close);
  focusPanel.append(focusHeader);
  lifecycle.after(focusPanel);
  let activeButton: HTMLButtonElement | undefined;
  function closeFocus() {
    focusPanel.hidden = true;
    focusPanel.querySelectorAll<HTMLDetailsElement>("details").forEach((d) => {
      d.open = false;
    });
    if (activeButton) {
      activeButton.setAttribute("aria-expanded", "false");
      activeButton.focus({ preventScroll: true });
    }
  }
  close.addEventListener("click", closeFocus);
  focusPanel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFocus();
  });
  const allUsages = branch.mechanisms.flatMap((mechanism) =>
    mechanism.usages.map((usage) => ({ mechanism, usage })),
  );
  const established = allUsages.filter(
    ({ usage }) => usage.basis !== "unresolved" && usage.agentUse && usage.source && usage.url,
  );
  function sourceLink(name: string, url: string) {
    const link = el("a", name);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    return link;
  }
  data.stages.forEach((stage, n) => {
    const row = el("section", undefined, `phase ${n % 2 ? "right" : "left"}`);
    const phaseUsages = established.filter(({ usage }) => usage.stage === stage.id);
    const stageInputs = branch.inputs.filter(
      (i) =>
        matchesOrigin(i.source.path) &&
        phaseUsages.some(({ usage }) => usage.inputIds.includes(i.id)),
    );
    const card = el("div", undefined, "guidance");
    row.dataset.stage = stage.id;
    for (const origin of originOrder) {
      const inputs = stageInputs.filter(
        (i) => guidanceOrigin(i.source.path, data.origins).id === origin.id,
      );
      if (!inputs.length) continue;
      const group = el("details", undefined, "category origin-group");
      group.dataset.origin = origin.id;
      group.hidden = true;
      const heading = el("summary");
      heading.append(el("span", origin.name), el("span", String(inputs.length), "count"));
      group.append(heading);
      const button = el("button", undefined, "origin-tile");
      button.type = "button";
      button.dataset.origin = origin.id;
      button.append(el("span", origin.name), el("span", String(inputs.length), "count"));
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-controls", "focus-panel");
      button.setAttribute(
        "aria-label",
        `${stage.name}: ${origin.name}, ${inputs.length} guidance items`,
      );
      button.addEventListener("click", () => {
        if (activeButton === button && !focusPanel.hidden) {
          closeFocus();
          return;
        }
        focusPanel.querySelectorAll<HTMLDetailsElement>("details").forEach((d) => {
          d.open = false;
        });
        focusPanel.querySelectorAll<HTMLElement>(".origin-group").forEach((g) => {
          g.hidden = true;
        });
        activeButton?.setAttribute("aria-expanded", "false");
        activeButton = button;
        button.setAttribute("aria-expanded", "true");
        group.hidden = false;
        group.open = true;
        focusPanel.hidden = false;
        focusTitle.textContent = `${stage.name} / ${origin.name}`;
        focusTitle.focus({ preventScroll: true });
        focusPanel.scrollIntoView({ block: "nearest", behavior: "instant" });
      });
      card.append(button);
      const headings = el("div", undefined, "usage-row column-headings");
      headings.append(el("h3", "Guidance"), el("h3", "Used when"));
      group.append(headings);
      for (const input of inputs) {
        const entry = el("div", undefined, "usage-row");
        entry.dataset.input = input.id;
        const guidance = el("div", undefined, "guidance-cell");
        const label = input.displayName ?? input.name;
        if (input.url) guidance.append(sourceLink(label, input.url));
        else guidance.append(el("strong", label), el("span", "Source unavailable", "empty"));
        const uses = el("div", undefined, "usage-cell");
        const linked = phaseUsages.filter(({ usage }) => usage.inputIds.includes(input.id));
        for (const summary of [
          ...new Set(linked.map(({ usage }) => usage.summary ?? usage.trigger)),
        ])
          uses.append(el("p", summary, "usage-trigger"));
        entry.append(guidance, uses);
        group.append(entry);
      }
      focusPanel.append(group);
    }
    if (!stageInputs.length) {
      row.classList.add("empty-phase");
      card.append(el("p", "No mapped connections", "empty"));
    }
    const center = el("div", undefined, "stage");
    center.append(
      el("span", String(n + 1).padStart(2, "0"), "number"),
      el("h2", stage.name),
      el("span", `${stageInputs.length} guidance items`, "phase-total"),
    );
    row.append(center, card);
    lifecycle.append(row);
  });
  document.querySelector("#unmapped")?.remove();
  const pending = el("details");
  pending.id = "unmapped";
  pending.append(
    el("summary", "Guidance and relationships to investigate"),
    el(
      "p",
      "Proposed relevance and unresolved connections are tracked here, outside the runtime relationship diagram. These are not established uses.",
    ),
  );
  let count = 0;
  for (const input of branch.inputs.filter((i) => matchesOrigin(i.source.path))) {
    const missingStages = input.stages.filter(
      (stage) =>
        !established.some(
          ({ usage }) => usage.stage === stage && usage.inputIds.includes(input.id),
        ),
    );
    const uncertain = allUsages.filter(
      ({ usage }) =>
        !established.some((item) => item.usage === usage) && usage.inputIds.includes(input.id),
    );
    const unplaced = !input.stages.length;
    if (!unplaced && !missingStages.length && !uncertain.length) continue;
    count++;
    const detail = el("details");
    detail.dataset.pendingInput = input.id;
    detail.append(el("summary", input.name));
    if (unplaced) detail.append(el("p", "No lifecycle placement established."));
    if (missingStages.length)
      detail.append(
        el(
          "p",
          "Proposed phases without a source-backed use: " +
            missingStages.map((id) => data.stages.find((s) => s.id === id)!.name).join(", "),
        ),
      );
    detail.append(el("p", input.evidence));
    if (input.url)
      detail.append(sourceLink(`${input.source.path}:${input.source.start}`, input.url));
    if (input.note) detail.append(el("p", input.note, "note"));
    if (input.unavailable) detail.append(el("p", "Source unavailable at this revision.", "note"));
    for (const { mechanism, usage } of uncertain) {
      detail.append(
        el(
          "p",
          `${mechanism.name} — ${data.stages.find((s) => s.id === usage.stage)!.name}: ${usage.trigger}`,
        ),
        el("p", usage.evidence),
      );
      if (usage.url && usage.source)
        detail.append(sourceLink(`${usage.source.path}:${usage.source.start}`, usage.url));
      if (usage.note) detail.append(el("p", usage.note, "note"));
    }
    pending.append(detail);
  }
  pending.querySelector(":scope > summary")!.textContent += ` (${count})`;
  if (!count) pending.append(el("p", "No guidance to investigate for the selected sources."));
  focusPanel.after(pending);
}
selector.addEventListener("change", () => {
  location.hash = new URLSearchParams({ branch: selector.value }).toString();
  selectedOrigins.clear();
  drawFilter();
  draw();
});
drawFilter();
draw();
