// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"errors"
	"fmt"

	"github.com/NVIDIA/NemoClaw/internal/config"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
	"github.com/NVIDIA/NemoClaw/internal/query"
)

func (e *Engine) export(ctx context.Context, r Record) error {
	if r.Version == 0 || r.Pending {
		return errors.New("export requires established resource bindings; reconcile any unfinished apply first")
	}
	ids, err := e.stateIDs()
	if err != nil {
		return err
	}
	d := r.Document
	targets := Targets(d, r.Generations)
	keys := make([]query.Key, 0, len(targets))
	for _, t := range targets {
		keys = append(keys, query.Key{Kind: t.Kind, Workspace: t.Values["workspace"], Name: t.Values["name"]})
	}
	observer := query.Client{BundleDir: e.BundleDir, Gateway: d.Spec.Gateway}
	observations, err := observer.Read(ctx, keys...)
	if err != nil {
		return fmt.Errorf("export: %w; no YAML exported", err)
	}
	for i, t := range targets {
		observation := observations[keys[i]]
		if observation.Status == query.Absent {
			return fmt.Errorf("export %s: resource is confirmed absent; no YAML exported", t.Kind)
		}
		got := observation.Row()
		t.Values["id"] = ids[t.Address]
		if t.Values["id"] == "" {
			return errors.New("resource has no durable state identity")
		}
		if err = oshell.VerifyIdentity(t.Values, got); err != nil {
			return fmt.Errorf("export %s: %w", t.Kind, err)
		}
		switch t.Kind {
		case "provider":
			d.Spec.InferenceProviders[0].Endpoint = got["endpoint"]
			d.Spec.InferenceProviders[0].Credential = nil
			if got["credential_env"] != "" {
				d.Spec.InferenceProviders[0].Credential = &config.Credential{Env: got["credential_env"]}
			}
		case "route":
			if got["provider_name"] != d.Spec.InferenceProviders[0].Name {
				return errors.New("route references a provider outside this deployment")
			}
			d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model = got["model"]
		case "sandbox":
			if got["image"] != t.Values["image"] || got["agent_name"] != t.Values["agent_name"] {
				return errors.New("sandbox configuration drift requires inspection")
			}
		}
	}
	if err = d.Validate(); err != nil {
		return err
	}
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		return err
	}
	defer c.Close()
	if err = oshell.Configuration(ctx, c, d.Workspace(), d.Spec.Sandboxes[0].Name, d.Spec.Sandboxes[0].Agents[0].Name); err != nil {
		return err
	}
	b, err := d.YAML()
	if err != nil {
		return err
	}
	_, err = e.Output.Write(b)
	return err
}
