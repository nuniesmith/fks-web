import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roleDenies, type Role } from "./adapter";
import { SPAWNER_ROUTES, matchSpawnerRoute, openapi, spawnerPathExists } from "./routes";

/** Every source file under src/, except tests and the server's own code. */
function sources(dir = "src"): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) && !p.includes("lib/server") ? [p] : [];
  });
}

/** The spawner paths the UI calls: `${BASE}/…` in the client, `/api/spawner/…` anywhere. */
function uiSpawnerPaths(): Set<string> {
  const out = new Set<string>();
  for (const file of sources()) {
    const text = readFileSync(file, "utf8");
    const base = file.endsWith("api/spawner.ts");
    const re = base ? /\$\{BASE\}(\/[^`"'\s]*)/g : /\/api\/spawner(\/[A-Za-z0-9_./${}()-]*)/g;
    for (const m of text.matchAll(re)) {
      let path = m[1]
        .replace(/(?<!\/)\$\{[^}]*\}?/g, "") // interpolated onto a segment: a query string
        .replace(/\$\{[^}]*\}?/g, "x") // an interpolated segment
        .replace(/\{[a-z_]+\}/gi, "x") // a {placeholder} in a comment-free literal
        .split("?")[0]
        .replace(/[^A-Za-z0-9_/.-]+$/, "");
      if (path.endsWith("/")) path = path.slice(0, -1); // a prefix built on (`/api/spawner/` + …)
      if (path) out.add(path);
    }
  }
  return out;
}

describe("the route registry (API v1)", () => {
  it("every spawner call the UI makes is a registered route", () => {
    const calls = uiSpawnerPaths();
    expect(calls.size).toBeGreaterThan(30);
    const missing = [...calls].filter((p) => !spawnerPathExists(p));
    expect(missing).toEqual([]);
  });

  it("each route's role agrees with the prefix rules it replaces (the oracle)", () => {
    const roles: Role[] = ["viewer", "operator", "admin"];
    const disagree: string[] = [];
    for (const route of SPAWNER_ROUTES) {
      const path = "/api/spawner" + route.path.replace(/\{[^}]+\}/g, "x");
      for (const role of roles) {
        const registry = ["viewer", "operator", "admin"].indexOf(role) >= ["viewer", "operator", "admin"].indexOf(route.minRole);
        const prefix = !roleDenies(path, route.method, role);
        if (registry !== prefix) disagree.push(`${route.method} ${route.path} as ${role}: registry ${registry}, rules ${prefix}`);
      }
    }
    expect(disagree).toEqual([]);
  });

  it("is unique, and every route is in the OpenAPI document", () => {
    const keys = SPAWNER_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    const doc = openapi() as { paths: Record<string, Record<string, { "x-min-role": string }>> };
    for (const r of SPAWNER_ROUTES) {
      expect(doc.paths[`/api/v1/spawner${r.path}`]?.[r.method.toLowerCase()]?.["x-min-role"]).toBe(r.minRole);
    }
  });

  it("matches one segment per placeholder, the method, and nothing loose", () => {
    expect(matchSpawnerRoute("GET", "/ladder")?.path).toBe("/ladder");
    expect(matchSpawnerRoute("HEAD", "/ladder")?.path).toBe("/ladder");
    expect(matchSpawnerRoute("POST", "/deployments/7/promote")?.guard).toBe("promotion");
    expect(matchSpawnerRoute("GET", "/deployments/7/promote")).toBeNull();
    expect(matchSpawnerRoute("POST", "/events")).toBeNull(); // the bots' ingest stays internal
    expect(matchSpawnerRoute("GET", "/ladder/")).toBeNull();
    expect(matchSpawnerRoute("GET", "//ladder")).toBeNull();
    expect(matchSpawnerRoute("GET", "/container/a/b/logs")).toBeNull();
    expect(matchSpawnerRoute("DELETE", "/secrets/kraken")?.minRole).toBe("admin");
    expect(spawnerPathExists("/deployments/7/promote")).toBe(true);
  });
});
