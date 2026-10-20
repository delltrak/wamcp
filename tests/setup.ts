import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const testDataDirectory = mkdtempSync(join(tmpdir(), "wamcp-vitest-"));
process.env.WA_DATABASE_PATH = join(testDataDirectory, "whatsapp.db");
process.env.WA_MEDIA_DIR = join(testDataDirectory, "media");
process.env.WA_MEDIA_DOWNLOAD_DIR = join(testDataDirectory, "downloads");

const postgresAdminUrl = process.env.WA_DATABASE_URL?.trim() ?? "";
let postgresSchema: string | null = null;

if (postgresAdminUrl) {
  const worker = (process.env.VITEST_WORKER_ID ?? "0").replace(/\D/g, "") || "0";
  postgresSchema = `wamcp_test_${worker}`;
  const { Client } = await import("pg");
  const admin = new Client({ connectionString: postgresAdminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${postgresSchema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${postgresSchema}`);
  } finally {
    await admin.end();
  }
  const url = new URL(postgresAdminUrl);
  url.searchParams.set(
    "options",
    `-c search_path=${postgresSchema} -c application_name=${postgresSchema}`,
  );
  process.env.WA_DATABASE_URL = url.toString();
}

afterAll(async () => {
  if (postgresSchema) {
    try {
      const { Client } = await import("pg");
      const admin = new Client({ connectionString: postgresAdminUrl });
      await admin.connect();
      try {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1 AND pid <> pg_backend_pid()",
          [postgresSchema],
        );
        await admin.query(`DROP SCHEMA IF EXISTS ${postgresSchema} CASCADE`);
      } finally {
        await admin.end();
      }
    } catch {
      // A leftover test schema is preferable to failing the run during teardown.
    }
  }
  rmSync(testDataDirectory, { recursive: true, force: true });
});
