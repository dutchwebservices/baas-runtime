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
  BaaSRuntime: () => BaaSRuntime,
  VERSION: () => VERSION,
  createBaasRuntime: () => createBaasRuntime
});
module.exports = __toCommonJS(index_exports);
var VERSION = "0.1.0";
var DEFAULT_MAX_QUEUE_SIZE = 1e3;
var DEFAULT_FLUSH_INTERVAL_MS = 1e3;
var DEFAULT_TIMEOUT_MS = 5e3;
function processEnv(name) {
  const candidate = globalThis;
  return candidate.process?.env?.[name];
}
function normalizedUrl(value) {
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
var BaaSRuntime = class {
  endpoint;
  enabled;
  metrics;
  logs;
  events;
  settings;
  token;
  service;
  environment;
  maxQueueSize;
  flushIntervalMs;
  timeoutMs;
  attributes;
  onError;
  fetchImpl;
  queues = {
    metrics: [],
    logs: [],
    events: []
  };
  flushTimer;
  heartbeatTimer;
  settingsCache;
  settingsEtag;
  started = false;
  constructor(options = {}) {
    this.endpoint = normalizedUrl(options.endpoint ?? processEnv("BAAS_RUNTIME_URL") ?? processEnv("BAAS_API_URL"));
    this.token = safeString(options.token ?? processEnv("BAAS_RUNTIME_TOKEN")) || void 0;
    this.enabled = Boolean(this.endpoint && this.token);
    this.service = safeString(options.service ?? processEnv("BAAS_RUNTIME_SERVICE")) || void 0;
    this.environment = safeString(options.environment ?? processEnv("BAAS_RUNTIME_ENV")) || void 0;
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.attributes = { ...options.attributes ?? {} };
    this.onError = options.onError;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
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
  }
  async start() {
    if (this.started || !this.enabled) return;
    this.started = true;
    const interval = await this.heartbeat();
    this.scheduleHeartbeat(interval);
  }
  async shutdown() {
    this.started = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = void 0;
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
      const response = await this.post("/runtime/v1/heartbeat", {
        runtime_name: this.service,
        sdk_name: "@dutchwebservices/baas-runtime",
        sdk_version: VERSION
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
  BaaSRuntime,
  VERSION,
  createBaasRuntime
});
//# sourceMappingURL=index.cjs.map