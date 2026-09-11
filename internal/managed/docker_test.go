// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package managed

import (
	"context"
	"encoding/json/v2"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/NVIDIA/NemoClaw/internal/config"
	"github.com/NVIDIA/NemoClaw/internal/spark"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	"github.com/moby/moby/api/types/volume"
	"github.com/moby/moby/client"
)

type runtimeFixture struct {
	Spec                    Spec
	Docker                  *Docker
	Container               *container.InspectResponse
	Volume                  *volume.Volume
	Network                 network.Inspect
	Unavailable             string
	Code                    int
	Writes, Starts, Removes int
}

func newRuntimeFixture(t *testing.T) *runtimeFixture {
	t.Helper()
	m := spark.ModelManifest()
	s := Spec{Kind: ServiceKind, Name: "nc-68d203b0c7e6083f-inference", Owner: "302ff5e1-088d-42ce-959f-4ff4c3570c13", Generation: strings.Repeat("a", 32), Gateway: config.Gateway{Management: "managed", Endpoint: "http://127.0.0.1:17681", Engine: "unix:///var/run/docker.sock", Image: config.DefaultGatewayImage, NetworkCIDR: "172.30.110.0/24"}, Service: &spark.Service{Backend: spark.Backend, Image: "fixture@sha256:" + strings.Repeat("b", 64), Model: spark.Model{Repository: m.Repository, Revision: m.Revision}}}
	s.Service.Defaults()
	c, h := s.Container("unused")
	// Docker returns an empty object for absent port bindings and supplies IPC
	// defaults. Comparisons must accept those representations without hiding drift.
	h.IpcMode = "private"
	f := &runtimeFixture{Spec: s, Container: &container.InspectResponse{ID: "container-id", Image: "image-id", Name: "/" + s.Name, Config: c, HostConfig: h, State: &container.State{Running: true}, Mounts: []container.MountPoint{{Type: mount.TypeVolume, Name: s.Volume(), Destination: "/data", RW: true}}}, Volume: &volume.Volume{Name: s.Volume(), Driver: "local", CreatedAt: "created-once", Mountpoint: "/var/lib/docker/volumes/" + s.Volume() + "/_data", Labels: s.labels()}, Network: network.Inspect{ID: "network-id", Name: s.Network(), Driver: "bridge", Labels: map[string]string{OwnerLabel: s.Owner}, IPAM: network.IPAM{Driver: "default", Config: []network.IPAMConfig{{Subnet: netip.MustParsePrefix(s.Gateway.NetworkCIDR), Gateway: netip.MustParseAddr(s.Gateway.Bridge())}}}}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, "/v1.53")
		if r.Method != "GET" && r.Method != "HEAD" {
			f.Writes++
		}
		if f.Unavailable != "" && strings.Contains(p, f.Unavailable) {
			w.WriteHeader(f.Code)
			fmt.Fprint(w, `{"message":"fixture failure"}`)
			return
		}
		switch {
		case p == "/info":
			fmt.Fprint(w, `{"ID":"engine"}`)
		case strings.HasPrefix(p, "/images/"):
			fmt.Fprint(w, `{"Id":"image-id","Architecture":"arm64","Os":"linux","Config":{"Env":[]}}`)
		case strings.HasPrefix(p, "/networks/"):
			json.MarshalWrite(w, f.Network)
		case strings.HasPrefix(p, "/volumes/"):
			if f.Volume == nil {
				w.WriteHeader(404)
				fmt.Fprint(w, `{"message":"absent"}`)
			} else {
				json.MarshalWrite(w, f.Volume)
			}
		case strings.HasSuffix(p, "/start"):
			f.Starts++
			f.Container.State.Running = true
			w.WriteHeader(204)
		case strings.HasSuffix(p, "/stop"):
			f.Container.State.Running = false
			w.WriteHeader(204)
		case strings.HasPrefix(p, "/containers/") && r.Method == "DELETE":
			f.Removes++
			f.Container = nil
			w.WriteHeader(204)
		case strings.HasPrefix(p, "/containers/"):
			if f.Container == nil {
				w.WriteHeader(404)
				fmt.Fprint(w, `{"message":"absent"}`)
			} else {
				json.MarshalWrite(w, f.Container)
			}
		default:
			t.Errorf("unexpected API call %s %s", r.Method, p)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(server.Close)
	api, err := client.New(client.WithHost(server.URL), client.WithAPIVersion("1.53"))
	if err != nil {
		t.Fatal(err)
	}
	f.Docker = &Docker{API: api, CheckStart: func(context.Context, Spec, *Observation) error { return nil }}
	t.Cleanup(func() { f.Docker.Close() })
	return f
}

func TestRefreshAndExplicitRestartPreserveRuntimeAndStorageIdentity(t *testing.T) {
	f := newRuntimeFixture(t)
	o, err := f.Docker.Observe(t.Context(), f.Spec, "")
	if err != nil {
		t.Fatal(err)
	}
	if o.ID != "engine/container-id/created-once/network-id" {
		t.Fatal("incomplete identity", o.ID)
	}
	if _, err = f.Docker.Ensure(t.Context(), f.Spec, o.ID); err != nil || f.Writes != 0 {
		t.Fatal("no-op mutated runtime", err)
	}
	f.Container.State.Running = false
	stopped, err := f.Docker.Observe(t.Context(), f.Spec, o.ID)
	if err != nil || stopped.Running || stopped.ID != o.ID {
		t.Fatal("stopped runtime became absent", err)
	}
	if f.Writes != 0 {
		t.Fatal("refresh restarted the service")
	}
	restarted, err := f.Docker.Ensure(t.Context(), f.Spec, o.ID)
	if err != nil || restarted.ID != o.ID || !restarted.Running || f.Starts != 1 {
		t.Fatal("restart lost identity", err)
	}
}

func TestFailedObservationAndDriftNeverRecreateOrLoseStorage(t *testing.T) {
	for _, failure := range []string{"authentication", "transport", "partial", "owner", "generation", "memory", "restart policy", "mount", "container identity", "storage identity", "container absence", "storage absence"} {
		t.Run(failure, func(t *testing.T) {
			f := newRuntimeFixture(t)
			o, err := f.Docker.Observe(t.Context(), f.Spec, "")
			if err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "authentication":
				f.Unavailable = "containers"
				f.Code = 403
			case "transport":
				f.Unavailable = "volumes"
				f.Code = 503
			case "partial":
				f.Container.State = nil
			case "owner":
				f.Container.Config.Labels[OwnerLabel] = "foreign"
			case "generation":
				f.Volume.Labels[GenerationLabel] = "other"
			case "memory":
				f.Container.HostConfig.Memory = 0
			case "restart policy":
				f.Container.HostConfig.RestartPolicy.Name = "always"
			case "mount":
				f.Container.Mounts = nil
			case "container identity":
				f.Container.ID = "replacement"
			case "storage identity":
				f.Volume.CreatedAt = "recreated"
			case "container absence":
				f.Container = nil
			case "storage absence":
				f.Volume = nil
			}
			if _, err = f.Docker.Observe(t.Context(), f.Spec, o.ID); err == nil {
				t.Fatal("failed observation became successful")
			}
			if _, err = f.Docker.Ensure(t.Context(), f.Spec, o.ID); err == nil {
				t.Fatal("unsafe create permitted")
			}
			if f.Writes != 0 {
				t.Fatal("observation failure caused runtime mutation")
			}
		})
	}
}

func TestConfirmedInitialAbsenceIsDistinctFromFailedObservation(t *testing.T) {
	f := newRuntimeFixture(t)
	f.Container = nil
	f.Volume = nil
	if o, err := f.Docker.Observe(t.Context(), f.Spec, ""); err != nil || o != nil {
		t.Fatal("confirmed initial absence not recognized", err)
	}
	f.Unavailable = "containers"
	f.Code = 503
	if _, err := f.Docker.Observe(t.Context(), f.Spec, ""); err == nil {
		t.Fatal("failed inventory became absence")
	}
}

func TestCapacityRejectionLeavesStoppedRuntimeAndDataUntouched(t *testing.T) {
	f := newRuntimeFixture(t)
	f.Container.State.Running = false
	f.Docker.CheckStart = func(context.Context, Spec, *Observation) error { return errors.New("insufficient headroom") }
	o, err := f.Docker.Observe(t.Context(), f.Spec, "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Docker.Ensure(t.Context(), f.Spec, o.ID); err == nil || f.Writes != 0 || f.Volume == nil {
		t.Fatal("capacity rejection changed resources")
	}
}

func TestPlannedRuntimeReplacementRetainsIndependentStorage(t *testing.T) {
	f := newRuntimeFixture(t)
	s := Storage{Name: f.Spec.Volume(), Owner: f.Spec.Owner, Generation: f.Spec.Generation}
	volumeID, err := f.Docker.Storage(t.Context(), s, "", false)
	if err != nil {
		t.Fatal(err)
	}
	o, err := f.Docker.Observe(t.Context(), f.Spec, "")
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Docker.ReplaceContainer(t.Context(), f.Spec, o.ID); err != nil {
		t.Fatal(err)
	}
	if f.Removes != 1 || f.Container != nil || f.Volume == nil {
		t.Fatal("replacement removed persistent storage")
	}
	if id, err := f.Docker.Storage(t.Context(), s, volumeID, false); err != nil || id != volumeID {
		t.Fatal("storage identity changed", err)
	}
}
