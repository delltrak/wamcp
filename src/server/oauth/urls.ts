export interface PublicHttpsUrl {
  origin: string;
  href: string;
  path: string;
}

export function assertSafePath(path: string, label: string): void {
  if (path === "") return;
  if (!path.startsWith("/") || path.includes("//")) {
    throw new Error(`Invalid ${label}; path is not allowed`);
  }
  for (const segment of path.slice(1).split("/")) {
    if (segment === "." || segment === ".." || !/^[A-Za-z0-9._~-]+$/.test(segment)) {
      throw new Error(`Invalid ${label}; path is not allowed`);
    }
  }
}

export function parsePublicHttpsUrl(raw: string, label: string): PublicHttpsUrl {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(
      `Invalid ${label}; expected an absolute public HTTPS URL without credentials, query, or fragment`,
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname
  ) {
    throw new Error(
      `Invalid ${label}; expected an absolute public HTTPS URL without credentials, query, or fragment`,
    );
  }

  const stripped = url.pathname.replace(/\/+$/, "");
  const path = stripped === "/" ? "" : stripped;
  assertSafePath(path, label);
  return { origin: url.origin, href: `${url.origin}${path}`, path };
}

/** RFC 8414 / RFC 9728 path insertion: `/.well-known/{name}` plus the public path. */
export function wellKnownPath(metadataName: string, publicPath: string): string {
  const cleaned = publicPath.replace(/^\/+|\/+$/g, "");
  if (!cleaned) return `/.well-known/${metadataName}`;
  return `/.well-known/${metadataName}/${cleaned}`;
}

export function defaultOAuthResourceUrl(issuer: PublicHttpsUrl, basePath: string): string {
  return `${issuer.origin}${basePath}/mcp`;
}
