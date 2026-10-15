import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const testDataDirectory = mkdtempSync(join(tmpdir(), "wamcp-vitest-"));
process.env.WA_DATABASE_PATH = join(testDataDirectory, "whatsapp.db");
process.env.WA_MEDIA_DIR = join(testDataDirectory, "media");
process.env.WA_MEDIA_DOWNLOAD_DIR = join(testDataDirectory, "downloads");

afterAll(() => {
  rmSync(testDataDirectory, { recursive: true, force: true });
});
