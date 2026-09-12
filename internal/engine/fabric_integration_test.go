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

func TestFabricDeploymentAndInvocationBoundary(t *testing.T) {
	for _, harness := range []string{"deepagents", "hermes"} {
		t.Run(harness, func(t *testing.T) { testFabricDeploymentAndInvocationBoundary(t, harness) })
	}
}

func testFabricDeploymentAndInvocationBoundary(t *testing.T, harness string) {
	e, f, d, out := setup(t)
	d.Spec.Sandboxes[0].Agents[0].Type = "fabric"
	d.Spec.Sandboxes[0].Agents[0].Harness = harness
	if err := invoke(t, e, "apply", d); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	sandbox := f.sandboxes[d.Workspace()+"/assistant"]
	id := sandbox.Metadata.Id
	if sandbox.Metadata.Labels[oshell.AgentRuntimeLabel] != "fabric-"+harness || sandbox.Spec.Command[0] != "/opt/fabric/bin/python" {
		t.Fatal("did not provision Fabric")
	}
	f.fabricResult = `{"status":"succeeded","runtime_id":"runtime-one","invocation_id":"turn-one","output":{"response":"hello"}}`
	f.mu.Unlock()
	out.Reset()
	prompt := "quotes ' \" and $(must-not-execute)\nsecond line"
	if err := e.Run(t.Context(), "invoke", strings.NewReader(prompt)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "runtime-one") {
		t.Fatal("lost Fabric result")
	}
	f.mu.Lock()
	if len(f.fabricInputs) != 1 || f.fabricInputs[0] != prompt {
		t.Fatal("prompt changed or request repeated")
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
	if f.sandboxes[d.Workspace()+"/assistant"].Metadata.Id != id || len(f.fabricInputs) != 1 {
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
	// Harness selection is immutable: ordinary apply cannot discard conversation state.
	d.Spec.Sandboxes[0].Agents[0].Harness = map[string]string{"hermes": "deepagents", "deepagents": "hermes"}[harness]
	effects := f.count()
	if err := invoke(t, e, "apply", d); err == nil || f.count() != effects {
		t.Fatal("harness switch permitted replacement or other effects")
	}
	d.Spec.Sandboxes[0].Agents[0].Harness = harness
	// A failing normalized result reaches the caller without automatic replay.
	f.mu.Lock()
	f.fabricResult = `{"status":"failed","runtime_id":"runtime-one","invocation_id":"turn-two","error":{"code":"failure"}}`
	f.mu.Unlock()
	out.Reset()
	if err := e.Run(t.Context(), "invoke", strings.NewReader("fail")); err == nil || !strings.Contains(out.String(), "failure") {
		t.Fatal("failed invocation lost its result or reported success")
	}
	f.mu.Lock()
	if len(f.fabricInputs) != 2 {
		t.Fatal("failed invocation retried")
	}
	sandbox.Spec.Environment["OPENAI_API_KEY"] = "changed"
	f.mu.Unlock()
	if err := e.Run(t.Context(), "invoke", strings.NewReader("do not run")); err == nil {
		t.Fatal("invoked a drifted sandbox")
	}
	f.mu.Lock()
	if len(f.fabricInputs) != 2 {
		t.Fatal("submitted request after failed observation")
	}
	f.mu.Unlock()
}
