/**
 * BaaS Runtime SDK.  It has no runtime dependencies and is safe to use in
 * Node 18+ servers, including applications that are not hosted by BaaS.
 */
declare const VERSION = "0.1.0";
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

export { BaaSRuntime, type BaaSRuntimeOptions, type HttpMiddleware, type JsonPrimitive, type JsonValue, type LogLevel, type MetricKind, type Next, type RequestLike, type ResponseLike, type RuntimeSettings, VERSION, createBaasRuntime };
