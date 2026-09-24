#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { collectInventory, type Inventory } from "./inventory.js";
import { compareInventories, renderDriftMarkdown, renderInventoryMarkdown } from "./report.js";

interface CliOptions {
  accountId?: string;
  outputDir: string;
  comparePath?: string;
  help: boolean;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const accountId = args.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId) throw new Error("Set CLOUDFLARE_ACCOUNT_ID or pass --account-id");
  if (!apiToken) throw new Error("Set CLOUDFLARE_API_TOKEN to a read-only, account-scoped API token");

  console.error("Collecting sanitized Cloudflare Developer Platform inventory...");
  const inventory = await collectInventory({ accountId, apiToken });
  const outputDir = resolve(args.outputDir);
  await mkdir(outputDir, { recursive: true });

  const timestamp = inventory.generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const jsonPath = resolve(outputDir, `cloudflare-inventory-${timestamp}.json`);
  const markdownPath = resolve(outputDir, `cloudflare-inventory-${timestamp}.md`);
  await Promise.all([
    writeFile(jsonPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: 0o600 }),
    writeFile(markdownPath, renderInventoryMarkdown(inventory), { mode: 0o600 }),
  ]);

  console.error(`Wrote ${jsonPath}`);
  console.error(`Wrote ${markdownPath}`);

  if (args.comparePath) {
    const previous = JSON.parse(await readFile(resolve(args.comparePath), "utf8")) as Inventory;
    const drift = compareInventories(previous, inventory);
    const driftJsonPath = resolve(outputDir, `cloudflare-drift-${timestamp}.json`);
    const driftMarkdownPath = resolve(outputDir, `cloudflare-drift-${timestamp}.md`);
    await Promise.all([
      writeFile(driftJsonPath, `${JSON.stringify(drift, null, 2)}\n`, { mode: 0o600 }),
      writeFile(driftMarkdownPath, renderDriftMarkdown(drift), { mode: 0o600 }),
    ]);
    console.error(`Compared against ${basename(args.comparePath)}`);
    console.error(`Wrote ${driftJsonPath}`);
    console.error(`Wrote ${driftMarkdownPath}`);
  }

  const incomplete = [inventory.workers, inventory.durableObjects, inventory.r2Buckets, inventory.queues, inventory.workflows]
    .some((section) => section.status !== "ok");
  if (incomplete) {
    console.error("Inventory completed with collection warnings. Review the report before sharing it.");
    process.exitCode = 2;
  }
}

function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { outputDir: "inventory-output", help: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--account-id") options.accountId = requiredValue(args, ++index, arg);
    else if (arg === "--output-dir") options.outputDir = requiredValue(args, ++index, arg);
    else if (arg === "--compare") options.comparePath = requiredValue(args, ++index, arg);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function printHelp(): void {
  console.log(`Cloudflare Developer Platform inventory collector

Usage:
  npm run inventory -- [options]

Options:
  --account-id <id>    Cloudflare account ID (or CLOUDFLARE_ACCOUNT_ID)
  --output-dir <path>  Output directory (default: inventory-output)
  --compare <file>     Compare against a previous inventory JSON file
  --help               Show this help

Required environment:
  CLOUDFLARE_API_TOKEN  Read-only, account-scoped Cloudflare API token`);
}

main().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
  process.exitCode = 1;
});
