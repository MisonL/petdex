import { describe, expect, it } from "bun:test";

import { readResponseBodyBounded } from "@/lib/response-body";

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

describe("readResponseBodyBounded", () => {
  it("counts chunked bodies when content length is unavailable", async () => {
    const body = await readResponseBodyBounded(
      responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      4,
    );
    expect(body).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects a chunked body before retaining bytes over the limit", async () => {
    await expect(
      readResponseBodyBounded(
        responseFromChunks([new Uint8Array([1, 2]), new Uint8Array([3])]),
        2,
      ),
    ).rejects.toThrow("response body exceeds limit");
  });

  it("times out a body that stops producing chunks", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    await expect(
      readResponseBodyBounded(new Response(body), 4, 20),
    ).rejects.toThrow("response body read timed out");
  });
});
