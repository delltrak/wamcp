// ============================================================
// WA MCP — Shared helpers for resource registration
// ============================================================

import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Variables } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import type { InstanceManager } from "../services/instance-manager.js";

/**
 * Read a single URI-template variable as a string.
 * A variable may arrive as string[] when the template allows repetition.
 */
export function varAsString(variables: Variables, name: string): string {
  const value = variables[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * Build a ResourceTemplate for a per-instance URI, whose `list` enumerates the
 * instances that actually exist. Without a list callback an agent only ever sees
 * the `{id}` placeholder and has no way to discover a concrete URI to read.
 */
export function perInstanceTemplate(
  instanceManager: InstanceManager,
  buildUri: (instanceId: string) => string,
  buildName: (instanceName: string) => string,
  mimeType = "application/json",
): ResourceTemplate {
  return new ResourceTemplate(buildUri("{id}"), {
    list: () => ({
      resources: instanceManager.getAllInstances().map((inst) => ({
        uri: buildUri(inst.id),
        name: buildName(inst.name),
        mimeType,
      })),
    }),
  });
}
