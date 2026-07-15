/**
 * BaaS Runtime SDK.  It has no runtime dependencies and is safe to use in
 * Node 18+ servers, including applications that are not hosted by BaaS.
 */

export const VERSION = "0.5.0";

export {
  BaaSClient,
  BaaSError,
  createBaasClient,
  type AccessTokenSource,
  type AuthSession,
  type BaaSClientOptions,
  type BaaSRequestOptions,
  type EntityCollection,
  type EntityData,
  type EntityDocument,
  type EntityListOptions,
  type EventListOptions,
  type FunctionInvokeOptions,
  type MachineToken,
  type RealtimeSubscription,
  type RealtimeSubscriptionOptions,
  type RuntimeEvent,
  type RuntimeUser,
  type StorageListOptions,
  type StorageObject,
  type TokenStorage,
  type WebhookCreateInput,
  type WebhookSubscription,
} from "./client.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type MetricKind = "counter" | "gauge" | "histogram" | "timing";
export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export interface RuntimeSettings {
  app_id: string;
  revision: number;
  values: Record<string, JsonValue>;
  updated_at?: string | null;
  project: { id: string; slug: string; name: string };
}

export interface ConnectedRuntimeUser {
  id: string;
  username: string;
  email?: string | null;
  name?: string | null;
  roles: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface ConnectedRuntimeUserCreateInput {
  username: string;
  password: string;
  email?: string | null;
  name?: string | null;
  roles: string[];
}

export interface RuntimeUserAdapter {
  /** Return users from the application's existing user store. Never include password data. */
  list: () => Promise<ConnectedRuntimeUser[]>;
  /** Create a user through the application's normal password hashing and validation path. */
  create: (input: ConnectedRuntimeUserCreateInput) => Promise<ConnectedRuntimeUser>;
  /** Delete a user by id, username, or email. */
  remove: (userRef: string) => Promise<void>;
}

export interface ConnectedStorageObject {
  key: string;
  size: number;
  content_type?: string | null;
  etag?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface RuntimeStorageListInput {
  prefix?: string | null;
  limit: number;
  offset: number;
}

export interface RuntimeStorageWriteInput {
  key: string;
  data: Uint8Array;
  contentType?: string | null;
}

export interface RuntimeStorageReadResult extends ConnectedStorageObject {
  data: Uint8Array;
}

export interface RuntimeObjectStorageAdapter {
  /** List objects from the application's existing object store. */
  list: (
    input: RuntimeStorageListInput,
  ) => Promise<ConnectedStorageObject[] | { objects: ConnectedStorageObject[]; total?: number | null }>;
  /** Create or replace an object without exposing provider credentials to BaaS. */
  write: (input: RuntimeStorageWriteInput) => Promise<ConnectedStorageObject>;
  /** Read an object for a bounded dashboard or CLI administration transfer. */
  read: (key: string) => Promise<RuntimeStorageReadResult>;
  /** Delete an object by key. */
  remove: (key: string) => Promise<void>;
}

export interface BaaSRuntimeOptions {
  /** Control-plane API URL. Defaults to BAAS_RUNTIME_URL then BAAS_API_URL. */
  endpoint?: string;
  /** Project-scoped runtime credential. Defaults to BAAS_RUNTIME_TOKEN. */
  token?: string;
  /** A readable name shown on the project connection page. */
  service?: string;
  /** Optional logical environment shown on logs. */
  environment?: string;
  /** Sends an initial heartbeat and keeps the connection visible. Default true. */
  heartbeat?: boolean;
  /** Exposes the application's existing user store to its BaaS dashboard and CLI. */
  users?: RuntimeUserAdapter;
  /** Exposes the application's object store to its BaaS dashboard and CLI. */
  storage?: RuntimeObjectStorageAdapter;
  /** How often connected management commands are checked. Default 2,000ms. */
  commandPollIntervalMs?: number;
  /** Maximum pending records of each kind. Default 1,000. */
  maxQueueSize?: number;
  /** Flush delay for batched telemetry. Default 1,000ms. */
  flushIntervalMs?: number;
  /** Request timeout. Default 5,000ms. */
  timeoutMs?: number;
  /** Makes missing runtime credentials throw instead of becoming a no-op. */
  required?: boolean;
  /** Extra context included with every metric. */
  attributes?: Record<string, JsonValue>;
  /** Observes background delivery failures without changing app behavior. */
  onError?: (error: unknown) => void;
  /** Allows tests or specialized runtimes to supply a fetch implementation. */
  fetch?: typeof fetch;
}

export interface RequestLike {
  method?: string;
  url?: string;
  originalUrl?: string;
  headers?: Record<string, string | string[] | undefined>;
}

export interface ResponseLike {
  statusCode?: number;
  setHeader?: (name: string, value: string) => void;
  once?: (event: "finish", callback: () => void) => void;
  on?: (event: "finish", callback: () => void) => void;
}

export type Next = (error?: unknown) => void;
export type HttpMiddleware = (request: RequestLike, response: ResponseLike, next: Next) => void;

type MetricRecord = {
  name: string;
  value: number;
  kind: MetricKind;
  unit: string;
  timestamp: string;
  attributes: Record<string, JsonValue>;
};

type LogRecord = {
  level: LogLevel;
  message: string;
  service?: string;
  logger?: string;
  request_id?: string;
  function_id?: string;
  function_name?: string;
  exception?: string;
  attributes?: Record<string, JsonValue>;
  timestamp: string;
};

type EventRecord = {
  name: string;
  channel?: string;
  payload: Record<string, JsonValue>;
  timestamp: string;
};

type QueueKind = "metrics" | "logs" | "events";

type RuntimeCommand = {
  id: string;
  action:
    | "users.create"
    | "users.delete"
    | "storage.list"
    | "storage.write"
    | "storage.read"
    | "storage.delete";
  payload: Record<string, unknown>;
};

const DEFAULT_MAX_QUEUE_SIZE = 1_000;
const DEFAULT_FLUSH_INTERVAL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_POLL_INTERVAL_MS = 2_000;
const MAX_STORAGE_BRIDGE_BYTES = 4 * 1024 * 1024;

function processEnv(name: string): string | undefined {
  const candidate = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return candidate.process?.env?.[name];
}

function normalizedUrl(value: string | undefined): string | undefined {
  const raw = value?.trim().replace(/\/+$/, "");
  return raw || undefined;
}

function safeString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function now(): string {
  return new Date().toISOString();
}

function randomRequestId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto?.getRandomValues?.(bytes);
  return `rt_${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function responseStatus(response: ResponseLike): number {
  const value = Number(response.statusCode ?? 200);
  return Number.isFinite(value) ? value : 200;
}

function allowProcessExit(timer: ReturnType<typeof setTimeout>): void {
  // Node timers keep a command-line process alive by default. The SDK is
  // best-effort telemetry, so a short-lived job must be allowed to finish.
  (timer as unknown as { unref?: () => void }).unref?.();
}

function requestHeader(request: RequestLike, name: string): string | undefined {
  const headers = request.headers ?? {};
  const direct = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(direct) ? direct[0] : direct;
}

function connectedUser(user: ConnectedRuntimeUser): ConnectedRuntimeUser {
  return {
    id: safeString(user.id),
    username: safeString(user.username),
    email: safeString(user.email ?? "") || null,
    name: safeString(user.name ?? "") || null,
    roles: Array.from(new Set((user.roles ?? []).map((role) => safeString(role)).filter(Boolean))),
    created_at: safeString(user.created_at ?? "") || null,
    updated_at: safeString(user.updated_at ?? "") || null,
  };
}

function connectedStorageObject(object: ConnectedStorageObject): ConnectedStorageObject {
  const size = Number(object.size);
  return {
    key: safeString(object.key),
    size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : -1,
    content_type: safeString(object.content_type ?? "") || null,
    etag: safeString(object.etag ?? "") || null,
    created_at: safeString(object.created_at ?? "") || null,
    updated_at: safeString(object.updated_at ?? "") || null,
  };
}

function validStorageObject(object: ConnectedStorageObject): ConnectedStorageObject {
  const normalized = connectedStorageObject(object);
  if (!normalized.key || normalized.size < 0) {
    throw new Error("Object storage adapter returned invalid object metadata");
  }
  return normalized;
}

function encodeBase64(data: Uint8Array): string {
  if (data.byteLength > MAX_STORAGE_BRIDGE_BYTES) {
    throw new Error(`Object exceeds the ${MAX_STORAGE_BRIDGE_BYTES}-byte dashboard transfer limit`);
  }
  if (typeof Buffer !== "undefined") return Buffer.from(data).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(value: unknown): Uint8Array {
  const encoded = safeString(value);
  if (!encoded) return new Uint8Array();
  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (encoded.length % 4 !== 0 || !canonicalBase64.test(encoded)) {
    throw new Error("Storage write command contains invalid object data");
  }
  const estimatedBytes = Math.floor((encoded.length * 3) / 4);
  if (estimatedBytes > MAX_STORAGE_BRIDGE_BYTES + 2) {
    throw new Error(`Object exceeds the ${MAX_STORAGE_BRIDGE_BYTES}-byte dashboard transfer limit`);
  }
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(encoded, "base64"));
  const binary = atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export class BaaSRuntime {
  readonly endpoint?: string;
  readonly enabled: boolean;
  readonly metrics: {
    increment: (name: string, value?: number, attributes?: Record<string, JsonValue>) => void;
    gauge: (name: string, value: number, attributes?: Record<string, JsonValue>) => void;
    timing: (name: string, value: number, attributes?: Record<string, JsonValue>) => void;
    observe: (name: string, value: number, attributes?: Record<string, JsonValue>) => void;
    http: () => HttpMiddleware;
  };
  readonly logs: {
    debug: (message: string, attributes?: Record<string, JsonValue>) => void;
    info: (message: string, attributes?: Record<string, JsonValue>) => void;
    warn: (message: string, attributes?: Record<string, JsonValue>) => void;
    error: (message: string, attributes?: Record<string, JsonValue> | Error) => void;
  };
  readonly events: {
    publish: (name: string, payload?: Record<string, JsonValue>, channel?: string) => void;
  };
  readonly settings: {
    get: (options?: { force?: boolean }) => Promise<RuntimeSettings | undefined>;
    clear: () => void;
  };
  readonly users: {
    /** Immediately refresh the sanitized dashboard/CLI user snapshot. */
    sync: () => Promise<boolean>;
  };

  private readonly token?: string;
  private readonly service?: string;
  private readonly environment?: string;
  private readonly maxQueueSize: number;
  private readonly flushIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly attributes: Record<string, JsonValue>;
  private readonly onError?: (error: unknown) => void;
  private readonly fetchImpl?: typeof fetch;
  private readonly heartbeatEnabled: boolean;
  private readonly userAdapter?: RuntimeUserAdapter;
  private readonly storageAdapter?: RuntimeObjectStorageAdapter;
  private readonly commandPollIntervalMs: number;
  private readonly queues: Record<QueueKind, Array<MetricRecord | LogRecord | EventRecord>> = {
    metrics: [],
    logs: [],
    events: [],
  };
  private flushTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setTimeout>;
  private commandTimer?: ReturnType<typeof setTimeout>;
  private settingsCache?: RuntimeSettings;
  private settingsEtag?: string;
  private started = false;

  constructor(options: BaaSRuntimeOptions = {}) {
    this.endpoint = normalizedUrl(options.endpoint ?? processEnv("BAAS_RUNTIME_URL") ?? processEnv("BAAS_API_URL"));
    this.token = safeString(options.token ?? processEnv("BAAS_RUNTIME_TOKEN")) || undefined;
    this.enabled = Boolean(this.endpoint && this.token);
    this.service = safeString(options.service ?? processEnv("BAAS_RUNTIME_SERVICE")) || undefined;
    this.environment = safeString(options.environment ?? processEnv("BAAS_RUNTIME_ENV")) || undefined;
    this.maxQueueSize = Math.max(1, options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE);
    this.flushIntervalMs = Math.max(0, options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
    this.timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.attributes = { ...(options.attributes ?? {}) };
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
      http: () => this.httpMiddleware(),
    };
    this.logs = {
      debug: (message, attributes) => this.queueLog("DEBUG", message, attributes),
      info: (message, attributes) => this.queueLog("INFO", message, attributes),
      warn: (message, attributes) => this.queueLog("WARNING", message, attributes),
      error: (message, attributes) => this.queueError(message, attributes),
    };
    this.events = {
      publish: (name, payload = {}, channel) => this.queueEvent(name, payload, channel),
    };
    this.settings = {
      get: (settingsOptions) => this.getSettings(settingsOptions),
      clear: () => {
        this.settingsCache = undefined;
        this.settingsEtag = undefined;
      },
    };
    this.users = {
      sync: () => this.syncUsers(),
    };
  }

  async start(): Promise<void> {
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

  async shutdown(): Promise<void> {
    this.started = false;
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    if (this.commandTimer) clearTimeout(this.commandTimer);
    this.commandTimer = undefined;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    await this.flush();
  }

  async flush(): Promise<void> {
    await Promise.all((["metrics", "logs", "events"] as QueueKind[]).map((kind) => this.flushQueue(kind)));
  }

  requestContext(): HttpMiddleware {
    return this.httpMiddleware();
  }

  private queueMetric(
    name: string,
    value: number,
    kind: MetricKind,
    unit: string,
    attributes?: Record<string, JsonValue>,
  ): void {
    if (!Number.isFinite(value)) return;
    this.enqueue("metrics", {
      name,
      value,
      kind,
      unit,
      timestamp: now(),
      attributes: { ...this.attributes, ...(attributes ?? {}) },
    });
  }

  private queueLog(level: LogLevel, message: string, attributes?: Record<string, JsonValue>): void {
    if (!message.trim()) return;
    this.enqueue("logs", {
      level,
      message,
      service: this.service,
      logger: typeof attributes?.logger === "string" ? attributes.logger : undefined,
      request_id: typeof attributes?.requestId === "string" ? attributes.requestId : undefined,
      attributes,
      timestamp: now(),
    });
  }

  private queueError(message: string, attributes?: Record<string, JsonValue> | Error): void {
    const exception = attributes instanceof Error ? `${attributes.name}: ${attributes.message}` : undefined;
    const context = attributes instanceof Error ? undefined : attributes;
    this.enqueue("logs", {
      level: "ERROR",
      message,
      service: this.service,
      exception,
      attributes: context,
      timestamp: now(),
    });
  }

  private queueEvent(name: string, payload: Record<string, JsonValue>, channel?: string): void {
    if (!name.trim()) return;
    this.enqueue("events", { name, payload, channel, timestamp: now() });
  }

  private enqueue(kind: QueueKind, record: MetricRecord | LogRecord | EventRecord): void {
    if (!this.enabled) return;
    const queue = this.queues[kind];
    if (queue.length >= this.maxQueueSize) queue.shift();
    queue.push(record);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, this.flushIntervalMs);
      allowProcessExit(this.flushTimer);
    }
  }

  private async flushQueue(kind: QueueKind): Promise<void> {
    const queue = this.queues[kind];
    if (!this.enabled || queue.length === 0) return;
    const batch = queue.splice(0, queue.length);
    const body = kind === "events" ? batch : { records: batch };
    const path = kind === "events" ? "/runtime/v1/events" : `/runtime/v1/${kind}`;
    if (kind === "events") {
      for (const event of batch as EventRecord[]) {
        const sent = await this.post(path, event);
        if (!sent) this.requeue(kind, [event]);
      }
      return;
    }
    const sent = await this.post(path, body);
    if (!sent) this.requeue(kind, batch);
  }

  private requeue(kind: QueueKind, records: Array<MetricRecord | LogRecord | EventRecord>): void {
    const queue = this.queues[kind];
    queue.unshift(...records.slice(0, Math.max(0, this.maxQueueSize - queue.length)));
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        void this.flush();
      }, Math.max(this.flushIntervalMs, 5_000));
      allowProcessExit(this.flushTimer);
    }
  }

  private async getSettings(options: { force?: boolean } = {}): Promise<RuntimeSettings | undefined> {
    if (!this.enabled) return this.settingsCache;
    const headers: Record<string, string> = {};
    if (!options.force && this.settingsEtag) headers["If-None-Match"] = this.settingsEtag;
    try {
      const response = await this.request("/runtime/v1/settings", { method: "GET", headers });
      if (response.status === 304) return this.settingsCache;
      if (!response.ok) throw new Error(`Settings request failed with ${response.status}`);
      const data = (await response.json()) as RuntimeSettings;
      this.settingsCache = data;
      this.settingsEtag = response.headers.get("etag") ?? undefined;
      return data;
    } catch (error) {
      this.reportError(error);
      return this.settingsCache;
    }
  }

  private httpMiddleware(): HttpMiddleware {
    return (request, response, next) => {
      const startedAt = Date.now();
      const requestId = requestHeader(request, "x-request-id") ?? randomRequestId();
      response.setHeader?.("X-Request-ID", requestId);
      const finish = () => {
        this.metrics.timing("http.server.duration", Date.now() - startedAt, {
          method: request.method ?? "GET",
          route: request.originalUrl ?? request.url ?? "/",
          status_code: responseStatus(response),
        });
      };
      if (response.once) response.once("finish", finish);
      else response.on?.("finish", finish);
      next();
    };
  }

  private async heartbeat(): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const capabilities: string[] = [];
      if (this.userAdapter) capabilities.push("runtime-users");
      if (this.storageAdapter) capabilities.push("object-storage");
      const response = await this.post("/runtime/v1/heartbeat", {
        runtime_name: this.service,
        sdk_name: "@dutchwebservices/baas-runtime",
        sdk_version: VERSION,
        capabilities,
      });
      if (!response) return 0;
      const parsed = (await response.json()) as { heartbeat_interval_seconds?: number };
      return Math.max(15_000, Number(parsed.heartbeat_interval_seconds ?? 60) * 1_000);
    } catch (error) {
      this.reportError(error);
      return 60_000;
    }
  }

  private scheduleHeartbeat(interval: number): void {
    if (!this.started || !this.enabled) return;
    this.heartbeatTimer = setTimeout(async () => {
      const nextInterval = await this.heartbeat();
      this.scheduleHeartbeat(nextInterval || 60_000);
    }, interval || 60_000);
    allowProcessExit(this.heartbeatTimer);
  }

  private async syncUsers(): Promise<boolean> {
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

  private async pollCommands(): Promise<void> {
    if (!this.started || !this.enabled || (!this.userAdapter && !this.storageAdapter)) return;
    const response = await this.post("/runtime/v1/commands/claim", { limit: 10 });
    if (!response) return;
    try {
      const data = (await response.json()) as { commands?: RuntimeCommand[] };
      for (const command of data.commands ?? []) await this.executeCommand(command);
    } catch (error) {
      this.reportError(error);
    }
  }

  private async executeCommand(command: RuntimeCommand): Promise<void> {
    if (!safeString(command.id)) return;
    try {
      if (command.action === "users.create") {
        if (!this.userAdapter) throw new Error("Runtime user adapter is not configured");
        const input: ConnectedRuntimeUserCreateInput = {
          username: safeString(command.payload.username),
          password: safeString(command.payload.password),
          email: safeString(command.payload.email) || null,
          name: safeString(command.payload.name) || null,
          roles: Array.isArray(command.payload.roles)
            ? command.payload.roles.map((role) => safeString(role)).filter(Boolean)
            : [],
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
          offset: Math.max(0, Number(command.payload.offset) || 0),
        });
        const objects = (Array.isArray(listed) ? listed : listed.objects).map(validStorageObject);
        const total = Array.isArray(listed) ? null : listed.total ?? null;
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { objects, total },
        });
      } else if (command.action === "storage.write") {
        if (!this.storageAdapter) throw new Error("Object storage adapter is not configured");
        const key = safeString(command.payload.key);
        if (!key) throw new Error("Storage write command is missing key");
        const object = validStorageObject(await this.storageAdapter.write({
          key,
          data: decodeBase64(command.payload.data_base64),
          contentType: safeString(command.payload.content_type) || null,
        }));
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: { object },
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
          result: { object, data_base64: encodeBase64(read.data) },
        });
      } else if (command.action === "storage.delete") {
        if (!this.storageAdapter) throw new Error("Object storage adapter is not configured");
        const key = safeString(command.payload.key);
        if (!key) throw new Error("Storage delete command is missing key");
        await this.storageAdapter.remove(key);
        await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
          ok: true,
          result: {},
        });
      } else {
        throw new Error(`Unsupported runtime command: ${String(command.action)}`);
      }
      if (this.userAdapter && command.action.startsWith("users.")) await this.syncUsers();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Connected runtime operation failed";
      await this.post(`/runtime/v1/commands/${encodeURIComponent(command.id)}/result`, {
        ok: false,
        error: message.slice(0, 2_000),
      });
      this.reportError(error);
    }
  }

  private scheduleCommandPoll(): void {
    if (!this.started || !this.enabled || (!this.userAdapter && !this.storageAdapter)) return;
    this.commandTimer = setTimeout(async () => {
      await this.pollCommands();
      this.scheduleCommandPoll();
    }, this.commandPollIntervalMs);
    allowProcessExit(this.commandTimer);
  }

  private async post(path: string, body: unknown): Promise<Response | undefined> {
    try {
      const response = await this.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error(`Runtime delivery failed with ${response.status}`);
      return response;
    } catch (error) {
      this.reportError(error);
      return undefined;
    }
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
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
          ...(init.headers ?? {}),
        },
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Observability callbacks must not affect the host application either.
    }
  }
}

export function createBaasRuntime(options: BaaSRuntimeOptions = {}): BaaSRuntime {
  return new BaaSRuntime(options);
}
