/**
 * The route registry (API v1, EDGE_FACTORY_PLAN §7.2 item 1): every spawner
 * route the API serves, one row each — method, path, the least role that may
 * call it, and what it does. The hook dispatches `/api/spawner/*` (and its
 * `/api/v1/spawner/*` spelling) only through this table: a path that isn't
 * here is a 404, so the generic passthrough is closed by construction
 * (§7.2 item 4; finding 2). `/api/v1/openapi.json` is generated from it.
 *
 * The role here is the floor. R2b still applies on top, decided by the body
 * (adapter.ts `spawnerWriteNeedsAdmin`): a spawn, saved config, instance or
 * respawn that could trade money, and a promotion to live, need an admin;
 * `guard` names which check a route gets. The prefix rules in adapter.ts
 * (`roleDenies`) stay as the oracle a test compares this table against.
 *
 * Not here on purpose: the spawner's `POST /events` (bots' ingest, internal
 * token only) and anything the spawner adds later until a row says who may
 * call it.
 */
import type { Role } from "./adapter";

export type Method = "GET" | "POST" | "DELETE";
export type Guard = "spawn-spec" | "instance" | "stored-config" | "promotion";

export interface Route {
  method: Method;
  /** The spawner's path; `{name}` is one path segment. */
  path: string;
  minRole: Role;
  summary: string;
  tag: string;
  guard?: Guard;
}

const r = (method: Method, path: string, minRole: Role, tag: string, summary: string, guard?: Guard): Route => ({
  method,
  path,
  minRole,
  tag,
  summary,
  ...(guard ? { guard } : {}),
});

export const SPAWNER_ROUTES: readonly Route[] = [
  r("GET", "/health", "viewer", "system", "The spawner's health"),
  r("GET", "/metrics", "viewer", "system", "The spawner's Prometheus metrics"),
  // Containers (every bot, recorder and job)
  r("GET", "/containers", "viewer", "containers", "List the spawned containers"),
  r("GET", "/container/{id}", "viewer", "containers", "Inspect a container"),
  r("GET", "/container/{id}/logs", "viewer", "containers", "A container's logs (SSE)"),
  r("POST", "/container/{id}/stop", "operator", "containers", "Stop a container"),
  r("POST", "/container/{id}/restart", "operator", "containers", "Restart a container"),
  r("DELETE", "/container/{id}", "operator", "containers", "Remove a container (its data is kept)"),
  r("POST", "/spawn", "operator", "containers", "Spawn a container from a spec", "spawn-spec"),
  r("GET", "/runs", "viewer", "containers", "The run ledger"),
  r("GET", "/bots/{bot_id}/status", "viewer", "containers", "A bot's own status document"),
  // Saved configs
  r("GET", "/configs", "viewer", "configs", "List the saved configs (secrets redacted)"),
  r("POST", "/configs", "operator", "configs", "Save a config", "spawn-spec"),
  r("DELETE", "/configs/{name}", "operator", "configs", "Delete a saved config"),
  r("POST", "/configs/{name}/respawn", "operator", "configs", "Respawn a saved config", "stored-config"),
  // Templates and instances
  r("GET", "/templates", "viewer", "instances", "List the templates (and the ones that failed to load)"),
  r("GET", "/templates/{id}", "viewer", "instances", "One template"),
  r("GET", "/instances", "viewer", "instances", "List the instances"),
  r("POST", "/instances", "operator", "instances", "Create an instance from a template", "instance"),
  r("POST", "/instances/validate", "operator", "instances", "Check an instance request without creating it"),
  r("DELETE", "/instances/{name}", "operator", "instances", "Delete an instance (its data is kept)"),
  r("POST", "/instances/{name}/start", "operator", "instances", "Start an instance", "stored-config"),
  r("POST", "/instances/{name}/stop", "operator", "instances", "Stop an instance"),
  r("GET", "/instances/{name}/files", "viewer", "instances", "A recorder's files per day"),
  // Credentials and notifications (write-only secrets)
  r("GET", "/secrets/status", "viewer", "settings", "Which exchanges have stored keys (never the keys)"),
  r("POST", "/secrets", "admin", "settings", "Store an exchange's keys"),
  r("DELETE", "/secrets/{exchange}", "admin", "settings", "Delete an exchange's keys"),
  r("GET", "/notifications", "viewer", "settings", "List the notification channels (never their URLs)"),
  r("POST", "/notifications", "admin", "settings", "Store a notification channel"),
  r("DELETE", "/notifications/{name}", "admin", "settings", "Delete a notification channel"),
  r("POST", "/notifications/{name}/test", "admin", "settings", "Send a channel a test message"),
  r("GET", "/notifications/history", "viewer", "settings", "The delivery ledger"),
  r("GET", "/leases", "viewer", "settings", "The account leases"),
  // Treasury
  r("GET", "/accounts", "viewer", "treasury", "List the accounts"),
  r("POST", "/accounts", "operator", "treasury", "Save an account"),
  r("DELETE", "/accounts/{id}", "operator", "treasury", "Delete an account"),
  r("GET", "/transfers", "viewer", "treasury", "List the transfers"),
  r("POST", "/transfers", "operator", "treasury", "Record a transfer"),
  r("GET", "/net-worth", "viewer", "treasury", "The net-worth series"),
  r("POST", "/net-worth", "operator", "treasury", "Record a net-worth sample"),
  r("GET", "/profit", "viewer", "treasury", "Profit over a window"),
  // The edge ladder (EDGE_PROCESS)
  r("GET", "/edges", "viewer", "edges", "List the edges"),
  r("POST", "/edges", "operator", "edges", "Save an edge"),
  r("DELETE", "/edges/{id}", "operator", "edges", "Delete an edge"),
  r("GET", "/edges/{id}/backtests", "viewer", "edges", "An edge's backtest runs"),
  r("POST", "/edges/{id}/backtest", "operator", "edges", "Run an edge's backtest"),
  r("POST", "/edges/{id}/hypotheses", "operator", "edges", "Register a hypothesis (stage 2)"),
  r("POST", "/hypotheses/{id}/withdraw", "operator", "edges", "Withdraw a hypothesis"),
  r("GET", "/ladder", "viewer", "edges", "The whole ladder: hypotheses, experiments, deployments, health"),
  r("POST", "/deployments", "operator", "edges", "Create a deployment at backtest"),
  r("POST", "/deployments/{id}/promote", "operator", "edges", "Promote a deployment (live: admin)", "promotion"),
  r("POST", "/deployments/{id}/retire", "operator", "edges", "Retire a deployment"),
  // Saved dashboard layouts
  r("GET", "/ui/layouts", "viewer", "ui", "List the saved layouts"),
  r("POST", "/ui/layouts", "operator", "ui", "Save a layout"),
  r("GET", "/ui/layouts/{name}", "viewer", "ui", "One saved layout"),
  r("DELETE", "/ui/layouts/{name}", "operator", "ui", "Delete a saved layout"),
];

function segments(path: string): string[] {
  return path.split("/").filter((s, i) => i > 0 || s !== "");
}

function matches(template: string, path: string): boolean {
  const t = segments(template);
  const p = segments(path);
  if (t.length !== p.length) return false;
  return t.every((seg, i) => (seg.startsWith("{") ? p[i] !== "" && !p[i].includes("/") : seg === p[i]));
}

/**
 * The registered route for a spawner path (`/ladder`, no query) and method,
 * or null. A path spelled with doubled or trailing slashes isn't a route.
 */
export function matchSpawnerRoute(method: string, path: string): Route | null {
  const m = method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase();
  if (path === "" || path.includes("//") || (path.length > 1 && path.endsWith("/"))) return null;
  return SPAWNER_ROUTES.find((x) => x.method === m && matches(x.path, path)) ?? null;
}

/** Whether a path exists under any method (a 405 rather than a 404). */
export function spawnerPathExists(path: string): boolean {
  return SPAWNER_ROUTES.some((x) => matches(x.path, path));
}

/** The OpenAPI document for API v1 (§7.2: generated from the registry). */
export function openapi(): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of SPAWNER_ROUTES) {
    const key = `/api/v1/spawner${route.path}`;
    const params = [...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
      name: m[1],
      in: "path",
      required: true,
      schema: { type: "string" },
    }));
    paths[key] ??= {};
    paths[key][route.method.toLowerCase()] = {
      summary: route.summary,
      tags: [route.tag],
      ...(params.length ? { parameters: params } : {}),
      "x-min-role": route.minRole,
      ...(route.guard ? { "x-admin-when": guardText[route.guard] } : {}),
      responses: {
        "200": { description: "The spawner's answer, as JSON (SSE for logs)" },
        "401": { description: "No session or token" },
        "403": { description: "The role is too low, or the request needs an admin" },
        "404": { description: "Not found" },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "FKS API",
      version: "1",
      description:
        "fks-web's server API. Authenticate with a session cookie or `Authorization: Bearer fks_pat_…` " +
        "(Settings → API tokens). A token's role is the lower of its user's and its cap. Paths under " +
        "/api/ are also served under /api/v1/.",
    },
    components: {
      securitySchemes: { pat: { type: "http", scheme: "bearer", description: "A personal access token" } },
    },
    security: [{ pat: [] }],
    paths,
  };
}

const guardText: Record<Guard, string> = {
  "spawn-spec": "the spec is in live mode, or asks for stored exchange keys or webhooks",
  instance: "the template's mode is live, or it may receive keys",
  "stored-config": "the stored config it runs is in live mode, or has keys or webhooks",
  promotion: "the promotion is to live",
};
