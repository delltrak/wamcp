import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveDatabaseConfig } from "../src/db/config.js";

describe("database config", () => {
  it("uses SQLite at WA_DATABASE_PATH when WA_DATABASE_URL is empty", () => {
    const config = resolveDatabaseConfig({
      WA_DATABASE_PATH: "data/whatsapp.db",
      WA_DATABASE_URL: "",
    } as NodeJS.ProcessEnv);
    expect(config).toEqual({
      driver: "sqlite",
      path: resolve("data/whatsapp.db"),
    });
  });

  it("keeps the default SQLite path when the URL is unset", () => {
    const config = resolveDatabaseConfig({} as NodeJS.ProcessEnv);
    expect(config.driver).toBe("sqlite");
    if (config.driver === "sqlite") {
      expect(config.path).toBe(resolve("data/whatsapp.db"));
    }
  });

  it("accepts postgres and postgresql URLs without changing the SQLite path", () => {
    for (const url of [
      "postgres://wamcp:wamcp@localhost:5432/wamcp",
      "postgresql://wamcp:wamcp@localhost:5432/wamcp",
    ]) {
      const config = resolveDatabaseConfig({
        WA_DATABASE_PATH: "data/whatsapp.db",
        WA_DATABASE_URL: url,
      } as NodeJS.ProcessEnv);
      expect(config.driver).toBe("postgres");
      if (config.driver === "postgres") {
        expect(config.url).toBe(url);
        expect(config.path).toBe(resolve("data/whatsapp.db"));
      }
    }
  });

  it("rejects other schemes without echoing the URL", () => {
    expect(() =>
      resolveDatabaseConfig({
        WA_DATABASE_URL: "mysql://user:supersecret@localhost/db",
      } as NodeJS.ProcessEnv),
    ).toThrow(/postgres:\/\/ or postgresql:\/\//);
    try {
      resolveDatabaseConfig({
        WA_DATABASE_URL: "mysql://user:supersecret@localhost/db",
      } as NodeJS.ProcessEnv);
    } catch (error) {
      expect(String(error)).not.toContain("supersecret");
    }
  });

  it("rejects a postgres URL without a database name", () => {
    expect(() =>
      resolveDatabaseConfig({
        WA_DATABASE_URL: "postgres://localhost",
      } as NodeJS.ProcessEnv),
    ).toThrow(/database name/);
  });
});
