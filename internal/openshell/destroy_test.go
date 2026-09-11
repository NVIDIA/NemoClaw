// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package openshell

import (
	"context"
	"strings"
	"testing"

	v1 "github.com/NVIDIA/OpenShell/sdk/go/openshell/v1"
)

type deletingSandbox struct {
	v1.SandboxInterface
	object  *v1.Sandbox
	failure string
	deletes int
}

func (s *deletingSandbox) Get(context.Context, string, string) (*v1.Sandbox, error) {
	if s.failure == "read" || (s.failure == "after delete" && s.deletes != 0) {
		return nil, &v1.StatusError{Code: v1.ErrorUnavailable, Message: "sensitive-sentinel"}
	}
	if s.object == nil {
		return nil, &v1.StatusError{Code: v1.ErrorNotFound}
	}
	return s.object, nil
}
func (s *deletingSandbox) Delete(context.Context, string, string) error {
	s.deletes++
	s.object = nil
	if s.failure == "lost response" {
		return &v1.StatusError{Code: v1.ErrorUnavailable, Message: "sensitive-sentinel"}
	}
	return nil
}

func TestRemoveSandboxVerifiesBindingAndConfirmsDeletion(t *testing.T) {
	for _, scenario := range []string{"success", "absent", "read", "after delete", "lost response", "foreign", "replacement", "unbound"} {
		t.Run(scenario, func(t *testing.T) {
			s := &deletingSandbox{failure: scenario, object: &v1.Sandbox{ID: "id", Name: "sandbox", Labels: map[string]string{OwnerLabel: "owner", GenerationLabel: "generation", AgentLabel: "agent"}, Spec: v1.SandboxSpec{Template: &v1.SandboxTemplate{Image: "image"}, Command: Command(), Environment: Environment("agent"), Policy: Policy()}, Status: v1.SandboxStatus{Phase: v1.SandboxError}}}
			want := Row{"name": "sandbox", "workspace": "workspace", "id": "id", "owner": "owner", "generation": "generation"}
			switch scenario {
			case "absent":
				s.object = nil
			case "foreign":
				s.object.Labels[OwnerLabel] = "other"
			case "replacement":
				s.object.ID = "other"
			case "unbound":
				want["id"] = ""
			}
			err := Remove(t.Context(), observationClient{sandboxes: s}, "sandbox", want)
			if (err == nil) != (scenario == "success" || scenario == "absent") {
				t.Fatal("deletion outcome incorrect", err)
			}
			if err != nil && strings.Contains(err.Error(), "sensitive-sentinel") {
				t.Fatal("remote error leaked")
			}
			wantDeletes := 0
			if scenario == "success" || scenario == "after delete" || scenario == "lost response" {
				wantDeletes = 1
			}
			if s.deletes != wantDeletes {
				t.Fatal("unsafe delete or automatic mutation retry", s.deletes)
			}
		})
	}
}
