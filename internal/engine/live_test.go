//go:build live

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
	"uuid"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

// This opt-in test creates real sandboxes and sends real model requests. It
// retains state and resources on failure. Successful test deployments are
// removed only after checking the exact identities created by this run.
func TestLivePlanApplyModelExportRecreate(t *testing.T) {
	input := os.Getenv("NEMOCLAW_LIVE_CONFIG")
	alternate := os.Getenv("NEMOCLAW_LIVE_ALTERNATE_MODEL")
	if input == "" || alternate == "" {
		t.Skip("set NEMOCLAW_LIVE_CONFIG and NEMOCLAW_LIVE_ALTERNATE_MODEL")
	}
	b, err := os.ReadFile(input)
	if err != nil {
		t.Fatal(err)
	}
	d, err := config.Parse(bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	if d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model == alternate {
		t.Fatal("alternate model must differ")
	}
	d.Metadata.UID = uuid.NewV4().String()
	root, err := filepath.Abs(filepath.Join("../../.local", "live-"+d.Metadata.UID))
	if err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(root, 0700); err != nil {
		t.Fatal(err)
	}
	t.Log("persistent evidence:", root)
	bundle, _ := filepath.Abs("../../dist/" + runtime.GOOS + "_" + runtime.GOARCH)
	out := &bytes.Buffer{}
	e := &Engine{StateDir: filepath.Join(root, "original"), BundleDir: bundle, Output: out}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Minute)
	defer cancel()
	invoke := func(e *Engine, operation string, d config.Document) Result {
		t.Helper()
		out.Reset()
		e.Output = out
		b, err := d.YAML()
		if err != nil {
			t.Fatal(err)
		}
		if err = e.Run(ctx, operation, bytes.NewReader(b)); err != nil {
			t.Fatal(err)
		}
		var result Result
		if operation != "export" && json.Unmarshal(out.Bytes(), &result) != nil {
			t.Fatal("invalid result")
		}
		return result
	}
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if result := invoke(e, "plan", d); len(result.Changes) != 4 {
		t.Fatalf("plan has %d changes", len(result.Changes))
	}
	if _, err = c.Workspaces().Get(ctx, d.Workspace()); !v1.IsNotFound(err) {
		t.Fatal("plan created a workspace")
	}
	if result := invoke(e, "apply", d); len(result.Changes) != 4 {
		t.Fatal("expected four created resources")
	}
	firstIDs, err := e.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !t.Failed() {
			liveCleanup(t, d, firstIDs)
		}
	})
	if result := invoke(e, "apply", d); len(result.Changes) != 0 {
		t.Fatal("repeated apply changed resources")
	}
	liveAgentReply(t, ctx, c, d)
	d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model = alternate
	result := invoke(e, "apply", d)
	if len(result.Changes) != 1 || result.Changes[0].Resource != "nemoclaw_route.primary" || strings.Join(result.Changes[0].Actions, ",") != "update" {
		t.Fatalf("model change affected unexpected resources: %+v", result)
	}
	ids, err := e.stateIDs()
	if err != nil || ids["nemoclaw_sandbox.agent"] != firstIDs["nemoclaw_sandbox.agent"] {
		t.Fatal("model change replaced sandbox")
	}
	liveAgentReply(t, ctx, c, d)
	invoke(e, "export", d)
	exported, err := config.Parse(bytes.NewReader(out.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	if exported.Digest() != d.Digest() {
		t.Fatal("live export differs from applied configuration")
	}
	if err = os.WriteFile(filepath.Join(root, "exported.yaml"), out.Bytes(), 0600); err != nil {
		t.Fatal(err)
	}
	// Fork the exported deployment into a new workspace with an explicit new UID.
	// The protocol integration test additionally recreates the same UID on a
	// different gateway endpoint.
	exported.Metadata.UID = uuid.NewV4().String()
	other := &Engine{StateDir: filepath.Join(root, "recreated"), BundleDir: bundle, Output: out}
	if result := invoke(other, "apply", exported); len(result.Changes) != 4 {
		t.Fatal("export did not create four resources")
	}
	otherIDs, err := other.stateIDs()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if !t.Failed() {
			liveCleanup(t, exported, otherIDs)
		}
	})
	liveAgentReply(t, ctx, c, exported)
	if err = saveJSON(filepath.Join(root, "evidence.json"), map[string]any{"result": "pass", "platform": runtime.GOOS + "_" + runtime.GOARCH, "gateway": "0.0.116", "firstIDs": firstIDs, "recreatedIDs": otherIDs, "modelAfter": alternate, "noOp": true, "sandboxPreserved": true, "agentReplies": 3}); err != nil {
		t.Fatal(err)
	}
}

func liveAgentReply(t *testing.T, ctx context.Context, c oshell.Client, d config.Document) {
	t.Helper()
	r, err := c.Exec().Run(ctx, d.Workspace(), d.Spec.Sandboxes[0].Name, []string{"openclaw", "agent", "--agent", d.Spec.Sandboxes[0].Agents[0].Name, "--session-id", uuid.NewV4().String(), "--message", "Reply with the word FOUR.", "--thinking", "off", "--json", "--timeout", "120"}, v1.ExecOptions{})
	if err != nil || r.ExitCode != 0 {
		t.Fatal("live OpenClaw inference failed; inspect retained deployment")
	}
	var response struct {
		Status string
		Result struct{ Payloads []struct{ Text string } }
	}
	if json.Unmarshal(r.Stdout, &response) != nil || response.Status != "ok" || len(response.Result.Payloads) == 0 || response.Result.Payloads[0].Text == "" {
		t.Fatal("agent produced no successful reply")
	}
}

func liveCleanup(t *testing.T, d config.Document, ids map[string]string) {
	t.Helper()
	// t.Context is canceled before cleanup callbacks, which still need to delete
	// the resources owned by this live test.
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		t.Error(err)
		return
	}
	defer c.Close()
	w, err := c.Workspaces().Get(ctx, d.Workspace())
	if err != nil || w.ID != ids["nemoclaw_workspace.deployment"] || w.Labels[oshell.OwnerLabel] != d.Metadata.UID {
		t.Error("cleanup workspace ownership changed")
		return
	}
	s, err := c.Sandboxes().Get(ctx, d.Workspace(), d.Spec.Sandboxes[0].Name)
	if err != nil || s.ID != ids["nemoclaw_sandbox.agent"] || s.Labels[oshell.OwnerLabel] != d.Metadata.UID {
		t.Error("cleanup sandbox ownership changed")
		return
	}
	p, err := c.Providers().Get(ctx, d.Workspace(), d.Spec.InferenceProviders[0].Name)
	if err != nil || p.ID != ids["nemoclaw_provider.inference"] || p.Labels[oshell.OwnerLabel] != d.Metadata.UID {
		t.Error("cleanup provider ownership changed")
		return
	}
	if err = c.Sandboxes().Delete(ctx, d.Workspace(), s.Name); err != nil {
		t.Error("cleanup sandbox failed")
		return
	}
	if err = c.Providers().Delete(ctx, d.Workspace(), p.Name); err != nil {
		t.Error("cleanup provider failed")
		return
	}
	if err = c.Workspaces().Delete(ctx, d.Workspace()); err != nil {
		t.Error("cleanup workspace failed")
	}
}
