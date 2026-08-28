// Generic Supabase client double for the auth-bypass matrix (issue #80). A
// real per-handler chain mock (like tests/support/api-auth.ts's makeLookup
// pattern) does not scale to ~60 handlers with different query-chain shapes,
// so instead of asserting *how* a handler queried, this records *what
// strings reached the client* — good enough to prove a cross-tenant caller's
// victim-tenant ids never reach the DB layer, regardless of the exact chain.

// Property names that must NOT be turned into recording functions: they are
// probed by `await`, Jest's expect(), and other runtime machinery, and
// returning a function for them breaks thenable/matcher detection.
const RESERVED_NAMES = new Set([
  "then",
  "catch",
  "finally",
  "constructor",
  "toJSON",
  "nodeType",
  "$$typeof",
  "asymmetricMatch",
]);

export type RecordingSupabaseResult = {
  data?: unknown;
  error?: unknown;
  count?: number | null;
};

export type RecordingSupabase = {
  /** Pass this as the getSupabaseClient mock's return value. */
  client: unknown;
  /** Table names passed to .from(). */
  tables: string[];
  /** Function names passed to .rpc(). */
  rpcs: string[];
  /** Every string that reached the client as (or inside) an argument. */
  seenValues: string[];
  /** True once .from() or .rpc() has been called at least once. */
  readonly touched: boolean;
};

// Flattens an argument into `seenValues`: strings are pushed directly,
// arrays push each string element, plain objects push each string *value*
// (keys are ignored). Recurses at most 2 levels deep; everything else
// (numbers, booleans, null, undefined, functions) is ignored.
function flatten(value: unknown, seenValues: string[], depth: number): void {
  if (depth > 2) return;

  if (typeof value === "string") {
    seenValues.push(value);
    return;
  }

  if (Array.isArray(value)) {
    for (const el of value) flatten(el, seenValues, depth + 1);
    return;
  }

  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) flatten(v, seenValues, depth + 1);
  }
}

export function makeRecordingSupabase(result?: RecordingSupabaseResult): RecordingSupabase {
  const tables: string[] = [];
  const rpcs: string[] = [];
  const seenValues: string[] = [];
  const resolvedResult: RecordingSupabaseResult = result ?? { data: [], error: null, count: 0 };
  let touched = false;

  function makeRecorder(propName: string): (...args: unknown[]) => unknown {
    return (...args: unknown[]) => {
      for (const arg of args) flatten(arg, seenValues, 0);

      if (propName === "from") {
        touched = true;
        const [table] = args;
        if (typeof table === "string") tables.push(table);
      } else if (propName === "rpc") {
        touched = true;
        const [name] = args;
        if (typeof name === "string") rpcs.push(name);
      }

      return proxy;
    };
  }

  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (typeof prop === "symbol") return undefined;
        if (prop === "then") {
          return (
            resolve: (value: RecordingSupabaseResult) => unknown,
            reject?: (reason: unknown) => unknown,
          ) => Promise.resolve(resolvedResult).then(resolve, reject);
        }
        if (RESERVED_NAMES.has(prop)) return undefined;
        return makeRecorder(prop);
      },
    },
  );

  return {
    client: proxy,
    tables,
    rpcs,
    seenValues,
    get touched() {
      return touched;
    },
  };
}
