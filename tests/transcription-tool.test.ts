import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { InstanceManager } from "../src/services/instance-manager.js";
import { registerTranscriptionTools } from "../src/tools/transcription.tools.js";
import { TranscribeAudioSchema } from "../src/schemas/transcription.schema.js";
import type { z } from "zod";

const ENV_KEYS = [
  "WA_TRANSCRIPTION_ENABLED",
  "WA_TRANSCRIPTION_API_KEY",
  "WA_TRANSCRIPTION_BASE_URL",
  "WA_TRANSCRIPTION_MODEL",
  "WA_TRANSCRIPTION_LANGUAGE",
  "WA_TRANSCRIPTION_MAX_MB",
  "WA_TRANSCRIPTION_TIMEOUT_MS",
] as const;
const originalEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

type TranscriptionInput = z.infer<typeof TranscribeAudioSchema>;
type TranscriptionHandler = (params: TranscriptionInput) => Promise<unknown>;

describe("wa_transcribe_audio", () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    vi.unstubAllGlobals();
  });

  it("returns a clear configuration error without downloading or contacting a provider", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    let handler: TranscriptionHandler | undefined;
    const server = {
      registerTool: (_name: string, _config: unknown, callback: TranscriptionHandler) => {
        handler = callback;
      },
    } as unknown as McpServer;

    registerTranscriptionTools(server, {} as InstanceManager);
    const result = (await handler!({ audio: "Zm9v" })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/transcription not configured/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("infers the MIME type from a URL extension when the response type is generic", async () => {
    process.env.WA_TRANSCRIPTION_ENABLED = "true";
    process.env.WA_TRANSCRIPTION_API_KEY = "unit-test-key";

    const fetchMock = vi.fn().mockImplementation((input: string) => {
      if (input === "https://audio.example.test/sample.mp3?download=1") {
        return Promise.resolve(
          new Response(Buffer.from("audio bytes"), {
            headers: { "content-type": "application/octet-stream" },
          }),
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ text: "recognized words" }), { status: 200 }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    let handler: TranscriptionHandler | undefined;
    const server = {
      registerTool: (_name: string, _config: unknown, callback: TranscriptionHandler) => {
        handler = callback;
      },
    } as unknown as McpServer;

    registerTranscriptionTools(server, {} as InstanceManager);
    await handler!({ audio: "https://audio.example.test/sample.mp3?download=1" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const init = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const file = (init.body as FormData).get("file") as File;
    expect(file.type).toBe("audio/mpeg");
    expect(file.name).toBe("audio.mp3");
  });
});
