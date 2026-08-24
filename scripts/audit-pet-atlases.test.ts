import { describe, expect, it } from "bun:test";

import { summarizeAtlasPixels } from "./audit-pet-atlases";

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
