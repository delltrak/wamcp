import type pino from "pino";

type FailureKind = "missing_key" | "sync_failed" | "hash_verification_failed" | "decode_failed";

interface ActiveResync {
  collection: string;
  failureKind?: FailureKind;
  abortOnFailure: boolean;
}

export type AppStateResyncResult<T> = { ok: true; value: T } | { ok: false; reason: string };

export interface AppStateResyncObservation {
  failureReason(): string | undefined;
  disarm(): void;
}

function hasWholeCollectionToken(message: string, collection: string): boolean {
  const escaped = collection.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}(?=$|[^\\w])`, "i").test(message);
}

/**
 * Baileys resyncAppState can log and return after it gives up or parks a collection.
 * Keep only a safe failure category; never retain Baileys log arguments or key material.
 */
export class AppStateResyncLogObserver {
  private readonly activeResyncs: ActiveResync[] = [];

  arm(collection: string, abortOnFailure = false): AppStateResyncObservation {
    const active: ActiveResync = { collection, abortOnFailure };
    this.activeResyncs.push(active);
    return {
      failureReason: () => (active.failureKind ? this.reasonFor(active.failureKind) : undefined),
      disarm: () => {
        const index = this.activeResyncs.lastIndexOf(active);
        if (index >= 0) this.activeResyncs.splice(index, 1);
      },
    };
  }

  async capture<T>(collection: string, action: () => Promise<T>): Promise<AppStateResyncResult<T>> {
    const observation = this.arm(collection);
    try {
      const value = await action();
      const failureReason = observation.failureReason();
      return failureReason ? { ok: false, reason: failureReason } : { ok: true, value };
    } catch {
      return { ok: false, reason: "Baileys resync threw an error" };
    } finally {
      observation.disarm();
    }
  }

  throwIfArmedFailure(): void {
    const active = [...this.activeResyncs]
      .reverse()
      .find((resync) => Boolean(resync.abortOnFailure && resync.failureKind));
    if (active?.failureKind) {
      throw new Error(this.reasonFor(active.failureKind));
    }
  }

  observe(args: unknown[]): void {
    const strings = args.filter((value): value is string => typeof value === "string");
    const message = strings.join(" ").toLowerCase();
    if (!message) return;

    for (const active of this.activeResyncs) {
      const hasCollectionName =
        strings.some((value) => hasWholeCollectionToken(value, active.collection)) ||
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
          const result = value.apply(target, args);
          observer.throwIfArmedFailure();
          return result;
        };
      }
      return value;
    },
  });
}
