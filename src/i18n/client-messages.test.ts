import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  CLIENT_MESSAGE_PATHS,
  pickClientMessages,
} from "@/i18n/client-messages";
import en from "@/i18n/messages/en.json";
import es from "@/i18n/messages/es.json";
import zh from "@/i18n/messages/zh.json";

const messagesByLocale = { en, es, zh };

describe("client messages", () => {
  it("covers every literal client translation namespace", async () => {
    const paths = new Set(CLIENT_MESSAGE_PATHS);
    for (const namespace of await clientTranslationNamespaces()) {
      expect(paths.has(namespace)).toBe(true);
    }
  });

  it("keeps every picked namespace available in every locale", () => {
    for (const messages of Object.values(messagesByLocale)) {
      const picked = pickClientMessages(messages);
      for (const path of CLIENT_MESSAGE_PATHS) {
        expect(readPath(picked, path)).toBeDefined();
      }
    }
  });

  it("keeps server-only copy out of the client provider", () => {
    const fullBytes = Buffer.byteLength(JSON.stringify(en));
    const pickedBytes = Buffer.byteLength(
      JSON.stringify(pickClientMessages(en)),
    );

    expect(pickedBytes).toBeLessThan(fullBytes * 0.5);
  });
});

async function clientTranslationNamespaces(): Promise<string[]> {
  const namespaces = new Set<string>();
  const sources = await Promise.all(
    sourceFiles(join(process.cwd(), "src"))
      .filter(
        (file) => !file.endsWith(".test.ts") && !file.endsWith(".test.tsx"),
      )
      .map((file) => readFile(file, "utf8")),
  );

  for (const source of sources) {
    for (const match of source.matchAll(/useTranslations\("([^"]+)"\)/g)) {
      namespaces.add(match[1]);
    }
  }
  return [...namespaces].sort();
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(path));
    } else if (
      entry.isFile() &&
      (path.endsWith(".ts") || path.endsWith(".tsx"))
    ) {
      out.push(path);
    }
  }
  return out;
}

function readPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || !(part in cursor)) {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}
