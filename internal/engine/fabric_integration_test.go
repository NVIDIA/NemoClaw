//go:build integration

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

func TestExistingOpenClawStateDefaultsRuntimeWithoutReplacement(t *testing.T) {
	e, f, d, out := setup(t)
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(e.StateDir, "terraform.tfstate")
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var state map[string]any
	if err := json.Unmarshal(b, &state); err != nil {
		t.Fatal(err)
	}
	for _, raw := range state["resources"].([]any) {
		r := raw.(map[string]any)
		if r["type"] == "nemoclaw_provider" {
			for _, instance := range r["instances"].([]any) {
				delete(instance.(map[string]any)["attributes"].(map[string]any), "provider_type")
			}
		}
		if r["type"] == "nemoclaw_sandbox" {
			for _, instance := range r["instances"].([]any) {
				delete(instance.(map[string]any)["attributes"].(map[string]any), "agent_runtime")
			}
		}
	}
	b, err = json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, b, 0600); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	var result Result
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || len(result.Changes) != 0 || f.count() != 4 {
		t.Fatal("older state caused resource changes", err)
	}
}

func TestFabricDeploymentBoundary(t *testing.T) {
	for _, harness := range []string{"deepagents", "hermes", "openclaw", "claude", "codex", "mini-swe-agent", "nooa", "nooa-bench", "remote-agent", "pi"} {
		t.Run(harness, func(t *testing.T) { testFabricDeploymentBoundary(t, harness) })
	}
}

func testFabricDeploymentBoundary(t *testing.T, harness string) {
	e, f, d, out := setup(t)
	d.Spec.Sandboxes[0].Agents[0].Type = "fabric"
	d.Spec.Sandboxes[0].Agents[0].Harness = harness
	if harness == "claude" {
		d.Spec.InferenceProviders[0].Provider = "anthropic"
	}
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	sandbox := f.sandboxes[d.Workspace()+"/assistant"]
	id := sandbox.Metadata.Id
	if sandbox.Metadata.Labels[oshell.AgentRuntimeLabel] != "fabric-"+harness || sandbox.Spec.Command[0] != "/opt/fabric/bin/python" {
		t.Fatal("did not provision Fabric")
	}
	f.mu.Unlock()
	out.Reset()
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	if f.count() != 4 {
		t.Fatal("unchanged apply mutated deployment")
	}
	f.mu.Lock()
	if f.sandboxes[d.Workspace()+"/assistant"].Metadata.Id != id {
		t.Fatal("reapply replaced sandbox or invoked conversation")
	}
	f.mu.Unlock()
	out.Reset()
	if err := invoke(t, e, "export", d); err != nil {
		t.Fatal(err)
	}
	exported, err := config.Parse(bytes.NewReader(out.Bytes()))
	if err != nil || exported.Digest() != d.Digest() {
		t.Fatal("Fabric export changed config", err)
	}
	// A failed probe must block apply without replacing resources or injecting a turn.
	f.mu.Lock()
	f.inferenceExit = 1
	f.mu.Unlock()
	effectsBeforeProbe := f.count()
	if err := invoke(t, e, "apply", d); err == nil || f.count() != effectsBeforeProbe {
		t.Fatal("failed inference probe did not block apply")
	}
	f.mu.Lock()
	f.inferenceExit = 0
	f.mu.Unlock()
	// Harness selection is immutable: ordinary apply cannot discard conversation state.
	d.Spec.Sandboxes[0].Agents[0].Harness = "deepagents"
	if harness == "deepagents" {
		d.Spec.Sandboxes[0].Agents[0].Harness = "hermes"
	}
	if harness == "claude" {
		d.Spec.InferenceProviders[0].Provider = "openai"
	}
	effects := f.count()
	if err := invoke(t, e, "apply", d); err == nil || f.count() != effects {
		t.Fatal("harness switch permitted replacement or other effects")
	}
	d.Spec.Sandboxes[0].Agents[0].Harness = harness
	if harness == "claude" {
		d.Spec.InferenceProviders[0].Provider = "anthropic"
	}
	// Configuration drift must still block reconciliation/export without runtime APIs.
	f.mu.Lock()
	sandbox.Spec.Environment["OPENAI_API_KEY"] = "changed"
	f.mu.Unlock()
	out.Reset()
	if err := invoke(t, e, "export", d); err == nil || out.Len() != 0 {
		t.Fatal("export accepted a drifted sandbox")
	}
	for _, operation := range []string{"invoke", "channels"} {
		if err := e.Run(t.Context(), operation, strings.NewReader("")); err == nil {
			t.Fatal("retired runtime command accepted", operation)
		}
	}
}
