// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package engine

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/managed"
	"github.com/NVIDIA/NemoClaw/internal/ollama"
	oshell "github.com/NVIDIA/NemoClaw/internal/openshell"
)

func (e *Engine) export(ctx context.Context, r Record) error {
	if r.Version == 0 || r.Pending || r.Destroyed {
		return errors.New("export requires established resource bindings; reconcile any unfinished apply first")
	}
	ids, err := e.stateIDs()
	if err != nil {
		return err
	}
	d := r.Document
	if d.Spec.Gateway.Management == "managed" {
		stage := &Engine{StateDir: filepath.Join(e.StateDir, "runtime")}
		bound, err := stage.stateIDs()
		if err != nil {
			return err
		}
		docker, err := managed.New(d.Spec.Gateway.Engine)
		if err != nil {
			return err
		}
		defer docker.Close()
		if bound[gatewayStorageAddress] == "" {
			return errors.New("gateway storage has no established identity")
		}
		if _, err = docker.GatewayStorage(ctx, gatewayStorageSpec(d, r.Generations), bound[gatewayStorageAddress], false); err != nil {
			return err
		}
		if d.Spec.InferenceProviders[0].Service != nil {
			if bound[storageAddress] == "" {
				return errors.New("model storage has no established identity")
			}
			if _, err = docker.Storage(ctx, runtimeStorage(d, r.Generations), bound[storageAddress], false); err != nil {
				return err
			}
		}
		for _, s := range runtimeSpecs(d, r.Generations) {
			id := bound[runtimeAddress(s)]
			if id == "" {
				return errors.New("managed runtime has no established identity")
			}
			o, err := docker.Observe(ctx, s, id)
			if err != nil || o == nil {
				return errors.New("managed runtime configuration is unobservable; no YAML exported")
			}
			if s.Service != nil {
				if err = docker.VerifyArtifacts(ctx, o); err != nil {
					return err
				}
			}
		}
	}
	targets := Targets(d, r.Generations)
	c, err := oshell.Connect(d.Spec.Gateway)
	if err != nil {
		return err
	}
	defer c.Close()
	observationCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for _, t := range targets {
		got, err := oshell.Observe(observationCtx, c, t.Kind, t.Values["workspace"], t.Values["name"])
		if err != nil {
			return fmt.Errorf("export %s: %w; no YAML exported", t.Kind, err)
		}
		if got == nil {
			return fmt.Errorf("export %s: resource is confirmed absent; no YAML exported", t.Kind)
		}
		t.Values["id"] = ids[t.Address]
		if t.Values["id"] == "" {
			return errors.New("resource has no durable state identity")
		}
		if err = oshell.VerifyIdentity(t.Values, got); err != nil {
			return fmt.Errorf("export %s: %w", t.Kind, err)
		}
		switch t.Kind {
		case "provider":
			if d.Spec.InferenceProviders[0].Service != nil {
				if got["endpoint"] != d.InferenceEndpoint() || got["credential_env"] != "" {
					return errors.New("managed inference registration drifted")
				}
			} else {
				d.Spec.InferenceProviders[0].Endpoint = got["endpoint"]
			}
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
	if d.Spec.InferenceProviders[0].Ollama != nil {
		id := ids["nemoclaw_ollama.service"]
		if id == "" || ids["nemoclaw_ollama_model.inference"] != id+"/model" {
			return errors.New("managed Ollama has no established bindings")
		}
		if _, err = observeOllama(ctx, d, r.Generations, id); err != nil {
			return err
		}
		if _, err = ollama.NewModels(d.Spec.InferenceProviders[0].Endpoint).Read(ctx, d.Spec.Sandboxes[0].Agents[0].Inference.Routes[0].Overrides.Model); err != nil {
			return err
		}
	}
	if err = d.Validate(); err != nil {
		return err
	}
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
