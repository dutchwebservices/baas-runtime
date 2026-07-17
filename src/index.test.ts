import assert from "node:assert/strict";
import test from "node:test";

import {
  BaaSError,
  createBaasClient,
  createBaasRuntime,
  validateRuntimeSchemaDocument,
  type ConnectedRuntimeCacheEntry,
  type ConnectedRuntimeServiceAccount,
  type ConnectedRuntimeUser,
  type ConnectedStorageObject,
  type RuntimeSchemaSnapshot,
} from "./index.js";

function response(body: unknown, init: ResponseInit = {}): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

test("batches metrics and uses the project credential", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test/",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    flushIntervalMs: 60_000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return response({ accepted: 2 });
    },
  });

  baas.metrics.increment("orders.created");
  baas.metrics.timing("checkout.duration_ms", 18);
  await baas.flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.test/runtime/v1/metrics");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer baas_rt_example.abcdefghijklmnopqrstuvwxyz");
  const payload = JSON.parse(String(calls[0].init?.body));
  assert.equal(payload.records.length, 2);
  assert.equal(payload.records[1].unit, "ms");
});

test("caches settings with ETag and accepts 304 responses", async () => {
  let calls = 0;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    fetch: async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(new Headers(init?.headers).get("if-none-match"), null);
        return response(
          { app_id: "app-1", revision: 2, values: { checkout: true }, project: { id: "app-1", slug: "shop", name: "Shop" } },
          { headers: { etag: 'W/"runtime-settings-2"' } },
        );
      }
      assert.equal(new Headers(init?.headers).get("if-none-match"), 'W/"runtime-settings-2"');
      return new Response(null, { status: 304, headers: { etag: 'W/"runtime-settings-2"' } });
    },
  });

  const initial = await baas.settings.get();
  const cached = await baas.settings.get();
  assert.equal(initial?.values.checkout, true);
  assert.equal(cached?.revision, 2);
  assert.equal(calls, 2);
});

test("is fail-open when credentials are absent", async () => {
  const baas = createBaasRuntime();
  assert.equal(baas.enabled, false);
  baas.logs.info("This must not throw");
  baas.metrics.increment("ignored.metric");
  await baas.flush();
  assert.equal(await baas.settings.get(), undefined);
});

test("preserves structured log context", async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    flushIntervalMs: 60_000,
    fetch: async (_url, init) => {
      calls.push({ init });
      return response({ accepted: 1 });
    },
  });

  baas.logs.info("Checkout completed", { orderId: "ord_123", logger: "checkout" });
  await baas.flush();

  const payload = JSON.parse(String(calls[0].init?.body));
  assert.equal(payload.records[0].logger, "checkout");
  assert.equal(payload.records[0].attributes.orderId, "ord_123");
});

test("records HTTP timing without requiring an Express dependency", async () => {
  const calls: Array<{ init?: RequestInit }> = [];
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    flushIntervalMs: 60_000,
    fetch: async (_url, init) => {
      calls.push({ init });
      return response({ accepted: 1 });
    },
  });
  let finish: (() => void) | undefined;
  let nextCalled = false;
  baas.metrics.http()(
    { method: "POST", originalUrl: "/orders", headers: {} },
    { statusCode: 201, once: (_event, callback) => { finish = callback; } },
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  finish?.();
  await baas.flush();
  const payload = JSON.parse(String(calls[0].init?.body));
  assert.equal(payload.records[0].name, "http.server.duration");
  assert.equal(payload.records[0].attributes.status_code, 201);
});

test("manages an existing application user store only when a users adapter is configured", async () => {
  const users: ConnectedRuntimeUser[] = [
    {
      id: "user-1",
      username: "owner@example.test",
      email: "owner@example.test",
      name: "Owner",
      roles: ["admin"],
    },
  ];
  const createdInputs: unknown[] = [];
  const removedRefs: string[] = [];
  const calls: Array<{ url: string; body: unknown }> = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    users: {
      list: async () => users,
      listRoles: async () => [
        {
          key: "admin:operations",
          label: "Operations administrator",
          description: "Can manage operations.",
        },
        { key: "client", label: "Client" },
      ],
      create: async (input) => {
        createdInputs.push(input);
        const user = { id: "user-2", ...input, roles: input.roles ?? [] };
        users.push(user);
        return user;
      },
      remove: async (userRef) => {
        removedRefs.push(userRef);
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            {
              id: "command-1",
              action: "users.create",
              payload: {
                username: "new@example.test",
                email: "new@example.test",
                name: "New user",
                password: "temporary-secret",
                roles: ["admin"],
              },
            },
            { id: "command-2", action: "users.delete", payload: { user_ref: "user-1" } },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await baas.shutdown();

  assert.deepEqual(createdInputs, [
    {
      username: "new@example.test",
      email: "new@example.test",
      name: "New user",
      password: "temporary-secret",
      roles: ["admin"],
    },
  ]);
  assert.deepEqual(removedRefs, ["user-1"]);
  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  assert.deepEqual((heartbeat?.body as { capabilities?: string[] }).capabilities, ["runtime-users"]);
  assert.deepEqual(
    (heartbeat?.body as { user_role_catalog?: unknown }).user_role_catalog,
    [
      {
        key: "admin:operations",
        label: "Operations administrator",
        description: "Can manage operations.",
      },
      { key: "client", label: "Client" },
    ],
  );
  assert.ok(calls.some((call) => call.url === "/runtime/v1/users/sync"));
  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 2);
  assert.doesNotMatch(JSON.stringify(results), /temporary-secret/);
});

test("rejects a users adapter when heartbeat is disabled", () => {
  assert.throws(
    () => createBaasRuntime({
      heartbeat: false,
      users: {
        list: async () => [],
        create: async () => ({ id: "never", username: "never", roles: [] }),
        remove: async () => undefined,
      },
    }),
    /requires heartbeat/,
  );
});

test("manages service accounts without returning one-time secrets", async () => {
  const accounts: ConnectedRuntimeServiceAccount[] = [
    {
      id: "account-1",
      name: "Reporting worker",
      client_id: "reporting-worker",
      scopes: ["reports:read"],
      token_url: "/api/auth/m2m/token",
      created_at: "2026-07-17T09:00:00Z",
    },
  ];
  const createdInputs: unknown[] = [];
  const removedRefs: string[] = [];
  const calls: Array<{ url: string; body: unknown }> = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    serviceAccounts: {
      list: async () => accounts,
      create: async (input) => {
        createdInputs.push(input);
        const account = {
          id: "account-2",
          name: input.name,
          client_id: input.clientId,
          scopes: input.scopes,
          token_url: "/api/auth/m2m/token",
          client_secret: input.clientSecret,
          secret_hash: "must-not-leave-runtime",
        } as ConnectedRuntimeServiceAccount & {
          client_secret: string;
          secret_hash: string;
        };
        accounts.push(account);
        return account;
      },
      remove: async (accountRef) => {
        removedRefs.push(accountRef);
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "command-1", action: "service_accounts.list", payload: {} },
            {
              id: "command-2",
              action: "service_accounts.create",
              payload: {
                name: "Deploy worker",
                client_id: "deploy-worker",
                client_secret: "one-time-secret",
                scopes: ["deploy:write"],
              },
            },
            {
              id: "command-3",
              action: "service_accounts.delete",
              payload: { account_ref: "account-1" },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await baas.shutdown();

  assert.deepEqual(createdInputs, [
    {
      name: "Deploy worker",
      clientId: "deploy-worker",
      clientSecret: "one-time-secret",
      scopes: ["deploy:write"],
    },
  ]);
  assert.deepEqual(removedRefs, ["account-1"]);
  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  assert.deepEqual(
    (heartbeat?.body as { capabilities?: string[] }).capabilities,
    ["service-accounts"],
  );
  assert.deepEqual(
    (heartbeat?.body as { integration_manifest?: unknown }).integration_manifest,
    [{ key: "service-accounts", status: "enabled", verification: "adapter" }],
  );
  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 3);
  assert.doesNotMatch(JSON.stringify(results), /one-time-secret|must-not-leave-runtime/);
  assert.deepEqual(results[1].body, {
    ok: true,
    result: {
      service_account: {
        id: "account-2",
        name: "Deploy worker",
        client_id: "deploy-worker",
        scopes: ["deploy:write"],
        token_url: "/api/auth/m2m/token",
        created_at: null,
        updated_at: null,
      },
    },
  });
});

test("rejects a service account adapter when heartbeat is disabled", () => {
  assert.throws(
    () => createBaasRuntime({
      heartbeat: false,
      serviceAccounts: {
        list: async () => [],
        create: async ({ name, clientId, scopes }) => ({
          id: clientId,
          name,
          client_id: clientId,
          scopes,
          token_url: "/api/auth/m2m/token",
        }),
        remove: async () => undefined,
      },
    }),
    /requires heartbeat/,
  );
});

test("redacts a one-time service account secret from adapter errors", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    serviceAccounts: {
      list: async () => [],
      create: async (input) => {
        throw new Error(`Credential ${input.clientSecret} could not be stored`);
      },
      remove: async () => undefined,
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            {
              id: "command-error",
              action: "service_accounts.create",
              payload: {
                name: "Failing worker",
                client_id: "failing-worker",
                client_secret: "error-secret-must-not-leak",
                scopes: [],
              },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await baas.shutdown();

  const result = calls.find((call) => call.url.endsWith("/command-error/result"));
  assert.deepEqual(result?.body, {
    ok: false,
    error: "Credential [redacted] could not be stored",
  });
  assert.doesNotMatch(JSON.stringify(calls), /error-secret-must-not-leak/);
});

test("advertises and executes connected object storage management", async () => {
  const objects = new Map<string, { data: Uint8Array; metadata: ConnectedStorageObject }>();
  objects.set("documents/existing.txt", {
    data: new TextEncoder().encode("existing"),
    metadata: { key: "documents/existing.txt", size: 8, content_type: "text/plain", etag: "v1" },
  });
  const calls: Array<{ url: string; body: unknown }> = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    storage: {
      list: async ({ prefix, offset, limit }) => {
        const matches = [...objects.values()]
          .map(({ metadata }) => metadata)
          .filter(({ key }) => !prefix || key.startsWith(prefix));
        return { objects: matches.slice(offset, offset + limit), total: matches.length };
      },
      write: async ({ key, data, contentType }) => {
        const metadata = { key, size: data.byteLength, content_type: contentType, etag: "v2" };
        objects.set(key, { data, metadata });
        return metadata;
      },
      read: async (key) => {
        const stored = objects.get(key);
        if (!stored) throw new Error("Object not found");
        return { ...stored.metadata, data: stored.data };
      },
      remove: async (key) => {
        objects.delete(key);
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "storage-1", action: "storage.list", payload: { prefix: "documents/", limit: 10, offset: 0 } },
            {
              id: "storage-2",
              action: "storage.write",
              payload: {
                key: "documents/new.txt",
                content_type: "text/plain",
                data_base64: Buffer.from("new object").toString("base64"),
              },
            },
            { id: "storage-3", action: "storage.read", payload: { key: "documents/existing.txt" } },
            { id: "storage-4", action: "storage.delete", payload: { key: "documents/new.txt" } },
            {
              id: "storage-5",
              action: "storage.write",
              payload: { key: "documents/invalid.txt", data_base64: "not-base64" },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  assert.deepEqual((heartbeat?.body as { capabilities?: string[] }).capabilities, ["object-storage"]);
  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 5);
  assert.equal(
    ((results[0].body as { result: { objects: ConnectedStorageObject[] } }).result.objects[0]).key,
    "documents/existing.txt",
  );
  assert.equal(
    (results[1].body as { result: { object: ConnectedStorageObject } }).result.object.size,
    10,
  );
  assert.equal(
    Buffer.from(
      (results[2].body as { result: { data_base64: string } }).result.data_base64,
      "base64",
    ).toString(),
    "existing",
  );
  assert.equal(objects.has("documents/new.txt"), false);
  assert.deepEqual(results[4].body, {
    ok: false,
    error: "Storage write command contains invalid object data",
  });
});

test("rejects a storage adapter when heartbeat is disabled", () => {
  assert.throws(
    () => createBaasRuntime({
      heartbeat: false,
      storage: {
        list: async () => [],
        write: async ({ key, data }) => ({ key, size: data.byteLength }),
        read: async (key) => ({ key, size: 0, data: new Uint8Array() }),
        remove: async () => undefined,
      },
    }),
    /requires heartbeat/,
  );
});

test("advertises and executes bounded application cache management", async () => {
  const entries = new Map<string, ConnectedRuntimeCacheEntry>([
    [
      "sessions/user-1",
      {
        key: "sessions/user-1",
        value: { authenticated: true },
        ttl_seconds: 600,
        size_bytes: 22,
        expires_at: "2026-07-17T08:10:00.000Z",
        updated_at: "2026-07-17T08:00:00.000Z",
      },
    ],
  ]);
  const calls: Array<{ url: string; body: unknown }> = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    cache: {
      list: async ({ prefix }) => ({
        entries: [...entries.values()]
          .filter((entry) => !prefix || entry.key.startsWith(prefix))
          .map(({ value: _value, ...entry }) => entry),
        next_cursor: null,
      }),
      get: async (key) => entries.get(key) ?? null,
      set: async ({ key, value, ttlSeconds }) => {
        const entry: ConnectedRuntimeCacheEntry = {
          key,
          value,
          ttl_seconds: ttlSeconds,
          size_bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
          updated_at: "2026-07-17T08:01:00.000Z",
        };
        entries.set(key, entry);
        return entry;
      },
      remove: async (key) => {
        entries.delete(key);
      },
      clear: async ({ prefix, all }) => {
        const keys = [...entries.keys()].filter((key) => all || key.startsWith(prefix ?? ""));
        for (const key of keys) entries.delete(key);
        return { deleted: keys.length };
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "cache-list", action: "cache.list", payload: { prefix: "sessions/", limit: 50 } },
            { id: "cache-get", action: "cache.get", payload: { key: "sessions/user-1" } },
            {
              id: "cache-set",
              action: "cache.set",
              payload: { key: "sessions/user-2", value: { authenticated: false }, ttl_seconds: 900 },
            },
            { id: "cache-delete", action: "cache.delete", payload: { key: "sessions/user-2" } },
            { id: "cache-clear", action: "cache.clear", payload: { prefix: "sessions/" } },
            { id: "cache-unsafe-clear", action: "cache.clear", payload: {} },
            { id: "cache-unsafe-key", action: "cache.get", payload: { key: "sessions/../admin" } },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 35));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const manifest = (heartbeat?.body as {
    integration_manifest?: Array<Record<string, string>>;
  }).integration_manifest;
  assert.ok(
    manifest?.some(
      (entry) => entry.key === "redis" && entry.status === "enabled" && entry.verification === "adapter",
    ),
  );
  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 7);
  assert.deepEqual(
    (results[0].body as { result: { entries: Array<Record<string, unknown>> } }).result.entries[0],
    {
      key: "sessions/user-1",
      ttl_seconds: 600,
      size_bytes: 22,
      expires_at: "2026-07-17T08:10:00.000Z",
      updated_at: "2026-07-17T08:00:00.000Z",
    },
  );
  assert.deepEqual(
    (results[1].body as { result: { entry: ConnectedRuntimeCacheEntry } }).result.entry.value,
    { authenticated: true },
  );
  assert.deepEqual(
    (results[2].body as { result: { entry: ConnectedRuntimeCacheEntry } }).result.entry.value,
    { authenticated: false },
  );
  assert.equal(entries.size, 0);
  assert.deepEqual(results[4].body, { ok: true, result: { deleted: 1 } });
  assert.deepEqual(results[5].body, {
    ok: false,
    error: "Cache clear requires a prefix or all=true",
  });
  assert.deepEqual(results[6].body, {
    ok: false,
    error: "Cache key contains an unsupported path segment",
  });
  assert.doesNotMatch(JSON.stringify(results[0].body), /authenticated/);
});

test("rejects a cache adapter when heartbeat is disabled", () => {
  assert.throws(
    () => createBaasRuntime({
      heartbeat: false,
      cache: {
        list: async () => [],
        get: async () => null,
        set: async ({ key, value }) => ({
          key,
          value,
          size_bytes: new TextEncoder().encode(JSON.stringify(value)).byteLength,
        }),
        remove: async () => undefined,
        clear: async () => ({ deleted: 0 }),
      },
    }),
    /requires heartbeat/,
  );
});

test("manages an external application's revision-checked schema through the adapter", async () => {
  const initialSchema: RuntimeSchemaSnapshot["schema"] = {
    entities: [
      {
        name: "customers",
        label: "Customers",
        fields: [{ name: "email", type: "string", required: true, unique: true }],
      },
    ],
  };
  const desiredSchema: RuntimeSchemaSnapshot["schema"] = {
    entities: [
      {
        name: "customers",
        label: "Customers",
        fields: [{ name: "email", type: "string", required: true, unique: true }],
      },
      {
        name: "orders",
        fields: [
          { name: "reference", type: "string", required: true, indexed: true },
          {
            name: "customer",
            type: "relation",
            relation_entity: "customers",
            relation_kind: "many_to_one",
            relation_on_delete: "restrict",
          },
        ],
      },
    ],
  };
  let snapshot: RuntimeSchemaSnapshot = {
    revision: "schema-r1",
    updated_at: "2026-07-16T08:00:00.000Z",
    schema: initialSchema,
  };
  const applied: Array<{ expectedRevision: string; entityNames: string[] }> = [];
  const calls: Array<{ url: string; body: unknown }> = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    schema: {
      read: async () => snapshot,
      apply: async (input) => {
        applied.push({
          expectedRevision: input.expectedRevision,
          entityNames: input.schema.entities.map((entity) => entity.name),
        });
        if (input.expectedRevision !== snapshot.revision) {
          throw new Error("Schema revision is stale");
        }
        snapshot = {
          revision: "schema-r2",
          updated_at: "2026-07-16T08:01:00.000Z",
          schema: input.schema,
        };
        return snapshot;
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "schema-read", action: "schema.read", payload: {} },
            {
              id: "schema-write",
              action: "schema.write",
              payload: { schema: desiredSchema, expected_revision: "schema-r1" },
            },
            {
              id: "schema-stale-write",
              action: "schema.write",
              payload: { schema: desiredSchema, expected_revision: "schema-r1" },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const heartbeatBody = heartbeat?.body as {
    capabilities?: string[];
    integration_manifest?: Array<Record<string, string>>;
  };
  assert.deepEqual(heartbeatBody.capabilities, ["schema-builder"]);
  assert.ok(
    heartbeatBody.integration_manifest?.some(
      (entry) =>
        entry.key === "schema-builder" &&
        entry.status === "enabled" &&
        entry.verification === "adapter",
    ),
  );
  assert.deepEqual(applied, [
    { expectedRevision: "schema-r1", entityNames: ["customers", "orders"] },
    { expectedRevision: "schema-r1", entityNames: ["customers", "orders"] },
  ]);

  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 3);
  const readResult = results[0].body as {
    ok: boolean;
    result: { snapshot: RuntimeSchemaSnapshot };
  };
  assert.equal(readResult.ok, true);
  assert.equal(readResult.result.snapshot.revision, "schema-r1");
  assert.deepEqual(
    readResult.result.snapshot.schema,
    JSON.parse(JSON.stringify(validateRuntimeSchemaDocument(initialSchema))),
  );
  assert.equal(
    (results[1].body as { result: { snapshot: RuntimeSchemaSnapshot } }).result.snapshot.revision,
    "schema-r2",
  );
  assert.deepEqual(results[2].body, { ok: false, error: "Schema revision is stale" });
});

test("lists, invokes, and configures application-owned functions through the adapter", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const invocations: Array<{ functionRef: string; payload: unknown }> = [];
  const updates: Array<{ functionRef: string; input: unknown }> = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    functions: {
      list: async () => [
        {
          id: "reports.daily",
          name: "Daily report",
          description: "Builds the daily project report.",
          enabled: true,
          auth_mode: "required",
          tags: ["reports", "scheduled", "reports"],
          rate_limit: { requests: 30, window_seconds: 60 },
        },
      ],
      invoke: async (functionRef, input) => {
        invocations.push({ functionRef, payload: input.payload });
        if (input.payload && typeof input.payload === "object" && "fail" in input.payload) {
          throw new Error("private application stack and credential detail");
        }
        return { result: { total: 42 }, duration_ms: 18 };
      },
      update: async (functionRef, input) => {
        updates.push({ functionRef, input });
        return {
          id: functionRef,
          name: "Daily report",
          enabled: input.enabled ?? true,
          auth_mode: input.authMode ?? "required",
          rate_limit: input.rateLimit,
        };
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "functions-list", action: "functions.list", payload: {} },
            {
              id: "functions-invoke",
              action: "functions.invoke",
              payload: { function_ref: "reports.daily", payload: { date: "2026-07-17" } },
            },
            {
              id: "functions-update",
              action: "functions.update",
              payload: {
                function_ref: "reports.daily",
                enabled: false,
                auth_mode: "optional",
                rate_limit: { requests: 10, window_seconds: 60 },
              },
            },
            {
              id: "functions-error",
              action: "functions.invoke",
              payload: { function_ref: "reports.daily", payload: { fail: true } },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const manifest = (heartbeat?.body as {
    integration_manifest?: Array<Record<string, unknown>>;
  }).integration_manifest;
  assert.deepEqual(
    manifest?.find((entry) => entry.key === "baas-functions"),
    {
      key: "baas-functions",
      status: "enabled",
      verification: "adapter",
      operations: ["list", "invoke", "update"],
    },
  );
  assert.deepEqual(invocations, [
    { functionRef: "reports.daily", payload: { date: "2026-07-17" } },
    { functionRef: "reports.daily", payload: { fail: true } },
  ]);
  assert.deepEqual(updates, [
    {
      functionRef: "reports.daily",
      input: {
        enabled: false,
        authMode: "optional",
        rateLimit: { requests: 10, window_seconds: 60 },
      },
    },
  ]);

  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 4);
  assert.equal(
    ((results[0].body as { result: { functions: Array<{ id: string }> } }).result.functions[0]).id,
    "reports.daily",
  );
  assert.deepEqual(
    (results[1].body as { result: unknown }).result,
    { invocation: { result: { total: 42 }, duration_ms: 18 } },
  );
  assert.deepEqual(
    (results[2].body as { result: { function: { enabled: boolean; auth_mode: string } } }).result.function,
    {
      id: "reports.daily",
      name: "Daily report",
      description: null,
      enabled: false,
      auth_mode: "optional",
      tags: [],
      rate_limit: { requests: 10, window_seconds: 60 },
      created_at: null,
      updated_at: null,
    },
  );
  assert.deepEqual(results[3].body, {
    ok: false,
    error: "Function adapter operation failed",
  });
  assert.doesNotMatch(JSON.stringify(results[3].body), /private application/);
});

test("manages application-owned cron schedules through the bounded adapter", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const created: unknown[] = [];
  const updated: Array<{ ref: string; input: unknown }> = [];
  const removed: string[] = [];
  const runs: string[] = [];
  let claimed = false;
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    cron: {
      listTargets: async () => [
        {
          id: "reports.daily",
          name: "Daily report",
          description: "Build the daily report.",
          type: "function",
        },
      ],
      list: async () => [
        {
          id: "schedule-daily-report",
          name: "Daily report",
          schedule: "0 7 * * 1-5",
          timezone: "Europe/Amsterdam",
          enabled: true,
          target: { type: "function", ref: "reports.daily" },
          payload: { locale: "nl-NL" },
          next_run_at: "2026-07-20T05:00:00.000Z",
        },
      ],
      create: async (input) => {
        created.push(input);
        return {
          id: "schedule-weekly-report",
          name: input.name,
          description: input.description,
          schedule: input.schedule,
          timezone: input.timezone,
          enabled: input.enabled,
          target: input.target,
          payload: input.payload,
        };
      },
      update: async (ref, input) => {
        updated.push({ ref, input });
        return {
          id: ref,
          name: input.name ?? "Daily report",
          schedule: input.schedule ?? "0 7 * * 1-5",
          timezone: input.timezone ?? "Europe/Amsterdam",
          enabled: input.enabled ?? true,
          target: input.target ?? { type: "function", ref: "reports.daily" },
          payload: input.payload ?? null,
        };
      },
      remove: async (ref) => {
        removed.push(ref);
      },
      run: async (ref) => {
        runs.push(ref);
        if (ref === "schedule-private-error") {
          throw new Error("private scheduler credentials and stack");
        }
        return {
          status: "succeeded",
          result: { generated: 12 },
          duration_ms: 24,
          started_at: "2026-07-17T07:00:00.000Z",
          finished_at: "2026-07-17T07:00:00.024Z",
        };
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "cron-targets", action: "cron.targets", payload: {} },
            { id: "cron-list", action: "cron.list", payload: {} },
            {
              id: "cron-create",
              action: "cron.create",
              payload: {
                name: "Weekly report",
                description: "Create the weekly report.",
                schedule: "0 8 * * 1",
                timezone: "Europe/Amsterdam",
                enabled: true,
                target: { type: "function", ref: "reports.daily" },
                payload: { locale: "nl-NL" },
              },
            },
            {
              id: "cron-update",
              action: "cron.update",
              payload: {
                schedule_ref: "schedule-daily-report",
                changes: { enabled: false, schedule: "30 7 * * 1-5" },
              },
            },
            {
              id: "cron-delete",
              action: "cron.delete",
              payload: { schedule_ref: "schedule-daily-report" },
            },
            {
              id: "cron-run",
              action: "cron.run",
              payload: { schedule_ref: "schedule-weekly-report" },
            },
            {
              id: "cron-error",
              action: "cron.run",
              payload: { schedule_ref: "schedule-private-error" },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 35));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const manifest = (heartbeat?.body as {
    integration_manifest?: Array<Record<string, unknown>>;
  }).integration_manifest;
  assert.deepEqual(
    manifest?.find((entry) => entry.key === "cron"),
    {
      key: "cron",
      status: "enabled",
      verification: "adapter",
      operations: ["targets", "list", "create", "update", "delete", "run"],
    },
  );
  assert.deepEqual(created, [
    {
      name: "Weekly report",
      description: "Create the weekly report.",
      schedule: "0 8 * * 1",
      timezone: "Europe/Amsterdam",
      enabled: true,
      target: { type: "function", ref: "reports.daily" },
      payload: { locale: "nl-NL" },
    },
  ]);
  assert.deepEqual(updated, [
    {
      ref: "schedule-daily-report",
      input: { enabled: false, schedule: "30 7 * * 1-5" },
    },
  ]);
  assert.deepEqual(removed, ["schedule-daily-report"]);
  assert.deepEqual(runs, ["schedule-weekly-report", "schedule-private-error"]);

  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 7);
  assert.equal(
    ((results[0].body as { result: { targets: Array<{ id: string }> } }).result.targets[0]).id,
    "reports.daily",
  );
  assert.equal(
    ((results[1].body as { result: { schedules: Array<{ id: string }> } }).result.schedules[0]).id,
    "schedule-daily-report",
  );
  assert.deepEqual(
    (results[5].body as { result: unknown }).result,
    {
      run: {
        status: "succeeded",
        result: { generated: 12 },
        duration_ms: 24,
        started_at: "2026-07-17T07:00:00.000Z",
        finished_at: "2026-07-17T07:00:00.024Z",
      },
    },
  );
  assert.deepEqual(results[6].body, {
    ok: false,
    error: "Schedule adapter operation failed",
  });
  assert.doesNotMatch(JSON.stringify(results[6].body), /private scheduler/);
});

test("manages application-owned webhook subscriptions through the bounded adapter", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const created: unknown[] = [];
  const updated: Array<{ ref: string; input: unknown }> = [];
  const removed: string[] = [];
  const rotated: string[] = [];
  const retried: string[] = [];
  let claimed = false;
  const subscription = {
    id: "orders-primary",
    name: "Order events",
    description: "Notify the order service.",
    url: "https://hooks.example.test/orders",
    event_types: ["entity.created", "entity.updated"],
    entities: ["orders"],
    event_name_overrides: { "entity.created": "order.created" },
    enabled: true,
    signing_secret_present: true,
    last_delivery_status: "delivered" as const,
    last_status_code: 202,
    last_delivery_at: "2026-07-17T08:00:00.000Z",
  };
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    webhooks: {
      listEventTypes: async () => [
        {
          key: "entity.created",
          name: "Entity created",
          description: "After a successful create.",
        },
        { key: "entity.updated", name: "Entity updated" },
      ],
      list: async () => [subscription],
      create: async (input) => {
        created.push(input);
        return {
          subscription: {
            ...subscription,
            name: input.name,
            description: input.description,
            url: input.url,
            event_types: input.eventTypes,
            entities: input.entities,
            event_name_overrides: input.eventNameOverrides,
            enabled: input.enabled,
            last_delivery_status: "never",
            last_status_code: null,
            last_delivery_at: null,
          },
          signingSecret: "whsec_creation_secret_123456",
        };
      },
      update: async (ref, input) => {
        updated.push({ ref, input });
        return {
          ...subscription,
          name: input.name ?? subscription.name,
          enabled: input.enabled ?? subscription.enabled,
        };
      },
      remove: async (ref) => {
        removed.push(ref);
      },
      rotateSecret: async (ref) => {
        rotated.push(ref);
        return "whsec_rotated_secret_123456";
      },
      retry: async (ref) => {
        retried.push(ref);
        if (ref === "private-failure") {
          throw new Error("private delivery credentials and stack");
        }
        return {
          status: "delivered",
          statusCode: 202,
          attemptedAt: "2026-07-17T09:00:00.000Z",
        };
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "webhook-types", action: "webhooks.event-types", payload: {} },
            { id: "webhook-list", action: "webhooks.list", payload: {} },
            {
              id: "webhook-create",
              action: "webhooks.create",
              payload: {
                name: "Order events",
                description: "Notify the order service.",
                url: "http://127.0.0.1:48123/orders",
                event_types: ["entity.created", "entity.updated"],
                entities: ["orders"],
                event_name_overrides: { "entity.created": "order.created" },
                enabled: true,
              },
            },
            {
              id: "webhook-update",
              action: "webhooks.update",
              payload: {
                subscription_ref: "orders-primary",
                changes: { name: "Order lifecycle", enabled: false },
              },
            },
            {
              id: "webhook-rotate",
              action: "webhooks.rotate-secret",
              payload: { subscription_ref: "orders-primary" },
            },
            {
              id: "webhook-retry",
              action: "webhooks.retry",
              payload: { subscription_ref: "orders-primary" },
            },
            {
              id: "webhook-delete",
              action: "webhooks.delete",
              payload: { subscription_ref: "orders-primary" },
            },
            {
              id: "webhook-error",
              action: "webhooks.retry",
              payload: { subscription_ref: "private-failure" },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 45));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const manifest = (heartbeat?.body as {
    integration_manifest?: Array<Record<string, unknown>>;
  }).integration_manifest;
  assert.deepEqual(
    manifest?.find((entry) => entry.key === "webhooks"),
    {
      key: "webhooks",
      status: "enabled",
      verification: "adapter",
      operations: [
        "event-types",
        "list",
        "create",
        "update",
        "delete",
        "rotate-secret",
        "retry",
      ],
    },
  );
  assert.deepEqual(created, [
    {
      name: "Order events",
      description: "Notify the order service.",
      url: "http://127.0.0.1:48123/orders",
      eventTypes: ["entity.created", "entity.updated"],
      entities: ["orders"],
      eventNameOverrides: { "entity.created": "order.created" },
      enabled: true,
    },
  ]);
  assert.deepEqual(updated, [
    { ref: "orders-primary", input: { name: "Order lifecycle", enabled: false } },
  ]);
  assert.deepEqual(removed, ["orders-primary"]);
  assert.deepEqual(rotated, ["orders-primary"]);
  assert.deepEqual(retried, ["orders-primary", "private-failure"]);

  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 8);
  assert.equal(
    ((results[0].body as { result: { event_types: Array<{ key: string }> } }).result.event_types[0]).key,
    "entity.created",
  );
  assert.equal(
    ((results[1].body as { result: { subscriptions: Array<{ id: string }> } }).result.subscriptions[0]).id,
    "orders-primary",
  );
  assert.equal(
    (results[2].body as { result: { signing_secret: string } }).result.signing_secret,
    "whsec_creation_secret_123456",
  );
  assert.equal(
    (results[4].body as { result: { signing_secret: string } }).result.signing_secret,
    "whsec_rotated_secret_123456",
  );
  assert.deepEqual((results[5].body as { result: unknown }).result, {
    status: "delivered",
    status_code: 202,
    attempted_at: "2026-07-17T09:00:00.000Z",
    error: null,
  });
  assert.deepEqual(results[7].body, {
    ok: false,
    error: "Webhook adapter operation failed",
  });
  assert.doesNotMatch(JSON.stringify(results[7].body), /private delivery/);
});

test("manages application-owned event streams through the bounded adapter", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const listInputs: unknown[] = [];
  const published: unknown[] = [];
  let claimed = false;
  const event = {
    id: "evt-order-101",
    event_type: "order.created",
    channel: "orders",
    payload: { order_id: "order-101", total: 42 },
    entity: "orders",
    action: "created",
    subject: "order-101",
    created_at: "2026-07-17T10:00:00.000Z",
  };
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    eventStream: {
      listChannels: async () => [
        {
          key: "orders",
          name: "Orders",
          description: "Order lifecycle events.",
          publishable: true,
        },
      ],
      list: async (input) => {
        listInputs.push(input);
        return { events: [event], nextCursor: "cursor-next" };
      },
      publish: async (input) => {
        published.push(input);
        if (input.channel === "private") throw new Error("private stream credentials and stack");
        return {
          ...event,
          event_type: input.eventType,
          channel: input.channel,
          payload: input.payload,
        };
      },
      connection: async () => ({
        streamUrl: "https://events.example.test/stream",
        historyUrl: "https://events.example.test/history",
        authMode: "bearer",
      }),
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "event-channels", action: "event_stream.channels", payload: {} },
            {
              id: "event-list",
              action: "event_stream.list",
              payload: {
                channel: "orders",
                event_types: ["order.created"],
                entity: "orders",
                search: "order-101",
                after: "2026-07-17T09:00:00.000Z",
                before: "2026-07-17T11:00:00.000Z",
                limit: 50,
                cursor: "cursor-current",
              },
            },
            {
              id: "event-publish",
              action: "event_stream.publish",
              payload: {
                event_type: "order.created",
                channel: "orders",
                payload: { order_id: "order-101", total: 42 },
              },
            },
            { id: "event-connection", action: "event_stream.connection", payload: {} },
            {
              id: "event-error",
              action: "event_stream.publish",
              payload: {
                event_type: "order.created",
                channel: "private",
                payload: { secret: "must-not-leak" },
              },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 75));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const manifest = (heartbeat?.body as {
    integration_manifest?: Array<Record<string, unknown>>;
  }).integration_manifest;
  assert.deepEqual(
    manifest?.find((entry) => entry.key === "event-stream"),
    {
      key: "event-stream",
      status: "enabled",
      verification: "adapter",
      operations: ["channels", "list", "publish", "connection"],
    },
  );
  assert.deepEqual(listInputs, [
    {
      channel: "orders",
      eventTypes: ["order.created"],
      entity: "orders",
      search: "order-101",
      after: "2026-07-17T09:00:00.000Z",
      before: "2026-07-17T11:00:00.000Z",
      limit: 50,
      cursor: "cursor-current",
    },
  ]);
  assert.deepEqual(published, [
    {
      eventType: "order.created",
      channel: "orders",
      payload: { order_id: "order-101", total: 42 },
    },
    {
      eventType: "order.created",
      channel: "private",
      payload: { secret: "must-not-leak" },
    },
  ]);

  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 5);
  assert.equal(
    ((results[0].body as { result: { channels: Array<{ key: string }> } }).result.channels[0]).key,
    "orders",
  );
  assert.deepEqual((results[1].body as { result: unknown }).result, {
    events: [event],
    next_cursor: "cursor-next",
  });
  assert.deepEqual((results[3].body as { result: unknown }).result, {
    connection: {
      stream_url: "https://events.example.test/stream",
      history_url: "https://events.example.test/history",
      auth_mode: "bearer",
    },
  });
  assert.deepEqual(results[4].body, {
    ok: false,
    error: "Event stream adapter operation failed",
  });
  assert.doesNotMatch(JSON.stringify(results[4].body), /private stream|must-not-leak/);
});

test("queries application-owned logs through the bounded read-only adapter", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const queryInputs: unknown[] = [];
  let claimed = false;
  const entry = {
    id: "log-order-101",
    timestamp: "2026-07-17T12:00:00.000Z",
    level: "ERROR" as const,
    message: "Order processing failed",
    source: "application",
    service: "orders-api",
    environment: "production",
    logger: "orders.checkout",
    request_id: "req-101",
    trace_id: "trace-101",
    attributes: { order_id: "order-101", retryable: true },
  };
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    commandPollIntervalMs: 5,
    logsAdapter: {
      listSources: async () => [
        {
          key: "application",
          name: "Application",
          description: "Application request logs.",
          service: "orders-api",
          environment: "production",
        },
      ],
      query: async (input) => {
        queryInputs.push(input);
        if (input.traceId === "private") throw new Error("private log-store credentials");
        return { entries: [entry], nextCursor: "cursor-next" };
      },
    },
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      if (path === "/runtime/v1/commands/claim" && !claimed) {
        claimed = true;
        return response({
          commands: [
            { id: "log-sources", action: "logs.sources", payload: {} },
            {
              id: "log-query",
              action: "logs.query",
              payload: {
                levels: ["ERROR"],
                sources: ["application"],
                services: ["orders-api"],
                environments: ["production"],
                search: "processing failed",
                logger: "orders.checkout",
                request_id: "req-101",
                trace_id: "trace-101",
                after: "2026-07-17T11:00:00.000Z",
                before: "2026-07-17T13:00:00.000Z",
                limit: 50,
                cursor: "cursor-current",
              },
            },
            {
              id: "log-error",
              action: "logs.query",
              payload: {
                levels: [],
                sources: [],
                services: [],
                environments: [],
                trace_id: "private",
                limit: 50,
              },
            },
          ],
        });
      }
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await new Promise((resolve) => setTimeout(resolve, 75));
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const manifest = (heartbeat?.body as {
    integration_manifest?: Array<Record<string, unknown>>;
  }).integration_manifest;
  assert.deepEqual(manifest?.find((item) => item.key === "logs"), {
    key: "logs",
    status: "enabled",
    verification: "adapter",
    operations: ["sources", "query"],
  });
  assert.equal(queryInputs.length, 2);
  assert.deepEqual(queryInputs[0], {
    levels: ["ERROR"],
    sources: ["application"],
    services: ["orders-api"],
    environments: ["production"],
    search: "processing failed",
    logger: "orders.checkout",
    requestId: "req-101",
    traceId: "trace-101",
    after: "2026-07-17T11:00:00.000Z",
    before: "2026-07-17T13:00:00.000Z",
    limit: 50,
    cursor: "cursor-current",
  });

  const results = calls.filter((call) => call.url.endsWith("/result"));
  assert.equal(results.length, 3);
  assert.equal(
    ((results[0].body as { result: { sources: Array<{ key: string }> } }).result.sources[0]).key,
    "application",
  );
  assert.deepEqual((results[1].body as { result: unknown }).result, {
    entries: [entry],
    next_cursor: "cursor-next",
  });
  assert.deepEqual(results[2].body, {
    ok: false,
    error: "Log adapter operation failed",
  });
  assert.doesNotMatch(JSON.stringify(results[2].body), /private log-store/);
});

test("advertises a verified integration manifest without exposing probe errors", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const reportedErrors: unknown[] = [];
  const baas = createBaasRuntime({
    endpoint: "https://api.example.test",
    token: "baas_rt_example.abcdefghijklmnopqrstuvwxyz",
    users: {
      list: async () => [],
      create: async () => ({ id: "user-1", username: "user-1", roles: [] }),
      remove: async () => undefined,
    },
    storage: {
      list: async () => [],
      write: async ({ key, data }) => ({ key, size: data.byteLength }),
      read: async (key) => ({ key, size: 0, data: new Uint8Array() }),
      remove: async () => undefined,
    },
    integrations: {
      redis: async () => true,
      "schema-builder": async () => true,
      "service-accounts": async () => false,
      "baas-functions": async () => {
        throw new Error("private infrastructure detail");
      },
      cron: async () => true,
      webhooks: async () => true,
      "event-stream": async () => true,
      logs: async () => true,
      "object-file-api": async () => true,
    },
    onError: (error) => reportedErrors.push(error),
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ url: path, body });
      return response(path === "/runtime/v1/commands/claim" ? { commands: [] } : { accepted: 1 });
    },
  });

  await baas.start();
  await baas.shutdown();

  const heartbeat = calls.find((call) => call.url === "/runtime/v1/heartbeat");
  const body = heartbeat?.body as {
    capability_manifest_version?: number;
    capabilities?: string[];
    integration_manifest?: Array<Record<string, string>>;
  };
  assert.equal(body.capability_manifest_version, 1);
  assert.deepEqual(body.capabilities, ["runtime-users", "object-storage"]);
  assert.deepEqual(body.integration_manifest, [
    { key: "runtime-users", status: "enabled", verification: "adapter" },
    { key: "blob-storage", status: "enabled", verification: "adapter" },
    { key: "redis", status: "degraded", verification: "probe" },
    { key: "schema-builder", status: "degraded", verification: "probe" },
    { key: "service-accounts", status: "degraded", verification: "probe" },
    { key: "baas-functions", status: "degraded", verification: "probe" },
    { key: "cron", status: "degraded", verification: "probe" },
    { key: "webhooks", status: "degraded", verification: "probe" },
    { key: "event-stream", status: "degraded", verification: "probe" },
    { key: "logs", status: "degraded", verification: "probe" },
    { key: "object-file-api", status: "enabled", verification: "probe" },
  ]);
  assert.equal(reportedErrors.length, 1);
  assert.doesNotMatch(JSON.stringify(body), /private infrastructure detail/);
});

test("rejects integration probes when heartbeat is disabled", () => {
  assert.throws(
    () => createBaasRuntime({
      heartbeat: false,
      integrations: { redis: async () => true },
    }),
    /requires heartbeat/,
  );
});

test("uses an end-user token for typed entity CRUD without exposing the runtime credential", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createBaasClient({
    url: "https://shop.example.test",
    accessToken: "user-access-token",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/orders")) return response({ id: "order-1", title: "First order" });
      return response([{ id: "order-1", title: "First order" }]);
    },
  });

  const orders = client.entities.collection<{ title: string }>("orders");
  const created = await orders.create({ title: "First order" });
  const listed = await orders.list({ limit: 20, offset: 0 });

  assert.equal(created.id, "order-1");
  assert.equal(listed[0].title, "First order");
  assert.equal(calls[0].url, "https://shop.example.test/api/entity/orders");
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer user-access-token");
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { data: { title: "First order" } });
  assert.match(calls[1].url, /limit=20/);
});

test("stores a login session only when explicitly requested and uses it for runtime users", async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createBaasClient({
    url: "https://shop.example.test",
    persistSession: true,
    storage,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/auth/login")) {
        return response({
          access_token: "runtime-user-token",
          token_type: "Bearer",
          expires_in: 3600,
          user: { id: "user-1", username: "hal", roles: ["admin"], created_at: "now", updated_at: "now" },
        });
      }
      return response([{ id: "user-1", username: "hal", roles: ["admin"], created_at: "now", updated_at: "now" }]);
    },
  });

  await client.auth.signIn({ username: "hal", password: "not-printed" });
  const users = await client.auth.users.list();

  assert.equal(users[0].username, "hal");
  assert.equal(client.auth.restoreSession(), "runtime-user-token");
  assert.equal(new Headers(calls[1].init?.headers).get("authorization"), "Bearer runtime-user-token");
  client.auth.signOut();
  assert.equal(client.auth.restoreSession(), undefined);
});

test("provides storage, function invocation, and a reconnectable realtime stream", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('id: evt-1\nevent: entity.created\ndata: {"id":"evt-1","event_type":"entity.created","entity":"orders","action":"created","document_id":"order-1","payload":{},"created_at":"now"}\n\n'));
      controller.close();
    },
  });
  const client = createBaasClient({
    url: "https://shop.example.test",
    accessToken: "admin-token",
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/api/events/stream")) {
        return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      if (String(url).includes("/api/storage/objects/")) return response({ key: "images/logo.png", size: 2, content_type: "image/png", created_at: "now", updated_at: "now" });
      return response({ ok: true, total: 42 });
    },
  });

  const uploaded = await client.storage.upload("images/logo.png", new Blob(["ok"]), { contentType: "image/png" });
  const invoked = await client.functions.invoke<{ total: number }>("/reports/daily", { body: { date: "2026-07-10" } });
  const received: string[] = [];
  const subscription = client.events.subscribe({ reconnect: false, onEvent: (event) => { received.push(event.id); } });
  await subscription.done;

  assert.equal(uploaded.key, "images/logo.png");
  assert.equal(invoked.total, 42);
  assert.deepEqual(received, ["evt-1"]);
  assert.equal(new Headers(calls[0].init?.headers).get("content-type"), "image/png");
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { date: "2026-07-10" });
});

test("surfaces runtime errors as typed client errors", async () => {
  const client = createBaasClient({
    url: "https://shop.example.test",
    fetch: async () => response({ detail: "Invalid token" }, { status: 401, headers: { "x-request-id": "req-1" } }),
  });

  await assert.rejects(
    () => client.auth.me(),
    (error: unknown) => error instanceof BaaSError && error.status === 401 && error.requestId === "req-1",
  );
});
