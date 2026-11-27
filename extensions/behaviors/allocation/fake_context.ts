/**
 * Test helper: a fake method context for SwampStore, shared by the store
 * and behavior tests.
 *
 * @module
 */

import type { DataHandleLike } from "./swamp_store.ts";

/** A fake datastore that numbers versions like Swamp: each write takes the next free number per name. */
export function fakeContext() {
  const data = new Map<string, Array<Record<string, unknown>>>();
  const write = (
    _spec: string,
    name: string,
    value: Record<string, unknown>,
  ): Promise<DataHandleLike> => {
    const versions = data.get(name) ?? [];
    versions.push(structuredClone(value));
    data.set(name, versions);
    return Promise.resolve({ name, version: versions.length });
  };
  return {
    data,
    ctx: {
      modelType: "@puddleworks/allocation",
      modelId: "m-1",
      dataRepository: {
        findByName: (_t: never, _id: string, name: string) => {
          const n = data.get(name)?.length ?? 0;
          return Promise.resolve(n ? { version: n } : null);
        },
      },
      readResource: (name: string, version?: number) => {
        const versions = data.get(name) ?? [];
        return Promise.resolve(
          versions[(version ?? versions.length) - 1] ?? null,
        );
      },
      writeResource: write,
    },
  };
}
