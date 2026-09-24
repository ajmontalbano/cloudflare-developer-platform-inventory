import assert from "node:assert/strict";
import test from "node:test";
import { collectInventory, inventoryContentHash, sanitizeBinding, type Inventory } from "../src/inventory.js";
import { compareInventories, renderInventoryMarkdown } from "../src/report.js";

test("collector uses endpoint-specific pagination and never emits binding values", async () => {
  const requested: string[] = [];
  const mockFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const jurisdiction = new Headers(init?.headers).get("cf-r2-jurisdiction");
    requested.push(`${url.pathname}?${url.searchParams.toString()}${jurisdiction ? `#${jurisdiction}` : ""}`);

    if (url.pathname.endsWith("/workers/scripts")) {
      return json(envelope([
        { id: "worker-b", modified_on: "2026-01-02T00:00:00Z" },
        { id: "worker-a", modified_on: "2026-01-01T00:00:00Z" },
      ]));
    }
    if (url.pathname.endsWith("/workers/domains")) {
      return json(url.searchParams.get("page") === "1"
        ? envelope([{ hostname: "app.example.com", service: "worker-a" }], { page: 1, total_pages: 2, total_count: 2 })
        : envelope([{ hostname: "api.example.com", service: "worker-b" }], { page: 2, total_pages: 2, total_count: 2 }));
    }
    if (url.pathname.includes("/workers/scripts/") && url.pathname.endsWith("/settings")) {
      return json(envelope({
        bindings: [
          { name: "PUBLIC_VALUE", type: "plain_text", text: "super-secret" },
          { name: "API_TOKEN", type: "secret_text", text: "db-password" },
          { name: "BUCKET", type: "r2_bucket", bucket_name: "assets" },
          { name: "STATE", type: "durable_object_namespace", class_name: "State", script_name: "worker-a" },
        ],
      }));
    }
    if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
      return json(url.searchParams.get("page") === "1"
        ? envelope([{ id: "do-1", name: "State", class: "State", script: "worker-a", use_sqlite: true }], { page: 1, total_pages: 2 })
        : envelope([{ id: "do-2", name: "Other", class: "Other", script: "worker-b", use_sqlite: true }], { page: 2, total_pages: 2 }));
    }
    if (url.pathname.endsWith("/r2/buckets")) {
      if (jurisdiction !== "default") return json(envelope({ buckets: [] }, {}));
      return json(url.searchParams.has("cursor")
        ? envelope({ buckets: [{ name: "backups", location: "enam" }] }, {})
        : envelope({ buckets: [{ name: "assets", location: "wnam" }] }, { cursor: "next-page" }));
    }
    if (url.pathname.endsWith("/queues")) return json(url.searchParams.get("page") === "1"
      ? envelope([{
        queue_id: "queue-id",
        queue_name: "jobs",
        producers: [{ type: "worker" }],
        producers_total_count: 3,
        consumers: [],
        consumers_total_count: 2,
      }], { page: 1, total_pages: 2, total_count: 2 })
      : envelope([{ queue_id: "queue-id-2", queue_name: "notifications" }], { page: 2, total_pages: 2, total_count: 2 }));
    if (url.pathname.endsWith("/workflows")) {
      return json(envelope([{ name: "sync", class_name: "SyncWorkflow", script_name: "worker-a" }], { page: 1, total_pages: 1, total_count: 1 }));
    }
    return json({ success: false, errors: [{ code: 1000, message: "Unexpected path" }] }, 404);
  };

  const inventory = await collectInventory({
    accountId: "account-id",
    apiToken: "token-that-must-not-appear",
    fetch: mockFetch as typeof fetch,
    now: () => new Date("2026-01-03T00:00:00Z"),
  });

  assert.deepEqual(inventory.workers.items.map((worker) => worker.name), ["worker-a", "worker-b"]);
  assert.deepEqual(inventory.workers.items[0]?.customDomains, ["app.example.com"]);
  assert.deepEqual(inventory.workers.items[1]?.customDomains, ["api.example.com"]);
  assert.deepEqual(inventory.r2Buckets.items.map((bucket) => bucket.name), ["assets", "backups"]);
  assert.ok(inventory.r2Buckets.items.every((bucket) => bucket.jurisdiction === "default"));
  assert.equal(inventory.durableObjects.items[0]?.sqlite, true);
  assert.equal(inventory.durableObjects.items.length, 2);
  assert.equal(inventory.queues.items[0]?.producers, 3);
  assert.equal(inventory.queues.items[0]?.consumers, 2);
  assert.equal(inventory.queues.items.length, 2);
  assert.equal(inventory.workflows.items[0]?.name, "sync");
  assert.ok(requested.some((path) => path.includes("durable_objects/namespaces?page=2")));
  assert.ok(requested.some((path) => path.includes("workers/domains?page=2")));
  assert.ok(requested.some((path) => path.includes("/queues?page=2")));
  assert.ok(requested.some((path) => path.includes("r2/buckets?per_page=1000&cursor=next-page#default")));
  assert.ok(requested.some((path) => path.endsWith("#fedramp-high")));
  assert.ok(requested.filter((path) => path.includes("workers/scripts?")).every((path) => !path.includes("page=")));

  const output = JSON.stringify(inventory);
  assert.doesNotMatch(output, /super-secret|db-password|token-that-must-not-appear/);
  assert.match(output, /PUBLIC_VALUE/);
  assert.match(output, /secret_text/);
});

test("binding sanitizer only retains allowlisted topology fields", () => {
  assert.deepEqual(sanitizeBinding({
    name: "DATABASE",
    type: "d1",
    database_name: "app-db",
    id: "database-id",
    text: "must-not-survive",
    unexpected: "must-not-survive",
  }), {
    name: "DATABASE",
    type: "d1",
    target: { databaseName: "app-db", databaseId: "database-id" },
  });
});

test("drift comparison skips incomplete sections and detects stable changes", () => {
  const previous = fixture();
  const current = fixture();
  current.generatedAt = "2026-01-02T00:00:00.000Z";
  current.workers.items[0]!.bindings.push({ name: "BUCKET", type: "r2_bucket", target: { bucketName: "assets" } });
  current.r2Buckets.status = "error";
  current.r2Buckets.errors = ["Forbidden"];
  reseal(current);

  const drift = compareInventories(previous, current, new Date("2026-01-03T00:00:00Z"));
  assert.deepEqual(drift.sections.workers?.changed, ["api"]);
  assert.equal(drift.sections.r2Buckets?.status, "skipped");
});

test("malformed successful responses fail closed and cannot report removals", async () => {
  const inventory = await collectInventory({
    accountId: "account-id",
    apiToken: "token",
    maxRetries: 0,
    fetch: (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/workers/scripts") || url.pathname.endsWith("/workers/domains")) return json(envelope([]));
      if (url.pathname.endsWith("/workers/durable_objects/namespaces") || url.pathname.endsWith("/workflows")) {
        return json(envelope([], { page: 1, total_pages: 1 }));
      }
      if (url.pathname.endsWith("/r2/buckets")) return json(envelope({ buckets: [] }, {}));
      if (url.pathname.endsWith("/queues")) return json(envelope({ queues: [] }));
      return json(envelope([]));
    }) as typeof fetch,
  });

  assert.equal(inventory.queues.status, "error");
  assert.match(inventory.queues.errors[0] ?? "", /result must be an array/);

  const previous = fixture();
  previous.queues.items = [{ name: "critical-jobs" }];
  reseal(previous);
  const drift = compareInventories(previous, inventory);
  assert.equal(drift.sections.queues?.status, "skipped");
  assert.deepEqual(drift.sections.queues?.removed, []);
});

test("pagination cycles fail the affected section", async () => {
  const inventory = await collectInventory({
    accountId: "account-id",
    apiToken: "token",
    maxRetries: 0,
    fetch: (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/workers/scripts") || url.pathname.endsWith("/workers/domains") || url.pathname.endsWith("/queues")) {
        return json(envelope([]));
      }
      if (url.pathname.endsWith("/workers/durable_objects/namespaces")) {
        return json(envelope([{ id: "same", name: "Same" }], { total_pages: 3 }));
      }
      if (url.pathname.endsWith("/workflows")) return json(envelope([], { total_pages: 1 }));
      if (url.pathname.endsWith("/r2/buckets")) return json(envelope({ buckets: [] }, {}));
      return json(envelope([]));
    }) as typeof fetch,
  });

  assert.equal(inventory.durableObjects.status, "error");
  assert.match(inventory.durableObjects.errors[0] ?? "", /repeated page data/);
});

test("contradictory pagination totals fail the affected section", async () => {
  const inventory = await collectInventory({
    accountId: "account-id",
    apiToken: "token",
    maxRetries: 0,
    fetch: (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/workers/scripts")) return json(envelope([]));
      if (url.pathname.endsWith("/workers/domains")) return json(envelope([], { page: 1, total_pages: 1, total_count: 0 }));
      if (url.pathname.endsWith("/queues")) {
        return json(envelope([{ queue_name: "only-one" }], { page: 1, total_pages: 1, total_count: 2 }));
      }
      if (url.pathname.endsWith("/workers/durable_objects/namespaces") || url.pathname.endsWith("/workflows")) {
        return json(envelope([], { page: 1, total_pages: 1, total_count: 0 }));
      }
      if (url.pathname.endsWith("/r2/buckets")) return json(envelope({ buckets: [] }, {}));
      return json(envelope([]));
    }) as typeof fetch,
  });

  assert.equal(inventory.queues.status, "error");
  assert.match(inventory.queues.errors[0] ?? "", /returned 1 items but reported 2/);
});

test("pagination totals cannot disappear on later pages", async () => {
  const inventory = await collectInventory({
    accountId: "account-id",
    apiToken: "token",
    maxRetries: 0,
    fetch: (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/workers/scripts")) return json(envelope([]));
      if (url.pathname.endsWith("/workers/domains")) return json(envelope([], { page: 1, total_pages: 1, total_count: 0 }));
      if (url.pathname.endsWith("/queues")) {
        return json(url.searchParams.get("page") === "1"
          ? envelope([{ queue_name: "first" }], { page: 1, total_pages: 2, total_count: 3 })
          : envelope([{ queue_name: "second" }], { page: 2, total_pages: 2 }));
      }
      if (url.pathname.endsWith("/workers/durable_objects/namespaces") || url.pathname.endsWith("/workflows")) {
        return json(envelope([], { page: 1, total_pages: 1, total_count: 0 }));
      }
      if (url.pathname.endsWith("/r2/buckets")) return json(envelope({ buckets: [] }, {}));
      return json(envelope([]));
    }) as typeof fetch,
  });

  assert.equal(inventory.queues.status, "error");
  assert.match(inventory.queues.errors[0] ?? "", /total_count disappeared/);
});

test("zero-based empty pagination metadata is accepted", async () => {
  const inventory = await collectInventory({
    accountId: "account-id",
    apiToken: "token",
    maxRetries: 0,
    fetch: (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/workers/scripts")) return json(envelope([]));
      if (url.pathname.endsWith("/workers/domains") || url.pathname.endsWith("/queues")
        || url.pathname.endsWith("/workers/durable_objects/namespaces") || url.pathname.endsWith("/workflows")) {
        return json(envelope([], { page: 0, total_pages: 0, total_count: 0 }));
      }
      if (url.pathname.endsWith("/r2/buckets")) return json(envelope({ buckets: [] }, {}));
      return json(envelope([]));
    }) as typeof fetch,
  });

  assert.equal(inventory.workers.status, "ok");
  assert.equal(inventory.durableObjects.status, "ok");
  assert.equal(inventory.queues.status, "ok");
  assert.equal(inventory.workflows.status, "ok");
});

test("retryable API failures are retried", async () => {
  let queueAttempts = 0;
  const inventory = await collectInventory({
    accountId: "account-id",
    apiToken: "token",
    maxRetries: 1,
    fetch: (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/queues")) {
        queueAttempts += 1;
        if (queueAttempts === 1) return json({ success: false, errors: [{ message: "Busy" }] }, 503, { "retry-after": "0" });
        return json(envelope([], { page: 1, total_pages: 1, total_count: 0 }));
      }
      if (url.pathname.endsWith("/workers/scripts") || url.pathname.endsWith("/workers/domains")) return json(envelope([]));
      if (url.pathname.endsWith("/workers/durable_objects/namespaces") || url.pathname.endsWith("/workflows")) {
        return json(envelope([], { total_pages: 1 }));
      }
      if (url.pathname.endsWith("/r2/buckets")) return json(envelope({ buckets: [] }, {}));
      return json(envelope([]));
    }) as typeof fetch,
  });

  assert.equal(queueAttempts, 2);
  assert.equal(inventory.queues.status, "ok");
});

test("drift rejects malformed or duplicate baseline items", () => {
  const previous = fixture();
  previous.queues.items = [{ name: "jobs" }, { name: "jobs" }];
  reseal(previous);
  assert.throws(() => compareInventories(previous, fixture()), /duplicate item keys/);
});

test("drift rejects snapshots changed after collection", () => {
  const previous = fixture();
  previous.workers.items = [];
  assert.throws(() => compareInventories(previous, fixture()), /contentHash does not match/);
});

test("Markdown report contains a safety notice and no values", () => {
  const inventory = fixture();
  inventory.workers.items[0]!.bindings.push({ name: "API_TOKEN", type: "secret_text" });
  const report = renderInventoryMarkdown(inventory);
  assert.match(report, /excludes Worker source, variable values, secrets/);
  assert.match(report, /API_TOKEN/);
  assert.doesNotMatch(report, /secret-value/);
});

test("Markdown report contains hostile names without creating HTML or breaking tables", () => {
  const inventory = fixture();
  inventory.workers.items[0]!.name = "bad`name<script>";
  inventory.r2Buckets.items[0]!.name = "assets|archive";
  reseal(inventory);

  const report = renderInventoryMarkdown(inventory);
  assert.doesNotMatch(report, /<script>/);
  assert.match(report, /assets\\\|archive/);
  assert.match(report, /``bad`name&lt;script&gt;``/);
});

function envelope(result: unknown, resultInfo?: Record<string, unknown>): Record<string, unknown> {
  return { success: true, result, ...(resultInfo ? { result_info: resultInfo } : {}) };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fixture(): Inventory {
  const inventory: Omit<Inventory, "contentHash"> = {
    schemaVersion: 3,
    collectorVersion: "1.2.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
    accountId: "account-id",
    workers: {
      status: "ok",
      errors: [],
      items: [{ name: "api", customDomains: [], bindings: [] }],
    },
    durableObjects: { status: "ok", errors: [], items: [] },
    r2Buckets: { status: "ok", errors: [], items: [{ name: "assets", jurisdiction: "default" }] },
    queues: { status: "ok", errors: [], items: [] },
    workflows: { status: "ok", errors: [], items: [] },
  };
  return { ...inventory, contentHash: inventoryContentHash(inventory) };
}

function reseal(inventory: Inventory): void {
  inventory.contentHash = inventoryContentHash(inventory);
}
