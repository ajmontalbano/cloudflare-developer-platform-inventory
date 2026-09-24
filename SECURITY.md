# Security Notes

## Reporting a vulnerability

Open a GitHub security advisory for suspected vulnerabilities. Do not include API tokens, generated inventory reports, customer identifiers, or other sensitive data in a public issue.

## Credentials

Use a custom, account-scoped, read-only Cloudflare API token. Supply it only through `CLOUDFLARE_API_TOKEN`. The collector never writes the token to disk or includes it in request URLs.

Do not use a Global API Key, an edit token, or a token copied into a configuration file.

## Generated files

Inventory reports contain resource names, account IDs, resource IDs, custom hostnames, and topology relationships. Worker settings API responses can contain binding values, but the collector discards them through an explicit allowlist before serialization. Reports do not contain source code, binding values, stored data, logs, or analytics.

Generated files use owner-only permissions where the operating system supports them. Treat the reports as configuration metadata and review them before external distribution.

## API behavior

The collector sends `GET` requests only to `https://api.cloudflare.com/client/v4`. The API base URL cannot be overridden, which prevents accidentally sending the token to another host.

If an endpoint cannot be read, the collector records a bounded error message and marks the section incomplete. Drift comparison skips incomplete sections to prevent false removal reports.
