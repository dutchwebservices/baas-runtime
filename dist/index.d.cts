/**
 * Client for an application's generated runtime API. It is deliberately
 * separate from BaaSRuntime: this client uses an end-user or machine token,
 * while BaaSRuntime uses a server-only connection credential for telemetry.
 */
type EntityData = Record<string, unknown>;
type EntityDocument<T extends EntityData = EntityData> = T & {
    id: string;
    created_at?: string;
    updated_at?: string;
    owner_id?: string;
};
interface RuntimeUser {
    id: string;
    username: string;
    email?: string | null;
    name?: string | null;
    roles: string[];
    created_at: string;
    updated_at: string;
}
interface AuthSession {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope?: string | null;
    user: RuntimeUser;
}
interface MachineToken {
    access_token: string;
    token_type: "Bearer";
    expires_in: number;
    scope?: string | null;
}
interface StorageObject {
    key: string;
    size: number;
    content_type: string;
    etag?: string | null;
    url?: string | null;
    uploaded_by?: string | null;
    created_at: string;
    updated_at: string;
}
interface RuntimeEvent {
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
interface WebhookSubscription {
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
interface TokenStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
type AccessTokenSource = string | undefined | (() => string | undefined | Promise<string | undefined>);
interface BaaSClientOptions {
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
interface EntityListOptions {
    limit?: number;
    offset?: number;
}
interface StorageListOptions extends EntityListOptions {
    prefix?: string;
}
interface EventListOptions {
    limit?: number;
    after?: string;
    eventTypes?: string[];
    entities?: string[];
}
interface WebhookCreateInput {
    url: string;
    eventTypes?: string[];
    entities?: string[];
    eventNameOverrides?: Record<string, string>;
    description?: string;
    enabled?: boolean;
    signingSecret?: string;
}
interface RealtimeSubscriptionOptions extends Omit<EventListOptions, "limit"> {
    onEvent: (event: RuntimeEvent) => void | Promise<void>;
    onError?: (error: unknown) => void;
    signal?: AbortSignal;
    reconnect?: boolean;
    reconnectDelayMs?: number;
}
interface RealtimeSubscription {
    close(): void;
    done: Promise<void>;
}
interface FunctionInvokeOptions {
    method?: string;
    body?: unknown;
    headers?: HeadersInit;
}
interface BaaSRequestOptions {
    method?: string;
    headers?: HeadersInit;
    body?: BodyInit | null;
    auth?: boolean;
    signal?: AbortSignal;
}
declare class BaaSError extends Error {
    readonly status: number;
    readonly detail?: unknown;
    readonly requestId?: string | null;
    constructor(message: string, options: {
        status: number;
        detail?: unknown;
        requestId?: string | null;
    });
}
interface EntityCollection<T extends EntityData = EntityData> {
    list(options?: EntityListOptions): Promise<Array<EntityDocument<T>>>;
    get(id: string): Promise<EntityDocument<T>>;
    create(data: T): Promise<EntityDocument<T>>;
    update(id: string, data: Partial<T>): Promise<EntityDocument<T>>;
    remove(id: string): Promise<{
        ok: true;
    }>;
}
declare class BaaSClient {
    readonly url: string;
    readonly auth: {
        signIn: (input: {
            username: string;
            password: string;
        }) => Promise<AuthSession>;
        signOut: () => void;
        restoreSession: () => string | undefined;
        setAccessToken: (token?: string) => void;
        getAccessToken: () => Promise<string | undefined>;
        me: () => Promise<RuntimeUser>;
        users: {
            list: () => Promise<RuntimeUser[]>;
            create: (input: {
                username: string;
                password: string;
                email?: string;
                name?: string;
                roles?: string[];
            }) => Promise<RuntimeUser>;
            updateRoles: (userId: string, roles: string[]) => Promise<RuntimeUser>;
            remove: (userId: string) => Promise<{
                ok: true;
            }>;
        };
        machineToken: (input: {
            clientId: string;
            clientSecret: string;
            scope?: string;
        }) => Promise<MachineToken>;
    };
    readonly entities: {
        collection: <T extends EntityData = EntityData>(name: string) => EntityCollection<T>;
    };
    readonly storage: {
        list: (options?: StorageListOptions) => Promise<StorageObject[]>;
        upload: (key: string, body: BodyInit, options?: {
            contentType?: string;
        }) => Promise<StorageObject>;
        download: (key: string, options?: {
            signal?: AbortSignal;
        }) => Promise<Response>;
        remove: (key: string) => Promise<{
            ok: true;
        }>;
    };
    readonly events: {
        list: (options?: EventListOptions) => Promise<RuntimeEvent[]>;
        subscribe: (options: RealtimeSubscriptionOptions) => RealtimeSubscription;
        webhooks: {
            list: () => Promise<WebhookSubscription[]>;
            create: (input: WebhookCreateInput) => Promise<WebhookSubscription>;
            remove: (webhookId: string) => Promise<{
                ok: true;
            }>;
            retry: (webhookId: string) => Promise<WebhookSubscription>;
        };
    };
    readonly functions: {
        invoke: <T = unknown>(route: string, options?: FunctionInvokeOptions) => Promise<T>;
        cron: {
            list: () => Promise<{
                functions: Array<Record<string, unknown>>;
            }>;
            run: (functionId: string, triggerId: string, payload?: unknown) => Promise<Record<string, unknown>>;
        };
    };
    readonly health: {
        check: () => Promise<{
            status: string;
        }>;
        openapi: () => Promise<Record<string, unknown>>;
    };
    private readonly fetchImpl?;
    private readonly tokenSource?;
    private readonly storageAdapter?;
    private readonly storageKey;
    private readonly defaultHeaders;
    private accessToken?;
    constructor(options?: BaaSClientOptions);
    request(path: string, options?: BaaSRequestOptions): Promise<Response>;
    getAccessToken(): Promise<string | undefined>;
    private signIn;
    private signOut;
    private restoreSession;
    private setAccessToken;
    private machineToken;
    private collection;
    private listStorage;
    private uploadStorage;
    private listEvents;
    private subscribeEvents;
    private consumeEvents;
    private invokeFunction;
    private getJson;
    private postJson;
    private patchJson;
    private deleteJson;
    private writeJson;
    private resolve;
}
declare function createBaasClient(options?: BaaSClientOptions): BaaSClient;

/**
 * BaaS Runtime SDK.  It has no runtime dependencies and is safe to use in
 * Node 18+ servers, including applications that are not hosted by BaaS.
 */
declare const VERSION = "0.2.0";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | {
    [key: string]: JsonValue;
};
type MetricKind = "counter" | "gauge" | "histogram" | "timing";
type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR";
interface RuntimeSettings {
    app_id: string;
    revision: number;
    values: Record<string, JsonValue>;
    updated_at?: string | null;
    project: {
        id: string;
        slug: string;
        name: string;
    };
}
interface BaaSRuntimeOptions {
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
interface RequestLike {
    method?: string;
    url?: string;
    originalUrl?: string;
    headers?: Record<string, string | string[] | undefined>;
}
interface ResponseLike {
    statusCode?: number;
    setHeader?: (name: string, value: string) => void;
    once?: (event: "finish", callback: () => void) => void;
    on?: (event: "finish", callback: () => void) => void;
}
type Next = (error?: unknown) => void;
type HttpMiddleware = (request: RequestLike, response: ResponseLike, next: Next) => void;
declare class BaaSRuntime {
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
        get: (options?: {
            force?: boolean;
        }) => Promise<RuntimeSettings | undefined>;
        clear: () => void;
    };
    private readonly token?;
    private readonly service?;
    private readonly environment?;
    private readonly maxQueueSize;
    private readonly flushIntervalMs;
    private readonly timeoutMs;
    private readonly attributes;
    private readonly onError?;
    private readonly fetchImpl?;
    private readonly queues;
    private flushTimer?;
    private heartbeatTimer?;
    private settingsCache?;
    private settingsEtag?;
    private started;
    constructor(options?: BaaSRuntimeOptions);
    start(): Promise<void>;
    shutdown(): Promise<void>;
    flush(): Promise<void>;
    requestContext(): HttpMiddleware;
    private queueMetric;
    private queueLog;
    private queueError;
    private queueEvent;
    private enqueue;
    private flushQueue;
    private requeue;
    private getSettings;
    private httpMiddleware;
    private heartbeat;
    private scheduleHeartbeat;
    private post;
    private request;
    private reportError;
}
declare function createBaasRuntime(options?: BaaSRuntimeOptions): BaaSRuntime;

export { type AccessTokenSource, type AuthSession, BaaSClient, type BaaSClientOptions, BaaSError, type BaaSRequestOptions, BaaSRuntime, type BaaSRuntimeOptions, type EntityCollection, type EntityData, type EntityDocument, type EntityListOptions, type EventListOptions, type FunctionInvokeOptions, type HttpMiddleware, type JsonPrimitive, type JsonValue, type LogLevel, type MachineToken, type MetricKind, type Next, type RealtimeSubscription, type RealtimeSubscriptionOptions, type RequestLike, type ResponseLike, type RuntimeEvent, type RuntimeSettings, type RuntimeUser, type StorageListOptions, type StorageObject, type TokenStorage, VERSION, type WebhookCreateInput, type WebhookSubscription, createBaasClient, createBaasRuntime };
