// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"errors"
	"io"

	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

func (e *Engine) invoke(ctx context.Context, r Record, input io.Reader) error {
	if r.Version == 0 || !r.Succeeded || r.Pending || r.Destroying || r.Destroyed {
		return errors.New("invoke requires a successfully applied deployment")
	}
	d := r.Document
	if err := d.Validate(); err != nil {
		return err
	}
	s := d.Spec.Sandboxes[0]
	a := s.Agents[0]
	if a.Runtime() != "fabric-deepagents" {
		return errors.New("invoke currently supports Fabric deployments only")
	}
	prompt, err := io.ReadAll(io.LimitReader(input, (64<<10)+1))
	if err != nil {
		return err
	}
	if len(prompt) == 0 || len(prompt) > 64<<10 {
		return errors.New("prompt must contain 1 to 65536 bytes")
	}
	ids, err := e.stateIDs()
	if err != nil {
		return err
	}
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		return err
	}
	defer c.Close()
	// Verify the entire OpenShell binding before allowing an agent to act.
	for _, target := range Targets(d, r.Generations) {
		target.Values["id"] = ids[target.Address]
		if target.Values["id"] == "" {
			return errors.New("invocation requires durable resource bindings")
		}
		got, err := oshell.Observe(ctx, c, target.Kind, target.Values["workspace"], target.Values["name"])
		if err != nil {
			return err
		}
		if err := oshell.VerifyIdentity(target.Values, got); err != nil {
			return err
		}
		for key, value := range target.Values {
			if got[key] != value {
				return errors.New("deployment configuration drifted; reconcile before invoking")
			}
		}
	}
	if err := oshell.Configuration(ctx, c, d.Workspace(), s.Name, a.Name, a.Runtime()); err != nil {
		return err
	}
	result, invokeErr := oshell.FabricInvoke(ctx, c, d.Workspace(), s.Name, string(prompt))
	if len(result) > 0 {
		if _, err := e.Output.Write(result); err != nil {
			return err
		}
	}
	return invokeErr
}
