import { describe, expect, test } from "bun:test";

import {
  formatRetiredCommand,
  RETIRED_COMMANDS,
} from "../src/retired-commands.js";

const VERSION = "1.2.2";
const DOWNLOAD_URL = "https://petdex.dev/download";

function normalizeCommand(output: string, command: string): string {
  return output.replace(`petdex ${command}`, "petdex <command>");
}

describe("retired command aliases", () => {
  test.each([
    ["start", "up"],
    ["restart", "up"],
    ["stop", "down"],
  ])("%s formats the same redirect as %s", (alias, canonical) => {
    expect(RETIRED_COMMANDS.has(alias)).toBe(true);
    expect(RETIRED_COMMANDS.has(canonical)).toBe(true);

    const actual = formatRetiredCommand(alias, VERSION, DOWNLOAD_URL);
    const expected = formatRetiredCommand(canonical, VERSION, DOWNLOAD_URL);

    expect(actual).not.toContain("Unknown command");
    expect(normalizeCommand(actual, alias)).toBe(
      normalizeCommand(expected, canonical),
    );
  });

  test("select points legacy users to the desktop app", () => {
    const result = formatRetiredCommand("select", VERSION, DOWNLOAD_URL);

    expect(result).not.toContain("Unknown command");
    expect(result).toContain("petdex select");
    expect(result).toContain("desktop app");
  });
});
