import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { loadEventWebhookConfig } from "../src/services/event-webhook-config.js";
import { postEventWebhook } from "../src/services/event-webhook.js";

vi.mock("undici", async (importOriginal) => {
  const actual = await importOriginal<typeof import("undici")>();
  return {
    ...actual,
    // Keep the real dispatcher and HTTP client; only route the test host to loopback.
    Agent: class extends actual.Agent {
      constructor(options: ConstructorParameters<typeof actual.Agent>[0]) {
        super({
          ...options,
          connect: {
            lookup: (_hostname, options, callback) => {
              if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
              else callback(null, "127.0.0.1", 4);
            },
          },
        });
      }
    },
  };
});

describe("event webhook HTTP transport", () => {
  it("delivers through the installed Undici dispatcher using the default HTTP client", async () => {
    let receivedBody = "";
    let receivedMethod: string | undefined;
    const server = createServer((request, response) => {
      receivedMethod = request.method;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(204).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server port");
      const destination = loadEventWebhookConfig({
        WA_EVENT_WEBHOOK_URL: `http://hooks.example.test:${address.port}/receive`,
        WA_EVENT_WEBHOOK_ALLOW_HTTP: "true",
      }).destinations[0]!;

      await postEventWebhook(destination, { event: "test" }, 1_000, undefined, async () => [
        { address: "93.184.216.34", family: 4 },
      ]);

      expect(receivedMethod).toBe("POST");
      expect(JSON.parse(receivedBody)).toEqual({ event: "test" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
