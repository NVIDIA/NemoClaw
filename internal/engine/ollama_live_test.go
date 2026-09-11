//go:build live

// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"bytes"
	"context"
	"encoding/json/v2"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/ollama"
	"github.com/moby/moby/client"
)

func liveStoppedOllama(t *testing.T, ctx context.Context, e *Engine, d config.Document, ids map[string]string) {
	t.Helper()
	c, err := ollama.NewDocker(d.Spec.InferenceProviders[0].Ollama.Engine)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	id := ids["nemoclaw_ollama.service"]
	s, err := c.Bound(ctx, id, d.Spec.InferenceProviders[0].Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	containerID := strings.Split(s.ID, "/")[1]
	if _, err = c.API.ContainerStop(ctx, containerID, client.ContainerStopOptions{}); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(e.StateDir, "terraform.tfstate"))
	if err != nil {
		t.Fatal(err)
	}
	b, _ := d.YAML()
	err = e.Run(ctx, "plan", bytes.NewReader(b))
	if err == nil || !strings.Contains(err.Error(), "model inventory is unknown") {
		t.Fatalf("expected model refresh to block stopped-service repair: %v", err)
	}
	observed, err := c.Bound(ctx, id, d.Spec.InferenceProviders[0].Endpoint)
	if err != nil || observed.Running {
		t.Fatalf("planning unexpectedly restarted Ollama: %+v, %v", observed, err)
	}
	after, err := os.ReadFile(filepath.Join(e.StateDir, "terraform.tfstate"))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed refresh changed persisted bindings")
	}
	if err = e.Run(ctx, "export", nil); err == nil {
		t.Fatal("stopped service exported unobservable model inventory")
	}
	// Explicit harness repair documents the boundary; the product has no hidden
	// restart or targeted apply outside its checked plan.
	if _, err = c.API.ContainerStart(ctx, containerID, client.ContainerStartOptions{}); err != nil {
		t.Fatal(err)
	}
	ready, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	ticks := time.Tick(200 * time.Millisecond)
	for {
		_, err = ollama.NewModels(d.Spec.InferenceProviders[0].Endpoint).Read(ready, d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model)
		if err == nil {
			break
		}
		select {
		case <-ready.Done():
			t.Fatal(err)
		case <-ticks:
		}
	}
	out := &bytes.Buffer{}
	e.Output = out
	if err = e.Run(ctx, "apply", bytes.NewReader(b)); err != nil {
		t.Fatal(err)
	}
	var result Result
	if err = json.Unmarshal(out.Bytes(), &result); err != nil || len(result.Changes) != 0 {
		t.Fatalf("recovered apply was not a no-op: %+v, %v", result, err)
	}
	recovered, err := c.Bound(ctx, id, d.Spec.InferenceProviders[0].Endpoint)
	if err != nil || recovered.ID != id {
		t.Fatal("restart changed persistent identity")
	}
	t.Log("experiment: model refresh blocks the plan that would restart its parent; explicit runtime restart preserves state and data")
}

func liveModelRetained(t *testing.T, ctx context.Context, d config.Document, name string) {
	t.Helper()
	if _, err := ollama.NewModels(d.Spec.InferenceProviders[0].Endpoint).Read(ctx, name); err != nil {
		t.Fatalf("changing the selected model removed cached data: %v", err)
	}
}

func liveFreshOllamaEndpoint(t *testing.T, d *config.Document) {
	t.Helper()
	u, err := url.Parse(d.Spec.InferenceProviders[0].Endpoint)
	if err != nil {
		t.Fatal(err)
	}
	l, err := net.Listen("tcp", net.JoinHostPort(u.Hostname(), "0"))
	if err != nil {
		t.Fatal(err)
	}
	u.Host = l.Addr().String()
	l.Close()
	d.Spec.InferenceProviders[0].Endpoint = u.String()
}

func liveOllamaCleanup(t *testing.T, ctx context.Context, d config.Document, ids map[string]string) {
	t.Helper()
	c, err := ollama.NewDocker(d.Spec.InferenceProviders[0].Ollama.Engine)
	if err != nil {
		t.Error(err)
		return
	}
	defer c.Close()
	s, err := c.Bound(ctx, ids["nemoclaw_ollama.service"], d.Spec.InferenceProviders[0].Endpoint)
	if err != nil || s.Spec.Owner != d.Metadata.UID {
		t.Error("cleanup Ollama identity or ownership changed")
		return
	}
	if _, err = c.API.ContainerRemove(ctx, strings.Split(s.ID, "/")[1], client.ContainerRemoveOptions{Force: true}); err != nil {
		t.Error(err)
		return
	}
	if _, err = c.API.VolumeRemove(ctx, s.Spec.Volume(), client.VolumeRemoveOptions{}); err != nil {
		t.Error(err)
	}
}
