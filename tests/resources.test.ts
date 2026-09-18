import { readFileSync, readdirSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { perInstanceTemplate, varAsString } from "../src/resources/resource-helpers.js";
import type { InstanceManager } from "../src/services/instance-manager.js";

// resource-helpers only imports the SDK plus a type-only InstanceManager, so it
// can be exercised without touching src/db/client.ts and creating a real file DB.

const stubManager = (
  rows: { id: string; name: string }[],
): InstanceManager => ({ getAllInstances: () => rows }) as unknown as InstanceManager;

describe("varAsString", () => {
  it("reads a plain string variable", () => {
    expect(varAsString({ id: "inst_abcd1234" }, "id")).toBe("inst_abcd1234");
  });

  it("takes the first value when a variable repeats", () => {
    expect(varAsString({ id: ["a", "b"] }, "id")).toBe("a");
  });

  it("returns an empty string for a missing or empty variable", () => {
    expect(varAsString({}, "id")).toBe("");
    expect(varAsString({ id: [] }, "id")).toBe("");
  });
});

describe("perInstanceTemplate", () => {
  it("registers the placeholder form, not a literal '{id}' URI", () => {
    const t = perInstanceTemplate(
      stubManager([]),
      (id) => `whatsapp://instances/${id}/contacts`,
      (n) => `Contacts — ${n}`,
    );
    expect(t.uriTemplate.toString()).toBe("whatsapp://instances/{id}/contacts");
  });

  it("expands to a concrete readable URI", () => {
    const t = perInstanceTemplate(
      stubManager([]),
      (id) => `whatsapp://instances/${id}/contacts`,
      (n) => `Contacts — ${n}`,
    );
    // The variables an agent supplies must round-trip back out of the URI.
    const uri = "whatsapp://instances/inst_abcd1234/contacts";
    expect(t.uriTemplate.match(uri)).toEqual({ id: "inst_abcd1234" });
  });

  it("lists a concrete URI per existing instance, so agents can discover them", async () => {
    const t = perInstanceTemplate(
      stubManager([
        { id: "inst_1", name: "work" },
        { id: "inst_2", name: "personal" },
      ]),
      (id) => `whatsapp://instances/${id}/contacts`,
      (n) => `Contacts — ${n}`,
    );
    const listed = await t.listCallback!({} as never);
    expect(listed.resources.map((r) => r.uri)).toEqual([
      "whatsapp://instances/inst_1/contacts",
      "whatsapp://instances/inst_2/contacts",
    ]);
    expect(listed.resources.map((r) => r.name)).toEqual([
      "Contacts — work",
      "Contacts — personal",
    ]);
  });
});

describe("registration APIs", () => {
  const sources = [
    ...readdirSync("src/tools").map((f) => `src/tools/${f}`),
    ...readdirSync("src/resources").map((f) => `src/resources/${f}`),
  ].filter((f) => f.endsWith(".ts"));

  // server.tool() and server.resource() are deprecated, and both silently drop
  // information: tool() rebuilds a raw shape with a plain z.object (losing
  // .strict()), and resource() treats a "{id}" URI as a literal static resource
  // rather than a template, making it unreadable.
  it("no source file uses the deprecated server.tool()/server.resource()", () => {
    const offenders = sources.filter((f) => /server\.(tool|resource)\(/.test(readFileSync(f, "utf-8")));
    expect(offenders).toEqual([]);
  });

  it("no resource is registered with an unexpanded placeholder as a static URI", () => {
    const offenders: string[] = [];
    for (const f of sources.filter((f) => f.startsWith("src/resources/"))) {
      const src = readFileSync(f, "utf-8");
      // A quoted URI containing "{" must come from a ResourceTemplate/helper,
      // never straight into registerResource as a static string.
      for (const m of src.matchAll(/registerResource\(\s*"[^"]+",\s*("whatsapp:\/\/[^"]*\{[^"]*")/g)) {
        offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
