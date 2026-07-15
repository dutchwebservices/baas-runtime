# BaaS TypeScript SDK

Use one TypeScript package for an application's data, authentication, runtime
users, object storage, event stream, webhooks, functions, project settings, and
server telemetry.

## Install

The public source installation does not require a package-registry token:

```bash
npm install github:dutchwebservices/baas-runtime#v0.5.0
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

## Server connection, users, storage, telemetry, and settings

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

With a `storage` adapter, the project dashboard and `baas-cli storage`
commands can list, upload, download, and delete objects through the
application's existing object-store service. The SDK advertises this capability
only while the adapter is configured and its heartbeat is current, so an
organization admin can distinguish a real integration from configuration
alone. Provider credentials remain inside the application.

Dashboard and CLI transfers through the administration bridge are limited to
4 MiB per object. Use `createBaasClient().storage` or the application's direct
upload flow for larger objects.

Start one `BaaSRuntime` instance per long-running server process, never in
browser code. Keep heartbeat enabled when a user or storage adapter is configured; the SDK
rejects that unsafe combination otherwise. `BaaSRuntime` also reports health, metrics, logs, custom events,
and reads non-secret project settings. Its connection credential is
server-only and cannot be used as an end-user or runtime-admin access token.

Verify the connected user store from the CLI:

```bash
baas-cli users list PROJECT_ID
baas-cli users create PROJECT_ID --username jane --password 'use-a-secret-value'
baas-cli users delete PROJECT_ID jane
```

Verify the connected object store from the CLI:

```bash
baas-cli storage status PROJECT_ID
baas-cli storage list PROJECT_ID --prefix documents/
baas-cli storage upload PROJECT_ID documents/example.pdf --file ./example.pdf
baas-cli storage download PROJECT_ID documents/example.pdf --out ./example.pdf
baas-cli storage delete PROJECT_ID documents/example.pdf
```
