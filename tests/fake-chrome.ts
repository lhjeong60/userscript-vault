type Store = Record<string, unknown>;

export function installFakeChrome(initial: Store = {}): { dump(): Store } {
  let store: Store = structuredClone(initial);

  const get = async (keys: null | string | string[]): Promise<Store> => {
    if (keys === null) return structuredClone(store);
    const list = typeof keys === "string" ? [keys] : keys;
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
  };
  const set = async (items: Store): Promise<void> => {
    store = { ...store, ...structuredClone(items) };
  };
  const remove = async (keys: string | string[]): Promise<void> => {
    const list = typeof keys === "string" ? [keys] : keys;
    store = Object.fromEntries(Object.entries(store).filter(([k]) => !list.includes(k)));
  };

  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { local: { get, set, remove } } };
  return { dump: () => structuredClone(store) };
}
