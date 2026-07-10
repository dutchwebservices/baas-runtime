# BaaS TypeScript SDK

Use one TypeScript package for an application's data, authentication, runtime
users, object storage, event stream, webhooks, functions, project settings, and
server telemetry.

## Install

The public source installation does not require a package-registry token:

```bash
npm install github:dutchwebservices/baas-runtime#v0.2.0
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

## Server telemetry and settings

Use the separate server-only helper after `baas-cli runtime connect`. The CLI
writes `BAAS_RUNTIME_URL`, `BAAS_RUNTIME_TOKEN`, and the generated runtime's
`BAAS_APP_URL` to a private `.env.local` file.

```ts
import { createBaasRuntime } from "@dutchwebservices/baas-runtime";

const runtime = createBaasRuntime({ service: "orders-api" });
await runtime.start();
runtime.metrics.increment("orders.created");
runtime.logs.info("Checkout completed", { orderId: "ord_123" });
```

`BaaSRuntime` reports health, metrics, logs, custom events, and reads non-secret
project settings. Its connection credential is server-only and does not grant
data or user access.
