---
name: baas-typescript-integration
description: Integrate an existing TypeScript, React, Next.js, Node.js, or BFF application with BaaS using @dutchwebservices/baas-runtime. Use when adding typed entity CRUD, runtime authentication/users, a connected own-runtime user adapter, object storage, realtime events, webhooks, function calls, scheduled-run controls, OpenAPI-derived types, or server telemetry to a BaaS project.
---

# BaaS TypeScript Integration

Turn an existing TypeScript application into a working BaaS client in one focused pass. Read [the runtime API reference](references/runtime-api.md) before making integration decisions.

## Workflow

1. Inspect the target repository: framework, package manager, existing auth state, API boundary, tests, and `.env.example`.
2. Obtain the project's generated runtime URL. Prefer `baas-cli apps get APP_ID --output json`; otherwise use the supplied runtime URL. Fetch `GET /openapi.json` to derive entity names and fields.
3. Install the SDK from the public source release:

   ```bash
   npm install github:dutchwebservices/baas-runtime#v0.5.0
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

When the application has its own server, user store, or object store, also follow the Own Server or BFF section. Adapt the existing services; do not create parallel storage merely to make dashboard management work.

## Security Boundary

- Browser code may use only the generated runtime URL and an end-user access token.
- Never place `BAAS_RUNTIME_TOKEN`, machine-client secrets, database credentials, or other server secrets in browser environment variables.
- `createBaasRuntime` is server-only connection plumbing. Its optional user and storage adapters execute bounded control-plane commands through the application's own services; the connection credential itself never authorizes public application API access.
- Keep `auth.users`, webhook administration, event history, and scheduled-run controls in authenticated staff/admin surfaces. The runtime independently enforces these permissions.
- Do not bypass owner-scoped data rules with client-side filtering.

## Own Server or BFF

For a server the customer operates, first run:

```bash
baas-cli runtime connect --project PROJECT_ID
```

This creates a project-only connection and writes server-only values to `.env.local`. Use both helpers on the server. If users or objects must be manageable from the dashboard or CLI, inspect the existing user, auth, and storage services first, then adapt those services directly:

```ts
import { createBaasClient, createBaasRuntime } from "@dutchwebservices/baas-runtime";

const runtime = createBaasRuntime({
  service: "api",
  users: {
    async list() {
      return userRepository.list().then((users) => users.map(toBaasUser));
    },
    async create({ username, password, email, name, roles }) {
      const user = await userService.create({ username, password, email, name, roles });
      return toBaasUser(user);
    },
    async remove(userRef) {
      await userService.remove(userRef);
    },
  },
  storage: {
    async list(input) {
      return objectStore.list(input);
    },
    async write({ key, data, contentType }) {
      return objectStore.write({ key, body: data, contentType });
    },
    async read(key) {
      const object = await objectStore.read(key);
      return { ...object.metadata, data: object.body };
    },
    async remove(key) {
      await objectStore.remove(key);
    },
  },
});
await runtime.start();

const client = createBaasClient({
  url: process.env.BAAS_APP_URL,
  accessToken: () => currentRequestAccessToken(),
});
```

Forward the current caller's token to `createBaasClient`; do not replace it with the telemetry credential.

The adapter is the security boundary for an own runtime:

- Keep password policy, hashing, duplicate checks, role validation, and audit logging in the existing `userService`.
- Map only safe user fields from `list` and `create`; never expose a password or password hash.
- Treat `userRef` as an id, username, or email only when the existing service supports that lookup safely.
- Start the runtime once per long-running server process, never in a browser or per request.
- Call `await runtime.users.sync()` after user mutations that happen outside the adapter.
- Add unit tests proving create uses the normal password-hashing path and list results contain no credential fields.
- Verify the live bridge with `baas-cli users list PROJECT_ID`, create a disposable user, delete it, and confirm both the application and dashboard update.
- Keep object-store credentials inside the application. Return only safe object metadata (`key`, `size`, content type, etag, and timestamps).
- Enforce the application's normal key validation, authorization, retention, and audit path inside the storage adapter.
- Dashboard and CLI transfers are capped at 4 MiB. Use the public application storage API or a signed upload flow for larger objects.
- Verify object storage with `baas-cli storage status PROJECT_ID`, then list, upload, download, and delete one disposable object.

The dashboard and CLI expose each management surface only when SDK 0.5.0 or newer advertises its capability and the heartbeat is live. `users` advertises `runtime-users`; `storage` advertises `object-storage`. A missing adapter or stale connection must remain unavailable; do not work around the resulting 409 by copying users or object credentials into control-plane storage.

## Completion Standard

Report the changed client module, supplied public env variable, entities integrated, connected adapters, test commands/results, and any capability that needs dashboard-side configuration. Do not claim that runtime users or object storage are manageable until a live CLI round trip has used the application's real service. Do not claim that an integration is complete until the application actually performs the requested runtime operation.
