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
var VERSION = "0.6.8";
var RUNTIME_INTEGRATION_CAPABILITIES = [
  "runtime-users",
  "blob-storage",
  "redis",
  "schema-builder",
  "service-accounts",
  "baas-functions",
  "cron",
  "webhooks",
  "event-stream",
  "logs",
  "object-file-api"
];
var DEFAULT_MAX_QUEUE_SIZE = 1e3;
var DEFAULT_FLUSH_INTERVAL_MS = 1e3;
var DEFAULT_TIMEOUT_MS = 5e3;
var DEFAULT_COMMAND_POLL_INTERVAL_MS = 2e3;
var MAX_STORAGE_BRIDGE_BYTES = 4 * 1024 * 1024;
var MAX_CACHE_VALUE_BYTES = 64 * 1024;
var MAX_CACHE_KEY_LENGTH = 512;
var MAX_CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;
var MAX_RUNTIME_SCHEMA_ENTITIES = 100;
var MAX_RUNTIME_SCHEMA_FIELDS = 100;
var MAX_RUNTIME_SCHEMA_BYTES = 1024 * 1024;
var MAX_RUNTIME_FUNCTIONS = 500;
var MAX_RUNTIME_FUNCTION_PAYLOAD_BYTES = 64 * 1024;
var MAX_RUNTIME_FUNCTION_RESULT_BYTES = 256 * 1024;
var RUNTIME_FUNCTION_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
var RUNTIME_FUNCTION_AUTH_MODES = /* @__PURE__ */ new Set([
  "required",
  "optional",
  "none"
]);
var MAX_RUNTIME_CRON_SCHEDULES = 500;
var MAX_RUNTIME_CRON_TARGETS = 200;
var MAX_RUNTIME_CRON_PAYLOAD_BYTES = 64 * 1024;
var MAX_RUNTIME_CRON_RESULT_BYTES = 256 * 1024;
var RUNTIME_CRON_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
var RUNTIME_CRON_TIMEZONE = /^(?:UTC|[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+)$/;
var RUNTIME_CRON_TARGET_TYPES = /* @__PURE__ */ new Set(["function", "action"]);
var RUNTIME_CRON_RUN_STATUSES = /* @__PURE__ */ new Set([
  "succeeded",
  "failed",
  "accepted"
]);
var RUNTIME_CRON_LAST_RUN_STATUSES = /* @__PURE__ */ new Set([
  "succeeded",
  "failed",
  "running"
]);
var MAX_RUNTIME_WEBHOOK_SUBSCRIPTIONS = 500;
var MAX_RUNTIME_WEBHOOK_EVENT_TYPES = 200;
var MAX_RUNTIME_WEBHOOK_FILTER_ITEMS = 50;
var MAX_RUNTIME_WEBHOOK_OVERRIDES = 50;
var RUNTIME_WEBHOOK_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
var RUNTIME_WEBHOOK_EVENT_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/;
var RUNTIME_WEBHOOK_DELIVERY_STATUSES = /* @__PURE__ */ new Set([
  "delivered",
  "failed",
  "pending",
  "never"
]);
var MAX_RUNTIME_EVENT_STREAM_CHANNELS = 200;
var MAX_RUNTIME_EVENT_STREAM_EVENTS = 200;
var MAX_RUNTIME_EVENT_STREAM_EVENT_TYPES = 50;
var MAX_RUNTIME_EVENT_STREAM_PAYLOAD_BYTES = 64 * 1024;
var MAX_RUNTIME_EVENT_STREAM_CURSOR_LENGTH = 512;
var MAX_RUNTIME_EVENT_STREAM_SEARCH_LENGTH = 200;
var RUNTIME_EVENT_STREAM_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
var RUNTIME_EVENT_STREAM_KEY = /^[A-Za-z][A-Za-z0-9._:-]{0,119}$/;
var RUNTIME_EVENT_STREAM_AUTH_MODES = /* @__PURE__ */ new Set([
  "bearer",
  "cookie"
]);
var MAX_RUNTIME_LOG_SOURCES = 200;
var MAX_RUNTIME_LOG_ENTRIES = 200;
var MAX_RUNTIME_LOG_FILTER_ITEMS = 50;
var MAX_RUNTIME_LOG_SEARCH_LENGTH = 500;
var MAX_RUNTIME_LOG_CURSOR_LENGTH = 512;
var MAX_RUNTIME_LOG_MESSAGE_LENGTH = 16 * 1024;
var MAX_RUNTIME_LOG_ATTRIBUTES_BYTES = 64 * 1024;
var MAX_RUNTIME_LOG_RESULT_BYTES = 512 * 1024;
var RUNTIME_LOG_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
var RUNTIME_LOG_LEVELS = /* @__PURE__ */ new Set(["DEBUG", "INFO", "WARNING", "ERROR"]);
var RUNTIME_SCHEMA_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
var RUNTIME_SCHEMA_FIELD_TYPES = /* @__PURE__ */ new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "date",
  "datetime",
  "object",
  "array",
  "relation"
]);
var RUNTIME_SCHEMA_RELATION_KINDS = /* @__PURE__ */ new Set([
  "many_to_one",
  "one_to_many",
  "one_to_one",
  "many_to_many"
]);
var RUNTIME_SCHEMA_DELETE_ACTIONS = /* @__PURE__ */ new Set([
  "restrict",
  "cascade",
  "set_null"
]);
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
function runtimeCommandError(command, error) {
  if (command.action.startsWith("logs.")) return "Log adapter operation failed";
  if (command.action.startsWith("event_stream.")) return "Event stream adapter operation failed";
  if (command.action.startsWith("webhooks.")) return "Webhook adapter operation failed";
  if (command.action.startsWith("cron.")) return "Schedule adapter operation failed";
  if (command.action.startsWith("functions.")) return "Function adapter operation failed";
  if (command.action === "cache.set") return "Cache adapter operation failed";
  let message = error instanceof Error ? error.message : "Connected runtime operation failed";
  const sensitiveKeys = command.action === "service_accounts.create" ? ["client_secret"] : command.action === "users.create" ? ["password"] : [];
  for (const key of sensitiveKeys) {
    const sensitiveValue = safeString(command.payload[key]);
    if (sensitiveValue) message = message.split(sensitiveValue).join("[redacted]");
  }
  return message.slice(0, 2e3);
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
var RUNTIME_USER_ROLE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
var RUNTIME_SERVICE_ACCOUNT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,199}$/;
function runtimeUserRoleOption(value) {
  const key = safeString(value.key);
  const label = safeString(value.label);
  const description = safeString(value.description ?? "");
  if (!RUNTIME_USER_ROLE_KEY.test(key)) {
    throw new Error("Runtime user role option has an invalid key");
  }
  if (!label || label.length > 120) {
    throw new Error("Runtime user role option has an invalid label");
  }
  if (description.length > 280) {
    throw new Error("Runtime user role option has an invalid description");
  }
  return description ? { key, label, description } : { key, label };
}
function connectedServiceAccount(value) {
  const id = safeString(value.id);
  const name = safeString(value.name);
  const clientId = safeString(value.client_id);
  const tokenUrl = safeString(value.token_url);
  const scopes = Array.from(
    new Set((value.scopes ?? []).map((scope) => safeString(scope)).filter(Boolean))
  );
  if (!RUNTIME_SERVICE_ACCOUNT_VALUE.test(id)) {
    throw new Error("Runtime service account adapter returned an invalid id");
  }
  if (!name || name.length > 120) {
    throw new Error("Runtime service account adapter returned an invalid name");
  }
  if (!RUNTIME_SERVICE_ACCOUNT_VALUE.test(clientId)) {
    throw new Error("Runtime service account adapter returned an invalid client id");
  }
  if (!tokenUrl || tokenUrl.length > 500 || !tokenUrl.startsWith("/") && !tokenUrl.startsWith("https://")) {
    throw new Error("Runtime service account adapter returned an invalid token URL");
  }
  if (scopes.length > 100 || scopes.some((scope) => scope.length > 200)) {
    throw new Error("Runtime service account adapter returned invalid scopes");
  }
  return {
    id,
    name,
    client_id: clientId,
    scopes,
    token_url: tokenUrl,
    created_at: safeString(value.created_at ?? "") || null,
    updated_at: safeString(value.updated_at ?? "") || null
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
function cacheKey(value, field = "key") {
  if (typeof value !== "string" || !value || value.length > MAX_CACHE_KEY_LENGTH || value !== value.trim() || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Cache ${field} is invalid`);
  }
  if (field === "key" && value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Cache key contains an unsupported path segment");
  }
  return value;
}
function cacheOptionalString(value, field) {
  if (value === void 0 || value === null || value === "") return null;
  return cacheKey(value, field);
}
function cacheTtl(value) {
  if (value === void 0 || value === null || value === "") return null;
  const ttl = Number(value);
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_CACHE_TTL_SECONDS) {
    throw new Error(`Cache TTL must be between 1 and ${MAX_CACHE_TTL_SECONDS} seconds`);
  }
  return ttl;
}
function cacheJsonValue(value) {
  let normalized;
  try {
    normalized = jsonValue(value);
  } catch {
    throw new Error("Cache values must be JSON-compatible");
  }
  const serialized = JSON.stringify(normalized);
  if (new TextEncoder().encode(serialized).byteLength > MAX_CACHE_VALUE_BYTES) {
    throw new Error(`Cache values may not exceed ${MAX_CACHE_VALUE_BYTES} bytes`);
  }
  return normalized;
}
function cacheEntrySummary(value) {
  const ttl = value.ttl_seconds == null ? null : Number(value.ttl_seconds);
  const size = Number(value.size_bytes);
  if (ttl != null && (!Number.isInteger(ttl) || ttl < 0 || ttl > MAX_CACHE_TTL_SECONDS)) {
    throw new Error("Cache adapter returned invalid TTL metadata");
  }
  if (!Number.isInteger(size) || size < 0 || size > MAX_CACHE_VALUE_BYTES) {
    throw new Error("Cache adapter returned invalid size metadata");
  }
  return {
    key: cacheKey(value.key),
    ttl_seconds: ttl,
    size_bytes: size,
    expires_at: safeString(value.expires_at ?? "") || null,
    updated_at: safeString(value.updated_at ?? "") || null
  };
}
function cacheEntry(value) {
  const normalizedValue = cacheJsonValue(value.value);
  const actualSize = new TextEncoder().encode(JSON.stringify(normalizedValue)).byteLength;
  const summary = cacheEntrySummary(value);
  if (summary.size_bytes !== actualSize) {
    throw new Error("Cache adapter returned inconsistent size metadata");
  }
  return {
    ...summary,
    value: normalizedValue
  };
}
function functionReference(value) {
  const normalized = safeString(value);
  if (!RUNTIME_FUNCTION_REFERENCE.test(normalized)) {
    throw new Error("Function reference is invalid");
  }
  return normalized;
}
function functionRateLimit(value) {
  if (value === void 0 || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Function rate limit is invalid");
  }
  const record = value;
  const requests = Number(record.requests);
  const windowSeconds = Number(record.window_seconds ?? record.windowSeconds);
  if (!Number.isInteger(requests) || requests < 1 || requests > 1e6 || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400) {
    throw new Error("Function rate limit is invalid");
  }
  return { requests, window_seconds: windowSeconds };
}
function connectedFunction(value) {
  const id = functionReference(value.id);
  const name = safeString(value.name);
  const description = safeString(value.description ?? "");
  const authMode = safeString(value.auth_mode ?? "required");
  const tags = Array.from(
    new Set((value.tags ?? []).map((tag) => safeString(tag)).filter(Boolean))
  );
  if (!name || name.length > 160) throw new Error("Function adapter returned an invalid name");
  if (description.length > 2e3) {
    throw new Error("Function adapter returned an invalid description");
  }
  if (!RUNTIME_FUNCTION_AUTH_MODES.has(authMode)) {
    throw new Error("Function adapter returned an invalid auth mode");
  }
  if (tags.length > 20 || tags.some((tag) => tag.length > 64)) {
    throw new Error("Function adapter returned invalid tags");
  }
  return {
    id,
    name,
    description: description || null,
    enabled: value.enabled === true,
    auth_mode: authMode,
    tags,
    rate_limit: functionRateLimit(value.rate_limit),
    created_at: safeString(value.created_at ?? "") || null,
    updated_at: safeString(value.updated_at ?? "") || null
  };
}
function boundedFunctionJson(value, maxBytes, label) {
  let normalized;
  try {
    normalized = jsonValue(value);
  } catch {
    throw new Error(`${label} must be JSON-compatible`);
  }
  if (new TextEncoder().encode(JSON.stringify(normalized)).byteLength > maxBytes) {
    throw new Error(`${label} exceeds the ${maxBytes}-byte limit`);
  }
  return normalized;
}
function functionInvocationResult(value) {
  const wrapped = value && typeof value === "object" && !Array.isArray(value) && "result" in value ? value : { result: value };
  const duration = wrapped.duration_ms == null ? null : Number(wrapped.duration_ms);
  if (duration != null && (!Number.isFinite(duration) || duration < 0 || duration > 864e5)) {
    throw new Error("Function adapter returned an invalid duration");
  }
  return {
    result: boundedFunctionJson(
      wrapped.result,
      MAX_RUNTIME_FUNCTION_RESULT_BYTES,
      "Function result"
    ),
    duration_ms: duration
  };
}
function cronReference(value, label) {
  const normalized = safeString(value);
  if (!RUNTIME_CRON_REFERENCE.test(normalized)) {
    throw new Error(`Schedule ${label} is invalid`);
  }
  return normalized;
}
function cronName(value, label = "name") {
  const normalized = safeString(value);
  if (!normalized || normalized.length > 160) {
    throw new Error(`Schedule ${label} is invalid`);
  }
  return normalized;
}
function cronDescription(value) {
  if (value === void 0 || value === null || value === "") return null;
  const normalized = safeString(value);
  if (!normalized || normalized.length > 2e3) {
    throw new Error("Schedule description is invalid");
  }
  return normalized;
}
function cronExpression(value) {
  const normalized = safeString(value).replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120 || normalized.split(" ").length !== 5 || /[^A-Za-z0-9*?,/\-#LW ]/.test(normalized)) {
    throw new Error("Schedule expression must contain five valid cron fields");
  }
  return normalized;
}
function cronTimezone(value) {
  const normalized = safeString(value);
  if (!normalized || normalized.length > 100 || !RUNTIME_CRON_TIMEZONE.test(normalized)) {
    throw new Error("Schedule timezone is invalid");
  }
  return normalized;
}
function cronTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule target is invalid");
  }
  const target = value;
  const type = safeString(target.type);
  if (!RUNTIME_CRON_TARGET_TYPES.has(type)) {
    throw new Error("Schedule target type is invalid");
  }
  return { type, ref: cronReference(target.ref, "target reference") };
}
function cronTimestamp(value, label) {
  if (value === void 0 || value === null || value === "") return null;
  const normalized = safeString(value);
  if (!normalized || normalized.length > 64 || !Number.isFinite(Date.parse(normalized))) {
    throw new Error(`Schedule ${label} is invalid`);
  }
  return normalized;
}
function connectedCronTarget(value) {
  const type = safeString(value.type);
  if (!RUNTIME_CRON_TARGET_TYPES.has(type)) {
    throw new Error("Schedule adapter returned an invalid target type");
  }
  return {
    id: cronReference(value.id, "target id"),
    name: cronName(value.name, "target name"),
    description: cronDescription(value.description),
    type
  };
}
function connectedCronSchedule(value) {
  const lastRunStatus = safeString(value.last_run_status ?? "");
  if (lastRunStatus && !RUNTIME_CRON_LAST_RUN_STATUSES.has(lastRunStatus)) {
    throw new Error("Schedule adapter returned an invalid last-run status");
  }
  return {
    id: cronReference(value.id, "id"),
    name: cronName(value.name),
    description: cronDescription(value.description),
    schedule: cronExpression(value.schedule),
    timezone: cronTimezone(value.timezone),
    enabled: value.enabled === true,
    target: cronTarget(value.target),
    payload: value.payload === void 0 ? null : boundedFunctionJson(value.payload, MAX_RUNTIME_CRON_PAYLOAD_BYTES, "Schedule payload"),
    next_run_at: cronTimestamp(value.next_run_at, "next-run timestamp"),
    last_run_at: cronTimestamp(value.last_run_at, "last-run timestamp"),
    last_run_status: lastRunStatus || null,
    created_at: cronTimestamp(value.created_at, "created timestamp"),
    updated_at: cronTimestamp(value.updated_at, "updated timestamp")
  };
}
function cronCreateInput(value) {
  if (typeof value.enabled !== "boolean") {
    throw new Error("Schedule enabled state is invalid");
  }
  return {
    name: cronName(value.name),
    description: cronDescription(value.description),
    schedule: cronExpression(value.schedule),
    timezone: cronTimezone(value.timezone),
    enabled: value.enabled,
    target: cronTarget(value.target),
    payload: value.payload === void 0 ? null : boundedFunctionJson(value.payload, MAX_RUNTIME_CRON_PAYLOAD_BYTES, "Schedule payload")
  };
}
function cronUpdateInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule update changes are invalid");
  }
  const changes = value;
  const allowed = /* @__PURE__ */ new Set([
    "name",
    "description",
    "schedule",
    "timezone",
    "enabled",
    "target",
    "payload"
  ]);
  if (Object.keys(changes).some((key) => !allowed.has(key))) {
    throw new Error("Schedule update contains unsupported fields");
  }
  const input = {};
  if (Object.prototype.hasOwnProperty.call(changes, "name")) input.name = cronName(changes.name);
  if (Object.prototype.hasOwnProperty.call(changes, "description")) {
    input.description = cronDescription(changes.description);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "schedule")) {
    input.schedule = cronExpression(changes.schedule);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "timezone")) {
    input.timezone = cronTimezone(changes.timezone);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "enabled")) {
    if (typeof changes.enabled !== "boolean") {
      throw new Error("Schedule enabled state is invalid");
    }
    input.enabled = changes.enabled;
  }
  if (Object.prototype.hasOwnProperty.call(changes, "target")) {
    input.target = cronTarget(changes.target);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "payload")) {
    input.payload = boundedFunctionJson(
      changes.payload,
      MAX_RUNTIME_CRON_PAYLOAD_BYTES,
      "Schedule payload"
    );
  }
  if (Object.keys(input).length === 0) {
    throw new Error("Schedule update command has no changes");
  }
  return input;
}
function cronRunResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Schedule adapter returned an invalid run result");
  }
  const status = safeString(value.status);
  if (!RUNTIME_CRON_RUN_STATUSES.has(status)) {
    throw new Error("Schedule adapter returned an invalid run status");
  }
  const duration = value.duration_ms == null ? null : Number(value.duration_ms);
  if (duration != null && (!Number.isFinite(duration) || duration < 0 || duration > 864e5)) {
    throw new Error("Schedule adapter returned an invalid duration");
  }
  return {
    status,
    result: value.result === void 0 ? null : boundedFunctionJson(value.result, MAX_RUNTIME_CRON_RESULT_BYTES, "Schedule run result"),
    duration_ms: duration,
    started_at: cronTimestamp(value.started_at, "run start timestamp"),
    finished_at: cronTimestamp(value.finished_at, "run finish timestamp")
  };
}
function webhookReference(value, label = "reference") {
  const normalized = safeString(value);
  if (!RUNTIME_WEBHOOK_REFERENCE.test(normalized)) {
    throw new Error(`Webhook ${label} contains unsupported characters`);
  }
  return normalized;
}
function webhookName(value) {
  const normalized = safeString(value);
  if (!normalized || normalized.length > 160) throw new Error("Webhook name is invalid");
  return normalized;
}
function webhookDescription(value) {
  if (value == null || value === "") return null;
  const normalized = safeString(value);
  if (normalized.length > 2e3) throw new Error("Webhook description is too long");
  return normalized || null;
}
function webhookEventKey(value, label = "event type") {
  const normalized = safeString(value);
  if (!RUNTIME_WEBHOOK_EVENT_KEY.test(normalized)) {
    throw new Error(`Webhook ${label} contains unsupported characters`);
  }
  return normalized;
}
function isPrivateWebhookHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
    return true;
  }
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168 || octets[0] >= 224;
}
function isDevelopmentLoopbackWebhookUrl(parsed) {
  if (process.env.NODE_ENV === "production") return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (parsed.protocol === "http:" || parsed.protocol === "https:") && (host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "::1");
}
function webhookUrl(value) {
  const normalized = safeString(value);
  if (!normalized || normalized.length > 2048) throw new Error("Webhook URL is invalid");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Webhook URL is invalid");
  }
  const isDevelopmentLoopback = isDevelopmentLoopbackWebhookUrl(parsed);
  if (!isDevelopmentLoopback && parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !parsed.hostname || !isDevelopmentLoopback && isPrivateWebhookHost(parsed.hostname)) {
    throw new Error("Webhook URL must be a public HTTPS destination");
  }
  return parsed.toString();
}
function webhookStringList(value, label, validator) {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_WEBHOOK_FILTER_ITEMS) {
    throw new Error(`Webhook ${label} list is invalid`);
  }
  return Array.from(new Set(value.map((entry) => validator(entry, label))));
}
function webhookOverrides(value) {
  if (value == null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Webhook event-name overrides are invalid");
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_RUNTIME_WEBHOOK_OVERRIDES) {
    throw new Error("Webhook has too many event-name overrides");
  }
  return Object.fromEntries(
    entries.map(([key, eventName]) => [
      webhookEventKey(key, "override key"),
      webhookEventKey(eventName, "custom event name")
    ])
  );
}
function webhookTimestamp(value, label) {
  if (value == null || value === "") return null;
  const normalized = safeString(value);
  if (!normalized || normalized.length > 80 || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`Webhook ${label} is invalid`);
  }
  return normalized;
}
function connectedWebhookEventType(value) {
  return {
    key: webhookEventKey(value?.key),
    name: webhookName(value?.name),
    description: webhookDescription(value?.description)
  };
}
function connectedWebhookSubscription(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Webhook adapter returned an invalid subscription");
  }
  const status = safeString(value.last_delivery_status ?? "");
  if (status && !RUNTIME_WEBHOOK_DELIVERY_STATUSES.has(status)) {
    throw new Error("Webhook adapter returned an invalid delivery status");
  }
  const statusCode = value.last_status_code == null ? null : Number(value.last_status_code);
  if (statusCode != null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) {
    throw new Error("Webhook adapter returned an invalid response status");
  }
  const lastError = safeString(value.last_error ?? "").slice(0, 1e3) || null;
  return {
    id: webhookReference(value.id, "id"),
    name: webhookName(value.name),
    description: webhookDescription(value.description),
    url: webhookUrl(value.url),
    event_types: webhookStringList(value.event_types, "event types", webhookEventKey),
    entities: webhookStringList(value.entities, "entities", webhookReference),
    event_name_overrides: webhookOverrides(value.event_name_overrides),
    enabled: value.enabled === true,
    signing_secret_present: value.signing_secret_present === true,
    last_delivery_at: webhookTimestamp(value.last_delivery_at, "last delivery timestamp"),
    last_delivery_status: status || "never",
    last_status_code: statusCode,
    last_error: lastError,
    created_at: webhookTimestamp(value.created_at, "created timestamp"),
    updated_at: webhookTimestamp(value.updated_at, "updated timestamp")
  };
}
function webhookCreateInput(value) {
  if (typeof value.enabled !== "boolean") throw new Error("Webhook enabled state is invalid");
  const eventTypes = webhookStringList(value.event_types, "event types", webhookEventKey);
  if (eventTypes.length === 0) throw new Error("Webhook requires at least one event type");
  return {
    name: webhookName(value.name),
    description: webhookDescription(value.description),
    url: webhookUrl(value.url),
    eventTypes,
    entities: webhookStringList(value.entities ?? [], "entities", webhookReference),
    eventNameOverrides: webhookOverrides(value.event_name_overrides),
    enabled: value.enabled
  };
}
function webhookUpdateInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Webhook update command is invalid");
  }
  const changes = value;
  const input = {};
  if (Object.prototype.hasOwnProperty.call(changes, "name")) input.name = webhookName(changes.name);
  if (Object.prototype.hasOwnProperty.call(changes, "description")) {
    input.description = webhookDescription(changes.description);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "url")) input.url = webhookUrl(changes.url);
  if (Object.prototype.hasOwnProperty.call(changes, "event_types")) {
    const eventTypes = webhookStringList(changes.event_types, "event types", webhookEventKey);
    if (eventTypes.length === 0) throw new Error("Webhook requires at least one event type");
    input.eventTypes = eventTypes;
  }
  if (Object.prototype.hasOwnProperty.call(changes, "entities")) {
    input.entities = webhookStringList(changes.entities, "entities", webhookReference);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "event_name_overrides")) {
    input.eventNameOverrides = webhookOverrides(changes.event_name_overrides);
  }
  if (Object.prototype.hasOwnProperty.call(changes, "enabled")) {
    if (typeof changes.enabled !== "boolean") throw new Error("Webhook enabled state is invalid");
    input.enabled = changes.enabled;
  }
  if (Object.keys(input).length === 0) throw new Error("Webhook update command has no changes");
  return input;
}
function webhookSigningSecret(value) {
  const normalized = safeString(value);
  if (normalized.length < 16 || normalized.length > 512) {
    throw new Error("Webhook adapter returned an invalid signing secret");
  }
  return normalized;
}
function webhookRetryResult(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Webhook adapter returned an invalid retry result");
  }
  const status = safeString(value.status);
  if (!RUNTIME_WEBHOOK_DELIVERY_STATUSES.has(status) || status === "never") {
    throw new Error("Webhook adapter returned an invalid retry status");
  }
  const statusCode = value.statusCode == null ? null : Number(value.statusCode);
  if (statusCode != null && (!Number.isInteger(statusCode) || statusCode < 100 || statusCode > 599)) {
    throw new Error("Webhook adapter returned an invalid retry response status");
  }
  return {
    status,
    status_code: statusCode,
    attempted_at: webhookTimestamp(value.attemptedAt, "retry timestamp"),
    error: safeString(value.error ?? "").slice(0, 1e3) || null
  };
}
function eventStreamReference(value, label) {
  const normalized = safeString(value);
  if (!RUNTIME_EVENT_STREAM_REFERENCE.test(normalized)) {
    throw new Error(`Event stream ${label} contains unsupported characters`);
  }
  return normalized;
}
function eventStreamKey(value, label) {
  const normalized = safeString(value);
  if (!RUNTIME_EVENT_STREAM_KEY.test(normalized)) {
    throw new Error(`Event stream ${label} contains unsupported characters`);
  }
  return normalized;
}
function eventStreamOptionalReference(value, label) {
  if (value == null || value === "") return null;
  return eventStreamReference(value, label);
}
function eventStreamTimestamp(value, label) {
  if (value == null || value === "") return null;
  const normalized = safeString(value);
  if (!normalized || normalized.length > 80 || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`Event stream ${label} is invalid`);
  }
  return normalized;
}
function eventStreamPayload(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Event stream payload must be a JSON object");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Event stream payload must be valid JSON");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RUNTIME_EVENT_STREAM_PAYLOAD_BYTES) {
    throw new Error("Event stream payload exceeds the dashboard transfer limit");
  }
  return JSON.parse(serialized);
}
function eventStreamChannel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Event stream adapter returned an invalid channel");
  }
  const name = safeString(value.name);
  const description = safeString(value.description ?? "");
  if (!name || name.length > 160 || description.length > 1e3) {
    throw new Error("Event stream adapter returned invalid channel metadata");
  }
  return {
    key: eventStreamKey(value.key, "channel key"),
    name,
    description: description || null,
    publishable: value.publishable === true
  };
}
function eventStreamRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Event stream adapter returned an invalid event");
  }
  const createdAt = eventStreamTimestamp(value.created_at, "event timestamp");
  if (!createdAt) throw new Error("Event stream adapter returned an event without a timestamp");
  return {
    id: eventStreamReference(value.id, "event id"),
    event_type: eventStreamKey(value.event_type, "event type"),
    channel: eventStreamKey(value.channel, "channel"),
    payload: eventStreamPayload(value.payload),
    entity: eventStreamOptionalReference(value.entity, "entity"),
    action: eventStreamOptionalReference(value.action, "action"),
    subject: eventStreamOptionalReference(value.subject, "subject"),
    created_at: createdAt
  };
}
function eventStreamStringList(value) {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_EVENT_STREAM_EVENT_TYPES) {
    throw new Error("Event stream event-type filter is invalid");
  }
  return Array.from(new Set(value.map((entry) => eventStreamKey(entry, "event type"))));
}
function eventStreamListInput(value) {
  const rawLimit = Number(value.limit ?? 100);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_RUNTIME_EVENT_STREAM_EVENTS) {
    throw new Error("Event stream page limit is invalid");
  }
  const search = safeString(value.search ?? "");
  const cursor = safeString(value.cursor ?? "");
  if (search.length > MAX_RUNTIME_EVENT_STREAM_SEARCH_LENGTH) {
    throw new Error("Event stream search is too long");
  }
  if (cursor.length > MAX_RUNTIME_EVENT_STREAM_CURSOR_LENGTH) {
    throw new Error("Event stream cursor is too long");
  }
  return {
    channel: value.channel == null || value.channel === "" ? null : eventStreamKey(value.channel, "channel"),
    eventTypes: eventStreamStringList(value.event_types ?? []),
    entity: eventStreamOptionalReference(value.entity, "entity"),
    search: search || null,
    after: eventStreamTimestamp(value.after, "after timestamp"),
    before: eventStreamTimestamp(value.before, "before timestamp"),
    limit: rawLimit,
    cursor: cursor || null
  };
}
function eventStreamNextCursor(value) {
  if (value == null || value === "") return null;
  const cursor = safeString(value);
  if (!cursor || cursor.length > MAX_RUNTIME_EVENT_STREAM_CURSOR_LENGTH) {
    throw new Error("Event stream adapter returned an invalid cursor");
  }
  return cursor;
}
function eventStreamPublishInput(value) {
  return {
    eventType: eventStreamKey(value.event_type, "event type"),
    channel: eventStreamKey(value.channel, "channel"),
    payload: eventStreamPayload(value.payload)
  };
}
function eventStreamUrl(value, label) {
  const normalized = safeString(value);
  if (!normalized || normalized.length > 2048) throw new Error(`Event stream ${label} is invalid`);
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`Event stream ${label} is invalid`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash || !parsed.hostname || isPrivateWebhookHost(parsed.hostname)) {
    throw new Error(`Event stream ${label} must be a public HTTPS URL`);
  }
  return parsed.toString();
}
function eventStreamConnection(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Event stream adapter returned invalid connection metadata");
  }
  if (!RUNTIME_EVENT_STREAM_AUTH_MODES.has(value.authMode)) {
    throw new Error("Event stream adapter returned an unsupported auth mode");
  }
  return {
    stream_url: eventStreamUrl(value.streamUrl, "stream URL"),
    history_url: value.historyUrl == null || value.historyUrl === "" ? null : eventStreamUrl(value.historyUrl, "history URL"),
    auth_mode: value.authMode
  };
}
function runtimeLogReference(value, label) {
  const normalized = safeString(value);
  if (!RUNTIME_LOG_REFERENCE.test(normalized)) {
    throw new Error(`Log ${label} contains unsupported characters`);
  }
  return normalized;
}
function runtimeLogOptionalText(value, label, maxLength = 320) {
  if (value == null || value === "") return null;
  const normalized = safeString(value);
  if (!normalized || normalized.length > maxLength) throw new Error(`Log ${label} is invalid`);
  return normalized;
}
function runtimeLogTimestamp(value, label) {
  if (value == null || value === "") return null;
  const normalized = safeString(value);
  if (!normalized || normalized.length > 80 || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`Log ${label} is invalid`);
  }
  return normalized;
}
function runtimeLogAttributes(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Log attributes must be a JSON object");
  }
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Log attributes must be valid JSON");
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_RUNTIME_LOG_ATTRIBUTES_BYTES) {
    throw new Error("Log attributes exceed the dashboard transfer limit");
  }
  return JSON.parse(serialized);
}
function runtimeLogSource(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Log adapter returned an invalid source");
  }
  const name = safeString(value.name);
  const description = safeString(value.description ?? "");
  if (!name || name.length > 160 || description.length > 1e3) {
    throw new Error("Log adapter returned invalid source metadata");
  }
  return {
    key: runtimeLogReference(value.key, "source key"),
    name,
    description: description || null,
    service: runtimeLogOptionalText(value.service, "source service"),
    environment: runtimeLogOptionalText(value.environment, "source environment")
  };
}
function runtimeLogEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Log adapter returned an invalid entry");
  }
  const timestamp = runtimeLogTimestamp(value.timestamp, "timestamp");
  const message = typeof value.message === "string" ? value.message : "";
  if (!timestamp || !message || message.length > MAX_RUNTIME_LOG_MESSAGE_LENGTH) {
    throw new Error("Log adapter returned invalid entry content");
  }
  if (!RUNTIME_LOG_LEVELS.has(value.level)) {
    throw new Error("Log adapter returned an invalid level");
  }
  return {
    id: runtimeLogReference(value.id, "entry id"),
    timestamp,
    level: value.level,
    message,
    source: runtimeLogReference(value.source, "source"),
    service: runtimeLogOptionalText(value.service, "service"),
    environment: runtimeLogOptionalText(value.environment, "environment"),
    logger: runtimeLogOptionalText(value.logger, "logger"),
    request_id: runtimeLogOptionalText(value.request_id, "request id"),
    trace_id: runtimeLogOptionalText(value.trace_id, "trace id"),
    attributes: runtimeLogAttributes(value.attributes)
  };
}
function runtimeLogFilterList(value, label) {
  if (!Array.isArray(value) || value.length > MAX_RUNTIME_LOG_FILTER_ITEMS) {
    throw new Error(`Log ${label} filter is invalid`);
  }
  return Array.from(new Set(value.map((item) => runtimeLogReference(item, label))));
}
function runtimeLogQueryInput(value) {
  const rawLimit = Number(value.limit ?? 100);
  if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_RUNTIME_LOG_ENTRIES) {
    throw new Error("Log page limit is invalid");
  }
  const rawLevels = Array.isArray(value.levels) ? value.levels : [];
  if (rawLevels.length > 4 || rawLevels.some((level) => !RUNTIME_LOG_LEVELS.has(level))) {
    throw new Error("Log level filter is invalid");
  }
  const search = safeString(value.search ?? "");
  const cursor = safeString(value.cursor ?? "");
  if (search.length > MAX_RUNTIME_LOG_SEARCH_LENGTH) throw new Error("Log search is too long");
  if (cursor.length > MAX_RUNTIME_LOG_CURSOR_LENGTH) throw new Error("Log cursor is too long");
  return {
    levels: Array.from(new Set(rawLevels)),
    sources: runtimeLogFilterList(value.sources ?? [], "source"),
    services: runtimeLogFilterList(value.services ?? [], "service"),
    environments: runtimeLogFilterList(value.environments ?? [], "environment"),
    search: search || null,
    logger: runtimeLogOptionalText(value.logger, "logger"),
    requestId: runtimeLogOptionalText(value.request_id, "request id"),
    traceId: runtimeLogOptionalText(value.trace_id, "trace id"),
    after: runtimeLogTimestamp(value.after, "after timestamp"),
    before: runtimeLogTimestamp(value.before, "before timestamp"),
    limit: rawLimit,
    cursor: cursor || null
  };
}
function runtimeLogNextCursor(value) {
  if (value == null || value === "") return null;
  const cursor = safeString(value);
  if (!cursor || cursor.length > MAX_RUNTIME_LOG_CURSOR_LENGTH) {
    throw new Error("Log adapter returned an invalid cursor");
  }
  return cursor;
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
function optionalSchemaString(value, field, maxLength = 320) {
  if (value === void 0 || value === null || value === "") return null;
  const normalized = safeString(value);
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`Runtime schema ${field} is invalid`);
  }
  return normalized;
}
function runtimeSchemaIdentifier(value, field) {
  const normalized = safeString(value);
  if (!RUNTIME_SCHEMA_IDENTIFIER.test(normalized)) {
    throw new Error(`Runtime schema ${field} must start with a letter and use only letters, digits, hyphens, or underscores`);
  }
  return normalized;
}
function runtimeSchemaNumber(value, field) {
  if (value === void 0 || value === null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Runtime schema ${field} must be finite`);
  return number;
}
function jsonValue(value, depth = 0) {
  if (depth > 20) throw new Error("Runtime schema JSON values may not be nested more than 20 levels");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Runtime schema JSON values must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item, depth + 1));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const record = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key || key.length > 200) throw new Error("Runtime schema JSON object key is invalid");
      record[key] = jsonValue(item, depth + 1);
    }
    return record;
  }
  throw new Error("Runtime schema values must be JSON-compatible");
}
function schemaRoles(value, field) {
  if (value === void 0 || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`Runtime schema ${field} must be an array`);
  const roles = Array.from(new Set(value.map((role) => safeString(role)).filter(Boolean)));
  if (roles.length > 100 || roles.some((role) => role.length > 100)) {
    throw new Error(`Runtime schema ${field} is invalid`);
  }
  return roles;
}
function runtimeSchemaField(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime schema field must be an object");
  }
  const field = value;
  const name = runtimeSchemaIdentifier(field.name, "field name");
  const rawType = safeString(field.type);
  if (!RUNTIME_SCHEMA_FIELD_TYPES.has(rawType)) {
    throw new Error(`Runtime schema field ${name} has an unsupported type`);
  }
  const relationKind = optionalSchemaString(field.relation_kind, "relation kind", 32);
  if (relationKind && !RUNTIME_SCHEMA_RELATION_KINDS.has(relationKind)) {
    throw new Error(`Runtime schema field ${name} has an unsupported relation kind`);
  }
  const relationOnDelete = optionalSchemaString(field.relation_on_delete, "relation delete action", 32);
  if (relationOnDelete && !RUNTIME_SCHEMA_DELETE_ACTIONS.has(relationOnDelete)) {
    throw new Error(`Runtime schema field ${name} has an unsupported relation delete action`);
  }
  let enumValues = null;
  if (field.enum !== void 0 && field.enum !== null) {
    if (!Array.isArray(field.enum) || field.enum.some((item) => item !== null && !["string", "number", "boolean"].includes(typeof item))) {
      throw new Error(`Runtime schema field ${name} enum must contain JSON primitives`);
    }
    enumValues = field.enum;
  }
  let items = null;
  if (field.items !== void 0 && field.items !== null) {
    if (!field.items || typeof field.items !== "object" || Array.isArray(field.items)) {
      throw new Error(`Runtime schema field ${name} items must be an object`);
    }
    const itemType = safeString(field.items.type);
    if (itemType && !RUNTIME_SCHEMA_FIELD_TYPES.has(itemType)) {
      throw new Error(`Runtime schema field ${name} items has an unsupported type`);
    }
    items = itemType ? { type: itemType } : {};
  }
  const normalized = {
    name,
    type: rawType,
    required: field.required === true,
    unique: field.unique === true,
    indexed: field.indexed === true,
    description: optionalSchemaString(field.description, "field description", 2e3),
    relation_entity: optionalSchemaString(field.relation_entity, "relation entity", 64),
    relation_kind: relationKind,
    relation_field: optionalSchemaString(field.relation_field, "relation field", 64),
    relation_on_delete: relationOnDelete,
    enum: enumValues,
    pattern: optionalSchemaString(field.pattern, "field pattern", 500),
    min_length: runtimeSchemaNumber(field.min_length, "field min_length"),
    max_length: runtimeSchemaNumber(field.max_length, "field max_length"),
    minimum: runtimeSchemaNumber(field.minimum, "field minimum"),
    maximum: runtimeSchemaNumber(field.maximum, "field maximum"),
    items,
    default_value: field.default_value === void 0 ? void 0 : jsonValue(field.default_value)
  };
  if (normalized.type === "relation" && !normalized.relation_entity) {
    throw new Error(`Runtime schema relation field ${name} must name a target collection`);
  }
  if (normalized.type !== "relation" && [
    normalized.relation_entity,
    normalized.relation_kind,
    normalized.relation_field,
    normalized.relation_on_delete
  ].some((value2) => value2 != null)) {
    throw new Error(`Runtime schema field ${name} has relation metadata but is not a relation`);
  }
  if (normalized.required && normalized.relation_on_delete === "set_null") {
    throw new Error(`Runtime schema field ${name} cannot be required with a set_null relation`);
  }
  if ([normalized.min_length, normalized.max_length].some(
    (value2) => value2 != null && (!Number.isInteger(value2) || value2 < 0)
  )) {
    throw new Error(`Runtime schema field ${name} has an invalid length limit`);
  }
  if (normalized.min_length != null && normalized.max_length != null && normalized.min_length > normalized.max_length) {
    throw new Error(`Runtime schema field ${name} has an invalid length range`);
  }
  if (normalized.minimum != null && normalized.maximum != null && normalized.minimum > normalized.maximum) {
    throw new Error(`Runtime schema field ${name} has an invalid numeric range`);
  }
  return normalized;
}
function validateRuntimeSchemaDocument(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime schema document must be an object");
  }
  const rawEntities = value.entities;
  if (!Array.isArray(rawEntities) || rawEntities.length > MAX_RUNTIME_SCHEMA_ENTITIES) {
    throw new Error(`Runtime schema must contain at most ${MAX_RUNTIME_SCHEMA_ENTITIES} collections`);
  }
  const names = /* @__PURE__ */ new Set();
  const entities = rawEntities.map((rawEntity) => {
    if (!rawEntity || typeof rawEntity !== "object" || Array.isArray(rawEntity)) {
      throw new Error("Runtime schema collection must be an object");
    }
    const entity = rawEntity;
    const name = runtimeSchemaIdentifier(entity.name, "collection name");
    if (names.has(name)) throw new Error(`Runtime schema contains duplicate collection ${name}`);
    names.add(name);
    if (!Array.isArray(entity.fields) || entity.fields.length > MAX_RUNTIME_SCHEMA_FIELDS) {
      throw new Error(`Runtime schema collection ${name} must contain at most ${MAX_RUNTIME_SCHEMA_FIELDS} fields`);
    }
    const fieldNames = /* @__PURE__ */ new Set();
    const fields = entity.fields.map((rawField) => {
      const field = runtimeSchemaField(rawField);
      if (fieldNames.has(field.name)) {
        throw new Error(`Runtime schema collection ${name} contains duplicate field ${field.name}`);
      }
      fieldNames.add(field.name);
      return field;
    });
    return {
      name,
      label: optionalSchemaString(entity.label, "collection label", 120),
      description: optionalSchemaString(entity.description, "collection description", 2e3),
      is_public: entity.is_public === true,
      realtime_enabled: entity.realtime_enabled === void 0 || entity.realtime_enabled === null ? null : entity.realtime_enabled === true,
      read_roles: schemaRoles(entity.read_roles, "collection read_roles"),
      write_roles: schemaRoles(entity.write_roles, "collection write_roles"),
      fields
    };
  });
  for (const entity of entities) {
    for (const field of entity.fields) {
      if (field.relation_entity && !names.has(field.relation_entity)) {
        throw new Error(
          `Runtime schema relation ${entity.name}.${field.name} targets an unknown collection ${field.relation_entity}`
        );
      }
    }
  }
  const normalized = { entities };
  const encoded = JSON.stringify(normalized);
  if (encoded.length > MAX_RUNTIME_SCHEMA_BYTES) {
    throw new Error(`Runtime schema exceeds the ${MAX_RUNTIME_SCHEMA_BYTES}-byte management limit`);
  }
  return normalized;
}
function runtimeSchemaSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Runtime schema adapter returned an invalid snapshot");
  }
  const snapshot = value;
  const revision = safeString(snapshot.revision);
  if (!revision || revision.length > 200) {
    throw new Error("Runtime schema adapter returned an invalid revision");
  }
  return {
    revision,
    schema: validateRuntimeSchemaDocument(snapshot.schema),
    updated_at: optionalSchemaString(snapshot.updated_at, "schema updated_at", 80)
  };
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
  serviceAccountAdapter;
  storageAdapter;
  cacheAdapter;
  schemaAdapter;
  functionsAdapter;
  cronAdapter;
  webhooksAdapter;
  eventStreamAdapter;
  logsAdapter;
  integrationProbes;
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
    this.serviceAccountAdapter = options.serviceAccounts;
    this.storageAdapter = options.storage;
    this.cacheAdapter = options.cache;
    this.schemaAdapter = options.schema;
    this.functionsAdapter = options.functions;
    this.cronAdapter = options.cron;
    this.webhooksAdapter = options.webhooks;
    this.eventStreamAdapter = options.eventStream;
    this.logsAdapter = options.logsAdapter;
    this.integrationProbes = { ...options.integrations ?? {} };
    this.commandPollIntervalMs = Math.max(5, options.commandPollIntervalMs ?? DEFAULT_COMMAND_POLL_INTERVAL_MS);
    if ((this.userAdapter || this.serviceAccountAdapter || this.storageAdapter || this.cacheAdapter || this.schemaAdapter || this.functionsAdapter || this.cronAdapter || this.webhooksAdapter || this.eventStreamAdapter || this.logsAdapter || Object.keys(this.integrationProbes).length > 0) && !this.heartbeatEnabled) {
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
    if (this.userAdapter || this.serviceAccountAdapter || this.storageAdapter || this.cacheAdapter || this.schemaAdapter || this.functionsAdapter || this.cronAdapter || this.webhooksAdapter || this.eventStreamAdapter || this.logsAdapter) {
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
      if (this.serviceAccountAdapter) capabilities.push("service-accounts");
      if (this.storageAdapter) capabilities.push("object-storage");
      if (this.schemaAdapter) capabilities.push("schema-builder");
      const integrationManifest = await this.integrationManifest();
      const userRoleCatalog = await this.userRoleCatalog();
      const payload = {
        runtime_name: this.service,
        sdk_name: "@dutchwebservices/baas-runtime",
        sdk_version: VERSION,
        capabilities,
        capability_manifest_version: 1,
        integration_manifest: integrationManifest
      };
      if (userRoleCatalog !== void 0) {
        payload.user_role_catalog = userRoleCatalog;
      }
      const response = await this.post("/runtime/v1/heartbeat", payload);
      if (!response) return 0;
      const parsed = await response.json();
      return Math.max(15e3, Number(parsed.heartbeat_interval_seconds ?? 60) * 1e3);
    } catch (error) {
      this.reportError(error);
      return 6e4;
    }
  }
  async userRoleCatalog() {
    if (!this.userAdapter?.listRoles) return void 0;
    try {
      const catalog = await this.userAdapter.listRoles();
      if (!Array.isArray(catalog)) {
        throw new Error("Runtime user adapter returned an invalid role catalog");
      }
      const normalized = catalog.map(runtimeUserRoleOption);
      if (new Set(normalized.map((role) => role.key)).size !== normalized.length) {
        throw new Error("Runtime user adapter returned duplicate role keys");
      }
      return normalized;
    } catch (error) {
      this.reportError(error);
      return void 0;
    }
  }
  async integrationManifest() {
    const manifest = /* @__PURE__ */ new Map();
    if (this.userAdapter) {
      manifest.set("runtime-users", {
        key: "runtime-users",
        status: "enabled",
        verification: "adapter"
      });
    }
    if (this.serviceAccountAdapter) {
      manifest.set("service-accounts", {
        key: "service-accounts",
        status: "enabled",
        verification: "adapter"
      });
    }
    if (this.storageAdapter) {
      manifest.set("blob-storage", {
        key: "blob-storage",
        status: "enabled",
        verification: "adapter"
      });
    }
    if (this.cacheAdapter) {
      manifest.set("redis", {
        key: "redis",
        status: "enabled",
        verification: "adapter"
      });
    }
    if (this.schemaAdapter) {
      manifest.set("schema-builder", {
        key: "schema-builder",
        status: "enabled",
        verification: "adapter"
      });
    }
    if (this.functionsAdapter) {
      manifest.set("baas-functions", {
        key: "baas-functions",
        status: "enabled",
        verification: "adapter",
        operations: [
          "list",
          "invoke",
          ...this.functionsAdapter.update ? ["update"] : []
        ]
      });
    }
    if (this.cronAdapter) {
      manifest.set("cron", {
        key: "cron",
        status: "enabled",
        verification: "adapter",
        operations: ["targets", "list", "create", "update", "delete", "run"]
      });
    }
    if (this.webhooksAdapter) {
      manifest.set("webhooks", {
        key: "webhooks",
        status: "enabled",
        verification: "adapter",
        operations: [
          "event-types",
          "list",
          "create",
          "update",
          "delete",
          "rotate-secret",
          "retry"
        ]
      });
    }
    if (this.eventStreamAdapter) {
      manifest.set("event-stream", {
        key: "event-stream",
        status: "enabled",
        verification: "adapter",
        operations: ["channels", "list", "publish", "connection"]
      });
    }
    if (this.logsAdapter) {
      manifest.set("logs", {
        key: "logs",
        status: "enabled",
        verification: "adapter",
        operations: ["sources", "query"]
      });
    }
    for (const key of RUNTIME_INTEGRATION_CAPABILITIES) {
      const probe = this.integrationProbes[key];
      if (!probe || manifest.get(key)?.status === "enabled") continue;
      try {
        const probePassed = await probe() === true;
        manifest.set(key, {
          key,
          // These probes are diagnostics only. Their management surfaces require
          // explicit adapters above.
          status: key === "redis" || key === "schema-builder" || key === "service-accounts" || key === "baas-functions" || key === "cron" || key === "webhooks" || key === "event-stream" || key === "logs" ? "degraded" : probePassed ? "enabled" : "degraded",
          verification: "probe"
        });
      } catch (error) {
        this.reportError(error);
        manifest.set(key, { key, status: "degraded", verification: "probe" });
      }
    }
    return RUNTIME_INTEGRATION_CAPABILITIES.flatMap((key) => {
      const entry = manifest.get(key);
      return entry ? [entry] : [];
    });
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
    if (!this.started || !this.enabled || !this.userAdapter && !this.serviceAccountAdapter && !this.storageAdapter && !this.cacheAdapter && !this.schemaAdapter && !this.functionsAdapter && !this.cronAdapter && !this.webhooksAdapter && !this.eventStreamAdapter && !this.logsAdapter) {
      return;
    }
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
      } else if (command.action === "service_accounts.list") {
        if (!this.serviceAccountAdapter) {
          throw new Error("Runtime service account adapter is not configured");
        }
        const serviceAccounts = (await this.serviceAccountAdapter.list()).map(connectedServiceAccount);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { service_accounts: serviceAccounts }
        });
      } else if (command.action === "service_accounts.create") {
        if (!this.serviceAccountAdapter) {
          throw new Error("Runtime service account adapter is not configured");
        }
        const input = {
          name: safeString(command.payload.name),
          clientId: safeString(command.payload.client_id),
          clientSecret: safeString(command.payload.client_secret),
          scopes: Array.isArray(command.payload.scopes) ? command.payload.scopes.map((scope) => safeString(scope)).filter(Boolean) : []
        };
        if (!input.name || !input.clientId || !input.clientSecret) {
          throw new Error("Service account create command is missing required fields");
        }
        const serviceAccount = connectedServiceAccount(
          await this.serviceAccountAdapter.create(input)
        );
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { service_account: serviceAccount }
        });
      } else if (command.action === "service_accounts.delete") {
        if (!this.serviceAccountAdapter) {
          throw new Error("Runtime service account adapter is not configured");
        }
        const accountRef = safeString(command.payload.account_ref);
        if (!accountRef) throw new Error("Service account delete command is missing account_ref");
        await this.serviceAccountAdapter.remove(accountRef);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: {}
        });
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
      } else if (command.action === "cache.list") {
        if (!this.cacheAdapter) throw new Error("Cache adapter is not configured");
        const listed = await this.cacheAdapter.list({
          prefix: cacheOptionalString(command.payload.prefix, "prefix"),
          limit: Math.max(1, Math.min(200, Number(command.payload.limit) || 100)),
          cursor: cacheOptionalString(command.payload.cursor, "cursor")
        });
        const entries = (Array.isArray(listed) ? listed : listed.entries).map(cacheEntrySummary);
        const nextCursor = Array.isArray(listed) ? null : cacheOptionalString(listed.next_cursor, "cursor");
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { entries, next_cursor: nextCursor }
        });
      } else if (command.action === "cache.get") {
        if (!this.cacheAdapter) throw new Error("Cache adapter is not configured");
        const key = cacheKey(command.payload.key);
        const result = await this.cacheAdapter.get(key);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { entry: result ? cacheEntry(result) : null }
        });
      } else if (command.action === "cache.set") {
        if (!this.cacheAdapter) throw new Error("Cache adapter is not configured");
        const entry = cacheEntry(await this.cacheAdapter.set({
          key: cacheKey(command.payload.key),
          value: cacheJsonValue(command.payload.value),
          ttlSeconds: cacheTtl(command.payload.ttl_seconds)
        }));
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { entry }
        });
      } else if (command.action === "cache.delete") {
        if (!this.cacheAdapter) throw new Error("Cache adapter is not configured");
        await this.cacheAdapter.remove(cacheKey(command.payload.key));
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: {}
        });
      } else if (command.action === "cache.clear") {
        if (!this.cacheAdapter) throw new Error("Cache adapter is not configured");
        const prefix = cacheOptionalString(command.payload.prefix, "prefix");
        const all = command.payload.all === true;
        if (!prefix && !all) throw new Error("Cache clear requires a prefix or all=true");
        const cleared = await this.cacheAdapter.clear({ prefix, all });
        const deleted = Number(cleared.deleted);
        if (!Number.isInteger(deleted) || deleted < 0) {
          throw new Error("Cache adapter returned an invalid deleted count");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { deleted }
        });
      } else if (command.action === "schema.read") {
        if (!this.schemaAdapter) throw new Error("Runtime schema adapter is not configured");
        const snapshot = runtimeSchemaSnapshot(await this.schemaAdapter.read());
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { snapshot }
        });
      } else if (command.action === "schema.write") {
        if (!this.schemaAdapter) throw new Error("Runtime schema adapter is not configured");
        const schema = validateRuntimeSchemaDocument(command.payload.schema);
        const expectedRevision = safeString(command.payload.expected_revision).trim();
        if (!expectedRevision || expectedRevision.length > 200) {
          throw new Error("Schema write command is missing a valid expected revision");
        }
        const snapshot = runtimeSchemaSnapshot(
          await this.schemaAdapter.apply({ schema, expectedRevision })
        );
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { snapshot }
        });
      } else if (command.action === "functions.list") {
        if (!this.functionsAdapter) throw new Error("Function adapter is not configured");
        const listed = await this.functionsAdapter.list();
        if (!Array.isArray(listed) || listed.length > MAX_RUNTIME_FUNCTIONS) {
          throw new Error("Function adapter returned an invalid function list");
        }
        const functions = listed.map(connectedFunction);
        if (new Set(functions.map((entry) => entry.id)).size !== functions.length) {
          throw new Error("Function adapter returned duplicate function ids");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { functions }
        });
      } else if (command.action === "functions.invoke") {
        if (!this.functionsAdapter) throw new Error("Function adapter is not configured");
        const functionRef = functionReference(command.payload.function_ref);
        const payload = boundedFunctionJson(
          command.payload.payload ?? null,
          MAX_RUNTIME_FUNCTION_PAYLOAD_BYTES,
          "Function payload"
        );
        const invocation = functionInvocationResult(
          await this.functionsAdapter.invoke(functionRef, { payload })
        );
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { invocation }
        });
      } else if (command.action === "functions.update") {
        if (!this.functionsAdapter?.update) {
          throw new Error("Function adapter does not support configuration updates");
        }
        const functionRef = functionReference(command.payload.function_ref);
        const input = {};
        if (Object.prototype.hasOwnProperty.call(command.payload, "enabled")) {
          if (typeof command.payload.enabled !== "boolean") {
            throw new Error("Function enabled state is invalid");
          }
          input.enabled = command.payload.enabled;
        }
        if (Object.prototype.hasOwnProperty.call(command.payload, "auth_mode")) {
          const authMode = safeString(command.payload.auth_mode);
          if (!RUNTIME_FUNCTION_AUTH_MODES.has(authMode)) {
            throw new Error("Function auth mode is invalid");
          }
          input.authMode = authMode;
        }
        if (Object.prototype.hasOwnProperty.call(command.payload, "rate_limit")) {
          input.rateLimit = functionRateLimit(command.payload.rate_limit);
        }
        if (Object.keys(input).length === 0) {
          throw new Error("Function update command has no changes");
        }
        const updated = connectedFunction(
          await this.functionsAdapter.update(functionRef, input)
        );
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { function: updated }
        });
      } else if (command.action === "cron.targets") {
        if (!this.cronAdapter) throw new Error("Schedule adapter is not configured");
        const listed = await this.cronAdapter.listTargets();
        if (!Array.isArray(listed) || listed.length > MAX_RUNTIME_CRON_TARGETS) {
          throw new Error("Schedule adapter returned an invalid target list");
        }
        const targets = listed.map(connectedCronTarget);
        if (new Set(targets.map((entry) => `${entry.type}:${entry.id}`)).size !== targets.length) {
          throw new Error("Schedule adapter returned duplicate targets");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { targets }
        });
      } else if (command.action === "cron.list") {
        if (!this.cronAdapter) throw new Error("Schedule adapter is not configured");
        const listed = await this.cronAdapter.list();
        if (!Array.isArray(listed) || listed.length > MAX_RUNTIME_CRON_SCHEDULES) {
          throw new Error("Schedule adapter returned an invalid schedule list");
        }
        const schedules = listed.map(connectedCronSchedule);
        if (new Set(schedules.map((entry) => entry.id)).size !== schedules.length) {
          throw new Error("Schedule adapter returned duplicate schedule ids");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { schedules }
        });
      } else if (command.action === "cron.create") {
        if (!this.cronAdapter) throw new Error("Schedule adapter is not configured");
        const schedule = connectedCronSchedule(
          await this.cronAdapter.create(cronCreateInput(command.payload))
        );
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { schedule }
        });
      } else if (command.action === "cron.update") {
        if (!this.cronAdapter) throw new Error("Schedule adapter is not configured");
        const scheduleRef = cronReference(command.payload.schedule_ref, "reference");
        const schedule = connectedCronSchedule(
          await this.cronAdapter.update(scheduleRef, cronUpdateInput(command.payload.changes))
        );
        if (schedule.id !== scheduleRef) {
          throw new Error("Schedule adapter changed the schedule id during update");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { schedule }
        });
      } else if (command.action === "cron.delete") {
        if (!this.cronAdapter) throw new Error("Schedule adapter is not configured");
        const scheduleRef = cronReference(command.payload.schedule_ref, "reference");
        await this.cronAdapter.remove(scheduleRef);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { deleted: true }
        });
      } else if (command.action === "cron.run") {
        if (!this.cronAdapter) throw new Error("Schedule adapter is not configured");
        const scheduleRef = cronReference(command.payload.schedule_ref, "reference");
        const run = cronRunResult(await this.cronAdapter.run(scheduleRef));
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { run }
        });
      } else if (command.action === "webhooks.event-types") {
        if (!this.webhooksAdapter) throw new Error("Webhook adapter is not configured");
        const listed = await this.webhooksAdapter.listEventTypes();
        if (!Array.isArray(listed) || listed.length > MAX_RUNTIME_WEBHOOK_EVENT_TYPES) {
          throw new Error("Webhook adapter returned an invalid event-type list");
        }
        const eventTypes = listed.map(connectedWebhookEventType);
        if (new Set(eventTypes.map((entry) => entry.key)).size !== eventTypes.length) {
          throw new Error("Webhook adapter returned duplicate event types");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { event_types: eventTypes }
        });
      } else if (command.action === "webhooks.list") {
        if (!this.webhooksAdapter) throw new Error("Webhook adapter is not configured");
        const listed = await this.webhooksAdapter.list();
        if (!Array.isArray(listed) || listed.length > MAX_RUNTIME_WEBHOOK_SUBSCRIPTIONS) {
          throw new Error("Webhook adapter returned an invalid subscription list");
        }
        const subscriptions = listed.map(connectedWebhookSubscription);
        if (new Set(subscriptions.map((entry) => entry.id)).size !== subscriptions.length) {
          throw new Error("Webhook adapter returned duplicate subscription ids");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { subscriptions }
        });
      } else if (command.action === "webhooks.create") {
        if (!this.webhooksAdapter) throw new Error("Webhook adapter is not configured");
        const created = await this.webhooksAdapter.create(webhookCreateInput(command.payload));
        if (!created || typeof created !== "object") {
          throw new Error("Webhook adapter returned an invalid create result");
        }
        const subscription = connectedWebhookSubscription(created.subscription);
        const signingSecret = created.signingSecret == null ? null : webhookSigningSecret(created.signingSecret);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { subscription, signing_secret: signingSecret }
        });
      } else if (command.action === "webhooks.update") {
        if (!this.webhooksAdapter) throw new Error("Webhook adapter is not configured");
        const subscriptionRef = webhookReference(command.payload.subscription_ref);
        const subscription = connectedWebhookSubscription(
          await this.webhooksAdapter.update(
            subscriptionRef,
            webhookUpdateInput(command.payload.changes)
          )
        );
        if (subscription.id !== subscriptionRef) {
          throw new Error("Webhook adapter changed the subscription id during update");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { subscription }
        });
      } else if (command.action === "webhooks.delete") {
        if (!this.webhooksAdapter) throw new Error("Webhook adapter is not configured");
        const subscriptionRef = webhookReference(command.payload.subscription_ref);
        await this.webhooksAdapter.remove(subscriptionRef);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { deleted: true }
        });
      } else if (command.action === "webhooks.rotate-secret") {
        if (!this.webhooksAdapter) throw new Error("Webhook adapter is not configured");
        const subscriptionRef = webhookReference(command.payload.subscription_ref);
        const rotated = await this.webhooksAdapter.rotateSecret(subscriptionRef);
        const signingSecret = webhookSigningSecret(
          typeof rotated === "string" ? rotated : rotated?.signing_secret
        );
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { signing_secret: signingSecret }
        });
      } else if (command.action === "webhooks.retry") {
        if (!this.webhooksAdapter) throw new Error("Webhook adapter is not configured");
        const subscriptionRef = webhookReference(command.payload.subscription_ref);
        const delivery = webhookRetryResult(await this.webhooksAdapter.retry(subscriptionRef));
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: delivery
        });
      } else if (command.action === "event_stream.channels") {
        if (!this.eventStreamAdapter) throw new Error("Event stream adapter is not configured");
        const listed = await this.eventStreamAdapter.listChannels();
        if (!Array.isArray(listed) || listed.length > MAX_RUNTIME_EVENT_STREAM_CHANNELS) {
          throw new Error("Event stream adapter returned an invalid channel list");
        }
        const channels = listed.map(eventStreamChannel);
        if (new Set(channels.map((entry) => entry.key)).size !== channels.length) {
          throw new Error("Event stream adapter returned duplicate channel keys");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { channels }
        });
      } else if (command.action === "event_stream.list") {
        if (!this.eventStreamAdapter) throw new Error("Event stream adapter is not configured");
        const listed = await this.eventStreamAdapter.list(eventStreamListInput(command.payload));
        if (!listed || typeof listed !== "object" || !Array.isArray(listed.events)) {
          throw new Error("Event stream adapter returned an invalid event page");
        }
        if (listed.events.length > MAX_RUNTIME_EVENT_STREAM_EVENTS) {
          throw new Error("Event stream adapter returned too many events");
        }
        const events = listed.events.map(eventStreamRecord);
        if (new Set(events.map((entry) => entry.id)).size !== events.length) {
          throw new Error("Event stream adapter returned duplicate event ids");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { events, next_cursor: eventStreamNextCursor(listed.nextCursor) }
        });
      } else if (command.action === "event_stream.publish") {
        if (!this.eventStreamAdapter) throw new Error("Event stream adapter is not configured");
        const event = eventStreamRecord(
          await this.eventStreamAdapter.publish(eventStreamPublishInput(command.payload))
        );
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { event }
        });
      } else if (command.action === "event_stream.connection") {
        if (!this.eventStreamAdapter) throw new Error("Event stream adapter is not configured");
        const connection = eventStreamConnection(await this.eventStreamAdapter.connection());
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { connection }
        });
      } else if (command.action === "logs.sources") {
        if (!this.logsAdapter) throw new Error("Log adapter is not configured");
        const listed = await this.logsAdapter.listSources();
        if (!Array.isArray(listed) || listed.length > MAX_RUNTIME_LOG_SOURCES) {
          throw new Error("Log adapter returned an invalid source list");
        }
        const sources = listed.map(runtimeLogSource);
        if (new Set(sources.map((entry) => entry.key)).size !== sources.length) {
          throw new Error("Log adapter returned duplicate source keys");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { sources }
        });
      } else if (command.action === "logs.query") {
        if (!this.logsAdapter) throw new Error("Log adapter is not configured");
        const listed = await this.logsAdapter.query(runtimeLogQueryInput(command.payload));
        if (!listed || typeof listed !== "object" || !Array.isArray(listed.entries)) {
          throw new Error("Log adapter returned an invalid entry page");
        }
        if (listed.entries.length > MAX_RUNTIME_LOG_ENTRIES) {
          throw new Error("Log adapter returned too many entries");
        }
        const entries = listed.entries.map(runtimeLogEntry);
        if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
          throw new Error("Log adapter returned duplicate entry ids");
        }
        const result = { entries, next_cursor: runtimeLogNextCursor(listed.nextCursor) };
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_RUNTIME_LOG_RESULT_BYTES) {
          throw new Error("Log adapter result exceeds the dashboard transfer limit");
        }
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result
        });
      } else {
        throw new Error(`Unsupported runtime command: ${String(command.action)}`);
      }
      if (this.userAdapter && command.action.startsWith("users.")) await this.syncUsers();
    } catch (error) {
      await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
        ok: false,
        error: runtimeCommandError(command, error)
      });
      this.reportError(error);
    }
  }
  scheduleCommandPoll() {
    if (!this.started || !this.enabled || !this.userAdapter && !this.serviceAccountAdapter && !this.storageAdapter && !this.cacheAdapter && !this.schemaAdapter && !this.functionsAdapter && !this.cronAdapter && !this.webhooksAdapter && !this.eventStreamAdapter && !this.logsAdapter) {
      return;
    }
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
export {
  BaaSClient,
  BaaSError,
  BaaSRuntime,
  RUNTIME_INTEGRATION_CAPABILITIES,
  VERSION,
  createBaasClient,
  createBaasRuntime,
  validateRuntimeSchemaDocument
};
//# sourceMappingURL=index.js.map