import type pino from "pino";

type FailureKind = "missing_key" | "sync_failed" | "hash_verification_failed" | "decode_failed";

interface ActiveResync {
  collection: string;
  failureKind?: FailureKind;
}

export type AppStateResyncResult<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Baileys resyncAppState can log and return after it gives up or parks a collection.
 * Keep only a safe failure category; never retain Baileys log arguments or key material.
 */
export class AppStateResyncLogObserver {
  private readonly activeResyncs: ActiveResync[] = [];

  async capture<T>(collection: string, action: () => Promise<T>): Promise<AppStateResyncResult<T>> {
    const active: ActiveResync = { collection };
    this.activeResyncs.push(active);
    try {
      const value = await action();
      return active.failureKind
        ? { ok: false, reason: this.reasonFor(active.failureKind) }
        : { ok: true, value };
    } catch {
      return { ok: false, reason: "Baileys resync threw an error" };
    } finally {
      const index = this.activeResyncs.lastIndexOf(active);
      if (index >= 0) this.activeResyncs.splice(index, 1);
    }
  }

  observe(args: unknown[]): void {
    const strings = args.filter((value): value is string => typeof value === "string");
    const message = strings.join(" ").toLowerCase();
    if (!message) return;

    for (const active of this.activeResyncs) {
      const hasCollectionName =
        message.includes(active.collection.toLowerCase()) ||
        args.some(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "name" in value &&
            (value as { name?: unknown }).name === active.collection,
        );
      if (!hasCollectionName) continue;

      if (/blocked on missing key|missing key|failed to find key/.test(message)) {
        active.failureKind = "missing_key";
      } else if (/lthash|snapshot mac|patch mac/.test(message)) {
        active.failureKind = "hash_verification_failed";
      } else if (/failed to decode patch|skipping/.test(message)) {
        active.failureKind = "decode_failed";
      } else if (/failed to sync|giving up/.test(message)) {
        active.failureKind = "sync_failed";
      }
    }
  }

  private reasonFor(kind: FailureKind): string {
    switch (kind) {
      case "missing_key":
        return "Baileys reported a missing app-state key";
      case "sync_failed":
        return "Baileys reported that the collection failed to sync";
      case "hash_verification_failed":
        return "Baileys reported an app-state hash verification failure";
      case "decode_failed":
        return "Baileys reported an app-state patch decode failure";
    }
  }
}

/** Preserve the Pino logger interface while observing Baileys resync diagnostics. */
export function observeAppStateResyncLogs(
  logger: pino.Logger,
  observer: AppStateResyncLogObserver,
): pino.Logger {
  return new Proxy(logger, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (property === "child" && typeof value === "function") {
        return (...args: unknown[]) =>
          observeAppStateResyncLogs(value.apply(target, args) as pino.Logger, observer);
      }
      if (
        (property === "trace" ||
          property === "debug" ||
          property === "info" ||
          property === "warn" ||
          property === "error" ||
          property === "fatal") &&
        typeof value === "function"
      ) {
        return (...args: unknown[]) => {
          observer.observe(args);
          return value.apply(target, args);
        };
      }
      return value;
    },
  });
}
