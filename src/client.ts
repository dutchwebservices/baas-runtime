/**
 * Client for an application's generated runtime API. It is deliberately
 * separate from BaaSRuntime: this client uses an end-user or machine token,
 * while BaaSRuntime uses a server-only connection credential for telemetry.
 */

export type EntityData = Record<string, unknown>;

export type EntityDocument<T extends EntityData = EntityData> = T & {
  id: string;
  created_at?: string;
  updated_at?: string;
  owner_id?: string;
};

export interface RuntimeUser {
  id: string;
  username: string;
  email?: string | null;
  name?: string | null;
  roles: string[];
  created_at: string;
  updated_at: string;
}

export interface AuthSession {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope?: string | null;
  user: RuntimeUser;
}

export interface MachineToken {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope?: string | null;
}

export interface StorageObject {
  key: string;
  size: number;
  content_type: string;
  etag?: string | null;
  url?: string | null;
  uploaded_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuntimeEvent {
  id: string;
  event_type: string;
  source_service_id?: string | null;
  entity: string;
  action: string;
  document_id: string;
  subject?: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface WebhookSubscription {
  id: string;
  url: string;
  event_types: string[];
  entities: string[];
  event_name_overrides: Record<string, string>;
  description?: string | null;
  enabled: boolean;
  signing_secret?: string | null;
  created_at: string;
  updated_at: string;
  last_delivery_at?: string | null;
  last_status?: string | null;
  last_status_code?: number | null;
  last_error?: string | null;
  last_event_id?: string | null;
  last_event_type?: string | null;
  last_delivered_event_type?: string | null;
}

export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AccessTokenSource = string | undefined | (() => string | undefined | Promise<string | undefined>);

export interface BaaSClientOptions {
  /** Generated runtime URL. Defaults to BAAS_APP_URL, BAAS_URL, VITE_BAAS_URL, or NEXT_PUBLIC_BAAS_URL. */
  url?: string;
  /** Initial bearer token or an async function that supplies the current token. */
  accessToken?: AccessTokenSource;
  /** Persist sign-in tokens only when explicitly enabled. Default false. */
  persistSession?: boolean;
  /** Optional browser/server token storage. Used only with persistSession. */
  storage?: TokenStorage;
  /** Optional storage key. Defaults to a URL-scoped key. */
  storageKey?: string;
  /** Additional headers sent with every application API request. */
  headers?: HeadersInit;
  /** Override fetch for tests or specialized runtimes. */
  fetch?: typeof fetch;
}

export interface EntityListOptions {
  limit?: number;
  offset?: number;
}

export interface StorageListOptions extends EntityListOptions {
  prefix?: string;
}

export interface EventListOptions {
  limit?: number;
  after?: string;
  eventTypes?: string[];
  entities?: string[];
}

export interface WebhookCreateInput {
  url: string;
  eventTypes?: string[];
  entities?: string[];
  eventNameOverrides?: Record<string, string>;
  description?: string;
  enabled?: boolean;
  signingSecret?: string;
}

export interface RealtimeSubscriptionOptions extends Omit<EventListOptions, "limit"> {
  onEvent: (event: RuntimeEvent) => void | Promise<void>;
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  reconnect?: boolean;
  reconnectDelayMs?: number;
}

export interface RealtimeSubscription {
  close(): void;
  done: Promise<void>;
}

export interface FunctionInvokeOptions {
  method?: string;
  body?: unknown;
  headers?: HeadersInit;
}

export interface BaaSRequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: BodyInit | null;
  auth?: boolean;
  signal?: AbortSignal;
}

export class BaaSError extends Error {
  readonly status: number;
  readonly detail?: unknown;
  readonly requestId?: string | null;

  constructor(message: string, options: { status: number; detail?: unknown; requestId?: string | null }) {
    super(message);
    this.name = "BaaSError";
    this.status = options.status;
    this.detail = options.detail;
    this.requestId = options.requestId;
  }
}

export interface EntityCollection<T extends EntityData = EntityData> {
  list(options?: EntityListOptions): Promise<Array<EntityDocument<T>>>;
  get(id: string): Promise<EntityDocument<T>>;
  create(data: T): Promise<EntityDocument<T>>;
  update(id: string, data: Partial<T>): Promise<EntityDocument<T>>;
  remove(id: string): Promise<{ ok: true }>;
}

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

function resolveStorage(options: BaaSClientOptions): TokenStorage | undefined {
  if (!options.persistSession) return undefined;
  if (options.storage) return options.storage;
  try {
    const candidate = globalThis as typeof globalThis & { localStorage?: TokenStorage };
    return candidate.localStorage;
  } catch {
    return undefined;
  }
}

function encodePath(value: string): string {
  return value
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const result = params.toString();
  return result ? `?${result}` : "";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function errorFromResponse(response: Response): Promise<BaaSError> {
  const requestId = response.headers.get("x-request-id");
  let detail: unknown;
  let message = `Request failed with ${response.status}`;
  try {
    detail = await response.clone().json();
    if (typeof detail === "object" && detail && "detail" in detail) {
      const candidate = (detail as { detail?: unknown }).detail;
      message = typeof candidate === "string" ? candidate : message;
    }
  } catch {
    try {
      const text = (await response.text()).trim();
      if (text) message = text;
    } catch {
      // Preserve the status-based message.
    }
  }
  return new BaaSError(message, { status: response.status, detail, requestId });
}

export class BaaSClient {
  readonly url: string;
  readonly auth: {
    signIn: (input: { username: string; password: string }) => Promise<AuthSession>;
    signOut: () => void;
    restoreSession: () => string | undefined;
    setAccessToken: (token?: string) => void;
    getAccessToken: () => Promise<string | undefined>;
    me: () => Promise<RuntimeUser>;
    users: {
      list: () => Promise<RuntimeUser[]>;
      create: (input: { username: string; password: string; email?: string; name?: string; roles?: string[] }) => Promise<RuntimeUser>;
      updateRoles: (userId: string, roles: string[]) => Promise<RuntimeUser>;
      remove: (userId: string) => Promise<{ ok: true }>;
    };
    machineToken: (input: { clientId: string; clientSecret: string; scope?: string }) => Promise<MachineToken>;
  };
  readonly entities: {
    collection: <T extends EntityData = EntityData>(name: string) => EntityCollection<T>;
  };
  readonly storage: {
    list: (options?: StorageListOptions) => Promise<StorageObject[]>;
    upload: (key: string, body: BodyInit, options?: { contentType?: string }) => Promise<StorageObject>;
    download: (key: string, options?: { signal?: AbortSignal }) => Promise<Response>;
    remove: (key: string) => Promise<{ ok: true }>;
  };
  readonly events: {
    list: (options?: EventListOptions) => Promise<RuntimeEvent[]>;
    subscribe: (options: RealtimeSubscriptionOptions) => RealtimeSubscription;
    webhooks: {
      list: () => Promise<WebhookSubscription[]>;
      create: (input: WebhookCreateInput) => Promise<WebhookSubscription>;
      remove: (webhookId: string) => Promise<{ ok: true }>;
      retry: (webhookId: string) => Promise<WebhookSubscription>;
    };
  };
  readonly functions: {
    invoke: <T = unknown>(route: string, options?: FunctionInvokeOptions) => Promise<T>;
    cron: {
      list: () => Promise<{ functions: Array<Record<string, unknown>> }>;
      run: (functionId: string, triggerId: string, payload?: unknown) => Promise<Record<string, unknown>>;
    };
  };
  readonly health: {
    check: () => Promise<{ status: string }>;
    openapi: () => Promise<Record<string, unknown>>;
  };

  private readonly fetchImpl?: typeof fetch;
  private readonly tokenSource?: AccessTokenSource;
  private readonly storageAdapter?: TokenStorage;
  private readonly storageKey: string;
  private readonly defaultHeaders: HeadersInit;
  private accessToken?: string;

  constructor(options: BaaSClientOptions = {}) {
    const url = normalizedUrl(
      options.url ?? processEnv("BAAS_APP_URL") ?? processEnv("BAAS_URL") ?? processEnv("VITE_BAAS_URL") ?? processEnv("NEXT_PUBLIC_BAAS_URL"),
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
      me: () => this.getJson<RuntimeUser>("/api/auth/me"),
      users: {
        list: () => this.getJson<RuntimeUser[]>("/api/auth/users"),
        create: (input) => this.postJson<RuntimeUser>("/api/auth/users", input),
        updateRoles: (userId, roles) => this.patchJson<RuntimeUser>(`/api/auth/users/${encodeURIComponent(userId)}/roles`, { roles }),
        remove: (userId) => this.deleteJson<{ ok: true }>(`/api/auth/users/${encodeURIComponent(userId)}`),
      },
      machineToken: (input) => this.machineToken(input),
    };
    this.entities = { collection: <T extends EntityData = EntityData>(name: string) => this.collection<T>(name) };
    this.storage = {
      list: (options) => this.listStorage(options),
      upload: (key, body, options) => this.uploadStorage(key, body, options),
      download: (key, options) => this.request(`/api/storage/objects/${encodePath(key)}`, { signal: options?.signal }),
      remove: (key) => this.deleteJson<{ ok: true }>(`/api/storage/objects/${encodePath(key)}`),
    };
    this.events = {
      list: (options) => this.listEvents(options),
      subscribe: (options) => this.subscribeEvents(options),
      webhooks: {
        list: () => this.getJson<WebhookSubscription[]>("/api/events/webhooks"),
        create: (input) =>
          this.postJson<WebhookSubscription>("/api/events/webhooks", {
            url: input.url,
            event_types: input.eventTypes ?? [],
            entities: input.entities ?? [],
            event_name_overrides: input.eventNameOverrides ?? {},
            description: input.description,
            enabled: input.enabled ?? true,
            signing_secret: input.signingSecret,
          }),
        remove: (webhookId) => this.deleteJson<{ ok: true }>(`/api/events/webhooks/${encodeURIComponent(webhookId)}`),
        retry: (webhookId) => this.postJson<WebhookSubscription>(`/api/events/webhooks/${encodeURIComponent(webhookId)}/retry`, {}),
      },
    };
    this.functions = {
      invoke: <T = unknown>(route: string, invokeOptions?: FunctionInvokeOptions) => this.invokeFunction<T>(route, invokeOptions),
      cron: {
        list: () => this.getJson<{ functions: Array<Record<string, unknown>> }>("/api/functions/cron"),
        run: (functionId, triggerId, payload) =>
          this.postJson<Record<string, unknown>>(
            `/api/functions/${encodeURIComponent(functionId)}/cron/${encodeURIComponent(triggerId)}/run`,
            payload === undefined ? {} : { payload },
          ),
      },
    };
    this.health = {
      check: () => this.getJson<{ status: string }>("/health", { auth: false }),
      openapi: () => this.getJson<Record<string, unknown>>("/openapi.json", { auth: false }),
    };
  }

  async request(path: string, options: BaaSRequestOptions = {}): Promise<Response> {
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
      signal: options.signal,
    });
    if (!response.ok) throw await errorFromResponse(response);
    return response;
  }

  async getAccessToken(): Promise<string | undefined> {
    if (this.accessToken) return this.accessToken;
    if (typeof this.tokenSource === "function") return this.tokenSource();
    if (typeof this.tokenSource === "string") return this.tokenSource;
    return this.restoreSession();
  }

  private async signIn(input: { username: string; password: string }): Promise<AuthSession> {
    const session = await this.postJson<AuthSession>("/api/auth/login", input, { auth: false });
    this.setAccessToken(session.access_token);
    return session;
  }

  private signOut(): void {
    this.accessToken = undefined;
    this.storageAdapter?.removeItem(this.storageKey);
  }

  private restoreSession(): string | undefined {
    try {
      const token = this.storageAdapter?.getItem(this.storageKey) ?? undefined;
      if (token) this.accessToken = token;
      return token;
    } catch {
      return undefined;
    }
  }

  private setAccessToken(token?: string): void {
    this.accessToken = token?.trim() || undefined;
    try {
      if (this.accessToken) this.storageAdapter?.setItem(this.storageKey, this.accessToken);
      else this.storageAdapter?.removeItem(this.storageKey);
    } catch {
      // Browser storage is optional. Keep the in-memory session usable.
    }
  }

  private async machineToken(input: { clientId: string; clientSecret: string; scope?: string }): Promise<MachineToken> {
    const headers = new Headers({
      Authorization: `Basic ${toBase64(`${input.clientId}:${input.clientSecret}`)}`,
      "Content-Type": "application/json",
    });
    const response = await this.request("/api/auth/m2m/token", {
      method: "POST",
      headers,
      body: JSON.stringify({ grant_type: "client_credentials", scope: input.scope }),
      auth: false,
    });
    return response.json() as Promise<MachineToken>;
  }

  private collection<T extends EntityData>(name: string): EntityCollection<T> {
    const entity = encodeURIComponent(name.trim());
    if (!entity) throw new Error("An entity name is required");
    return {
      list: (options = {}) =>
        this.getJson<Array<EntityDocument<T>>>(
          `/api/entity/${entity}${queryString({ limit: options.limit, offset: options.offset })}`,
        ),
      get: (id) => this.getJson<EntityDocument<T>>(`/api/entity/${entity}/${encodeURIComponent(id)}`),
      create: (data) => this.postJson<EntityDocument<T>>(`/api/entity/${entity}`, { data }),
      update: (id, data) => this.patchJson<EntityDocument<T>>(`/api/entity/${entity}/${encodeURIComponent(id)}`, { data }),
      remove: (id) => this.deleteJson<{ ok: true }>(`/api/entity/${entity}/${encodeURIComponent(id)}`),
    };
  }

  private async listStorage(options: StorageListOptions = {}): Promise<StorageObject[]> {
    return this.getJson<StorageObject[]>(
      `/api/storage/objects${queryString({ prefix: options.prefix, limit: options.limit, offset: options.offset })}`,
    );
  }

  private async uploadStorage(key: string, body: BodyInit, options: { contentType?: string } = {}): Promise<StorageObject> {
    const headers = new Headers();
    if (options.contentType) headers.set("Content-Type", options.contentType);
    const response = await this.request(`/api/storage/objects/${encodePath(key)}`, {
      method: "PUT",
      headers,
      body,
    });
    return response.json() as Promise<StorageObject>;
  }

  private async listEvents(options: EventListOptions = {}): Promise<RuntimeEvent[]> {
    return this.getJson<RuntimeEvent[]>(
      `/api/events${queryString({
        limit: options.limit,
        after: options.after,
        event_type: options.eventTypes?.join(","),
        entity: options.entities?.join(","),
      })}`,
    );
  }

  private subscribeEvents(options: RealtimeSubscriptionOptions): RealtimeSubscription {
    const controller = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) controller.abort();
      else options.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    return {
      close: () => controller.abort(),
      done: this.consumeEvents(options, controller.signal),
    };
  }

  private async consumeEvents(options: RealtimeSubscriptionOptions, signal: AbortSignal): Promise<void> {
    const reconnect = options.reconnect ?? true;
    const reconnectDelayMs = Math.max(100, options.reconnectDelayMs ?? 1_000);
    let after = options.after;
    while (!signal.aborted) {
      try {
        const response = await this.request(
          `/api/events/stream${queryString({
            after,
            event_type: options.eventTypes?.join(","),
            entity: options.entities?.join(","),
          })}`,
          { signal },
        );
        if (!response.body) throw new Error("Realtime stream did not return a response body");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let message: { id?: string; eventType?: string; data: string[] } = { data: [] };
        const dispatch = async () => {
          if (message.data.length === 0) return;
          const parsed = JSON.parse(message.data.join("\n")) as RuntimeEvent;
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
          // Subscriber errors must not break stream cleanup.
        }
        if (!reconnect) throw error;
      }
      if (!reconnect || signal.aborted) return;
      await delay(reconnectDelayMs, signal);
    }
  }

  private async invokeFunction<T>(route: string, options: FunctionInvokeOptions = {}): Promise<T> {
    const method = (options.method ?? "POST").toUpperCase();
    const headers = new Headers(options.headers);
    let body: BodyInit | undefined;
    if (options.body !== undefined) {
      if (typeof options.body === "string" || options.body instanceof FormData || options.body instanceof Blob || options.body instanceof URLSearchParams) {
        body = options.body;
      } else {
        headers.set("Content-Type", headers.get("Content-Type") ?? "application/json");
        body = JSON.stringify(options.body);
      }
    }
    const response = await this.request(route.startsWith("/") ? route : `/${route}`, { method, headers, body });
    const contentType = response.headers.get("content-type") ?? "";
    return (contentType.includes("application/json") ? response.json() : response.text()) as Promise<T>;
  }

  private async getJson<T>(path: string, options: Omit<BaaSRequestOptions, "method"> = {}): Promise<T> {
    const response = await this.request(path, { ...options, method: "GET" });
    return response.json() as Promise<T>;
  }

  private async postJson<T>(path: string, payload: unknown, options: Omit<BaaSRequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.writeJson<T>("POST", path, payload, options);
  }

  private async patchJson<T>(path: string, payload: unknown, options: Omit<BaaSRequestOptions, "method" | "body"> = {}): Promise<T> {
    return this.writeJson<T>("PATCH", path, payload, options);
  }

  private async deleteJson<T>(path: string): Promise<T> {
    const response = await this.request(path, { method: "DELETE" });
    return response.json() as Promise<T>;
  }

  private async writeJson<T>(method: string, path: string, payload: unknown, options: Omit<BaaSRequestOptions, "method" | "body"> = {}): Promise<T> {
    const headers = new Headers(options.headers);
    headers.set("Content-Type", "application/json");
    const response = await this.request(path, { ...options, method, headers, body: JSON.stringify(payload) });
    return response.json() as Promise<T>;
  }

  private resolve(path: string): string {
    return new URL(path, `${this.url}/`).toString();
  }
}

function toBase64(value: string): string {
  const nodeBuffer = (globalThis as typeof globalThis & { Buffer?: { from(value: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
  if (nodeBuffer) return nodeBuffer.from(value, "utf8").toString("base64");
  return btoa(unescape(encodeURIComponent(value)));
}

export function createBaasClient(options: BaaSClientOptions = {}): BaaSClient {
  return new BaaSClient(options);
}
