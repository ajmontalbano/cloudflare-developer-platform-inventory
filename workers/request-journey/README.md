# Request Journey Worker

A small, privacy-conscious reverse proxy for demonstrating the life of a request through Cloudflare and an AWS origin.

It adds a request correlation ID, forwards it to the origin, returns it to the client, and emits structured edge metadata for Workers Logs or Logpush. It does not log request bodies, query strings, authorization headers, cookies, IP addresses, or PHI.

## What It Shows

- Cloudflare Ray ID when available
- Edge colo and country
- Request method, hostname, and path
- Worker-to-origin duration
- Origin response status
- A shared `x-station-trace-id` and W3C `traceparent` value for origin log correlation
- Optional country and region enforcement for geographic access requirements
- Optional route classes without logging the raw request path

This is not a packet-level trace of Cloudflare's internal network and it does not replace Cloudflare Trace. It supplies the correlation layer needed to join Cloudflare edge logs with AWS or application logs.

## Configure

Edit `wrangler.jsonc` and set `ORIGIN` to the customer origin. Use `ORIGIN_HOST_HEADER` only when the origin requires a specific Host header.

Optional variables:

- `ALLOWED_COUNTRIES`: comma-separated ISO country codes, for example `US`.
- `BLOCKED_REGION_CODES`: comma-separated Cloudflare region codes, for example `AK`.
- `ROUTE_CLASS_MAP`: JSON array of `{ "prefix": "/api/appointments", "label": "appointments" }` entries. The Worker logs the label, never the raw path.

For a customer deployment, create a separate Worker environment or clone this directory. Do not commit customer origins, tokens, API keys, request samples, or logs.

The geographic controls are an access policy only. They do not provide DLS data residency or replace application authorization. Configure DLS separately when processing or storage location is a requirement.

## Deploy

From this directory:

```sh
npx wrangler deploy --dry-run
npx wrangler deploy
```

Attach the Worker to a non-production API hostname first. Validate that the origin logs `x-station-trace-id` and `traceparent` before moving any production route.

## Customer-safe demonstration

1. Send a request to the test API endpoint.
2. Capture the returned `x-station-trace-id` and Cloudflare `cf-ray` value.
3. Find the structured Worker event in Workers Logs or Log Explorer.
4. Search the AWS or application logs for `x-station-trace-id`.
5. Walk through the edge decision, Worker timing, origin response, and final client response.

For API traffic, keep the Worker in monitor mode first. Do not cache authenticated or PHI-bearing responses, and do not log request or response bodies.

## StationMD extensions

The next safe additions for a StationMD deployment are:

- A route allowlist for the mobile API and QA paths
- Redacted API outcome labels such as `read`, `write`, or `health`
- A health-check demonstration endpoint
- A Log Explorer query pack for Ray ID and trace ID correlation
- A small static HTML timeline generated from exported, redacted logs

These should remain configuration-driven and should not inspect or persist PHI.
