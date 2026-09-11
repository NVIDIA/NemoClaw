// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package ollama

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/netip"
	"slices"
	"strings"
	"time"

	"github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

const ownerLabel = "nemoclaw.nvidia.com/uid"
const operationLabel = "nemoclaw.nvidia.com/generation"

var errPartialCreate = errors.New("Ollama container is absent but persistent storage remains; reconcile the recorded create or inspect the deployment")

const specLabel = "nemoclaw.nvidia.com/ollama-spec"

type ServiceSpec struct {
	Name, Owner, Generation, Image, Network, BindAddress string
}

type Service struct {
	Spec    ServiceSpec
	ID      string
	Running bool
}

type Docker struct{ API *client.Client }

func NewDocker(endpoint string) (*Docker, error) {
	// The first experiment deliberately selects a local engine. Remote engine
	// authentication and Windows/Podman topology require their own qualification.
	if !strings.HasPrefix(endpoint, "unix:///") {
		return nil, errors.New("managed Ollama requires an explicit local Unix engine socket")
	}
	c, err := client.New(client.WithHost(endpoint))
	if err != nil {
		return nil, errors.New("cannot configure Docker engine client")
	}
	return &Docker{API: c}, nil
}

func (d *Docker) Close() error { return d.API.Close() }

// Bound validates the physical parent before accessing its unauthenticated API.
func (d *Docker) Bound(ctx context.Context, id, endpoint string) (*Service, error) {
	parts := strings.Split(id, "/")
	if len(parts) != 3 {
		return nil, errors.New("invalid Ollama physical binding")
	}
	c, err := d.API.ContainerInspect(ctx, parts[1], client.ContainerInspectOptions{})
	if err != nil || c.Container.Config == nil || c.Container.HostConfig == nil {
		return nil, errors.New("bound Ollama container observation failed")
	}
	spec := ServiceSpec{Name: strings.TrimPrefix(c.Container.Name, "/"), Owner: c.Container.Config.Labels[ownerLabel], Generation: c.Container.Config.Labels[operationLabel], Image: c.Container.Config.Image, Network: string(c.Container.HostConfig.NetworkMode), BindAddress: strings.TrimSuffix(strings.TrimPrefix(endpoint, "http://"), "/v1")}
	s, err := d.Observe(ctx, spec)
	if err != nil {
		return nil, err
	}
	if s == nil || s.ID != id {
		return nil, errors.New("Ollama target or storage identity changed")
	}
	return s, nil
}
func (s ServiceSpec) Volume() string { return s.Name + "-models" }
func (s ServiceSpec) labels() map[string]string {
	b, _ := json.Marshal(s)
	h := sha256.Sum256(b)
	return map[string]string{ownerLabel: s.Owner, operationLabel: s.Generation, specLabel: hex.EncodeToString(h[:])}
}

func (d *Docker) Preflight(ctx context.Context, want ServiceSpec, id string) error {
	s, err := d.Observe(ctx, want)
	if id != "" {
		if err != nil || s == nil || s.ID != id {
			return errors.New("bound Ollama identity or storage is unavailable; automatic replacement is forbidden")
		}
		return nil
	}
	if !errors.Is(err, errPartialCreate) {
		return err
	}
	v, err := d.API.VolumeInspect(ctx, want.Volume(), client.VolumeInspectOptions{})
	if err != nil || v.Volume.CreatedAt == "" || v.Volume.Driver != "local" || len(v.Volume.Options) != 0 {
		return errors.New("incomplete retained Ollama storage")
	}
	for k, value := range want.labels() {
		if value == "" || v.Volume.Labels[k] != value {
			return errors.New("Ollama storage does not match the retained create operation")
		}
	}
	return nil
}

func (d *Docker) Observe(ctx context.Context, want ServiceSpec) (*Service, error) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	info, err := d.API.Info(ctx, client.InfoOptions{})
	if err != nil || info.Info.ID == "" {
		return nil, errors.New("Docker target identity is unavailable")
	}
	c, ce := d.API.ContainerInspect(ctx, want.Name, client.ContainerInspectOptions{})
	v, ve := d.API.VolumeInspect(ctx, want.Volume(), client.VolumeInspectOptions{})
	if errdefs.IsNotFound(ce) && errdefs.IsNotFound(ve) {
		return nil, nil
	}
	if errdefs.IsNotFound(ce) && ve == nil {
		return nil, errPartialCreate
	}
	if ce != nil || ve != nil {
		return nil, errors.New("Ollama container or storage observation failed; absence is unconfirmed")
	}
	if err = verify(want, c.Container, v.Volume); err != nil {
		return nil, err
	}
	return &Service{Spec: want, ID: info.Info.ID + "/" + c.Container.ID + "/" + v.Volume.CreatedAt, Running: c.Container.State.Running}, nil
}

func verify(want ServiceSpec, c container.InspectResponse, v volume.Volume) error {
	if c.ID == "" || c.Config == nil || c.HostConfig == nil || c.State == nil || v.CreatedAt == "" {
		return errors.New("incomplete Docker resource metadata")
	}
	for k, value := range want.labels() {
		if value == "" || c.Config.Labels[k] != value || v.Labels[k] != value {
			return errors.New("Ollama ownership, operation identity, or configuration conflict")
		}
	}
	bind, err := netip.ParseAddrPort(want.BindAddress)
	if err != nil {
		return errors.New("invalid Ollama binding")
	}
	port, _ := network.ParsePort("11434/tcp")
	pb := c.HostConfig.PortBindings[port]
	if strings.TrimPrefix(c.Name, "/") != want.Name || c.Config.Image != want.Image ||
		string(c.HostConfig.NetworkMode) != want.Network || c.HostConfig.Privileged ||
		!slices.Contains(c.HostConfig.CapDrop, "ALL") || !slices.Contains(c.HostConfig.SecurityOpt, "no-new-privileges") ||
		!slices.Equal(c.Config.Entrypoint, []string{"/bin/ollama"}) || !slices.Equal(c.Config.Cmd, []string{"serve"}) ||
		len(c.HostConfig.PortBindings) != 1 || len(pb) != 1 || pb[0].HostIP != bind.Addr() || pb[0].HostPort != fmt.Sprint(bind.Port()) ||
		v.Name != want.Volume() || v.Driver != "local" || len(v.Options) != 0 {
		return errors.New("Ollama container configuration drift requires inspection")
	}
	if len(c.Mounts) != 1 || c.Mounts[0].Type != mount.TypeVolume || c.Mounts[0].Name != want.Volume() || c.Mounts[0].Destination != "/root/.ollama" || !c.Mounts[0].RW {
		return errors.New("Ollama persistent storage binding drifted")
	}
	return nil
}

// Ensure reconciles only the exact retained operation token. Configuration and
// runtime effects remain distinct from readiness of the HTTP/model endpoint.
func (d *Docker) Ensure(ctx context.Context, want ServiceSpec, id string) (*Service, error) {
	got, err := d.Observe(ctx, want)
	if err != nil && !errors.Is(err, errPartialCreate) {
		return nil, err
	}
	if got != nil {
		if id != "" && id != got.ID {
			return nil, errors.New("Ollama physical identity changed")
		}
		if !got.Running {
			// Recheck by immutable container ID just before starting.
			if _, err = d.API.ContainerStart(ctx, strings.Split(got.ID, "/")[1], client.ContainerStartOptions{}); err != nil {
				return nil, errors.New("Ollama start outcome is unknown; reapply to reconcile")
			}
		}
		return d.Observe(ctx, want)
	}
	if id != "" {
		return nil, errors.New("bound Ollama resource is unavailable; automatic recreation is forbidden")
	}
	// An interrupted initial create can leave only the named volume. Verify its
	// retained random operation token before continuing that same create.
	v, ve := d.API.VolumeInspect(ctx, want.Volume(), client.VolumeInspectOptions{})
	if ve == nil {
		for k, value := range want.labels() {
			if value == "" || v.Volume.Labels[k] != value {
				return nil, errors.New("existing Ollama storage belongs to another operation")
			}
		}
		if v.Volume.Driver != "local" || len(v.Volume.Options) != 0 {
			return nil, errors.New("unexpected Ollama volume configuration")
		}
		if _, ce := d.API.ContainerInspect(ctx, want.Name, client.ContainerInspectOptions{}); !errdefs.IsNotFound(ce) {
			return nil, errors.New("Ollama create cannot reconcile container observation")
		}
	} else if !errdefs.IsNotFound(ve) || err != nil {
		return nil, errors.New("Ollama create requires complete engine observations")
	}
	if _, err = d.API.ImageInspect(ctx, want.Image); errdefs.IsNotFound(err) {
		pull, e := d.API.ImagePull(ctx, want.Image, client.ImagePullOptions{})
		if e != nil {
			return nil, errors.New("Ollama image pull failed")
		}
		e = pull.Wait(ctx)
		pull.Close()
		if e != nil {
			return nil, errors.New("Ollama image pull incomplete")
		}
	} else if err != nil {
		return nil, errors.New("Ollama image observation failed")
	}
	if errdefs.IsNotFound(ve) {
		if _, err = d.API.VolumeCreate(ctx, client.VolumeCreateOptions{Name: want.Volume(), Driver: "local", Labels: want.labels()}); err != nil {
			return nil, errors.New("Ollama volume create outcome unknown; retain operation and reapply")
		}
	}
	// Inspect after create: VolumeCreate can return an existing named volume.
	v, err = d.API.VolumeInspect(ctx, want.Volume(), client.VolumeInspectOptions{})
	if err != nil {
		return nil, errors.New("cannot verify newly created Ollama storage")
	}
	for k, value := range want.labels() {
		if v.Volume.Labels[k] != value {
			return nil, errors.New("Ollama storage collision")
		}
	}
	bind, err := netip.ParseAddrPort(want.BindAddress)
	if err != nil {
		return nil, err
	}
	port, _ := network.ParsePort("11434/tcp")
	c, err := d.API.ContainerCreate(ctx, client.ContainerCreateOptions{Name: want.Name,
		Config: &container.Config{Image: want.Image, Labels: want.labels(), Entrypoint: []string{"/bin/ollama"}, Cmd: []string{"serve"}},
		HostConfig: &container.HostConfig{NetworkMode: container.NetworkMode(want.Network),
			Mounts:       []mount.Mount{{Type: mount.TypeVolume, Source: want.Volume(), Target: "/root/.ollama"}},
			PortBindings: network.PortMap{port: {{HostIP: bind.Addr(), HostPort: fmt.Sprint(bind.Port())}}},
			CapDrop:      []string{"ALL"}, SecurityOpt: []string{"no-new-privileges"}},
	})
	if err != nil || c.ID == "" {
		return nil, errors.New("Ollama container create outcome unknown; retain operation and reapply")
	}
	if _, err = d.API.ContainerStart(ctx, c.ID, client.ContainerStartOptions{}); err != nil {
		return nil, errors.New("Ollama start outcome unknown; retain operation and reapply")
	}
	return d.Observe(ctx, want)
}
