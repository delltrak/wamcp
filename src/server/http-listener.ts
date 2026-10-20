import type { IncomingMessage, ServerResponse } from "node:http";
import type { HttpRoutes } from "./http-config.js";
import type { McpOAuthServer } from "./oauth/server.js";

export interface HttpListenerDeps {
  routes: HttpRoutes;
  authorize: (req: IncomingMessage, res: ServerResponse) => boolean;
  oauth: McpOAuthServer | null;
  health: (req: IncomingMessage, res: ServerResponse) => void;
  mcp: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  webhook: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>;
}

export function createHttpRequestHandler(
  deps: HttpListenerDeps,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Bad request" }));
      return;
    }

    if (deps.oauth?.handles(url.pathname)) {
      await deps.oauth.handle(req, res);
      return;
    }
    if (url.pathname === deps.routes.health && req.method === "GET") {
      deps.health(req, res);
      return;
    }
    if (url.pathname === deps.routes.mcp) {
      if (!deps.authorize(req, res)) return;
      await deps.mcp(req, res);
      return;
    }
    if (url.pathname === deps.routes.webhook) {
      await deps.webhook(req, res, url);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  };
}
