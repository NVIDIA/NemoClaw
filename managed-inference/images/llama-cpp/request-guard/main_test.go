// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

func testConfig() guardConfig {
	return guardConfig{
		listenHost:            "0.0.0.0",
		listenPort:            8081,
		upstreamHost:          "127.0.0.1",
		upstreamPort:          0,
		maxRequestBodyBytes:   1024,
		maxRequestHeaderBytes: 4096,
		maxOutputTokens:       32,
		requestTimeout:        10 * time.Second,
		shutdownTimeout:       5 * time.Second,
	}
}

func configForServer(t *testing.T, upstream *httptest.Server) guardConfig {
	t.Helper()
	address := strings.TrimPrefix(upstream.URL, "http://")
	host, portText, found := strings.Cut(address, ":")
	if !found {
		t.Fatal("test upstream has no port")
	}
	var port int
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse test upstream port: %v", err)
	}
	config := testConfig()
	config.upstreamHost = host
	config.upstreamPort = port
	return config
}

func guardedServer(t *testing.T, upstream http.Handler) (*httptest.Server, *atomic.Int32) {
	t.Helper()
	var calls atomic.Int32
	backend := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		upstream.ServeHTTP(writer, request)
	}))
	t.Cleanup(backend.Close)
	handler, err := newGuardHandler(configForServer(t, backend))
	if err != nil {
		t.Fatalf("create guard: %v", err)
	}
	guard := httptest.NewServer(handler)
	t.Cleanup(guard.Close)
	return guard, &calls
}

func request(t *testing.T, method, endpoint, contentType string, body io.Reader) *http.Response {
	t.Helper()
	req, err := http.NewRequest(method, endpoint, body)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("send request: %v", err)
	}
	return response
}

func responseCode(t *testing.T, response *http.Response) string {
	t.Helper()
	defer response.Body.Close()
	var payload struct {
		Error struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return payload.Error.Code
}

func TestParseConfigRequiresEveryDeclaredValue(t *testing.T) {
	valid := []string{
		"--listen-host", "0.0.0.0",
		"--listen-port", "8081",
		"--upstream-host", "127.0.0.1",
		"--upstream-port", "8082",
		"--max-request-body-bytes", "1048576",
		"--max-request-header-bytes", "32768",
		"--max-output-tokens", "4096",
		"--request-timeout-seconds", "900",
		"--shutdown-timeout-seconds", "25",
		"--", llamaServerPath,
		"--model", "/models/model.gguf",
		"--host", "127.0.0.1",
		"--port", "8082",
		"--api-key-file", llamaServerAPIKeyPath,
		"--n-predict", "4096",
		"--jinja",
		"--chat-template-kwargs", `{"reasoning_strength":"low"}`,
		"--no-ui",
		"--no-slots",
		"--no-mmproj",
		"--no-agent",
	}
	config, command, err := parseConfig(valid)
	if err != nil {
		t.Fatalf("parse valid config: %v", err)
	}
	if config.maxRequestBodyBytes != 1048576 ||
		config.maxOutputTokens != 4096 ||
		config.shutdownTimeout != 25*time.Second {
		t.Fatalf("declared bounds were not retained: %+v", config)
	}
	if len(command) < 3 || command[0] != llamaServerPath {
		t.Fatalf("unexpected command: %v", command)
	}

	for _, remove := range []string{
		"--listen-host",
		"--listen-port",
		"--upstream-host",
		"--upstream-port",
		"--max-request-body-bytes",
		"--max-request-header-bytes",
		"--max-output-tokens",
		"--request-timeout-seconds",
		"--shutdown-timeout-seconds",
	} {
		candidate := append([]string(nil), valid...)
		for index, value := range candidate {
			if value == remove {
				candidate = append(candidate[:index], candidate[index+2:]...)
				break
			}
		}
		if _, _, err := parseConfig(candidate); err == nil {
			t.Fatalf("configuration without %s was accepted", remove)
		}
	}
}

func TestParseConfigRejectsABypassableLlamaServerCommand(t *testing.T) {
	base := []string{
		"--listen-host", "0.0.0.0",
		"--listen-port", "8081",
		"--upstream-host", "127.0.0.1",
		"--upstream-port", "8082",
		"--max-request-body-bytes", "1048576",
		"--max-request-header-bytes", "32768",
		"--max-output-tokens", "4096",
		"--request-timeout-seconds", "900",
		"--shutdown-timeout-seconds", "25",
		"--", llamaServerPath,
		"--host", "127.0.0.1",
		"--port", "8082",
		"--api-key-file", llamaServerAPIKeyPath,
		"--n-predict", "4096",
		"--no-ui", "--no-slots", "--no-mmproj", "--no-agent",
	}
	for _, mutation := range []struct {
		name        string
		option      string
		replacement string
		marker      bool
	}{
		{name: "executable", replacement: "/bin/sh"},
		{name: "host", option: "--host", replacement: "0.0.0.0"},
		{name: "api key", option: "--api-key-file", replacement: "/tmp/key"},
		{name: "token bound", option: "--n-predict", replacement: "4097"},
		{name: "disabled route", option: "--no-ui", replacement: "--metrics", marker: true},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			candidate := append([]string(nil), base...)
			separator := -1
			for index, value := range candidate {
				if value == "--" {
					separator = index
					break
				}
			}
			if separator < 0 || separator+1 >= len(candidate) {
				t.Fatal("base command has no child command")
			}
			if mutation.option == "" {
				candidate[separator+1] = mutation.replacement
			} else {
				target := -1
				for index := separator + 2; index < len(candidate); index++ {
					if candidate[index] == mutation.option {
						target = index
						break
					}
				}
				if target < 0 {
					t.Fatalf("child option %s is absent", mutation.option)
				}
				if mutation.marker {
					candidate[target] = mutation.replacement
				} else {
					if target+1 >= len(candidate) {
						t.Fatalf("child option %s has no value", mutation.option)
					}
					candidate[target+1] = mutation.replacement
				}
			}
			if _, _, err := parseConfig(candidate); err == nil {
				t.Fatalf("child %s bypass was accepted", mutation.name)
			}
		})
	}
	for _, extra := range []string{"--embedding", "--model", "/models/other.gguf"} {
		candidate := append(append([]string(nil), base...), extra)
		if _, _, err := parseConfig(candidate); err == nil {
			t.Fatalf("child command with extra %s was accepted", extra)
		}
	}
}

func TestAPIKeyFileMustBeReadableRegularAndNonEmpty(t *testing.T) {
	root := t.TempDir()
	missing := filepath.Join(root, "missing")
	if err := validateAPIKeyFile(missing); err == nil {
		t.Fatal("missing API-key file was accepted")
	}
	if err := validateAPIKeyFile(root); err == nil {
		t.Fatal("API-key directory was accepted")
	}
	empty := filepath.Join(root, "empty")
	if err := os.WriteFile(empty, nil, 0600); err != nil {
		t.Fatalf("create empty API-key file: %v", err)
	}
	if err := validateAPIKeyFile(empty); err == nil {
		t.Fatal("empty API-key file was accepted")
	}
	unreadable := filepath.Join(root, "unreadable")
	if err := os.WriteFile(unreadable, []byte("opaque-test-key\n"), 0600); err != nil {
		t.Fatalf("create unreadable API-key file: %v", err)
	}
	if err := os.Chmod(unreadable, 0000); err != nil {
		t.Fatalf("remove API-key file read permissions: %v", err)
	}
	t.Run("unreadable", func(t *testing.T) {
		probe, err := os.Open(unreadable)
		if err == nil {
			_ = probe.Close()
			t.Skip("test process can read a mode-000 file")
		}
		if err := validateAPIKeyFile(unreadable); err == nil {
			t.Fatal("unreadable API-key file was accepted")
		}
	})
	valid := filepath.Join(root, "valid")
	if err := os.WriteFile(valid, []byte("opaque-test-key\n"), 0600); err != nil {
		t.Fatalf("create API-key file: %v", err)
	}
	if err := validateAPIKeyFile(valid); err != nil {
		t.Fatalf("valid API-key file was rejected: %v", err)
	}
}

func TestServerUsesTheDeclaredHeaderAndTimeBounds(t *testing.T) {
	config := testConfig()
	server := newHTTPServer(config, http.NotFoundHandler())
	if server.MaxHeaderBytes != config.maxRequestHeaderBytes {
		t.Fatalf("header limit = %d", server.MaxHeaderBytes)
	}
	for name, actual := range map[string]time.Duration{
		"read-header": server.ReadHeaderTimeout,
		"read":        server.ReadTimeout,
		"write":       server.WriteTimeout,
		"idle":        server.IdleTimeout,
	} {
		if actual != config.requestTimeout {
			t.Fatalf("%s timeout = %s", name, actual)
		}
	}
}

func TestRequestGuardChildHelper(t *testing.T) {
	if os.Getenv("NEMOCLAW_REQUEST_GUARD_CHILD_HELPER") != "1" {
		return
	}
	signal.Ignore(syscall.SIGTERM)
	_, _ = fmt.Fprintln(os.Stdout, "ready")
	select {}
}

func TestStopChildKillsAtTheDeclaredDeadline(t *testing.T) {
	child := exec.Command(os.Args[0], "-test.run=TestRequestGuardChildHelper")
	child.Env = append(os.Environ(), "NEMOCLAW_REQUEST_GUARD_CHILD_HELPER=1")
	stdout, err := child.StdoutPipe()
	if err != nil {
		t.Fatalf("create child stdout: %v", err)
	}
	if err := child.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	ready := bufio.NewScanner(stdout)
	if !ready.Scan() || ready.Text() != "ready" {
		_ = child.Process.Kill()
		t.Fatalf("child did not become ready: %v", ready.Err())
	}
	exited := make(chan *os.ProcessState, 1)
	go func() {
		_ = child.Wait()
		exited <- child.ProcessState
	}()

	started := time.Now()
	code := stopChildWithin(child, exited, syscall.SIGTERM, 50*time.Millisecond)
	if elapsed := time.Since(started); elapsed < 40*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("declared stop deadline elapsed = %s", elapsed)
	}
	if code == 0 {
		t.Fatal("force-killed child exited successfully")
	}
}

func TestGuardRejectsOversizedBodiesBeforeUpstream(t *testing.T) {
	guard, calls := guardedServer(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))

	declared := strings.NewReader(strings.Repeat("x", 1025))
	response := request(t, http.MethodPost, guard.URL+"/v1/chat/completions", "application/json", declared)
	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("declared body status = %d", response.StatusCode)
	}
	if code := responseCode(t, response); code != "request_body_too_large" {
		t.Fatalf("declared body code = %q", code)
	}

	chunkedRequest, err := http.NewRequest(
		http.MethodPost,
		guard.URL+"/v1/chat/completions",
		bufio.NewReader(strings.NewReader(strings.Repeat("y", 1025))),
	)
	if err != nil {
		t.Fatalf("create chunked request: %v", err)
	}
	chunkedRequest.ContentLength = -1
	chunkedRequest.Header.Set("Content-Type", "application/json")
	chunkedResponse, err := http.DefaultClient.Do(chunkedRequest)
	if err != nil {
		t.Fatalf("send chunked request: %v", err)
	}
	if chunkedResponse.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("chunked body status = %d", chunkedResponse.StatusCode)
	}
	if code := responseCode(t, chunkedResponse); code != "request_body_too_large" {
		t.Fatalf("chunked body code = %q", code)
	}
	if calls.Load() != 0 {
		t.Fatalf("upstream received %d oversized requests", calls.Load())
	}
}

func TestGuardRejectsEveryOutputTokenBypass(t *testing.T) {
	guard, calls := guardedServer(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	for _, body := range []string{
		`{"model":"test","max_tokens":33}`,
		`{"model":"test","max_completion_tokens":33}`,
		`{"model":"test","n_predict":33}`,
		`{"model":"test","max_tokens":-1}`,
		`{"model":"test","max_tokens":1.5}`,
		`{"model":"test","max_tokens":"32"}`,
		`{"model":"test","max_tokens":32,"max_tokens":1}`,
	} {
		response := request(
			t,
			http.MethodPost,
			guard.URL+"/v1/chat/completions",
			"application/json",
			strings.NewReader(body),
		)
		if response.StatusCode != http.StatusBadRequest {
			t.Fatalf("body %s status = %d", body, response.StatusCode)
		}
		response.Body.Close()
	}
	if calls.Load() != 0 {
		t.Fatalf("upstream received %d denied token requests", calls.Load())
	}
}

func TestGuardInjectsTheDeclaredLimitAndPreservesAuthorization(t *testing.T) {
	var seenAuthorization string
	var seenBody map[string]any
	guard, calls := guardedServer(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		seenAuthorization = request.Header.Get("Authorization")
		if err := json.NewDecoder(request.Body).Decode(&seenBody); err != nil {
			t.Errorf("decode upstream body: %v", err)
		}
		writer.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(writer, `{"ok":true}`)
	}))
	req, err := http.NewRequest(
		http.MethodPost,
		guard.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"test","messages":[]}`),
	)
	if err != nil {
		t.Fatalf("create request: %v", err)
	}
	req.Header.Set("Authorization", "Bearer opaque-test-value")
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("send request: %v", err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if calls.Load() != 1 || seenBody["max_tokens"] != float64(32) {
		t.Fatalf("upstream calls/body = %d/%v", calls.Load(), seenBody)
	}
	if seenAuthorization != "Bearer opaque-test-value" {
		t.Fatalf("authorization header changed: %q", seenAuthorization)
	}
}

func TestGuardPreservesBackendAuthenticationFailure(t *testing.T) {
	guard, calls := guardedServer(t, http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") == "" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		writer.WriteHeader(http.StatusOK)
	}))
	response := request(
		t,
		http.MethodPost,
		guard.URL+"/v1/chat/completions",
		"application/json",
		strings.NewReader(`{"model":"test","max_tokens":8}`),
	)
	response.Body.Close()
	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", response.StatusCode)
	}
	if calls.Load() != 1 {
		t.Fatalf("backend authentication calls = %d", calls.Load())
	}
}

func TestGuardSanitizesUpstreamFailures(t *testing.T) {
	upstream := httptest.NewServer(http.NotFoundHandler())
	config := configForServer(t, upstream)
	upstream.Close()
	handler, err := newGuardHandler(config)
	if err != nil {
		t.Fatalf("create guard: %v", err)
	}
	guard := httptest.NewServer(handler)
	defer guard.Close()

	response := request(t, http.MethodGet, guard.URL+"/health", "", nil)
	body, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatalf("read response: %v", err)
	}
	if response.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d", response.StatusCode)
	}
	if strings.Contains(string(body), config.upstreamHost) ||
		strings.Contains(string(body), fmt.Sprintf("%d", config.upstreamPort)) {
		t.Fatalf("upstream address leaked: %s", body)
	}
	if !strings.Contains(string(body), `"code":"upstream_unavailable"`) {
		t.Fatalf("unexpected error body: %s", body)
	}
}

func TestGuardRejectsEncodedOrMislabeledChatBodiesBeforeUpstream(t *testing.T) {
	guard, calls := guardedServer(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	encoded, err := http.NewRequest(
		http.MethodPost,
		guard.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"test","max_tokens":8}`),
	)
	if err != nil {
		t.Fatalf("create encoded request: %v", err)
	}
	encoded.Header.Set("Content-Encoding", "gzip")
	encoded.Header.Set("Content-Type", "application/json")
	encodedResponse, err := http.DefaultClient.Do(encoded)
	if err != nil {
		t.Fatalf("send encoded request: %v", err)
	}
	if encodedResponse.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("encoded status = %d", encodedResponse.StatusCode)
	}
	encodedResponse.Body.Close()

	mislabeled := request(
		t,
		http.MethodPost,
		guard.URL+"/v1/chat/completions",
		"text/plain",
		strings.NewReader(`{"model":"test","max_tokens":8}`),
	)
	if mislabeled.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("mislabeled status = %d", mislabeled.StatusCode)
	}
	mislabeled.Body.Close()
	if calls.Load() != 0 {
		t.Fatalf("upstream received %d encoded or mislabeled requests", calls.Load())
	}
}

func TestGuardStreamsAllowedResponses(t *testing.T) {
	release := make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	guard, _ := guardedServer(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		flusher, ok := writer.(http.Flusher)
		if !ok {
			t.Error("upstream response writer cannot flush")
			return
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(writer, "data: first\n\n")
		flusher.Flush()
		<-release
		_, _ = io.WriteString(writer, "data: second\n\n")
	}))
	req, err := http.NewRequest(
		http.MethodPost,
		guard.URL+"/v1/chat/completions",
		strings.NewReader(`{"model":"test","stream":true,"max_tokens":32}`),
	)
	if err != nil {
		t.Fatalf("create stream request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	client := &http.Client{Timeout: 2 * time.Second}
	response, err := client.Do(req)
	if err != nil {
		t.Fatalf("receive streamed response headers: %v", err)
	}
	defer response.Body.Close()
	reader := bufio.NewReader(response.Body)
	first := make([]byte, len("data: first\n\n"))
	if _, err := io.ReadFull(reader, first); err != nil {
		t.Fatalf("read first event before upstream completes: %v", err)
	}
	if string(first) != "data: first\n\n" {
		t.Fatalf("first event = %q", string(first))
	}
	close(release)
	rest, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read remaining stream: %v", err)
	}
	if string(rest) != "data: second\n\n" {
		t.Fatalf("remaining stream = %q", string(rest))
	}
}

func TestGuardPropagatesCancellation(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseBackend := func() { releaseOnce.Do(func() { close(release) }) }
	backend := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		_ = request.Body.Close()
		close(started)
		select {
		case <-request.Context().Done():
			close(cancelled)
		case <-release:
		}
	}))
	defer func() {
		releaseBackend()
		backend.CloseClientConnections()
		backend.Close()
	}()
	handler, err := newGuardHandler(configForServer(t, backend))
	if err != nil {
		t.Fatalf("create guard: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(
		ctx,
		http.MethodPost,
		"http://guard.test/v1/chat/completions",
		strings.NewReader(`{"model":"test","max_tokens":8}`),
	)
	if err != nil {
		t.Fatalf("create guard request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	result := make(chan struct{})
	go func() {
		handler.ServeHTTP(httptest.NewRecorder(), req)
		close(result)
	}()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request did not start")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream request was not cancelled")
	}
	select {
	case <-result:
	case <-time.After(2 * time.Second):
		t.Fatal("guard handler did not return after cancellation")
	}
}

func TestGuardBlocksUnsupportedServerSurfaces(t *testing.T) {
	guard, calls := guardedServer(t, http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	for _, target := range []string{
		"/",
		"/slots",
		"/v1/completions",
		"/v1/responses",
		"/v1/embeddings",
		"/v1/chat/completions?debug=true",
	} {
		response := request(t, http.MethodPost, guard.URL+target, "application/json", bytes.NewReader([]byte(`{}`)))
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("target %s status = %d", target, response.StatusCode)
		}
		response.Body.Close()
	}
	for _, probe := range []struct {
		method string
		target string
	}{
		{method: http.MethodGet, target: "/v1/chat/completions"},
		{method: http.MethodPost, target: "/health"},
		{method: http.MethodPost, target: "/v1/models"},
		{method: http.MethodDelete, target: "/props"},
	} {
		response := request(t, probe.method, guard.URL+probe.target, "", nil)
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("%s %s status = %d", probe.method, probe.target, response.StatusCode)
		}
		response.Body.Close()
	}
	if calls.Load() != 0 {
		t.Fatalf("upstream received %d unsupported requests", calls.Load())
	}
}
