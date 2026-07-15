import assert from "node:assert/strict";
import test from "node:test";

import {
  BaaSError,
  createBaasClient,
  createBaasRuntime,
  type ConnectedRuntimeUser,
  type ConnectedStorageObject,
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
