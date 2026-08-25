import { describe, expect, it } from "bun:test";

import {
  parseCompactManifest,
  parseLegacyManifest,
  readResponseBodyBounded,
  resolveManifestAsset,
  summarizeAtlasPixels,
} from "./audit-pet-atlases";

function responseFromChunks(chunks: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  );
}

describe("bounded asset reads", () => {
  it("reads chunked bodies up to the configured limit", async () => {
    const body = await readResponseBodyBounded(
      responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      4,
    );
    expect(body).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects a chunked body as soon as it exceeds the limit", async () => {
    await expect(
      readResponseBodyBounded(
        responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3])]),
        2,
      ),
    ).rejects.toThrow("asset exceeds audit limit");
  });

  it("cancels a body that stops producing chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    await expect(
      readResponseBodyBounded(new Response(body), 4, 20),
    ).rejects.toThrow("asset read timed out");
  });
});

describe("atlas audit geometry", () => {
  it("counts expected classic cells without treating unused columns as errors", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 1872 * 4);
    const offset = (3 * 208 * width + 10 * width + 2 * 192 + 10) * 4;
    data[offset + 3] = 255;
    const result = summarizeAtlasPixels(data, width, 1);
    expect(result.expectedFrames).toBe(57);
    expect(result.emptyFrames).toBe(56);
    expect(result.touchingFrames).toBe(0);
  });

  it("includes both additional v2 direction rows", () => {
    const width = 1536;
    const data = Buffer.alloc(width * 2288 * 4);
    const offset = (10 * 208 * width + 7 * 192 + 10) * 4;
    data[offset + 3] = 255;
    const result = summarizeAtlasPixels(data, width, 2);
    expect(result.expectedFrames).toBe(73);
    expect(result.emptyFrames).toBe(72);
  });
});

describe("manifest parsing", () => {
  it("parses the compact v2 manifest and resolves relative assets", () => {
    const pets = parseCompactManifest({
      assetBase: "https://assets.petdex.dev",
      pets: [
        [
          "demo",
          "Demo",
          "character",
          null,
          "pets/demo/sprite.webp",
          "pets/demo/pet.json",
          null,
          2,
        ],
      ],
    });
    expect(pets).toEqual([
      {
        slug: "demo",
        approvedAt: null,
        spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        spriteVersionNumber: 2,
      },
    ]);
  });

  it("keeps the legacy manifest fallback strict and host-bound", () => {
    const pets = parseLegacyManifest({
      pets: [
        {
          slug: "demo",
          spritesheetUrl: "https://assets.petdex.dev/pets/demo/sprite.webp",
        },
      ],
    });
    expect(pets[0]?.spriteVersionNumber).toBe(1);
    expect(() =>
      resolveManifestAsset(undefined, "https://example.test/sprite.webp"),
    ).toThrow("untrusted spritesheet host");
  });

  it("rejects malformed compact entries instead of defaulting their version", () => {
    expect(() =>
      parseCompactManifest({
        assetBase: "https://assets.petdex.dev",
        pets: [["demo", "Demo", "character", null, "pets/demo/sprite.webp"]],
      }),
    ).toThrow("invalid compact manifest pet");
  });
});
