import { describe, expect, it, vi } from "vitest";
import { normalizeBackground, ReaderBackgroundStore } from "./backgroundResource";

const first = {
  revision: "11111111-1111-4111-8111-111111111111",
  url: "http://komori-background.localhost/11111111-1111-4111-8111-111111111111",
};
const second = {
  revision: "22222222-2222-4222-8222-222222222222",
  url: "http://komori-background.localhost/22222222-2222-4222-8222-222222222222",
};
describe("Reader managed backgrounds", () => {
  it("accepts only exact owned revision URLs, never paths, foreign hosts, queries or CSS", () => {
    expect(normalizeBackground(first)).toEqual(first);
    expect(
      normalizeBackground({
        ...first,
        url: `komori-background://localhost/${first.revision}`,
        sourcePath: "private",
      }),
    ).toEqual({ ...first, url: `komori-background://localhost/${first.revision}` });
    for (const url of [
      "C:/private.png",
      "https://example.com/image",
      `${first.url}?file=private`,
      `${first.url}/other`,
      "url(javascript:alert(1))",
      "http://komori-background.localhost.evil/" + first.revision,
    ]) {
      expect(() => normalizeBackground({ ...first, url })).toThrow();
    }
    expect(normalizeBackground(null)).toBeNull();
    expect(() => normalizeBackground({ ...first, revision: "../private" })).toThrow();
  });
  it("loads, retains on picker cancel/invalid response/failure, replaces and removes atomically", async () => {
    const api = {
      get: vi.fn(async () => first),
      choose: vi.fn<() => Promise<unknown>>(async () => null),
      remove: vi.fn(async () => {}),
    };
    const store = new ReaderBackgroundStore(api);
    const observer = vi.fn();
    const unsubscribe = store.subscribe(observer);
    await store.load();
    await store.change("choose");
    expect(store.snapshot().image).toEqual(first);
    api.choose.mockResolvedValueOnce({ ...first, url: "file:///private" });
    await store.change("choose");
    expect(store.snapshot().image).toEqual(first);
    expect(store.snapshot().error).not.toContain("private");
    api.choose.mockRejectedValueOnce(Error("secret filesystem path"));
    await store.change("choose");
    expect(store.snapshot().image).toEqual(first);
    api.choose.mockResolvedValueOnce(second);
    await store.change("choose");
    expect(store.snapshot().image).toEqual(second);
    api.remove.mockRejectedValueOnce(Error("private"));
    await store.change("remove");
    expect(store.snapshot().image).toEqual(second);
    await store.change("remove");
    expect(store.snapshot()).toMatchObject({ image: null, error: null, pending: null });
    unsubscribe();
    observer.mockClear();
    await store.load();
    expect(observer).not.toHaveBeenCalled();
  });
  it("serializes across panel lifetimes and rejects obsolete image errors while retrying the same revision", async () => {
    let resolve!: (image: unknown) => void;
    const api = {
      get: vi.fn(async () => first),
      choose: vi.fn(
        () =>
          new Promise<unknown>((done) => {
            resolve = done;
          }),
      ),
      remove: vi.fn(async () => {}),
    };
    const store = new ReaderBackgroundStore(api);
    await store.load();
    const previous = store.snapshot().attempt;
    const pending = store.change("choose");
    await store.load();
    await store.change("remove");
    expect(api.get).toHaveBeenCalledOnce();
    expect(api.remove).not.toHaveBeenCalled();
    resolve(second);
    await pending;
    store.failed(first.revision, previous);
    expect(store.snapshot().imageFailed).toBe(false);
    store.failed(second.revision, store.snapshot().attempt);
    expect(store.snapshot().imageFailed).toBe(true);
    const attempt = store.snapshot().attempt;
    api.get.mockResolvedValueOnce(second);
    await store.load();
    store.failed(second.revision, attempt);
    expect(store.snapshot()).toMatchObject({ imageFailed: false, error: null });
  });
  it("keeps load failures retryable and hides native details", async () => {
    const get = vi.fn().mockRejectedValueOnce(Error("private path")).mockResolvedValueOnce(first);
    const store = new ReaderBackgroundStore({
      get,
      choose: async () => null,
      remove: async () => {},
    });
    await store.load();
    expect(store.snapshot()).toMatchObject({ loaded: true, pending: null, image: null });
    expect(store.snapshot().error).not.toContain("private path");
    await store.load();
    expect(store.snapshot()).toMatchObject({ image: first, error: null });
  });
});
