# BaaS TypeScript SDK

Use one TypeScript package for an application's data, authentication, runtime
users, object storage, event stream, webhooks, functions, project settings, and
server telemetry.

## Install

The public source installation does not require a package-registry token:

```bash
npm install github:dutchwebservices/baas-runtime#v0.6.8
```

For an agent-assisted integration, install the public Codex skill from
`dutchwebservices/baas-runtime` at `skills/baas-typescript-integration`, then
ask Codex to integrate the current app with BaaS. The skill inspects the
runtime's OpenAPI document, adds typed client code, and verifies the real app
flow.

## Application client

Use `createBaasClient` in browser code, server code, or a BFF. It only uses an
end-user access token or a machine token. Never put `BAAS_RUNTIME_TOKEN` in
browser-delivered environment variables.

```ts
import { createBaasClient } from "@dutchwebservices/baas-runtime";

type Order = {
  title: string;
  total: number;
  status: "draft" | "paid";
};

export const baas = createBaasClient({
  url: import.meta.env.VITE_BAAS_URL,
  persistSession: true,
});

const session = await baas.auth.signIn({ username, password });
const orders = baas.entities.collection<Order>("orders");
const order = await orders.create({ title: "Website order", total: 49, status: "draft" });
const mine = await orders.list({ limit: 50 });
```

`createBaasClient` includes:

- `entities.collection<T>(name)` for typed list/get/create/update/delete
- `auth` for sign-in, session state, current user, machine-token exchange, and
  admin runtime-user management
- `storage` for list/upload/download/delete
- `events` for event history, authenticated realtime streams, and webhooks
- `functions` for invoking an HTTP function and managing scheduled runs
- `health` for health and generated OpenAPI documents

The runtime enforces the caller's roles and owner-scoped access. The client is
only a convenience layer; it never elevates permissions.

## Storage and realtime

```ts
await baas.storage.upload("products/sku-1.png", file, { contentType: file.type });

const subscription = baas.events.subscribe({
  entities: ["orders"],
  onEvent(event) {
    console.log(event.event_type, event.payload);
  },
});

// Later, for example when a React effect is cleaned up:
subscription.close();
```

## Functions

```ts
const report = await baas.functions.invoke<{ total: number }>("/reports/daily", {
  body: { date: "2026-07-10" },
});
```

## Server connection, users, service accounts, storage, cache, schemas, telemetry, and settings

Use the separate server-only helper after `baas-cli runtime connect`. The CLI
writes `BAAS_RUNTIME_URL`, `BAAS_RUNTIME_TOKEN`, and the generated runtime's
`BAAS_APP_URL` to a private `.env.local` file.

```ts
import { createBaasRuntime } from "@dutchwebservices/baas-runtime";

const runtime = createBaasRuntime({
  service: "orders-api",
  users: {
    async list() {
      return userRepository.list();
    },
    async create({ username, password, email, name, roles }) {
      // Keep validation and password hashing in the application's user service.
      return userService.create({ username, password, email, name, roles });
    },
    async remove(userRef) {
      await userService.remove(userRef);
    },
  },
  serviceAccounts: {
    async list() {
      return serviceAccountRepository.listPublic();
    },
    async create({ name, clientId, clientSecret, scopes }) {
      const account = await serviceAccountService.create({
        name,
        clientId,
        secret: clientSecret,
        scopes,
      });
      return {
        id: account.id,
        name: account.name,
        client_id: account.clientId,
        scopes: account.scopes,
        token_url: "/api/auth/m2m/token",
        created_at: account.createdAt,
      };
    },
    async remove(accountRef) {
      await serviceAccountService.revoke(accountRef);
    },
  },
  storage: {
    async list({ prefix, limit, offset }) {
      return objectStore.list({ prefix, limit, offset });
    },
    async write({ key, data, contentType }) {
      return objectStore.put({ key, data, contentType });
    },
    async read(key) {
      const object = await objectStore.get(key);
      return { ...object.metadata, data: object.data };
    },
    async remove(key) {
      await objectStore.remove(key);
    },
  },
  cache: {
    async list({ prefix, limit, cursor }) {
      return cacheService.listLogicalKeys({ prefix, limit, cursor });
    },
    async get(key) {
      return cacheService.getJson(key);
    },
    async set({ key, value, ttlSeconds }) {
      return cacheService.setJson({ key, value, ttlSeconds });
    },
    async remove(key) {
      await cacheService.remove(key);
    },
    async clear({ prefix, all }) {
      return cacheService.clear({ prefix, all });
    },
  },
  schema: {
    async read() {
      const current = await schemaService.describe();
      return {
        revision: current.revision,
        schema: { entities: current.collections.map(toBaasSchemaCollection) },
      };
    },
    async apply({ schema, expectedRevision }) {
      const applied = await schemaService.applyDeclarativeModel({
        schema,
        expectedRevision,
      });
      return {
        revision: applied.revision,
        schema: { entities: applied.collections.map(toBaasSchemaCollection) },
      };
    },
  },
  functions: {
    async list() {
      return functionRegistry.listPublic().then((functions) =>
        functions.map(toBaasFunction),
      );
    },
    async invoke(functionRef, { payload }) {
      const startedAt = Date.now();
      const result = await functionRegistry.invokeAuthorized(functionRef, payload);
      return { result, duration_ms: Date.now() - startedAt };
    },
    async update(functionRef, changes) {
      return toBaasFunction(
        await functionRegistry.updateAdminSettings(functionRef, changes),
      );
    },
  },
  cron: {
    async listTargets() {
      return scheduler.listSchedulableTargets();
    },
    async list() {
      return scheduler.listSchedules();
    },
    async create(input) {
      return scheduler.createSchedule(input);
    },
    async update(scheduleRef, changes) {
      return scheduler.updateSchedule(scheduleRef, changes);
    },
    async remove(scheduleRef) {
      await scheduler.removeSchedule(scheduleRef);
    },
    async run(scheduleRef) {
      return scheduler.runNow(scheduleRef);
    },
  },
  webhooks: {
    async listEventTypes() {
      return webhookService.listAllowedEventTypes();
    },
    async list() {
      return webhookService.listSubscriptions();
    },
    async create(input) {
      return webhookService.createSubscription(input);
    },
    async update(subscriptionRef, changes) {
      return webhookService.updateSubscription(subscriptionRef, changes);
    },
    async remove(subscriptionRef) {
      await webhookService.removeSubscription(subscriptionRef);
    },
    async rotateSecret(subscriptionRef) {
      return webhookService.rotateSigningSecret(subscriptionRef);
    },
    async retry(subscriptionRef) {
      return webhookService.retryLatestFailedDelivery(subscriptionRef);
    },
  },
  eventStream: {
    async listChannels() {
      return eventService.listChannels();
    },
    async list(input) {
      return eventService.listHistory(input);
    },
    async publish(input) {
      return eventService.publishAuthorized(input);
    },
    async connection() {
      return {
        streamUrl: "https://events.example.com/v1/stream",
        historyUrl: "https://events.example.com/v1/history",
        authMode: "bearer",
      };
    },
  },
  logsAdapter: {
    async listSources() {
      return logService.listSources();
    },
    async query(input) {
      return logService.queryProjectHistory(input);
    },
  },
  integrations: {
    redis: () => cache.healthCheck(),
    "object-file-api": () => objectRoutes.healthCheck(),
  },
});
await runtime.start();
runtime.metrics.increment("orders.created");
runtime.logs.info("Checkout completed", { orderId: "ord_123" });
```

With a `users` adapter, runtime users become manageable from the BaaS dashboard
and `baas-cli users` commands. The adapter must call the application's existing
user service so its normal validation, password hashing, roles, and audit logic
remain authoritative. `list` and `create` must return only safe profile fields:
`id`, `username`, `email`, `name`, `roles`, `created_at`, and
`updated_at`. Never return passwords or password hashes.

The SDK advertises user management only while this adapter is configured and
the server connection is alive. It synchronizes a safe user index for the
dashboard, receives create/delete commands, executes them through the adapter,
and reports the result. After a user mutation performed elsewhere in the app,
refresh the dashboard index explicitly:

```ts
await runtime.users.sync();
```

With a `serviceAccounts` adapter, machine credentials become manageable from
the BaaS dashboard and `baas-cli service-accounts` commands. BaaS generates a
client id and one-time secret, delivers them directly to the connected
adapter, and immediately removes the secret from the command record. The
application must validate scopes, hash the secret through its normal
credential service, and store only that hash. Adapter results may contain only
public metadata and an application-owned relative or HTTPS `token_url`; the
SDK strips secret and hash fields defensively.

`create()` must be idempotent by `clientId`. A runtime may commit the credential
before a transient network failure prevents the command result from reaching
BaaS; retrying that command must return the existing public account metadata
instead of creating a second credential.

Token exchange stays in the application at the returned `token_url`. BaaS does
not mirror external credentials and cannot mint tokens for them. Deleting a
service account must revoke it in the application's credential store.

With a `storage` adapter, the project dashboard and `baas-cli storage`
commands can list, upload, download, and delete objects through the
application's existing object-store service. The SDK advertises this capability
only while the adapter is configured and its heartbeat is current, so an
organization admin can distinguish a real integration from configuration
alone. Provider credentials remain inside the application.

With a `cache` adapter, Application Cache becomes manageable from the project
dashboard and `baas-cli cache` commands. The contract exposes only bounded
list/get/set/delete/clear operations for JSON values. It never accepts an
arbitrary cache command or connection credential. The adapter must translate
every logical key to a physical organization-and-project namespace, for
example `org:{orgId}:app:{appId}:cache:{logicalKey}`, and must remove that
prefix from list/get results. A project must never be able to enumerate,
overwrite, or clear another project's keys.

Cache keys and cursors are limited to 512 characters, list pages to 200
entries, JSON values to 64 KiB, and TTL values to 30 days. Clearing requires a
non-empty prefix or explicit `all: true`. The control plane removes returned
values from command history after the active request completes; values remain
authoritative only in the connected application cache.

With a `schema` adapter, the Schema Builder can manage an application's
collections, fields, indexes, and declared relations through its normal
migration boundary. The application remains the schema authority: `read()`
returns its canonical declarative model and stable revision, while `apply()`
must validate, authorize, and atomically migrate that model only when
`expectedRevision` still matches. A stale revision must fail rather than
silently overwriting another administrator's change. BaaS never receives
database credentials and never sends raw database commands to an external
application.

Do not configure a schema adapter merely because an application has a
database. Leave Schema Builder unavailable when the application cannot safely
provide revision-checked migrations. A schema readiness probe may provide
diagnostics, but cannot unlock the Schema Builder because it cannot safely
perform writes.

With an `eventStream` adapter, project administrators can inspect the
application's channel catalog and bounded event history, publish an authorized
test event, and discover its direct stream and history endpoints. The
application remains responsible for durable storage, tenant isolation,
authorization, retention, cursor pagination, replay behavior, and live
fan-out. The adapter must expose only public HTTPS endpoint metadata and never
return a stream credential, bearer token, cookie, internal broker address, or
provider detail.

The bridge accepts at most 200 channels or events per page, 50 event-type
filters, and a 64 KiB JSON object payload. Event payloads are returned only to
the active authenticated administrator request and are removed from durable
control-plane command history. `publish()` must use the application's normal
authorization, validation, idempotency, audit, and event-dispatch path.

With a `logsAdapter`, project administrators can inspect the connected
application's structured log history from the dashboard and
`baas-cli runtime-logs`. This is separate from `runtime.logs`, which sends new
telemetry to the central log sink. The adapter remains read-only and queries
the application's existing, project-scoped log service; BaaS never receives a
log-store credential or an arbitrary query language.

`listSources()` returns a bounded catalog of safe source keys. `query()`
receives validated level, source, service, environment, text, logger,
request-id, trace-id, time-range, cursor, and limit filters. Return at most 200
entries, stable unique ids, ISO-8601 timestamps, opaque cursors, and JSON-safe
attributes. Enforce the project boundary and administrator authorization again
inside the adapter. Redact access tokens, credentials, personal data, stack
traces, internal addresses, and provider details before returning entries.
The application remains authoritative for indexing, retention, redaction, and
access policy. Query text and returned entries are removed from durable
control-plane command history after the active request.

The `integrations` probes make the connected runtime's implementation status
visible in the BaaS dashboard. A probe must be a bounded, side-effect-free
readiness check for the running service; never return a hardcoded `true`.
`users` automatically verifies `runtime-users`, `serviceAccounts`
automatically verifies `service-accounts`, `storage` automatically verifies
`blob-storage`, `cache` automatically verifies Application Cache, `schema`
automatically verifies `schema-builder`, `functions` automatically verifies
`baas-functions`, `cron` automatically verifies schedule management, and
`webhooks` automatically verifies webhook management. `eventStream`
automatically verifies Event Stream management, and `logsAdapter` verifies
connected Application Logs. The remaining supported
diagnostic probes are `redis`, `event-stream`, and `object-file-api`.
A `service-accounts` probe is diagnostic-only and never unlocks credential
management; only the explicit adapter does.
A `redis` probe is likewise diagnostic-only and never unlocks Application
Cache; only the explicit `cache` adapter does.
A `baas-functions` or `cron` probe is diagnostic-only and never unlocks
management; only the explicit adapter does.
A `webhooks` probe is diagnostic-only and never unlocks subscription
management; only the explicit adapter does.
An `event-stream` probe is diagnostic-only and never unlocks history or publish
management; only the explicit `eventStream` adapter does.
A log readiness probe is diagnostic-only and never unlocks log queries; only
the explicit `logsAdapter` does.
A false result or thrown error is
reported as degraded without sending the error or internal connection details
to the control plane.

Dashboard and CLI transfers through the administration bridge are limited to
4 MiB per object. Use `createBaasClient().storage` or the application's direct
upload flow for larger objects.

Start one `BaaSRuntime` instance per long-running server process, never in
browser code. Keep heartbeat enabled when a user, service-account, storage,
cache, schema, function, cron, webhook, event-stream, or log adapter is configured;
the SDK rejects that unsafe combination otherwise. `BaaSRuntime` also reports
health, metrics, logs, custom events, and reads non-secret project settings.
Its connection credential is server-only and cannot be used as an end-user or
runtime-admin access token.

Verify the connected user store from the CLI:

```bash
baas-cli users list PROJECT_ID
baas-cli users create PROJECT_ID --username jane --password 'use-a-secret-value'
baas-cli users delete PROJECT_ID jane
```

Verify the connected service-account store from the CLI. The create response
contains the secret once; store it securely before continuing:

```bash
baas-cli service-accounts list PROJECT_ID
baas-cli service-accounts create PROJECT_ID --name reporting --scope 'reports:read'
baas-cli service-accounts delete PROJECT_ID CLIENT_ID
```

Verify the connected object store from the CLI:

```bash
baas-cli storage status PROJECT_ID
baas-cli storage list PROJECT_ID --prefix documents/
baas-cli storage upload PROJECT_ID documents/example.pdf --file ./example.pdf
baas-cli storage download PROJECT_ID documents/example.pdf --out ./example.pdf
baas-cli storage delete PROJECT_ID documents/example.pdf
```

Verify the connected application cache from the CLI. Use only disposable
logical keys; no cache connection details are required:

```bash
baas-cli cache status PROJECT_ID
baas-cli cache list PROJECT_ID --prefix smoke/
baas-cli cache set PROJECT_ID smoke/example --value '{"ok":true}' --ttl-seconds 300
baas-cli cache get PROJECT_ID smoke/example
baas-cli cache delete PROJECT_ID smoke/example
baas-cli cache clear PROJECT_ID --prefix smoke/
```

With a `functions` adapter, the dashboard and `baas-cli functions` commands
can list, test-invoke, enable, disable, and configure bounded auth/rate-limit
settings for handlers registered by the application. BaaS never uploads or
evaluates source code in a connected runtime. Keep the registry static, expose
only safe metadata, invoke through the normal authorization/business-logic
path, and return safe JSON. Invocation payloads are limited to 64 KiB and
results to 256 KiB. Make durable handlers idempotent because commands may be
retried.

```bash
baas-cli functions status PROJECT_ID
baas-cli functions list PROJECT_ID
baas-cli functions invoke PROJECT_ID FUNCTION_REF --payload '{"smoke":true}'
baas-cli functions configure PROJECT_ID FUNCTION_REF --enabled
```

With a `cron` adapter, schedules become manageable from the project dashboard
and top-level `baas-cli cron` commands. The application remains responsible for
durable schedule persistence, next/last-run metadata, target dispatch,
distributed locks, idempotency, overlap policy, bounded retries, and audit
logs. `listTargets()` must return only stable application-owned function or
action references. The adapter accepts no source code, callback URL, module
path, shell command, or scheduler credential.

Use five-field cron expressions and UTC or IANA timezones. The bridge permits
at most 500 schedules, 200 targets, 64 KiB payloads, and 256 KiB manual-run
results. Scheduled and manual runs must use the same execution path, and a
distributed lease must prevent two replicas from running the same occurrence.

```bash
baas-cli cron status PROJECT_ID
baas-cli cron targets PROJECT_ID
baas-cli cron list PROJECT_ID
baas-cli cron create PROJECT_ID --name smoke --schedule '*/15 * * * *' \
  --timezone UTC --target daily-report --target-type function \
  --payload '{"smoke":true}' --disable
baas-cli cron update PROJECT_ID SCHEDULE_REF --enable
baas-cli cron run PROJECT_ID SCHEDULE_REF
baas-cli cron delete PROJECT_ID SCHEDULE_REF
```

Always delete the disposable schedule and revert any disposable function
configuration after verification.

With a `webhooks` adapter, subscriptions become manageable from the project
dashboard and top-level `baas-cli webhooks` commands. The connected application
remains responsible for durable subscription and delivery records, event
dispatch, destination validation, request signing, retries, secret storage,
and audit history. BaaS never sends an event on the application's behalf and
never receives a stored signing secret.

`listEventTypes()` must expose only stable event keys the application really
publishes. Validate those keys and optional entity filters again in `create()`
and `update()`. Store signing secrets encrypted at rest and return a plaintext
secret only from `create()` or `rotateSecret()`; BaaS reveals it once and
removes it from command state immediately after the active request completes.
`list()` must return only public metadata and whether a secret exists.

Accept only public HTTPS destinations. Before every delivery, resolve the
hostname and reject loopback, private, link-local, multicast, documentation,
and reserved addresses. Revalidate every redirect target or disable redirects;
the initial URL check alone does not prevent DNS rebinding. Sign a timestamp,
stable event id, and raw request body with HMAC-SHA256, document the headers,
and require receivers to enforce a replay window. Use a durable delivery id,
bounded exponential backoff with jitter, timeouts, and an idempotency key.
Never expose response bodies, credentials, stack traces, or internal URLs in
`last_error`; return only a short safe diagnostic.

```bash
baas-cli webhooks status PROJECT_ID
baas-cli webhooks event-types PROJECT_ID
baas-cli webhooks list PROJECT_ID
baas-cli webhooks create PROJECT_ID --name smoke \
  --url https://receiver.example/webhooks/smoke \
  --event-type order.created --entity orders --disable
baas-cli webhooks edit PROJECT_ID SUBSCRIPTION_REF --enable
baas-cli webhooks retry PROJECT_ID SUBSCRIPTION_REF
baas-cli webhooks rotate-secret PROJECT_ID SUBSCRIPTION_REF
baas-cli webhooks delete PROJECT_ID SUBSCRIPTION_REF
```

Use a disposable receiver and subscription for verification. Confirm a signed
delivery, one bounded retry, pause/resume behavior, and one-time secret
visibility, then delete the subscription and receiver data.

With an `eventStream` adapter, channels, bounded event history, authorized test
publishing, and public connection metadata become manageable from the project
dashboard and `baas-cli events` commands.

```bash
baas-cli events status PROJECT_ID
baas-cli events channels PROJECT_ID
baas-cli events list PROJECT_ID --channel smoke --limit 25
baas-cli events publish PROJECT_ID --channel smoke \
  --event-type smoke.event --payload '{"source":"baas-smoke"}'
baas-cli events connection PROJECT_ID
```

Publish only to a dedicated smoke channel. The bridge intentionally has no
arbitrary event deletion operation, so remove the disposable record through
the application's administration path or verify its short retention policy.

With a `logsAdapter`, bounded application log history is queryable from the
project dashboard and `baas-cli runtime-logs` commands:

```bash
baas-cli runtime-logs status PROJECT_ID
baas-cli runtime-logs sources PROJECT_ID
baas-cli runtime-logs list PROJECT_ID \
  --level ERROR \
  --source api \
  --service checkout \
  --search "payment failed" \
  --after 2026-07-17T00:00:00Z \
  --limit 50
```

Use a dedicated synthetic request id for smoke verification and remove or
expire its records through the application's normal retention path. The bridge
is intentionally read-only and has no arbitrary log deletion operation.
