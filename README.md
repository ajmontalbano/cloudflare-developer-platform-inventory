# Cloudflare Developer Platform Inventory

[![CI](https://github.com/ajmontalbano/cloudflare-developer-platform-inventory/actions/workflows/ci.yml/badge.svg)](https://github.com/ajmontalbano/cloudflare-developer-platform-inventory/actions/workflows/ci.yml)

A read-only CLI that produces a sanitized inventory of selected Cloudflare Developer Platform resources. It creates both JSON and Markdown reports and can compare a new inventory with a previous snapshot.

> This is a community reference tool provided as-is. It is not an official Cloudflare product and is not covered by Cloudflare Support.

## What It Collects

- Workers, including creation and modification timestamps
- Binding names, types, and allowlisted topology references
- Worker Custom Domains
- Durable Object namespaces and storage backends
- R2 buckets across supported jurisdictions
- Queues and producer/consumer counts
- Workflows

It does **not** request Worker source, R2 objects, Durable Object instance data, Queue messages, Workflow instances, logs, analytics, or telemetry. Worker settings responses can contain variable and secret values; the collector uses an explicit allowlist and discards those values before creating or serializing its inventory. The API token is never written to output.

## Optional Request Journey Worker

The repository also contains a separate `workers/request-journey` package. It is a small, customer-deployable reverse proxy for correlating Cloudflare edge events with origin logs. It is intentionally separate from the read-only inventory CLI and does not collect source code, request bodies, query strings, credentials, or PHI.

See [`workers/request-journey/README.md`](workers/request-journey/README.md) for the deployment and customer handoff workflow.

## Quick Start

Prerequisites: Git, Node.js 20 or newer, npm, your Cloudflare account ID, and a read-only account-scoped API token.

```sh
git clone https://github.com/ajmontalbano/cloudflare-developer-platform-inventory.git
cd cloudflare-developer-platform-inventory
npm ci

export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_API_TOKEN="your-read-only-api-token"

npm run inventory
```

The command writes timestamped JSON and Markdown files to `inventory-output/`. Generated files use owner-only permissions where the operating system supports them.

The command exits with:

- `0` when every section was collected successfully.
- `2` when a report was created but one or more sections were incomplete.
- `1` when the command could not run.

Always review generated reports before sharing them outside your organization. Resource names, IDs, custom hostnames, and topology relationships are configuration metadata.

## Create the API Token

In the Cloudflare dashboard, create a **Custom token** scoped to the account being inventoried. Add only these account permissions:

- Workers Scripts: Read
- Workers R2 Storage: Read
- Queues: Read

Do not use a Global API Key or an edit token. Supply the token only through `CLOUDFLARE_API_TOKEN`; do not save it in this repository or pass it as a command-line argument.

Cloudflare may adjust permission requirements as APIs evolve. If a section reports an authorization error, add only the corresponding read permission.

## Options

Write reports to a different directory:

```sh
npm run inventory -- --output-dir ./reports
```

Pass the account ID explicitly:

```sh
npm run inventory -- --account-id your-account-id
```

Compare against a previous snapshot:

```sh
npm run inventory -- --compare ./inventory-output/cloudflare-inventory-PREVIOUS.json
```

Drift comparison is skipped for any section that was incomplete in either snapshot. Snapshots include an unkeyed SHA-256 checksum that detects accidental truncation or editing. It is not a digital signature and does not prove authenticity.

Show all options:

```sh
npm run inventory -- --help
```

## Safety Design

- Sends `GET` requests only to the fixed `https://api.cloudflare.com/client/v4` origin.
- Uses explicit output allowlists rather than copying API responses.
- Handles endpoint-specific page and cursor pagination and fails closed on inconsistent responses.
- Retries transient network, rate-limit, and server failures twice; each request attempt times out after 15 seconds.
- Marks inaccessible sections incomplete instead of treating them as empty.
- Never includes the API token in output or request URLs.

See [SECURITY.md](SECURITY.md) for additional guidance.

## Development

```sh
npm ci
npm run check
npm test
npm run build
```

## Scope

This tool creates an inventory and drift report. It is not a backup or Infrastructure-as-Code exporter and cannot recreate Worker source, secrets, stored data, messages, or runtime state.

## License

MIT. See [LICENSE](LICENSE).
