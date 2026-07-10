# BaaS Runtime SDK

Connect a server you operate yourself to a BaaS project. The SDK reports
health, metrics, logs, and events, and reads non-secret project settings.

## Install

The public source installation does not require a package-registry token:

```bash
npm install github:dutchwebservices/baas-runtime#v0.1.0
```

The package is also published to GitHub Packages as
`@dutchwebservices/baas-runtime`. GitHub requires a token to install npm
packages from that registry, even when a package is public.

```bash
npm install @dutchwebservices/baas-runtime --registry=https://npm.pkg.github.com
```

## Connect a project

Install `baas-cli`, then run this from the server project directory:

```bash
baas-cli runtime connect --project YOUR_PROJECT
```

The command opens a browser for sign-in when necessary, creates a project-only
connection credential, writes `BAAS_RUNTIME_URL` and `BAAS_RUNTIME_TOKEN` to
`.env.local`, and installs this package. Keep that env file out of source
control.

## Use it

```ts
import { createBaasRuntime } from "@dutchwebservices/baas-runtime";

const baas = createBaasRuntime({ service: "orders-api" });
await baas.start();

const settings = await baas.settings.get();
baas.metrics.increment("orders.created");
baas.metrics.timing("checkout.duration_ms", 183);
baas.logs.info("Checkout completed", { orderId: "ord_123" });
baas.events.publish("order.created", { orderId: "ord_123" });
```

For an Express-style server:

```ts
app.use(baas.requestContext());
app.use(baas.metrics.http());
```

The SDK is deliberately fail-open. Telemetry delivery failures are retried in
the background and never fail a customer request. The connection credential is
for server code only; do not put it in browser-delivered environment variables.
