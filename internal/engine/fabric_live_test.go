//go:build live

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"uuid"

	"github.com/NVIDIA/NemoClaw/internal/config"
)

// This test executes a real Fabric adapter and real inference in OpenShell.
// Success removes only its sandbox, route and provider; failure retains evidence.
func TestLiveFabric(t *testing.T) {
	file := os.Getenv("NEMOCLAW_LIVE_FABRIC_CONFIG")
	if file == "" {
		t.Skip("set NEMOCLAW_LIVE_FABRIC_CONFIG to an absolute deployment YAML path")
	}
	if !filepath.IsAbs(file) {
		t.Fatal("live config must be absolute")
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	d, err := config.Parse(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if d.Spec.Gateway.Management != "external" || d.Spec.InferenceProviders[0].Ollama != nil || d.Spec.InferenceProviders[0].Service != nil || d.Spec.Sandboxes[0].Agents[0].Runtime() != "fabric-deepagents" {
		t.Fatal("Fabric live test requires external gateway/inference and Fabric Deep Agents")
	}
	d.Metadata.UID = uuid.NewV4().String()
	state, err := filepath.Abs("../../.local/fabric-live-" + d.Metadata.UID)
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := filepath.Abs("../../dist/" + runtime.GOOS + "_" + runtime.GOARCH)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(state, 0700); err != nil {
		t.Fatal(err)
	}
	t.Log("evidence and deployment state:", state)
	b, err = d.YAML()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "deployment.yaml"), b, 0600); err != nil {
		t.Fatal(err)
	}
	out := &bytes.Buffer{}
	e := &Engine{StateDir: state, BundleDir: bundle, Output: out}
	run := func(operation string, input []byte, evidence string) {
		t.Helper()
		out.Reset()
		err := e.Run(t.Context(), operation, bytes.NewReader(input))
		if writeErr := os.WriteFile(filepath.Join(state, evidence), out.Bytes(), 0600); writeErr != nil {
			t.Fatal(writeErr)
		}
		if err != nil {
			t.Fatal(err)
		}
	}
	run("apply", b, "apply.json")
	ids, err := e.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	run("invoke", []byte("Reply with exactly the word FOUR."), "first-result.json")
	var first struct {
		RuntimeID    string `json:"runtime_id"`
		InvocationID string `json:"invocation_id"`
		Output       struct {
			Response string `json:"response"`
		} `json:"output"`
	}
	if err := json.Unmarshal(out.Bytes(), &first); err != nil || first.RuntimeID == "" || !strings.Contains(strings.ToUpper(first.Output.Response), "FOUR") {
		t.Fatal("no actual expected agent response", err)
	}
	run("apply", b, "unchanged-apply.json")
	var result Result
	if err := json.Unmarshal(out.Bytes(), &result); err != nil || len(result.Changes) != 0 {
		t.Fatal("unchanged apply changed resources", err)
	}
	after, err := e.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	for address, id := range ids {
		if after[address] != id {
			t.Fatal("resource identity changed", address)
		}
	}
	run("export", nil, "export.yaml")
	exported := bytes.Clone(out.Bytes())
	parsed, err := config.Parse(bytes.NewReader(exported))
	if err != nil || parsed.Digest() != d.Digest() {
		t.Fatal("export lost Fabric configuration", err)
	}
	run("apply", exported, "export-reapply.json")
	run("invoke", []byte("What is two plus two? Reply with the English word only."), "second-result.json")
	var second struct {
		RuntimeID    string `json:"runtime_id"`
		InvocationID string `json:"invocation_id"`
	}
	if err := json.Unmarshal(out.Bytes(), &second); err != nil || second.RuntimeID != first.RuntimeID || second.InvocationID == first.InvocationID {
		t.Fatal("Fabric runtime was restarted or invocation identity reused", err)
	}
	run("destroy", nil, "destroy.json")
}
