# Runtime API Reference

Use this reference while integrating the TypeScript SDK. The SDK surface mirrors these generated runtime endpoints.

| Capability | SDK entry point | Runtime path | Caller |
| --- | --- | --- | --- |
| Entity CRUD | `entities.collection<T>(name)` | `/api/entity/{entity}` | End user or machine token |
| Sign-in/current user | `auth.signIn`, `auth.me` | `/api/auth/login`, `/api/auth/me` | Public sign-in, then user token |
| Generated-runtime users | `auth.users` | `/api/auth/users` | Runtime admin only |
| Own-runtime users | `createBaasRuntime({ users })` | Connected command/sync protocol | Existing server user service |
| Machine token exchange | `auth.machineToken` | `/api/auth/m2m/token` | Server only; never browser secrets |
| Object storage | `storage` | `/api/storage/objects/{key}` | End user or machine token |
| Own-runtime object storage | `createBaasRuntime({ storage })` | Connected command protocol | Existing server object store |
| Realtime event stream | `events.subscribe` | `/api/events/stream` | Runtime admin only |
| Webhooks | `events.webhooks` | `/api/events/webhooks` | Runtime admin only |
| Function call | `functions.invoke` | Function route | Function's configured auth mode |
| Scheduled runs | `functions.cron` | `/api/functions/.../cron/...` | Runtime admin only |
| Health/schema | `health.check`, `health.openapi` | `/health`, `/openapi.json` | Public |

## Type Pattern

Use the `components.schemas` section in `/openapi.json` as the source of truth. Example:

```ts
type Product = {
  title: string;
  price: number;
  imageKey?: string;
};

const products = baas.entities.collection<Product>("products");
```

The SDK automatically returns `id`, `created_at`, `updated_at`, and (when applicable) `owner_id` alongside the declared entity fields.

## React Pattern

Keep BaaS calls in a service/hook rather than rendering them inline:

```ts
export async function createProduct(input: Product) {
  return baas.entities.collection<Product>("products").create(input);
}
```

After sign-in, call `baas.auth.setAccessToken(session.access_token)`. Set `persistSession: true` only when the product deliberately keeps a browser session across reloads.

## Connected Own-Runtime Users

Use `createBaasClient().auth.users` only when calling a generated runtime's
admin user endpoints. For an application that owns its server and user store,
configure `createBaasRuntime({ users })` instead. The adapter must wrap the
existing repository/service rather than introducing a second user database.

```ts
const runtime = createBaasRuntime({
  service: "api",
  users: {
    list: async () => (await userRepository.list()).map(toBaasUser),
    create: async (input) => toBaasUser(await userService.create(input)),
    remove: async (userRef) => userService.remove(userRef),
  },
});

await runtime.start();
```

The control plane stores only a synchronized safe profile index. Passwords are
delivered only to the connected server for a create command and must be hashed
by the application's normal auth service. Passwords and hashes must never
appear in adapter results, telemetry, logs, or sync output.

A proper connection requires all of the following:

1. `baas-cli runtime connect --project PROJECT_ID` has configured the server.
2. SDK 0.4.0 or newer is running in a long-lived server process.
3. A `users` adapter is configured and advertises the `runtime-users` capability.
4. The runtime heartbeat is current.

After an out-of-band user mutation, call `await runtime.users.sync()`. Verify
the bridge with `baas-cli users list PROJECT_ID`, followed by disposable
create/delete commands.

## Connected Own-Runtime Object Storage

Use `createBaasClient().storage` for the generated runtime storage API. For an
application that owns its server and object store, configure
`createBaasRuntime({ storage })` so project admins can manage that store from
the dashboard and CLI without exposing provider credentials.

```ts
const runtime = createBaasRuntime({
  service: "api",
  storage: {
    list: (input) => objectStore.list(input),
    write: async ({ key, data, contentType }) =>
      objectStore.write({ key, body: data, contentType }),
    read: async (key) => {
      const object = await objectStore.read(key);
      return { ...object.metadata, data: object.body };
    },
    remove: (key) => objectStore.remove(key),
  },
});

await runtime.start();
```

A proper storage connection requires all of the following:

1. `baas-cli runtime connect --project PROJECT_ID` has configured the server.
2. SDK 0.5.0 or newer is running in a long-lived server process.
3. A `storage` adapter advertises the `object-storage` capability.
4. The authenticated runtime heartbeat is current.

The control plane stores only safe capability and object metadata. Storage
credentials remain in the application. Dashboard and CLI file transfers are
limited to 4 MiB; use the application's public storage API or signed URLs for
larger files. Verify with `baas-cli storage status PROJECT_ID`, then perform a
disposable list/upload/download/delete round trip.
