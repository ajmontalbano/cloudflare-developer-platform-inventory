import { createHash } from "node:crypto";

const API_BASE = "https://api.cloudflare.com/client/v4";

export const SCHEMA_VERSION = 3;
export const COLLECTOR_VERSION = "1.2.0";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_PAGINATION_REQUESTS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const R2_JURISDICTIONS = ["default", "eu", "us", "fedramp", "fedramp-high"] as const;

type JsonRecord = Record<string, unknown>;

export type SectionStatus = "ok" | "partial" | "error";

export interface InventorySection<T> {
  status: SectionStatus;
  items: T[];
  errors: string[];
}

export interface BindingInventory {
  name: string;
  type: string;
  target?: Record<string, string | boolean>;
}

export interface WorkerInventory {
  name: string;
  createdOn?: string;
  modifiedOn?: string;
  usageModel?: string;
  customDomains: string[];
  bindings: BindingInventory[];
}

export interface DurableObjectInventory {
  id?: string;
  name: string;
  className?: string;
  scriptName?: string;
  environment?: string;
  sqlite?: boolean;
}

export interface R2BucketInventory {
  name: string;
  jurisdiction: string;
  creationDate?: string;
  location?: string;
  storageClass?: string;
}

export interface QueueInventory {
  id?: string;
  name: string;
  createdOn?: string;
  modifiedOn?: string;
  producers?: number;
  consumers?: number;
}

export interface WorkflowInventory {
  name: string;
  className?: string;
  scriptName?: string;
  modifiedOn?: string;
}

export interface Inventory {
  schemaVersion: number;
  collectorVersion: string;
  contentHash: string;
  generatedAt: string;
  accountId: string;
  workers: InventorySection<WorkerInventory>;
  durableObjects: InventorySection<DurableObjectInventory>;
  r2Buckets: InventorySection<R2BucketInventory>;
  queues: InventorySection<QueueInventory>;
  workflows: InventorySection<WorkflowInventory>;
}

interface ApiEnvelope {
  success?: boolean;
  result?: unknown;
  result_info?: JsonRecord;
  errors?: Array<{ code?: number; message?: string }>;
}

export interface CollectorOptions {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

class CloudflareApi {
  constructor(
    private readonly accountId: string,
    private readonly apiToken: string,
    private readonly fetchImpl: typeof fetch,
    private readonly requestTimeoutMs: number,
    private readonly maxRetries: number,
  ) {}

  accountPath(path: string): string {
    return `/accounts/${encodeURIComponent(this.accountId)}/${path}`;
  }

  async get(
    path: string,
    query: Record<string, string> = {},
    headers: Record<string, string> = {},
  ): Promise<ApiEnvelope> {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    let response: Response | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        response = await this.fetchImpl(url, {
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            Accept: "application/json",
            ...headers,
          },
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (error) {
        if (attempt === this.maxRetries) {
          throw new Error(`Cloudflare API request failed after ${attempt + 1} attempts: ${errorMessage(error)}`);
        }
        await retryDelay(attempt);
        continue;
      }

      if (!isRetryableStatus(response.status) || attempt === this.maxRetries) break;
      await retryDelay(attempt, response.headers.get("retry-after"));
    }

    if (!response) throw new Error("Cloudflare API request did not return a response");

    let rawEnvelope: unknown;
    try {
      rawEnvelope = await response.json();
    } catch {
      throw new Error(`Cloudflare API returned HTTP ${response.status} with a non-JSON response`);
    }

    const envelope = asRecord(rawEnvelope) as ApiEnvelope | undefined;
    if (!envelope) throw new Error(`Cloudflare API returned HTTP ${response.status} with an invalid response envelope`);

    if (!response.ok || envelope.success !== true) {
      const details = envelope.errors
        ?.map((error) => [error.code, error.message].filter((value) => value !== undefined).join(": "))
        .filter(Boolean)
        .join("; ");
      throw new Error(details || `Cloudflare API returned HTTP ${response.status}`);
    }

    return envelope;
  }

  async listUnpaginated(path: string): Promise<unknown[]> {
    const envelope = await this.get(path);
    const items = requireArray(envelope.result, `${path} result`);
    const totalCount = optionalNonnegativeInteger(asRecord(envelope.result_info)?.total_count, `${path} total_count`);
    if (totalCount !== undefined && totalCount > items.length) {
      throw new Error(`${path} returned ${items.length} of ${totalCount} items but does not support pagination`);
    }
    return items;
  }

  async listPages(path: string, perPage: number): Promise<unknown[]> {
    const items: unknown[] = [];
    const seenPages = new Set<string>();
    const seenItems = new Set<string>();
    let expectedTotalPages: number | undefined;
    let expectedTotalCount: number | undefined;

    for (let page = 1; page <= MAX_PAGINATION_REQUESTS; page += 1) {
      const envelope = await this.get(path, { page: String(page), per_page: String(perPage) });
      const pageItems = requireArray(envelope.result, `${path} result`);
      const fingerprint = JSON.stringify(pageItems);
      if (pageItems.length > 0 && seenPages.has(fingerprint)) {
        throw new Error(`${path} pagination repeated page data at page ${page}`);
      }
      seenPages.add(fingerprint);
      for (const item of pageItems) {
        const itemFingerprint = JSON.stringify(item);
        if (seenItems.has(itemFingerprint)) throw new Error(`${path} pagination returned a duplicate item`);
        seenItems.add(itemFingerprint);
      }
      items.push(...pageItems);

      const info = requireRecord(envelope.result_info, `${path} result_info`);
      const reportedPage = optionalNonnegativeInteger(info.page, `${path} page`);
      const totalPages = optionalNonnegativeInteger(info.total_pages, `${path} total_pages`);
      const totalCount = optionalNonnegativeInteger(info.total_count, `${path} total_count`);
      const emptyZeroPage = page === 1 && pageItems.length === 0 && reportedPage === 0
        && totalPages === 0 && totalCount === 0;
      if (reportedPage !== undefined && reportedPage !== page && !emptyZeroPage) {
        throw new Error(`${path} reported page ${reportedPage} while page ${page} was requested`);
      }
      if (totalPages === undefined && totalCount === undefined) {
        throw new Error(`${path} result_info is missing total_pages and total_count`);
      }
      if (expectedTotalPages !== undefined && totalPages !== undefined && totalPages !== expectedTotalPages) {
        throw new Error(`${path} total_pages changed during pagination`);
      }
      if (expectedTotalCount !== undefined && totalCount !== undefined && totalCount !== expectedTotalCount) {
        throw new Error(`${path} total_count changed during pagination`);
      }
      if (expectedTotalPages !== undefined && totalPages === undefined) {
        throw new Error(`${path} total_pages disappeared during pagination`);
      }
      if (expectedTotalCount !== undefined && totalCount === undefined) {
        throw new Error(`${path} total_count disappeared during pagination`);
      }
      expectedTotalPages ??= totalPages;
      expectedTotalCount ??= totalCount;

      const reachedLastPage = totalPages !== undefined && page >= totalPages;
      const reachedTotalCount = totalCount !== undefined && items.length >= totalCount;
      if (reachedLastPage || reachedTotalCount) {
        if (totalCount !== undefined && items.length !== totalCount) {
          throw new Error(`${path} returned ${items.length} items but reported ${totalCount}`);
        }
        if (totalPages !== undefined && page !== totalPages && !emptyZeroPage) {
          throw new Error(`${path} reached the reported item count before the final page`);
        }
        return items;
      }
      if (pageItems.length === 0) {
        throw new Error(`${path} pagination ended before the reported total was collected`);
      }
    }

    throw new Error(`${path} exceeded ${MAX_PAGINATION_REQUESTS} pagination requests`);
  }

  async listR2Buckets(jurisdiction: string): Promise<unknown[]> {
    const path = this.accountPath("r2/buckets");
    const items: unknown[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    for (let requestCount = 0; requestCount < MAX_PAGINATION_REQUESTS; requestCount += 1) {
      const query: Record<string, string> = { per_page: "1000" };
      if (cursor) query.cursor = cursor;
      const envelope = await this.get(path, query, { "cf-r2-jurisdiction": jurisdiction });
      const result = requireRecord(envelope.result, `${path} result`);
      const pageItems = requireArray(result.buckets, `${path} result.buckets`);
      items.push(...pageItems);

      const info = asRecord(envelope.result_info);
      const nextCursor = optionalString(info?.cursor, `${path} cursor`);
      if (!nextCursor) return items;
      if (seenCursors.has(nextCursor)) throw new Error(`${path} pagination repeated cursor ${nextCursor}`);
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    throw new Error(`${path} exceeded ${MAX_PAGINATION_REQUESTS} pagination requests`);
  }
}

export async function collectInventory(options: CollectorOptions): Promise<Inventory> {
  const api = new CloudflareApi(
    options.accountId,
    options.apiToken,
    options.fetch ?? fetch,
    options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    options.maxRetries ?? DEFAULT_MAX_RETRIES,
  );

  const [workers, durableObjects, r2Buckets, queues, workflows] = await Promise.all([
    collectWorkers(api),
    collectSection(
      () => api.listPages(api.accountPath("workers/durable_objects/namespaces"), 1000),
      sanitizeDurableObject,
      durableObjectKey,
    ),
    collectR2Buckets(api),
    collectSection(
      () => api.listPages(api.accountPath("queues"), 100),
      sanitizeQueue,
      (item) => item.name,
    ),
    collectSection(
      () => api.listPages(api.accountPath("workflows"), 100),
      sanitizeWorkflow,
      (item) => item.name,
    ),
  ]);

  const inventory: Omit<Inventory, "contentHash"> = {
    schemaVersion: SCHEMA_VERSION,
    collectorVersion: COLLECTOR_VERSION,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    accountId: options.accountId,
    workers,
    durableObjects,
    r2Buckets,
    queues,
    workflows,
  };
  return { ...inventory, contentHash: inventoryContentHash(inventory) };
}

export function inventoryContentHash(inventory: Inventory | Omit<Inventory, "contentHash">): string {
  const { contentHash: _contentHash, ...content } = inventory as Inventory;
  return createHash("sha256").update(canonicalStringify(content)).digest("hex");
}

async function collectWorkers(api: CloudflareApi): Promise<InventorySection<WorkerInventory>> {
  let scripts: unknown[];
  try {
    scripts = await api.listUnpaginated(api.accountPath("workers/scripts"));
  } catch (error) {
    return { status: "error", items: [], errors: [errorMessage(error)] };
  }

  const errors: string[] = [];
  let domains: unknown[] = [];
  try {
    domains = await api.listPages(api.accountPath("workers/domains"), 100);
  } catch (error) {
    errors.push(`Custom domains: ${errorMessage(error)}`);
  }

  const domainMap = new Map<string, string[]>();
  for (const rawDomain of domains) {
    const domain = asRecord(rawDomain);
    const service = stringValue(domain?.service) ?? stringValue(domain?.script);
    const hostname = stringValue(domain?.hostname);
    if (!service || !hostname) {
      errors.push("Custom domains: response item is missing service or hostname");
      continue;
    }
    const hostnames = domainMap.get(service) ?? [];
    hostnames.push(hostname);
    domainMap.set(service, hostnames);
  }

  const items = await mapLimit(scripts, 4, async (rawScript) => {
    const script = asRecord(rawScript);
    const name = requiredString(script?.id ?? script?.name, "Worker script name");
    let bindings: BindingInventory[] = [];

    try {
      const settings = await api.get(api.accountPath(`workers/scripts/${encodeURIComponent(name)}/settings`));
      const settingsResult = requireRecord(settings.result, `${name} settings result`);
      const rawBindings = requireArray(settingsResult.bindings, `${name} settings bindings`);
      bindings = rawBindings.map(sanitizeBinding).sort(compareBindings);
    } catch (error) {
      errors.push(`${name} settings: ${errorMessage(error)}`);
    }

    return withoutUndefined({
      name,
      createdOn: stringValue(script?.created_on),
      modifiedOn: stringValue(script?.modified_on),
      usageModel: stringValue(script?.usage_model),
      customDomains: [...new Set(domainMap.get(name) ?? [])].sort(),
      bindings,
    }) as WorkerInventory;
  });

  items.sort((a, b) => a.name.localeCompare(b.name));
  assertUnique(items, (item) => item.name, "Worker scripts");
  return { status: errors.length > 0 ? "partial" : "ok", items, errors: errors.sort() };
}

async function collectR2Buckets(api: CloudflareApi): Promise<InventorySection<R2BucketInventory>> {
  const results = await Promise.all(R2_JURISDICTIONS.map(async (jurisdiction) => {
    try {
      const items = (await api.listR2Buckets(jurisdiction)).map((raw) => sanitizeR2Bucket(raw, jurisdiction));
      return { jurisdiction, items };
    } catch (error) {
      return { jurisdiction, items: [] as R2BucketInventory[], error: errorMessage(error) };
    }
  }));

  const items = results.flatMap((result) => result.items)
    .sort((a, b) => r2BucketKey(a).localeCompare(r2BucketKey(b)));
  const errors = results
    .filter((result) => result.error)
    .map((result) => `${result.jurisdiction}: ${result.error}`)
    .sort();
  const successfulJurisdictions = results.length - errors.length;
  try {
    assertUnique(items, r2BucketKey, "R2 buckets");
  } catch (error) {
    errors.push(errorMessage(error));
  }
  const status: SectionStatus = errors.length === 0 ? "ok" : successfulJurisdictions === 0 ? "error" : "partial";
  return { status, items, errors };
}

async function collectSection<T>(
  read: () => Promise<unknown[]>,
  sanitize: (raw: unknown) => T,
  key: (item: T) => string,
): Promise<InventorySection<T>> {
  try {
    const items = (await read()).map(sanitize).sort((a, b) => key(a).localeCompare(key(b)));
    assertUnique(items, key, "Inventory section");
    return { status: "ok", items, errors: [] };
  } catch (error) {
    return { status: "error", items: [], errors: [errorMessage(error)] };
  }
}

export function sanitizeBinding(raw: unknown): BindingInventory {
  const binding = asRecord(raw) ?? {};
  const type = stringValue(binding.type) ?? "unknown";
  const name = stringValue(binding.name) ?? stringValue(binding.binding) ?? "unknown";
  let target: Record<string, string | boolean> | undefined;

  switch (type) {
    case "kv_namespace":
      target = pickTarget(binding, [["namespaceId", "namespace_id"]]);
      break;
    case "durable_object_namespace":
      target = pickTarget(binding, [
        ["className", "class_name"],
        ["scriptName", "script_name"],
        ["environment", "environment"],
      ]);
      break;
    case "r2_bucket":
      target = pickTarget(binding, [
        ["bucketName", "bucket_name"],
        ["jurisdiction", "jurisdiction"],
      ]);
      break;
    case "d1":
      target = pickTarget(binding, [
        ["databaseName", "database_name"],
        ["databaseId", "id"],
      ]);
      break;
    case "service":
      target = pickTarget(binding, [
        ["service", "service"],
        ["environment", "environment"],
      ]);
      break;
    case "queue":
      target = pickTarget(binding, [["queueName", "queue_name"]]);
      break;
    case "workflow":
      target = pickTarget(binding, [
        ["workflowName", "workflow_name"],
        ["className", "class_name"],
        ["scriptName", "script_name"],
      ]);
      break;
    case "hyperdrive":
      target = pickTarget(binding, [["configId", "id"]]);
      break;
    case "vectorize":
      target = pickTarget(binding, [["indexName", "index_name"]]);
      break;
    case "dispatch_namespace":
      target = pickTarget(binding, [["namespace", "namespace"]]);
      break;
  }

  return target && Object.keys(target).length > 0 ? { name, type, target } : { name, type };
}

function sanitizeDurableObject(raw: unknown): DurableObjectInventory {
  const item = requireRecord(raw, "Durable Object namespace");
  return withoutUndefined({
    id: stringValue(item.id) ?? stringValue(item.namespace_id),
    name: requiredString(item.name, "Durable Object namespace name"),
    className: stringValue(item.class) ?? stringValue(item.class_name),
    scriptName: stringValue(item.script) ?? stringValue(item.script_name),
    environment: stringValue(item.environment),
    sqlite: booleanValue(item.use_sqlite),
  }) as unknown as DurableObjectInventory;
}

function sanitizeR2Bucket(raw: unknown, requestedJurisdiction: string): R2BucketInventory {
  const item = requireRecord(raw, "R2 bucket");
  return withoutUndefined({
    name: requiredString(item.name, "R2 bucket name"),
    jurisdiction: stringValue(item.jurisdiction) ?? requestedJurisdiction,
    creationDate: stringValue(item.creation_date) ?? stringValue(item.creationDate),
    location: stringValue(item.location),
    storageClass: stringValue(item.storage_class),
  }) as unknown as R2BucketInventory;
}

function sanitizeQueue(raw: unknown): QueueInventory {
  const item = requireRecord(raw, "Queue");
  return withoutUndefined({
    id: stringValue(item.queue_id) ?? stringValue(item.id),
    name: requiredString(item.queue_name ?? item.name, "Queue name"),
    createdOn: stringValue(item.created_on),
    modifiedOn: stringValue(item.modified_on),
    producers: numberValue(item.producers_total_count) ?? (Array.isArray(item.producers) ? item.producers.length : undefined),
    consumers: numberValue(item.consumers_total_count) ?? (Array.isArray(item.consumers) ? item.consumers.length : undefined),
  }) as unknown as QueueInventory;
}

function sanitizeWorkflow(raw: unknown): WorkflowInventory {
  const item = requireRecord(raw, "Workflow");
  return withoutUndefined({
    name: requiredString(item.name ?? item.id, "Workflow name"),
    className: stringValue(item.class_name) ?? stringValue(item.class),
    scriptName: stringValue(item.script_name) ?? stringValue(item.script),
    modifiedOn: stringValue(item.modified_on) ?? stringValue(item.modified_at),
  }) as unknown as WorkflowInventory;
}

function pickTarget(source: JsonRecord, fields: Array<[string, string]>): Record<string, string | boolean> {
  const target: Record<string, string | boolean> = {};
  for (const [outputName, inputName] of fields) {
    const value = source[inputName];
    if (typeof value === "string" || typeof value === "boolean") target[outputName] = value;
  }
  return target;
}

function withoutUndefined<T extends JsonRecord>(record: T): Partial<T> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireRecord(value: unknown, label: string): JsonRecord {
  const record = asRecord(value);
  if (!record) throw new Error(`${label} must be an object`);
  return record;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${label} must be a non-empty string`);
  return result;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function optionalNonnegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function durableObjectKey(item: DurableObjectInventory): string {
  return item.id ?? `${item.scriptName ?? ""}:${item.className ?? ""}:${item.name}`;
}

function r2BucketKey(item: R2BucketInventory): string {
  return `${item.jurisdiction}:${item.name}`;
}

function assertUnique<T>(items: T[], key: (item: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    const value = key(item);
    if (seen.has(value)) throw new Error(`${label} returned duplicate key ${value}`);
    seen.add(value);
  }
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function compareBindings(a: BindingInventory, b: BindingInventory): number {
  return a.name.localeCompare(b.name) || a.type.localeCompare(b.type);
}

async function mapLimit<T, R>(items: T[], limit: number, callback: (item: T) => Promise<R>): Promise<R[]> {
  const output = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) output[index] = await callback(item);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function retryDelay(attempt: number, retryAfter?: string | null): Promise<void> {
  let retryAfterMs: number | undefined;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) retryAfterMs = seconds * 1000;
    else {
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) retryAfterMs = date - Date.now();
    }
  }
  const delayMs = Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAfterMs ?? 250 * 2 ** attempt));
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}
