# Runtime API Reference

Use this reference while integrating the TypeScript SDK. The SDK surface mirrors these generated runtime endpoints.

| Capability | SDK entry point | Runtime path | Caller |
| --- | --- | --- | --- |
| Entity CRUD | `entities.collection<T>(name)` | `/api/entity/{entity}` | End user or machine token |
| Sign-in/current user | `auth.signIn`, `auth.me` | `/api/auth/login`, `/api/auth/me` | Public sign-in, then user token |
| Runtime users | `auth.users` | `/api/auth/users` | Runtime admin only |
| Machine token exchange | `auth.machineToken` | `/api/auth/m2m/token` | Server only; never browser secrets |
| Object storage | `storage` | `/api/storage/objects/{key}` | End user or machine token |
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
