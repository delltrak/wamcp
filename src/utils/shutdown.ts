export const SHUTDOWN_TIMEOUT_MS = 15_000;

export type ShutdownSignal = "SIGINT" | "SIGTERM";

interface ShutdownOptions {
  timeoutMs?: number;
  exit?: (code: number) => void;
  onError?: (error: unknown) => void;
}

export function createShutdownHandler(
  cleanup: (signal: ShutdownSignal) => Promise<void>,
  options: ShutdownOptions = {},
): (signal: ShutdownSignal) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let shutdownPromise: Promise<void> | null = null;

  return (signal) => {
    if (shutdownPromise) return shutdownPromise;

    const cleanupPromise = Promise.resolve().then(() => cleanup(signal));
    let timeout: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`Shutdown exceeded ${timeoutMs} ms`)), timeoutMs);
    });

    shutdownPromise = Promise.race([cleanupPromise, timeoutPromise])
      .then(() => exit(0))
      .catch((error: unknown) => {
        try {
          options.onError?.(error);
        } catch {
          // Logging must not prevent the process from exiting.
        }
        exit(1);
      })
      .finally(() => clearTimeout(timeout));

    return shutdownPromise;
  };
}

export function installShutdownHandlers(
  cleanup: (signal: ShutdownSignal) => Promise<void>,
  options: ShutdownOptions = {},
): () => void {
  const shutdown = createShutdownHandler(cleanup, options);
  const onSigint = () => void shutdown("SIGINT");
  const onSigterm = () => void shutdown("SIGTERM");

  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  };
}
