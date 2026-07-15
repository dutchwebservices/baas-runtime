"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/index.ts
var index_exports = {};
__export(index_exports, {
  BaaSClient: () => BaaSClient,
  BaaSError: () => BaaSError,
  BaaSRuntime: () => BaaSRuntime,
  VERSION: () => VERSION,
  createBaasClient: () => createBaasClient,
  createBaasRuntime: () => createBaasRuntime
});
module.exports = __toCommonJS(index_exports);

// src/client.ts
var BaaSError = class extends Error {
  status;
  detail;
  requestId;
  constructor(message, options) {
    super(message);
    this.name = "BaaSError";
    this.status = options.status;
    this.detail = options.detail;
    this.requestId = options.requestId;
  }
};
function processEnv(name) {
  const candidate = globalThis;
  return candidate.process?.env?.[name];
}
function normalizedUrl(value) {
  const raw = value?.trim().replace(/\/+$/, "");
  return raw || void 0;
}
function resolveStorage(options) {
  if (!options.persistSession) return void 0;
  if (options.storage) return options.storage;
  try {
    const candidate = globalThis;
    return candidate.localStorage;
  } catch {
    return void 0;
  }
}
function encodePath(value) {
  return value.split("/").filter((part) => part.length > 0).map((part) => encodeURIComponent(part)).join("/");
}
function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== void 0 && value !== "") params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : "";
}
function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
async function errorFromResponse(response) {
  const requestId = response.headers.get("x-request-id");
  let detail;
  let message = `Request failed with ${response.status}`;
  try {
    detail = await response.clone().json();
    if (typeof detail === "object" && detail && "detail" in detail) {
      const candidate = detail.detail;
      message = typeof candidate === "string" ? candidate : message;
    }
  } catch {
    try {
      const text = (await response.text()).trim();
      if (text) message = text;
    } catch {
    }
  }
  return new BaaSError(message, { status: response.status, detail, requestId });
}
var BaaSClient = class {
  url;
  auth;
  entities;
  storage;
  events;
  functions;
  health;
  fetchImpl;
  tokenSource;
  storageAdapter;
  storageKey;
  defaultHeaders;
  accessToken;
  constructor(options = {}) {
    const url = normalizedUrl(
      options.url ?? processEnv("BAAS_APP_URL") ?? processEnv("BAAS_URL") ?? processEnv("VITE_BAAS_URL") ?? processEnv("NEXT_PUBLIC_BAAS_URL")
    );
    if (!url) throw new Error("A generated runtime URL is required. Pass url or set BAAS_URL.");
    this.url = url;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.tokenSource = options.accessToken;
    this.storageAdapter = resolveStorage(options);
    this.storageKey = options.storageKey ?? `baas.session.${this.url}`;
    this.defaultHeaders = options.headers ?? {};
    if (typeof options.accessToken === "string") this.accessToken = options.accessToken;
    this.auth = {
      signIn: (input) => this.signIn(input),
      signOut: () => this.signOut(),
      restoreSession: () => this.restoreSession(),
      setAccessToken: (token) => this.setAccessToken(token),
      getAccessToken: () => this.getAccessToken(),
      me: () => this.getJson("/api/auth/me"),
      users: {
        list: () => this.getJson("/api/auth/users"),
        create: (input) => this.postJson("/api/auth/users", input),
        updateRoles: (userId, roles) => this.patchJson(`/api/auth/users/${encodeURIComponent(userId)}/roles`, { roles }),
        remove: (userId) => this.deleteJson(`/api/auth/users/${encodeURIComponent(userId)}`)
      },
      machineToken: (input) => this.machineToken(input)
    };
    this.entities = { collection: (name) => this.collection(name) };
    this.storage = {
      list: (options2) => this.listStorage(options2),
      upload: (key, body, options2) => this.uploadStorage(key, body, options2),
      download: (key, options2) => this.request(`/api/storage/objects/${encodePath(key)}`, { signal: options2?.signal }),
      remove: (key) => this.deleteJson(`/api/storage/objects/${encodePath(key)}`)
    };
    this.events = {
      list: (options2) => this.listEvents(options2),
      subscribe: (options2) => this.subscribeEvents(options2),
      webhooks: {
        list: () => this.getJson("/api/events/webhooks"),
        create: (input) => this.postJson("/api/events/webhooks", {
          url: input.url,
          event_types: input.eventTypes ?? [],
          entities: input.entities ?? [],
          event_name_overrides: input.eventNameOverrides ?? {},
          description: input.description,
          enabled: input.enabled ?? true,
          signing_secret: input.signingSecret
        }),
        remove: (webhookId) => this.deleteJson(`/api/events/webhooks/${encodeURIComponent(webhookId)}`),
        retry: (webhookId) => this.postJson(`/api/events/webhooks/${encodeURIComponent(webhookId)}/retry`, {})
      }
    };
    this.functions = {
      invoke: (route, invokeOptions) => this.invokeFunction(route, invokeOptions),
      cron: {
        list: () => this.getJson("/api/functions/cron"),
        run: (functionId, triggerId, payload) => this.postJson(
          `/api/functions/${encodeURIComponent(functionId)}/cron/${encodeURIComponent(triggerId)}/run`,
          payload === void 0 ? {} : { payload }
        )
      }
    };
    this.health = {
      check: () => this.getJson("/health", { auth: false }),
      openapi: () => this.getJson("/openapi.json", { auth: false })
    };
  }
  async request(path, options = {}) {
    if (!this.fetchImpl) throw new Error("fetch is not available in this environment");
    const headers = new Headers(this.defaultHeaders);
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    if (options.auth !== false) {
      const token = await this.getAccessToken();
      if (token && !headers.has("authorization")) headers.set("authorization", `Bearer ${token}`);
    }
    headers.set("x-baas-sdk", "@dutchwebservices/baas-runtime");
    const response = await this.fetchImpl(this.resolve(path), {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      signal: options.signal
    });
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }
  async getAccessToken() {
    if (this.accessToken) return this.accessToken;
    if (typeof this.tokenSource === "function") return this.tokenSource();
    if (typeof this.tokenSource === "string") return this.tokenSource;
    return this.restoreSession();
  }
  async signIn(input) {
    const session = await this.postJson("/api/auth/login", input, { auth: false });
    this.setAccessToken(session.access_token);
    return session;
  }
  signOut() {
    this.accessToken = void 0;
    this.storageAdapter?.removeItem(this.storageKey);
  }
  restoreSession() {
    try {
      const token = this.storageAdapter?.getItem(this.storageKey) ?? void 0;
      if (token) this.accessToken = token;
      return token;
    } catch {
      return void 0;
    }
  }
  setAccessToken(token) {
    this.accessToken = token?.trim() || void 0;
    try {
      if (this.accessToken) this.storageAdapter?.setItem(this.storageKey, this.accessToken);
      else this.storageAdapter?.removeItem(this.storageKey);
    } catch {
    }
  }
  async machineToken(input) {
    const headers = new Headers({
      Authorization: `Basic ${toBase64(`${input.clientId}:${input.clientSecret}`)}`,
      "Content-Type": "application/json"
    });
    const response = await this.request("/api/auth/m2m/token", {
      method: "POST",
      headers,
      body: JSON.stringify({ grant_type: "client_credentials", scope: input.scope }),
      auth: false
    });
    return response.json();
  }
  collection(name) {
    const entity = encodeURIComponent(name.trim());
    if (!entity) throw new Error("An entity name is required");
    return {
      list: (options = {}) => this.getJson(
        `/api/entity/${entity}${queryString({ limit: options.limit, offset: options.offset })}`
      ),
      get: (id) => this.getJson(`/api/entity/${entity}/${encodeURIComponent(id)}`),
      create: (data) => this.postJson(`/api/entity/${entity}`, { data }),
      update: (id, data) => this.patchJson(`/api/entity/${entity}/${encodeURIComponent(id)}`, { data }),
      remove: (id) => this.deleteJson(`/api/entity/${entity}/${encodeURIComponent(id)}`)
    };
  }
  async listStorage(options = {}) {
    return this.getJson(
      `/api/storage/objects${queryString({ prefix: options.prefix, limit: options.limit, offset: options.offset })}`
    );
  }
  async uploadStorage(key, body, options = {}) {
    const headers = new Headers();
    if (options.contentType) headers.set("Content-Type", options.contentType);
    const response = await this.request(`/api/storage/objects/${encodePath(key)}`, {
      method: "PUT",
      headers,
      body
    });
    return response.json();
  }
  async listEvents(options = {}) {
    return this.getJson(
      `/api/events${queryString({
        limit: options.limit,
        after: options.after,
        event_type: options.eventTypes?.join(","),
        entity: options.entities?.join(",")
      })}`
    );
  }
  subscribeEvents(options) {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return {
      close: () => controller.abort(),
      done: this.consumeEvents(options, controller.signal)
    };
  }
  async consumeEvents(options, signal) {
    const reconnect = options.reconnect ?? true;
    const reconnectDelayMs = Math.max(100, options.reconnectDelayMs ?? 1e3);
    let after = options.after;
    while (!signal.aborted) {
      try {
        const response = await this.request(
          `/api/events/stream${queryString({
            after,
            event_type: options.eventTypes?.join(","),
            entity: options.entities?.join(",")
          })}`,
          { signal }
        );
        if (!response.body) throw new Error("Realtime stream did not return a response body");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let message = { data: [] };
        const dispatch = async () => {
          if (message.data.length === 0) return;
          const parsed = JSON.parse(message.data.join("\n"));
          after = parsed.id || message.id || after;
          await options.onEvent(parsed);
          message = { data: [] };
        };
        while (!signal.aborted) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
          let lineEnd = buffer.indexOf("\n");
          while (lineEnd >= 0) {
            const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
            buffer = buffer.slice(lineEnd + 1);
            if (!line) await dispatch();
            else if (line.startsWith("id:")) message.id = line.slice(3).trim();
            else if (line.startsWith("event:")) message.eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) message.data.push(line.slice(5).trimStart());
            lineEnd = buffer.indexOf("\n");
          }
          if (done) {
            await dispatch();
            break;
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        try {
          options.onError?.(error);
        } catch {
        }
        if (!reconnect) throw error;
      }
      if (!reconnect || signal.aborted) return;
      await delay(reconnectDelayMs, signal);
    }
  }
  async invokeFunction(route, options = {}) {
    const method = (options.method ?? "POST").toUpperCase();
    const headers = new Headers(options.headers);
    let body;
    if (options.body !== void 0) {
      if (typeof options.body === "string" || options.body instanceof FormData || options.body instanceof Blob || options.body instanceof URLSearchParams) {
        body = options.body;
      } else {
        headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
        body = JSON.stringify(options.body);
      }
    }
    const response = await this.request(route.startsWith("/") ? route : `/${route}`, { method, headers, body });
    const contentType = response.headers.get("content-type") ?? "";
    return contentType.includes("application/json") ? response.json() : response.text();
  }
  async getJson(path, options = {}) {
    const response = await this.request(path, { ...options, method: "GET" });
    return response.json();
  }
  async postJson(path, payload, options = {}) {
    return this.writeJson("POST", path, payload, options);
  }
  async patchJson(path, payload, options = {}) {
    return this.writeJson("PATCH", path, payload, options);
  }
  async deleteJson(path) {
    const response = await this.request(path, { method: "DELETE" });
    return response.json();
  }
  async writeJson(method, path, payload, options = {}) {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/json");
    const response = await this.request(path, { ...options, method, headers, body: JSON.stringify(payload) });
    return response.json();
  }
  resolve(path) {
    return new URL(path, `${this.url}/`).toString();
  }
};
function toBase64(value) {
  const nodeBuffer = globalThis.Buffer;
  if (nodeBuffer) return nodeBuffer.from(value, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(value)));
}
function createBaasClient(options = {}) {
  return new BaaSClient(options);
}

// src/index.ts
var VERSION = "0.5.0";
var DEFAULT_MAX_QUEUE_SIZE = 1e3;
var DEFAULT_FLUSH_INTERVAL_MS = 1e3;
var DEFAULT_TIMEOUT_MS = 5e3;
var DEFAULT_COMMAND_POLL_INTERVAL_MS = 2e3;
var MAX_STORAGE_BRIDGE_BYTES = 4 * 1024 * 1024;
function processEnv2(name) {
  const candidate = globalThis;
  return candidate.process?.env?.[name];
}
function normalizedUrl2(value) {
  const raw = value?.trim().replace(/\/+$/, "");
  return raw || void 0;
}
function safeString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
function now() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function randomRequestId() {
  const bytes = new Uint8Array(12);
  globalThis.crypto?.getRandomValues?.(bytes);
  return `rt_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}
function responseStatus(response) {
  const value = Number(response.statusCode ?? 200);
  return Number.isFinite(value) ? value : 200;
}
function allowProcessExit(timer) {
  timer.unref?.();
}
function requestHeader(request, name) {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(direct) ? direct[0] : direct;
}
function connectedUser(user) {
  return {
    id: safeString(user.id),
    username: safeString(user.username),
    email: safeString(user.email ?? "") || null,
    name: safeString(user.name ?? "") || null,
    roles: Array.from(new Set((user.roles ?? []).map((role) => safeString(role)).filter(Boolean))),
    created_at: safeString(user.created_at ?? "") || null,
    updated_at: safeString(user.updated_at ?? "") || null
  };
}
function connectedStorageObject(object) {
  const size = Number(object.size);
  return {
    key: safeString(object.key),
    size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : -1,
    content_type: safeString(object.content_type ?? "") || null,
    etag: safeString(object.etag ?? "") || null,
    created_at: safeString(object.created_at ?? "") || null,
    updated_at: safeString(object.updated_at ?? "") || null
  };
}
function validStorageObject(object) {
  const normalized = connectedStorageObject(object);
  if (!normalized.key || normalized.size < 0) {
    throw new Error("Object storage adapter returned invalid object metadata");
  }
  return normalized;
}
function encodeBase64(data) {
  if (data.byteLength > MAX_STORAGE_BRIDGE_BYTES) {
    throw new Error(`Object exceeds the ${MAX_STORAGE_BRIDGE_BYTES}-byte dashboard transfer limit`);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let binary = "";
  const chunkSize = 32768;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}
function decodeBase64(value) {
  const encoded = safeString(value);
  if (!encoded) return new Uint8Array();
  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (encoded.length % 4 !== 0 || !canonicalBase64.test(encoded)) {
    throw new Error("Storage write command contains invalid object data");
  }
  const estimatedBytes = Math.floor(encoded.length * 3 / 4);
  if (estimatedBytes > MAX_STORAGE_BRIDGE_BYTES + 2) {
    throw new Error(`Object exceeds the ${MAX_STORAGE_BRIDGE_BYTES}-byte dashboard transfer limit`);
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(encoded, "base64"));
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
var BaaSRuntime = class {
  endpoint;
  enabled;
  metrics;
  logs;
  events;
  settings;
  users;
  token;
  service;
  environment;
  maxQueueSize;
  flushIntervalMs;
  timeoutMs;
  attributes;
  onError;
  fetchImpl;
  heartbeatEnabled;
  userAdapter;
  storageAdapter;
  commandPollIntervalMs;
  queues = {
    metrics: [],
    logs: [],
    events: []
  };
  flushTimer;
  heartbeatTimer;
  commandTimer;
  settingsCache;
  settingsEtag;
  started = false;
  constructor(options = {}) {
    this.endpoint = normalizedUrl2(options.endpoint ?? processEnv2("BAAS_RUNTIME_URL") ?? processEnv2("BAAS_API_URL"));
    this.token = safeString(options.token ?? processEnv2("BAAS_RUNTIME_TOKEN")) || void 0;
    this.enabled = Boolean(this.endpoint && this.token);
    this.service = safeString(options.service ?? processEnv2("BAAS_RUNTIME_SERVICE")) || void 0;
    this.environment = safeString(options.environment ?? processEnv2("BAAS_RUNTIME_ENV")) || void 0;
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.attributes = { ...options.attributes ?? {} };
    this.onError = options.onError;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.heartbeatEnabled = options.heartbeat !== false;
    this.userAdapter = options.users;
    this.storageAdapter = options.storage;
    this.commandPollIntervalMs = Math.max(5, options.commandPollIntervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS);
    if ((this.userAdapter || this.storageAdapter) && !this.heartbeatEnabled) {
      throw new Error("Connected runtime management requires heartbeat to remain enabled");
    }
    if (options.required && !this.enabled) {
      throw new Error("BAAS_RUNTIME_URL and BAAS_RUNTIME_TOKEN are required for this runtime");
    }
    this.metrics = {
      increment: (name, value = 1, attributes) => this.queueMetric(name, value, "counter", "count", attributes),
      gauge: (name, value, attributes) => this.queueMetric(name, value, "gauge", "count", attributes),
      timing: (name, value, attributes) => this.queueMetric(name, value, "timing", "ms", attributes),
      observe: (name, value, attributes) => this.queueMetric(name, value, "histogram", "count", attributes),
      http: () => this.httpMiddleware()
    };
    this.logs = {
      debug: (message, attributes) => this.queueLog("DEBUG", message, attributes),
      info: (message, attributes) => this.queueLog("INFO", message, attributes),
      warn: (message, attributes) => this.queueLog("WARNING", message, attributes),
      error: (message, attributes) => this.queueError(message, attributes)
    };
    this.events = {
      publish: (name, payload = {}, channel) => this.queueEvent(name, payload, channel)
    };
    this.settings = {
      get: (settingsOptions) => this.getSettings(settingsOptions),
      clear: () => {
        this.settingsCache = void 0;
        this.settingsEtag = void 0;
      }
    };
    this.users = {
      sync: () => this.syncUsers()
    };
  }
  async start() {
    if (this.started || !this.enabled) return;
    this.started = true;
    if (this.heartbeatEnabled) {
      const interval = await this.heartbeat();
      this.scheduleHeartbeat(interval);
    }
    if (this.userAdapter || this.storageAdapter) {
      if (this.userAdapter) await this.syncUsers();
      await this.pollCommands();
      this.scheduleCommandPoll();
    }
  }
  async shutdown() {
    this.started = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = void 0;
    if (this.commandTimer) clearTimeout(this.commandTimer);
    this.commandTimer = void 0;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = void 0;
    await this.flush();
  }
  async flush() {
    await Promise.all(["metrics", "logs", "events"].map((kind) => this.flushQueue(kind)));
  }
  requestContext() {
    return this.httpMiddleware();
  }
  queueMetric(name, value, kind, unit, attributes) {
    if (!Number.isFinite(value)) return;
    this.enqueue("metrics", {
      name,
      value,
      kind,
      unit,
      timestamp: now(),
      attributes: { ...this.attributes, ...attributes ?? {} }
    });
  }
  queueLog(level, message, attributes) {
    if (!message.trim()) return;
    this.enqueue("logs", {
      level,
      message,
      service: this.service,
      logger: typeof attributes?.logger === "string" ? attributes.logger : void 0,
      request_id: typeof attributes?.requestId === "string" ? attributes.requestId : void 0,
      attributes,
      timestamp: now()
    });
  }
  queueError(message, attributes) {
    const exception = attributes instanceof Error ? `${attributes.name}: ${attributes.message}` : void 0;
    const context = attributes instanceof Error ? void 0 : attributes;
    this.enqueue("logs", {
      level: "ERROR",
      message,
      service: this.service,
      exception,
      attributes: context,
      timestamp: now()
    });
  }
  queueEvent(name, payload, channel) {
    if (!name.trim()) return;
    this.enqueue("events", { name, payload, channel, timestamp: now() });
  }
  enqueue(kind, record) {
    if (!this.enabled) return;
    const queue = this.queues[kind];
    if (queue.length >= this.maxQueueSize) queue.shift();
    queue.push(record);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = void 0;
        void this.flush();
      }, this.flushIntervalMs);
      allowProcessExit(this.flushTimer);
    }
  }
  async flushQueue(kind) {
    const queue = this.queues[kind];
    if (!this.enabled || queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    const body = kind === "events" ? batch : { records: batch };
    const path = kind === "events" ? "/runtime/v1/events" : `/runtime/v1/${kind}`;
    if (kind === "events") {
      for (const event of batch) {
        const sent2 = await this.post(path, event);
        if (!sent2) this.requeue(kind, [event]);
      }
      return;
    }
    const sent = await this.post(path, body);
    if (!sent) this.requeue(kind, batch);
  }
  requeue(kind, records) {
    const queue = this.queues[kind];
    queue.unshift(...records.slice(0, Math.max(0, this.maxQueueSize - queue.length)));
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = void 0;
        void this.flush();
      }, Math.max(this.flushIntervalMs, 5e3));
      allowProcessExit(this.flushTimer);
    }
  }
  async getSettings(options = {}) {
    if (!this.enabled) return this.settingsCache;
    const headers = {};
    if (!options.force && this.settingsEtag) headers["If-None-Match"] = this.settingsEtag;
    try {
      const response = await this.request("/runtime/v1/settings", { method: "GET", headers });
      if (response.status === 304) return this.settingsCache;
      if (!response.ok) throw new Error(`Settings request failed with ${response.status}`);
      const data = await response.json();
      this.settingsCache = data;
      this.settingsEtag = response.headers.get("etag") ?? void 0;
      return data;
    } catch (error) {
      this.reportError(error);
      return this.settingsCache;
    }
  }
  httpMiddleware() {
    return (request, response, next) => {
      const startedAt = Date.now();
      const requestId = requestHeader(request, "x-request-id") ?? randomRequestId();
      response.setHeader?.("X-Request-ID", requestId);
      const finish = () => {
        this.metrics.timing("http.server.duration", Date.now() - startedAt, {
          method: request.method ?? "GET",
          route: request.originalUrl ?? request.url ?? "/",
          status_code: responseStatus(response)
        });
      };
      if (response.once) response.once("finish", finish);
      else response.on?.("finish", finish);
      next();
    };
  }
  async heartbeat() {
    if (!this.enabled) return 0;
    try {
      const capabilities = [];
      if (this.userAdapter) capabilities.push("runtime-users");
      if (this.storageAdapter) capabilities.push("object-storage");
      const response = await this.post("/runtime/v1/heartbeat", {
        runtime_name: this.service,
        sdk_name: "@dutchwebservices/baas-runtime",
        sdk_version: VERSION,
        capabilities
      });
      if (!response) return 0;
      const parsed = await response.json();
      return Math.max(15e3, Number(parsed.heartbeat_interval_seconds ?? 60) * 1e3);
    } catch (error) {
      this.reportError(error);
      return 6e4;
    }
  }
  scheduleHeartbeat(interval) {
    if (!this.started || !this.enabled) return;
    this.heartbeatTimer = setTimeout(async () => {
      const nextInterval = await this.heartbeat();
      this.scheduleHeartbeat(nextInterval || 6e4);
    }, interval || 6e4);
    allowProcessExit(this.heartbeatTimer);
  }
  async syncUsers() {
    if (!this.enabled || !this.userAdapter) return false;
    try {
      const users = (await this.userAdapter.list()).map(connectedUser);
      if (users.some((user) => !user.id || !user.username)) {
        throw new Error("Runtime user adapter returned a user without id or username");
      }
      return Boolean(await this.post("/runtime/v1/users/sync", { users }));
    } catch (error) {
      this.reportError(error);
      return false;
    }
  }
  async pollCommands() {
    if (!this.started || !this.enabled || !this.userAdapter && !this.storageAdapter) return;
    const response = await this.post("/runtime/v1/commands/claim", { limit: 10 });
    if (!response) return;
    try {
      const data = await response.json();
      for (const command of data.commands ?? []) await this.executeCommand(command);
    } catch (error) {
      this.reportError(error);
    }
  }
  async executeCommand(command) {
    if (!safeString(command.id)) return;
    try {
      if (command.action === "users.create") {
        if (!this.userAdapter) throw new Error("Runtime user adapter is not configured");
        const input = {
          username: safeString(command.payload.username),
          password: safeString(command.payload.password),
          email: safeString(command.payload.email) || null,
          name: safeString(command.payload.name) || null,
          roles: Array.isArray(command.payload.roles) ? command.payload.roles.map((role) => safeString(role)).filter(Boolean) : []
        };
        if (!input.username || !input.password) throw new Error("User create command is missing username or password");
        const user = connectedUser(await this.userAdapter.create(input));
        if (!user.id || !user.username) throw new Error("Runtime user adapter returned a user without id or username");
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, { ok: true, user });
      } else if (command.action === "users.delete") {
        if (!this.userAdapter) throw new Error("Runtime user adapter is not configured");
        const userRef = safeString(command.payload.user_ref);
        if (!userRef) throw new Error("User delete command is missing user_ref");
        await this.userAdapter.remove(userRef);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, { ok: true });
      } else if (command.action === "storage.list") {
        if (!this.storageAdapter) throw new Error("Object storage adapter is not configured");
        const listed = await this.storageAdapter.list({
          prefix: safeString(command.payload.prefix) || null,
          limit: Math.max(1, Math.min(500, Number(command.payload.limit) || 200)),
          offset: Math.max(0, Number(command.payload.offset) || 0)
        });
        const objects = (Array.isArray(listed) ? listed : listed.objects).map(validStorageObject);
        const total = Array.isArray(listed) ? null : listed.total ?? null;
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { objects, total }
        });
      } else if (command.action === "storage.write") {
        if (!this.storageAdapter) throw new Error("Object storage adapter is not configured");
        const key = safeString(command.payload.key);
        if (!key) throw new Error("Storage write command is missing key");
        const object = validStorageObject(await this.storageAdapter.write({
          key,
          data: decodeBase64(command.payload.data_base64),
          contentType: safeString(command.payload.content_type) || null
        }));
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { object }
        });
      } else if (command.action === "storage.read") {
        if (!this.storageAdapter) throw new Error("Object storage adapter is not configured");
        const key = safeString(command.payload.key);
        if (!key) throw new Error("Storage read command is missing key");
        const read = await this.storageAdapter.read(key);
        const object = validStorageObject(read);
        if (read.data.byteLength !== object.size) {
          throw new Error("Object storage adapter returned inconsistent object metadata");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { object, data_base64: encodeBase64(read.data) }
        });
      } else if (command.action === "storage.delete") {
        if (!this.storageAdapter) throw new Error("Object storage adapter is not configured");
        const key = safeString(command.payload.key);
        if (!key) throw new Error("Storage delete command is missing key");
        await this.storageAdapter.remove(key);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: {}
        });
      } else {
        throw new Error(`Unsupported runtime command: ${String(command.action)}`);
      }
      if (this.userAdapter && command.action.startsWith("users.")) await this.syncUsers();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connected runtime operation failed";
      await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
        ok: false,
        error: message.slice(0, 2e3)
      });
      this.reportError(error);
    }
  }
  scheduleCommandPoll() {
    if (!this.started || !this.enabled || !this.userAdapter && !this.storageAdapter) return;
    this.commandTimer = setTimeout(async () => {
      await this.pollCommands();
      this.scheduleCommandPoll();
    }, this.commandPollIntervalMs);
    allowProcessExit(this.commandTimer);
  }
  async post(path, body) {
    try {
      const response = await this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error(`Runtime delivery failed with ${response.status}`);
      return response;
    } catch (error) {
      this.reportError(error);
      return void 0;
    }
  }
  async request(path, init) {
    if (!this.endpoint || !this.token || !this.fetchImpl) throw new Error("Runtime SDK is not configured");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(`${this.endpoint}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "X-Baas-SDK": "@dutchwebservices/baas-runtime",
          "X-Baas-SDK-Version": VERSION,
          ...init.headers ?? {}
        }
      });
    } finally {
      clearTimeout(timeout);
    }
  }
  reportError(error) {
    try {
      this.onError?.(error);
    } catch {
    }
  }
};
function createBaasRuntime(options = {}) {
  return new BaaSRuntime(options);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BaaSClient,
  BaaSError,
  BaaSRuntime,
  VERSION,
  createBaasClient,
  createBaasRuntime
});
//# sourceMappingURL=index.cjs.map