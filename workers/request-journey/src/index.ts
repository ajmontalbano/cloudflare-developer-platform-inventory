interface Env {
  ORIGIN: string;
  ORIGIN_HOST_HEADER?: string;
  ALLOWED_COUNTRIES?: string;
  BLOCKED_REGION_CODES?: string;
  ROUTE_CLASS_MAP?: string;
}

interface RequestCfProperties {
  colo?: string;
  country?: string;
  city?: string;
  regionCode?: string;
}

interface JourneyRequest extends Request {
  cf?: RequestCfProperties;
}

interface JourneyEvent {
  event: "request_journey";
  traceId: string;
  rayId: string | null;
  method: string;
  host: string;
  path: string;
  colo: string | null;
  country: string | null;
  startedAt: string;
  durationMs: number;
  status: number;
  outcome: "origin_response" | "origin_error";
  routeClass: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const started = Date.now();
    const traceId = crypto.randomUUID();
    const cf = (request as JourneyRequest).cf;
    const policy = geoPolicy(cf, env);
    if (!policy.allowed) {
      const response = new Response("Request not allowed", { status: 403 });
      const headers = new Headers(response.headers);
      headers.set("x-request-journey-id", traceId);
      console.log(JSON.stringify({
        event: "request_journey",
        traceId,
        rayId: request.headers.get("cf-ray"),
        method: request.method,
        host: new URL(request.url).hostname,
        routeClass: routeClass(new URL(request.url).pathname, env.ROUTE_CLASS_MAP),
        colo: cf?.colo ?? null,
        country: cf?.country ?? null,
        regionCode: cf?.regionCode ?? null,
        outcome: "policy_denied",
        reason: policy.reason,
      }));
      return new Response(response.body, { status: response.status, headers });
    }

    const requestUrl = new URL(request.url);
    const originUrl = new URL(env.ORIGIN);
    originUrl.pathname = requestUrl.pathname;
    originUrl.search = requestUrl.search;

    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("x-request-journey-id", traceId);
    upstreamHeaders.set("traceparent", createTraceparent(traceId));
    if (env.ORIGIN_HOST_HEADER) upstreamHeaders.set("host", env.ORIGIN_HOST_HEADER);

    let response: Response;
    let outcome: JourneyEvent["outcome"] = "origin_response";

    try {
      response = await fetch(new Request(originUrl, {
        method: request.method,
        headers: upstreamHeaders,
        body: request.body,
        redirect: "manual",
      }));
    } catch {
      outcome = "origin_error";
      response = new Response("Upstream request failed", { status: 502 });
    }

    const durationMs = Date.now() - started;
    const event: JourneyEvent = {
      event: "request_journey",
      traceId,
      rayId: request.headers.get("cf-ray"),
      method: request.method,
      host: requestUrl.hostname,
      path: "redacted",
      colo: cf?.colo ?? null,
      country: cf?.country ?? null,
      startedAt: new Date(started).toISOString(),
      durationMs,
      status: response.status,
      outcome,
      routeClass: routeClass(requestUrl.pathname, env.ROUTE_CLASS_MAP),
    };
    console.log(JSON.stringify(event));

    const clientHeaders = new Headers(response.headers);
    clientHeaders.set("x-request-journey-id", traceId);
    clientHeaders.set("access-control-expose-headers", appendHeader(
      clientHeaders.get("access-control-expose-headers"),
      "x-request-journey-id",
    ));

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: clientHeaders,
    });
  },
};

function createTraceparent(traceId: string): string {
  const trace = traceId.replaceAll("-", "").padEnd(32, "0").slice(0, 32);
  const span = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  return `00-${trace}-${span}-01`;
}

function appendHeader(existing: string | null, value: string): string {
  if (!existing) return value;
  if (existing.split(",").map((item) => item.trim()).includes(value)) return existing;
  return `${existing}, ${value}`;
}

function geoPolicy(cf: RequestCfProperties | undefined, env: Env): { allowed: boolean; reason?: string } {
  const country = cf?.country?.toUpperCase();
  const regionCode = cf?.regionCode?.toUpperCase();
  const allowedCountries = splitList(env.ALLOWED_COUNTRIES);
  const blockedRegions = splitList(env.BLOCKED_REGION_CODES);

  if (allowedCountries.length > 0 && (!country || !allowedCountries.includes(country))) {
    return { allowed: false, reason: "country_not_allowed" };
  }
  if (blockedRegions.length > 0 && regionCode && blockedRegions.includes(regionCode)) {
    return { allowed: false, reason: "region_not_allowed" };
  }
  return { allowed: true };
}

function routeClass(pathname: string, serializedMap: string | undefined): string {
  if (!serializedMap) return "unclassified";
  try {
    const entries = JSON.parse(serializedMap) as unknown;
    if (!Array.isArray(entries)) return "unclassified";
    const match = entries.find((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const value = entry as Record<string, unknown>;
      return typeof value.prefix === "string" && typeof value.label === "string"
        && pathname.startsWith(value.prefix);
    }) as Record<string, unknown> | undefined;
    return typeof match?.label === "string" ? match.label : "unclassified";
  } catch {
    return "unclassified";
  }
}

function splitList(value: string | undefined): string[] {
  return value
    ?.split(",")
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean) ?? [];
}
