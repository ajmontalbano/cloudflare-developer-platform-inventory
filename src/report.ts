import {
  inventoryContentHash,
  type BindingInventory,
  type Inventory,
  type InventorySection,
  type SectionStatus,
} from "./inventory.js";

export interface SectionDrift {
  status: "compared" | "skipped";
  reason?: string;
  added: string[];
  removed: string[];
  changed: string[];
}

export interface InventoryDrift {
  schemaVersion: number;
  comparedAt: string;
  baselineGeneratedAt: string;
  currentGeneratedAt: string;
  sections: Record<string, SectionDrift>;
}

export function compareInventories(previous: Inventory, current: Inventory, now = new Date()): InventoryDrift {
  validateInventory(previous, "Baseline inventory");
  validateInventory(current, "Current inventory");
  if (previous.schemaVersion !== current.schemaVersion) {
    throw new Error(`Cannot compare schema version ${previous.schemaVersion} with ${current.schemaVersion}`);
  }
  if (previous.accountId !== current.accountId) {
    throw new Error("Cannot compare inventories from different Cloudflare accounts");
  }

  return {
    schemaVersion: current.schemaVersion,
    comparedAt: now.toISOString(),
    baselineGeneratedAt: previous.generatedAt,
    currentGeneratedAt: current.generatedAt,
    sections: {
      workers: compareSection(previous.workers, current.workers, (item) => item.name),
      durableObjects: compareSection(previous.durableObjects, current.durableObjects, (item) => item.id ?? item.name),
      r2Buckets: compareSection(previous.r2Buckets, current.r2Buckets, (item) => `${item.jurisdiction}:${item.name}`),
      queues: compareSection(previous.queues, current.queues, (item) => item.id ?? item.name),
      workflows: compareSection(previous.workflows, current.workflows, (item) => item.name),
    },
  };
}

function validateInventory(inventory: unknown, label: string): asserts inventory is Inventory {
  if (!inventory || typeof inventory !== "object" || Array.isArray(inventory)) throw new Error(`${label} must be an object`);
  const value = inventory as Record<string, unknown>;
  if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion)) {
    throw new Error(`${label} has an invalid schemaVersion`);
  }
  if (typeof value.accountId !== "string" || value.accountId.length === 0) throw new Error(`${label} has an invalid accountId`);
  if (typeof value.collectorVersion !== "string" || value.collectorVersion.length === 0) {
    throw new Error(`${label} has an invalid collectorVersion`);
  }
  if (typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt))) {
    throw new Error(`${label} has an invalid generatedAt timestamp`);
  }

  const sections: Array<[string, (item: unknown) => string | undefined]> = [
    ["workers", (item) => recordString(item, "name")],
    ["durableObjects", (item) => recordString(item, "id") ?? recordString(item, "name")],
    ["r2Buckets", (item) => {
      const name = recordString(item, "name");
      const jurisdiction = recordString(item, "jurisdiction");
      return name && jurisdiction ? `${jurisdiction}:${name}` : undefined;
    }],
    ["queues", (item) => recordString(item, "id") ?? recordString(item, "name")],
    ["workflows", (item) => recordString(item, "name")],
  ];

  for (const [sectionName, key] of sections) {
    const section = value[sectionName];
    if (!section || typeof section !== "object" || Array.isArray(section)) throw new Error(`${label}.${sectionName} must be an object`);
    const sectionRecord = section as Record<string, unknown>;
    if (sectionRecord.status !== "ok" && sectionRecord.status !== "partial" && sectionRecord.status !== "error") {
      throw new Error(`${label}.${sectionName} has an invalid status`);
    }
    if (!Array.isArray(sectionRecord.items) || !Array.isArray(sectionRecord.errors)
      || !sectionRecord.errors.every((error) => typeof error === "string")) {
      throw new Error(`${label}.${sectionName} has invalid items or errors`);
    }
    if (sectionRecord.status === "ok" && sectionRecord.errors.length > 0) {
      throw new Error(`${label}.${sectionName} cannot be ok with collection errors`);
    }
    const keys = sectionRecord.items.map(key);
    if (keys.some((itemKey) => !itemKey)) throw new Error(`${label}.${sectionName} contains an item without a stable key`);
    if (new Set(keys).size !== keys.length) throw new Error(`${label}.${sectionName} contains duplicate item keys`);
    for (const item of sectionRecord.items) validateInventoryItem(sectionName, item, label);
  }

  if (typeof value.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(value.contentHash)) {
    throw new Error(`${label} has an invalid contentHash`);
  }
  if (inventoryContentHash(inventory as Inventory) !== value.contentHash) {
    throw new Error(`${label} contentHash does not match its contents`);
  }
}

function recordString(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const fieldValue = (value as Record<string, unknown>)[field];
  return typeof fieldValue === "string" && fieldValue.length > 0 ? fieldValue : undefined;
}

function validateInventoryItem(sectionName: string, item: unknown, label: string): void {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    throw new Error(`${label}.${sectionName} contains a non-object item`);
  }
  const record = item as Record<string, unknown>;
  const requireString = (field: string): void => {
    if (typeof record[field] !== "string" || record[field].length === 0) {
      throw new Error(`${label}.${sectionName} item has an invalid ${field}`);
    }
  };

  requireString("name");
  if (sectionName === "workers") {
    if (!Array.isArray(record.customDomains) || !record.customDomains.every((value) => typeof value === "string")) {
      throw new Error(`${label}.workers item has invalid customDomains`);
    }
    if (!Array.isArray(record.bindings)) throw new Error(`${label}.workers item has invalid bindings`);
    for (const binding of record.bindings) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)
        || !recordString(binding, "name") || !recordString(binding, "type")) {
        throw new Error(`${label}.workers item has an invalid binding`);
      }
    }
  }
  if (sectionName === "r2Buckets") requireString("jurisdiction");
  if (sectionName === "queues") {
    for (const field of ["producers", "consumers"]) {
      const count = record[field];
      if (count !== undefined && (typeof count !== "number" || !Number.isInteger(count) || count < 0)) {
        throw new Error(`${label}.queues item has an invalid ${field}`);
      }
    }
  }
}

export function renderInventoryMarkdown(inventory: Inventory): string {
  const lines = [
    "# Cloudflare Developer Platform Inventory",
    "",
    `Generated: ${inventory.generatedAt}`,
    `Account ID: \`${inventory.accountId}\``,
    `Schema version: ${inventory.schemaVersion}`,
    "",
    "> This report contains resource names and topology metadata only. It excludes Worker source, variable values, secrets, object data, logs, and analytics.",
    "",
    "## Summary",
    "",
    "| Resource | Status | Count |",
    "| --- | --- | ---: |",
    summaryRow("Workers", inventory.workers),
    summaryRow("Durable Object namespaces", inventory.durableObjects),
    summaryRow("R2 buckets", inventory.r2Buckets),
    summaryRow("Queues", inventory.queues),
    summaryRow("Workflows", inventory.workflows),
    "",
  ];

  appendErrors(lines, inventory);

  lines.push("## Workers", "");
  if (inventory.workers.items.length === 0) lines.push("None found.", "");
  for (const worker of inventory.workers.items) {
    lines.push(`### ${code(worker.name)}`, "");
    lines.push(`- Modified: ${worker.modifiedOn ?? "Not reported"}`);
    lines.push(`- Custom domains: ${worker.customDomains.length > 0 ? worker.customDomains.map(code).join(", ") : "None"}`);
    lines.push(`- Bindings: ${worker.bindings.length > 0 ? worker.bindings.map(formatBinding).join(", ") : "None"}`, "");
  }

  appendTable(lines, "Durable Object Namespaces", ["Name", "Class", "Worker", "Storage"], inventory.durableObjects.items.map((item) => [
    code(item.name), code(item.className), code(item.scriptName), item.sqlite === true ? "SQLite" : item.sqlite === false ? "Legacy KV" : "Not reported",
  ]));
  appendTable(lines, "R2 Buckets", ["Name", "Jurisdiction", "Location", "Storage class", "Created"], inventory.r2Buckets.items.map((item) => [
    code(item.name), item.jurisdiction, item.location, item.storageClass, item.creationDate,
  ]));
  appendTable(lines, "Queues", ["Name", "Producers", "Consumers", "Modified"], inventory.queues.items.map((item) => [
    code(item.name), numberText(item.producers), numberText(item.consumers), item.modifiedOn,
  ]));
  appendTable(lines, "Workflows", ["Name", "Class", "Worker", "Modified"], inventory.workflows.items.map((item) => [
    code(item.name), code(item.className), code(item.scriptName), item.modifiedOn,
  ]));

  return `${lines.join("\n").trim()}\n`;
}

export function renderDriftMarkdown(drift: InventoryDrift): string {
  const lines = [
    "# Cloudflare Developer Platform Inventory Drift",
    "",
    `Compared: ${drift.comparedAt}`,
    `Baseline: ${drift.baselineGeneratedAt}`,
    `Current: ${drift.currentGeneratedAt}`,
    "",
  ];

  for (const [name, section] of Object.entries(drift.sections)) {
    lines.push(`## ${heading(name)}`, "");
    if (section.status === "skipped") {
      lines.push(`Comparison skipped: ${section.reason ?? "section collection was incomplete"}.`, "");
      continue;
    }
    lines.push(`- Added: ${formatNames(section.added)}`);
    lines.push(`- Removed: ${formatNames(section.removed)}`);
    lines.push(`- Changed: ${formatNames(section.changed)}`, "");
  }

  return `${lines.join("\n").trim()}\n`;
}

function compareSection<T>(previous: InventorySection<T>, current: InventorySection<T>, key: (item: T) => string): SectionDrift {
  if (previous.status !== "ok" || current.status !== "ok") {
    return {
      status: "skipped",
      reason: `baseline status is ${previous.status}; current status is ${current.status}`,
      added: [],
      removed: [],
      changed: [],
    };
  }

  const previousItems = new Map(previous.items.map((item) => [key(item), stableStringify(item)]));
  const currentItems = new Map(current.items.map((item) => [key(item), stableStringify(item)]));
  const added = [...currentItems.keys()].filter((name) => !previousItems.has(name)).sort();
  const removed = [...previousItems.keys()].filter((name) => !currentItems.has(name)).sort();
  const changed = [...currentItems.keys()]
    .filter((name) => previousItems.has(name) && previousItems.get(name) !== currentItems.get(name))
    .sort();

  return { status: "compared", added, removed, changed };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function appendErrors(lines: string[], inventory: Inventory): void {
  const sections: Array<[string, SectionStatus, string[]]> = [
    ["Workers", inventory.workers.status, inventory.workers.errors],
    ["Durable Objects", inventory.durableObjects.status, inventory.durableObjects.errors],
    ["R2", inventory.r2Buckets.status, inventory.r2Buckets.errors],
    ["Queues", inventory.queues.status, inventory.queues.errors],
    ["Workflows", inventory.workflows.status, inventory.workflows.errors],
  ];
  const failures = sections.filter(([, status]) => status !== "ok");
  if (failures.length === 0) return;

  lines.push("## Collection Warnings", "");
  for (const [name, , errors] of failures) {
    for (const error of errors) lines.push(`- ${name}: ${escapeMarkdown(error)}`);
  }
  lines.push("");
}

function appendTable(lines: string[], title: string, headers: string[], rows: Array<Array<string | undefined>>): void {
  lines.push(`## ${title}`, "");
  if (rows.length === 0) {
    lines.push("None found.", "");
    return;
  }
  lines.push(`| ${headers.join(" | ")} |`);
  lines.push(`| ${headers.map(() => "---").join(" | ")} |`);
  for (const row of rows) lines.push(`| ${row.map((value) => escapeTableCell(value ?? "Not reported")).join(" | ")} |`);
  lines.push("");
}

function summaryRow(name: string, section: InventorySection<unknown>): string {
  return `| ${name} | ${section.status} | ${section.items.length} |`;
}

function formatBinding(binding: BindingInventory): string {
  const target = binding.target ? Object.values(binding.target).join(" / ") : undefined;
  return `${code(binding.name)} (${escapeMarkdown(binding.type)})${target ? ` -> ${code(target)}` : ""}`;
}

function code(value: string | undefined): string {
  if (!value) return "Not reported";
  const normalized = escapeHtml(value).replace(/[\r\n]+/g, " ");
  const longestRun = Math.max(0, ...[...normalized.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longestRun + 1);
  const padding = normalized.startsWith("`") || normalized.endsWith("`") ? " " : "";
  return `${fence}${padding}${normalized}${padding}${fence}`;
}

function escapeMarkdown(value: string): string {
  return escapeHtml(value)
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/g, " ");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/[\r\n]+/g, " ");
}

function numberText(value: number | undefined): string {
  return value === undefined ? "Not reported" : String(value);
}

function formatNames(names: string[]): string {
  return names.length > 0 ? names.map(code).join(", ") : "None";
}

function heading(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase());
}
