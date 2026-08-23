// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	llamaServerPath       = "/usr/local/bin/llama-server"
	llamaServerAPIKeyPath = "/run/secrets/llama-cpp-api-key"
	maximumBodyBytes      = 64 * 1024 * 1024
	maximumHeaderBytes    = 1024 * 1024
	maximumOutputTokens   = 1024 * 1024
	maximumTimeoutSeconds = 24 * 60 * 60
)

type guardConfig struct {
	listenHost            string
	listenPort            int
	upstreamHost          string
	upstreamPort          int
	maxRequestBodyBytes   int64
	maxRequestHeaderBytes int
	maxOutputTokens       int64
	requestTimeout        time.Duration
	shutdownTimeout       time.Duration
}

type guardError struct {
	status  int
	code    string
	message string
}

func (e *guardError) Error() string { return e.message }

func positiveBounded(value int64, maximum int64, name string) error {
	if value < 1 || value > maximum {
		return fmt.Errorf("%s must be between 1 and %d", name, maximum)
	}
	return nil
}

func requireExactCommandOption(command []string, option, expected string) error {
	count := 0
	for index, value := range command {
		if value == option {
			count++
			if index+1 >= len(command) || command[index+1] != expected {
				return fmt.Errorf("llama-server %s must be %s", option, expected)
			}
		}
		if strings.HasPrefix(value, option+"=") {
			return fmt.Errorf("llama-server %s must use a separate exact value", option)
		}
	}
	if count != 1 {
		return fmt.Errorf("llama-server command must declare %s exactly once", option)
	}
	return nil
}

func requireExactCommandMarker(command []string, option string) error {
	count := 0
	for _, value := range command {
		if value == option {
			count++
		}
		if strings.HasPrefix(value, option+"=") {
			return fmt.Errorf("llama-server %s does not accept a value", option)
		}
	}
	if count != 1 {
		return fmt.Errorf("llama-server command must declare %s exactly once", option)
	}
	return nil
}

func validateSupportedCommandOptions(command []string) error {
	allowed := map[string]bool{
		"--alias":                true,
		"--api-key-file":         true,
		"--batch-size":           true,
		"--cache-type-k":         true,
		"--cache-type-v":         true,
		"--chat-template-kwargs": true,
		"--ctx-size":             true,
		"--flash-attn":           true,
		"--gpu-layers":           true,
		"--host":                 true,
		"--jinja":                false,
		"--metrics":              false,
		"--model":                true,
		"--no-agent":             false,
		"--no-mmproj":            false,
		"--no-slots":             false,
		"--no-ui":                false,
		"--n-predict":            true,
		"--parallel":             true,
		"--port":                 true,
		"--sleep-idle-seconds":   true,
		"--timeout":              true,
		"--ubatch-size":          true,
	}
	seen := make(map[string]bool, len(allowed))
	for index := 0; index < len(command); index++ {
		option := command[index]
		takesValue, supported := allowed[option]
		if !supported {
			return fmt.Errorf("llama-server option %s is not supported by the request guard", option)
		}
		if seen[option] {
			return fmt.Errorf("llama-server command must declare %s at most once", option)
		}
		seen[option] = true
		if !takesValue {
			continue
		}
		index++
		if index >= len(command) || strings.HasPrefix(command[index], "--") {
			return fmt.Errorf("llama-server %s requires one value", option)
		}
	}
	if !seen["--model"] {
		return errors.New("llama-server command must declare --model exactly once")
	}
	return nil
}

func validateLlamaServerCommand(command []string, config guardConfig) error {
	if len(command) == 0 || command[0] != llamaServerPath {
		return fmt.Errorf("request guard command must start with %s", llamaServerPath)
	}
	if err := validateSupportedCommandOptions(command[1:]); err != nil {
		return err
	}
	for _, required := range []struct {
		option string
		value  string
	}{
		{option: "--host", value: config.upstreamHost},
		{option: "--port", value: strconv.Itoa(config.upstreamPort)},
		{option: "--api-key-file", value: llamaServerAPIKeyPath},
		{option: "--n-predict", value: strconv.FormatInt(config.maxOutputTokens, 10)},
	} {
		if err := requireExactCommandOption(command[1:], required.option, required.value); err != nil {
			return err
		}
	}
	for _, marker := range []string{"--no-agent", "--no-mmproj", "--no-slots", "--no-ui"} {
		if err := requireExactCommandMarker(command[1:], marker); err != nil {
			return err
		}
	}
	return nil
}

func parseConfig(args []string) (guardConfig, []string, error) {
	var config guardConfig
	var timeoutSeconds int64
	var shutdownTimeoutSeconds int64
	separator := -1
	for index, arg := range args {
		if arg == "--" {
			separator = index
			break
		}
	}
	if separator < 0 {
		return config, nil, errors.New("request guard requires '--' before the llama-server command")
	}

	flags := flag.NewFlagSet("nemoclaw-llama-cpp-request-guard", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.StringVar(&config.listenHost, "listen-host", "", "guard listen host")
	flags.IntVar(&config.listenPort, "listen-port", 0, "guard listen port")
	flags.StringVar(&config.upstreamHost, "upstream-host", "", "llama-server host")
	flags.IntVar(&config.upstreamPort, "upstream-port", 0, "llama-server port")
	flags.Int64Var(
		&config.maxRequestBodyBytes,
		"max-request-body-bytes",
		0,
		"maximum request body bytes",
	)
	flags.IntVar(
		&config.maxRequestHeaderBytes,
		"max-request-header-bytes",
		0,
		"maximum request header bytes",
	)
	flags.Int64Var(
		&config.maxOutputTokens,
		"max-output-tokens",
		0,
		"maximum generated tokens",
	)
	flags.Int64Var(
		&timeoutSeconds,
		"request-timeout-seconds",
		0,
		"request timeout seconds",
	)
	flags.Int64Var(
		&shutdownTimeoutSeconds,
		"shutdown-timeout-seconds",
		0,
		"graceful shutdown timeout seconds",
	)
	if err := flags.Parse(args[:separator]); err != nil {
		return config, nil, fmt.Errorf("invalid request guard arguments: %w", err)
	}
	if flags.NArg() != 0 {
		return config, nil, errors.New("request guard received an argument before '--'")
	}
	if config.listenHost != "0.0.0.0" {
		return config, nil, errors.New("request guard listen host must be 0.0.0.0")
	}
	if config.upstreamHost != "127.0.0.1" {
		return config, nil, errors.New("request guard upstream host must be 127.0.0.1")
	}
	if err := positiveBounded(int64(config.listenPort), 65535, "request guard listen port"); err != nil {
		return config, nil, err
	}
	if err := positiveBounded(int64(config.upstreamPort), 65535, "request guard upstream port"); err != nil {
		return config, nil, err
	}
	if config.listenPort == config.upstreamPort {
		return config, nil, errors.New("request guard listen and upstream ports must differ")
	}
	if err := positiveBounded(
		config.maxRequestBodyBytes,
		maximumBodyBytes,
		"maximum request body bytes",
	); err != nil {
		return config, nil, err
	}
	if err := positiveBounded(
		int64(config.maxRequestHeaderBytes),
		maximumHeaderBytes,
		"maximum request header bytes",
	); err != nil {
		return config, nil, err
	}
	if err := positiveBounded(
		config.maxOutputTokens,
		maximumOutputTokens,
		"maximum output tokens",
	); err != nil {
		return config, nil, err
	}
	if err := positiveBounded(timeoutSeconds, maximumTimeoutSeconds, "request timeout seconds"); err != nil {
		return config, nil, err
	}
	if err := positiveBounded(
		shutdownTimeoutSeconds,
		maximumTimeoutSeconds,
		"shutdown timeout seconds",
	); err != nil {
		return config, nil, err
	}
	config.requestTimeout = time.Duration(timeoutSeconds) * time.Second
	config.shutdownTimeout = time.Duration(shutdownTimeoutSeconds) * time.Second

	command := args[separator+1:]
	if err := validateLlamaServerCommand(command, config); err != nil {
		return config, nil, err
	}
	return config, command, nil
}

func writeGuardError(writer http.ResponseWriter, failure *guardError) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	writer.Header().Set("X-Content-Type-Options", "nosniff")
	writer.WriteHeader(failure.status)
	_ = json.NewEncoder(writer).Encode(map[string]any{
		"error": map[string]string{
			"code":    failure.code,
			"message": failure.message,
			"type":    "invalid_request_error",
		},
	})
}

func boundedBody(request *http.Request, maximum int64) ([]byte, *guardError) {
	if request.ContentLength > maximum {
		return nil, &guardError{
			status:  http.StatusRequestEntityTooLarge,
			code:    "request_body_too_large",
			message: "Request body exceeds the declared limit.",
		}
	}
	encoding := strings.TrimSpace(strings.ToLower(request.Header.Get("Content-Encoding")))
	if encoding != "" && encoding != "identity" {
		return nil, &guardError{
			status:  http.StatusUnsupportedMediaType,
			code:    "content_encoding_unsupported",
			message: "Compressed request bodies are not supported.",
		}
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maximum+1))
	if err != nil {
		return nil, &guardError{
			status:  http.StatusBadRequest,
			code:    "request_body_unreadable",
			message: "Request body could not be read.",
		}
	}
	if int64(len(body)) > maximum {
		return nil, &guardError{
			status:  http.StatusRequestEntityTooLarge,
			code:    "request_body_too_large",
			message: "Request body exceeds the declared limit.",
		}
	}
	return body, nil
}

func decodeTopLevelObject(body []byte) (map[string]json.RawMessage, *guardError) {
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, &guardError{
			status:  http.StatusBadRequest,
			code:    "invalid_json",
			message: "Chat Completions request must be one JSON object.",
		}
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, keyErr := decoder.Token()
		key, ok := keyToken.(string)
		if keyErr != nil || !ok {
			return nil, &guardError{
				status:  http.StatusBadRequest,
				code:    "invalid_json",
				message: "Chat Completions request must be one JSON object.",
			}
		}
		if _, exists := fields[key]; exists {
			return nil, &guardError{
				status:  http.StatusBadRequest,
				code:    "duplicate_json_field",
				message: "Chat Completions request contains a duplicate field.",
			}
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, &guardError{
				status:  http.StatusBadRequest,
				code:    "invalid_json",
				message: "Chat Completions request must be one JSON object.",
			}
		}
		fields[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, &guardError{
			status:  http.StatusBadRequest,
			code:    "invalid_json",
			message: "Chat Completions request must be one JSON object.",
		}
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, &guardError{
			status:  http.StatusBadRequest,
			code:    "invalid_json",
			message: "Chat Completions request must contain one JSON value.",
		}
	}
	return fields, nil
}

func parsePositiveInteger(raw json.RawMessage) (int64, bool) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return 0, false
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	parsed, err := strconv.ParseInt(number.String(), 10, 64)
	return parsed, err == nil && parsed > 0
}

func guardChatBody(body []byte, maximum int64) ([]byte, *guardError) {
	fields, failure := decodeTopLevelObject(body)
	if failure != nil {
		return nil, failure
	}
	boundedFieldPresent := false
	for _, name := range []string{"max_tokens", "max_completion_tokens", "n_predict"} {
		raw, present := fields[name]
		if !present {
			continue
		}
		boundedFieldPresent = true
		value, valid := parsePositiveInteger(raw)
		if !valid {
			return nil, &guardError{
				status:  http.StatusBadRequest,
				code:    "output_token_limit_invalid",
				message: "Output token limit must be a positive integer.",
			}
		}
		if value > maximum {
			return nil, &guardError{
				status:  http.StatusBadRequest,
				code:    "output_token_limit_exceeded",
				message: "Output token limit exceeds the declared limit.",
			}
		}
	}
	if boundedFieldPresent {
		return body, nil
	}
	fields["max_tokens"] = json.RawMessage(strconv.FormatInt(maximum, 10))
	guarded, err := json.Marshal(fields)
	if err != nil {
		return nil, &guardError{
			status:  http.StatusBadRequest,
			code:    "invalid_json",
			message: "Chat Completions request could not be normalized.",
		}
	}
	return guarded, nil
}

func routeAllowed(request *http.Request) bool {
	if request.URL.RawQuery != "" {
		return false
	}
	switch request.URL.Path {
	case "/v1/chat/completions":
		return request.Method == http.MethodPost
	case "/v1/models", "/health", "/props", "/metrics":
		return request.Method == http.MethodGet
	default:
		return false
	}
}

func newGuardHandler(config guardConfig) (http.Handler, error) {
	upstream, err := url.Parse(
		fmt.Sprintf("http://%s:%d", config.upstreamHost, config.upstreamPort),
	)
	if err != nil {
		return nil, errors.New("request guard upstream URL is invalid")
	}
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	baseDirector := proxy.Director
	proxy.Director = func(request *http.Request) {
		baseDirector(request)
		request.Host = upstream.Host
		request.Header.Del("Forwarded")
		request.Header.Del("X-Forwarded-Host")
		request.Header.Del("X-Forwarded-Proto")
		request.Header["X-Forwarded-For"] = nil
	}
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(writer http.ResponseWriter, _ *http.Request, _ error) {
		writeGuardError(writer, &guardError{
			status:  http.StatusBadGateway,
			code:    "upstream_unavailable",
			message: "The managed inference server is unavailable.",
		})
	}

	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if !routeAllowed(request) {
			writeGuardError(writer, &guardError{
				status:  http.StatusNotFound,
				code:    "route_not_available",
				message: "The requested server route is not available.",
			})
			return
		}
		body, failure := boundedBody(request, config.maxRequestBodyBytes)
		if failure != nil {
			writeGuardError(writer, failure)
			return
		}
		if request.URL.Path == "/v1/chat/completions" {
			contentType := strings.ToLower(strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0]))
			if contentType != "application/json" {
				writeGuardError(writer, &guardError{
					status:  http.StatusUnsupportedMediaType,
					code:    "content_type_unsupported",
					message: "Chat Completions request must use application/json.",
				})
				return
			}
			body, failure = guardChatBody(body, config.maxOutputTokens)
			if failure != nil {
				writeGuardError(writer, failure)
				return
			}
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		request.ContentLength = int64(len(body))
		request.TransferEncoding = nil
		request.Header.Set("Content-Length", strconv.Itoa(len(body)))
		proxy.ServeHTTP(writer, request)
	}), nil
}

func childExitCode(state *os.ProcessState) int {
	if state == nil {
		return 1
	}
	return state.ExitCode()
}

func waitForChildUntil(
	child *exec.Cmd,
	childExited <-chan *os.ProcessState,
	deadline time.Time,
) int {
	remaining := time.Until(deadline)
	if remaining > 0 {
		timer := time.NewTimer(remaining)
		defer timer.Stop()
		select {
		case state := <-childExited:
			return childExitCode(state)
		case <-timer.C:
		}
	}
	_ = child.Process.Kill()
	return childExitCode(<-childExited)
}

func stopChildWithin(
	child *exec.Cmd,
	childExited <-chan *os.ProcessState,
	received os.Signal,
	timeout time.Duration,
) int {
	deadline := time.Now().Add(timeout)
	_ = child.Process.Signal(received)
	return waitForChildUntil(child, childExited, deadline)
}

func newHTTPServer(config guardConfig, handler http.Handler) *http.Server {
	return &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: config.requestTimeout,
		ReadTimeout:       config.requestTimeout,
		WriteTimeout:      config.requestTimeout,
		IdleTimeout:       config.requestTimeout,
		MaxHeaderBytes:    config.maxRequestHeaderBytes,
	}
}

func validateAPIKeyFile(path string) error {
	file, err := os.Open(path)
	if err != nil {
		return errors.New("request guard API-key file is unavailable")
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("request guard API-key file is not a regular file")
	}
	var firstByte [1]byte
	if count, err := file.Read(firstByte[:]); count != 1 || err != nil {
		return errors.New("request guard API-key file is empty or unreadable")
	}
	return nil
}

func run(config guardConfig, command []string) int {
	if err := validateAPIKeyFile(llamaServerAPIKeyPath); err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	listener, err := net.Listen("tcp", net.JoinHostPort(config.listenHost, strconv.Itoa(config.listenPort)))
	if err != nil {
		fmt.Fprintln(os.Stderr, "request guard could not bind its declared listener")
		return 1
	}
	defer listener.Close()

	handler, err := newGuardHandler(config)
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		return 1
	}
	child := exec.Command(command[0], command[1:]...)
	child.Stdin = os.Stdin
	child.Stdout = os.Stdout
	child.Stderr = os.Stderr
	if err := child.Start(); err != nil {
		fmt.Fprintln(os.Stderr, "request guard could not start llama-server")
		return 1
	}

	server := newHTTPServer(config, handler)
	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.Serve(listener)
	}()
	childExited := make(chan *os.ProcessState, 1)
	go func() {
		_ = child.Wait()
		childExited <- child.ProcessState
	}()
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signals)

	select {
	case state := <-childExited:
		_ = server.Close()
		return childExitCode(state)
	case serverErr := <-serverErrors:
		if !errors.Is(serverErr, http.ErrServerClosed) {
			fmt.Fprintln(os.Stderr, "request guard listener stopped")
		}
		return stopChildWithin(child, childExited, syscall.SIGTERM, config.shutdownTimeout)
	case received := <-signals:
		deadline := time.Now().Add(config.shutdownTimeout)
		_ = child.Process.Signal(received)
		shutdownContext, cancel := context.WithDeadline(
			context.Background(),
			deadline,
		)
		_ = server.Shutdown(shutdownContext)
		cancel()
		return waitForChildUntil(child, childExited, deadline)
	}
}

func main() {
	config, command, err := parseConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err.Error())
		os.Exit(2)
	}
	os.Exit(run(config, command))
}
