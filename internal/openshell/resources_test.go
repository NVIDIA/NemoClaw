// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"strings"
	"testing"
	"time"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

type observationClient struct {
	Client
	sandboxes v1.SandboxInterface
}

func (c observationClient) Sandboxes() v1.SandboxInterface { return c.sandboxes }

type sandboxReader struct {
	v1.SandboxInterface
	get func(context.Context, string, string) (*v1.Sandbox, error)
}

func (r sandboxReader) Get(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
	return r.get(ctx, workspace, name)
}

func TestObserveSandboxRequiresCompleteFacts(t *testing.T) {
	for _, mode := range []string{"present", "absent", "failed", "nil response", "missing phase", "missing identity", "wrong name", "missing policy", "failed startup policy drift"} {
		t.Run(mode, func(t *testing.T) {
			c := observationClient{sandboxes: sandboxReader{get: func(ctx context.Context, workspace, name string) (*v1.Sandbox, error) {
				if deadline, ok := ctx.Deadline(); !ok || time.Until(deadline) > 20*time.Second {
					t.Fatal("observation is not bounded")
				}
				if workspace != "workspace" || name != "sandbox" {
					t.Fatal("reader received the wrong resource key")
				}
				s := &v1.Sandbox{
					ID: "durable-id", Name: name,
					Labels: map[string]string{OwnerLabel: "owner", GenerationLabel: "generation", AgentLabel: "agent"},
					Spec: v1.SandboxSpec{
						Template: &v1.SandboxTemplate{Image: "image"},
						Command:  Command(), Environment: Environment("agent"), Policy: Policy(),
					},
					Status: v1.SandboxStatus{Phase: v1.SandboxProvisioning},
				}
				switch mode {
				case "absent":
					return nil, &v1.StatusError{Code: v1.ErrorNotFound}
				case "failed":
					return nil, &v1.StatusError{Code: v1.ErrorUnavailable, Message: "sensitive-sentinel"}
				case "nil response":
					return nil, nil
				case "missing phase":
					s.Status.Phase = ""
				case "missing identity":
					s.ID = ""
				case "missing policy":
					s.Spec.Policy = nil
				case "failed startup policy drift":
					s.Status.Phase = v1.SandboxError
					s.Spec.Policy.Process.RunAsUser = "0"
				case "wrong name":
					s.Name = "other"
				}
				return s, nil
			}}}
			got, err := Observe(t.Context(), c, "sandbox", "workspace", "sandbox")
			switch mode {
			case "present":
				if err != nil || got["id"] != "durable-id" || got["phase"] != string(v1.SandboxProvisioning) {
					t.Fatalf("lost observed configuration: %v, %v", got, err)
				}
			case "absent":
				if err != nil || got != nil {
					t.Fatalf("explicit absence: %v, %v", got, err)
				}
			default:
				if err == nil || got != nil {
					t.Fatalf("incomplete observation returned facts or absence: %v, %v", got, err)
				}
				if strings.Contains(err.Error(), "sensitive-sentinel") {
					t.Fatal("remote error leaked credentials")
				}
			}
		})
	}
}

func TestObserveRejectsInvalidKeysBeforeReading(t *testing.T) {
	for _, key := range []struct{ kind, workspace, name string }{
		{"unknown", "workspace", "name"},
		{"provider", "", "name"},
		{"workspace", "workspace", "name"},
		{"workspace", "", ""},
		{"workspace", "", "name\x00"},
	} {
		if got, err := Observe(t.Context(), nil, key.kind, key.workspace, key.name); err == nil || got != nil {
			t.Fatalf("invalid key yielded an observation: %v, %v", got, err)
		}
	}
}
