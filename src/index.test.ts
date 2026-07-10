import assert from "node:assert/strict";
import test from "node:test";

import { BaaSError, createBaasClient, createBaasRuntime } from "./index.js";

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
