import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
const baseline = config.app.security.csp;
// Execute the actual checker with only its config read and process/console outputs replaced.
const checker = readFileSync("scripts/check-csp.mjs", "utf8").replace(/^import .*?;\r?\n/u, "");
const policies = new Map(
  baseline.split(";").map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/u);
    return [name, sources];
  }),
);
const names = [...policies.keys(), "script-src"];
const sourcesFor = (name) => policies.get(name) ?? ["'self'"];
const serialize = (directives) =>
  [...directives].map(([name, sources]) => [name, ...sources].join(" ")).join("; ");
const mutate = (name, sources) => serialize(new Map(policies).set(name, sources));

function check(csp) {
  const stop = Symbol("checker exit");
  let status = 0;
  const messages = [];
  try {
    runInNewContext(checker, {
      readFileSync: () => JSON.stringify({ app: { security: { csp } } }),
      console: { log() {}, error: (message) => messages.push(message) },
      process: {
        exit(code) {
          status = code;
          throw stop;
        },
      },
    });
  } catch (error) {
    if (error !== stop) throw error;
  }
  return { status, messages };
}

describe("production CSP checker", () => {
  it("accepts the unchanged production policy and its protocol/blob/data allowances", () => {
    expect(check(baseline).status).toBe(0);
  });

  it("accepts an explicit script-src with the same self-only fallback", () => {
    expect(check(mutate("script-src", ["'self'"])).status).toBe(0);
  });

  it("accepts reordered directives/sources and a trailing separator", () => {
    const reversed = [...policies]
      .reverse()
      .map(([name, sources]) => [name, [...sources].reverse()]);
    expect(check(`${serialize(reversed)};`).status).toBe(0);
  });

  it("matches directive names without case sensitivity", () => {
    const uppercase = [...policies].map(([name, sources]) => [name.toUpperCase(), sources]);
    expect(check(serialize(uppercase)).status).toBe(0);
  });

  it.each([undefined, null, [], {}])("refuses a non-string policy (%j)", (csp) => {
    expect(check(csp).status).toBe(1);
  });

  it("refuses an unapproved directive", () => {
    expect(check(`${baseline}; worker-src 'self'`).status).toBe(1);
  });

  it.each([...policies.keys()])("requires the production %s directive", (name) => {
    const missing = new Map(policies);
    missing.delete(name);
    expect(check(serialize(missing)).status).toBe(1);
  });

  it.each(names)("refuses a named external host in %s", (name) => {
    expect(check(mutate(name, [...sourcesFor(name), "https://unapproved.example"])).status).toBe(1);
  });

  it.each(names)("refuses a wildcard in %s", (name) => {
    expect(check(mutate(name, [...sourcesFor(name), "*"])).status).toBe(1);
  });

  it.each(names.flatMap((name) => sourcesFor(name).map((source) => [name, source])))(
    "requires the approved %s source %s",
    (name, source) => {
      expect(
        check(
          mutate(
            name,
            sourcesFor(name).filter((item) => item !== source),
          ),
        ).status,
      ).toBe(1);
    },
  );

  it.each(names)("rejects duplicate %s directives in both orders and across case", (name) => {
    const base = mutate(name, sourcesFor(name));
    for (const csp of [
      `${name} https://unapproved.example; ${base}`,
      `${base}; ${name} https://unapproved.example`,
      `${base}; ${name.toUpperCase()} ${sourcesFor(name).join(" ")}`,
    ]) {
      const result = check(csp);
      expect(result.status).toBe(1);
      expect(result.messages.join(" ")).toMatch(/duplicate/iu);
    }
  });

  it("refuses repeated tokens in an exact source list", () => {
    expect(check(mutate("default-src", ["'self'", "'self'"])).status).toBe(1);
  });
});
