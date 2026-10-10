// The slash-command schema is the only place a caller's option is bounded
// before it reaches a handler. `/collection` interpolates its slug into a
// channel message, and Discord rejects content over 2000 chars — an
// unbounded slug made the reply itself throw, which (before the error
// listener in bot.ts) killed the process.
import { describe, expect, it } from "bun:test";

import { commandData } from "./commands.js";

describe("slash command options", () => {
  it("bounds every slug option so a long value cannot overflow the reply", () => {
    const withSlug = commandData.filter((c) =>
      (c.options ?? []).some((o) => o.name === "slug"),
    );
    expect(withSlug.length).toBeGreaterThan(0);
    for (const cmd of withSlug) {
      const slug = (cmd.options ?? []).find((o) => o.name === "slug") as
        | { max_length?: number }
        | undefined;
      expect(slug?.max_length, cmd.name).toBe(100);
    }
  });
});
