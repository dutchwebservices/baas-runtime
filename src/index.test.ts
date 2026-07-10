import assert from "node:assert/strict";
import test from "node:test";

import { createBaasRuntime } from "./index.js";

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
