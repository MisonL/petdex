import { describe, expect, it } from "bun:test";

import {
  readResponseBodyBounded,
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
