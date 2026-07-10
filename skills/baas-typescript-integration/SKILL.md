---
name: baas-typescript-integration
description: Integrate an existing TypeScript, React, Next.js, Node.js, or BFF application with a BaaS generated runtime using @dutchwebservices/baas-runtime. Use when adding typed entity CRUD, runtime authentication/users, object storage, realtime events, webhooks, function calls, scheduled-run controls, OpenAPI-derived types, or server telemetry to a BaaS project.
---

# BaaS TypeScript Integration

Turn an existing TypeScript application into a working BaaS client in one focused pass. Read [the runtime API reference](references/runtime-api.md) before making integration decisions.

## Workflow

1. Inspect the target repository: framework, package manager, existing auth state, API boundary, tests, and `.env.example`.
2. Obtain the project's generated runtime URL. Prefer `baas-cli apps get APP_ID --output json`; otherwise use the supplied runtime URL. Fetch `GET /openapi.json` to derive entity names and fields.
3. Install the SDK from the public source release:

   ```bash
   npm install github:dutchwebservices/baas-runtime#v0.2.0
   ```

4. Add one small client module, such as `src/lib/baas.ts`. Use `createBaasClient` and one public runtime URL env variable:

   ```ts
   import { createBaasClient } from "@dutchwebservices/baas-runtime";

   export const baas = createBaasClient({
     url: import.meta.env.VITE_BAAS_URL,
     persistSession: true,
   });
   ```

   For Next.js browser code use `NEXT_PUBLIC_BAAS_URL`. For a server/BFF use `BAAS_APP_URL`.

5. Define TypeScript entity types from the project's OpenAPI schema, then use `baas.entities.collection<T>(name)`. Keep data access in the existing app service layer rather than scattering raw fetch calls through UI components.
6. Implement the requested user flow end to end: sign-in/session handling, entity read/write, storage upload when needed, and a visible success/error state. Use runtime errors directly; do not invent local permission checks.
7. Add a real test for the flow. Use unit tests for client/service behavior and Playwright for sign-in plus the relevant create/read/update/delete or upload workflow.
8. Run the repository's formatter, type check, test suite, and production build. Fix failures before reporting completion.

## Security Boundary

- Browser code may use only the generated runtime URL and an end-user access token.
- Never place `BAAS_RUNTIME_TOKEN`, machine-client secrets, database credentials, or other server secrets in browser environment variables.
- `createBaasRuntime` is server-only telemetry/settings plumbing. It does not authorize entity or user access.
- Keep `auth.users`, webhook administration, event history, and scheduled-run controls in authenticated staff/admin surfaces. The runtime independently enforces these permissions.
- Do not bypass owner-scoped data rules with client-side filtering.

## Own Server or BFF

For a server the customer operates, first run:

```bash
baas-cli runtime connect --project PROJECT_ID
```

This creates a project-only telemetry connection and writes server-only values to `.env.local`. Use both helpers on the server:

```ts
import { createBaasClient, createBaasRuntime } from "@dutchwebservices/baas-runtime";

const runtime = createBaasRuntime({ service: "api" });
await runtime.start();

const client = createBaasClient({
  url: process.env.BAAS_APP_URL,
  accessToken: () => currentRequestAccessToken(),
});
```

Forward the current caller's token to `createBaasClient`; do not replace it with the telemetry credential.

## Completion Standard

Report the changed client module, supplied public env variable, entities integrated, test commands/results, and any capability that needs a dashboard-side configuration. Do not claim that an integration is complete until the application actually performs the requested runtime operation.
