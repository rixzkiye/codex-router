import { describe, expect, it, vi } from "vitest";
import { VisionBridge } from "../src/platform/vision.js";

const image = `data:image/png;base64,${Buffer.from("fixture").toString("base64")}`;

describe("governed vision bridge", () => {
  it("transcribes and deduplicates repeated images without changing native modality truth", async () => {
    const describe = vi.fn(async () => "A terminal showing a TypeScript error.");
    const bridge = new VisionBridge({ enabled: true, maxDataUrlBytes: 1024, allowedRemoteHosts: [], fallback: false, cacheEntries: 8 }, [
      { id: "vision-a", source: "registry", modelId: "vision-model", describe }
    ]);
    const result = await bridge.apply({ input: [{ role: "user", content: [
      { type: "input_image", image_url: image },
      { type: "input_image", image_url: image }
    ] }] });
    expect(result).toMatchObject({ imagesObserved: 2, imagesBridged: 2, deduplicated: 1, engineId: "vision-a" });
    expect(describe).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.input)).toContain("Image transcript via vision bridge");
  });

  it("coalesces concurrent requests and records explicit fallback", async () => {
    const first = vi.fn(async () => { throw new Error("offline"); });
    const second = vi.fn(async () => "Fallback transcript");
    const bridge = new VisionBridge({ enabled: true, maxDataUrlBytes: 1024, allowedRemoteHosts: [], fallback: true, cacheEntries: 8 }, [
      { id: "primary", source: "local", modelId: "local", describe: first },
      { id: "fallback", source: "native", modelId: "native", describe: second }
    ]);
    const request = { input: [{ type: "input_image", image_url: image }] };
    const [left, right] = await Promise.all([bridge.apply(request), bridge.apply(request)]);
    expect(left.fallbackCount + right.fallbackCount).toBeGreaterThan(0);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unconfigured, oversized, and non-allowlisted images", async () => {
    const disabled = new VisionBridge({ enabled: false, maxDataUrlBytes: 1, allowedRemoteHosts: [], fallback: false, cacheEntries: 1 }, []);
    await expect(disabled.apply({ input: [{ type: "input_image", image_url: image }] })).rejects.toThrow(/configured/);
    const bridge = new VisionBridge({ enabled: true, maxDataUrlBytes: 1, allowedRemoteHosts: [], fallback: false, cacheEntries: 1 }, [
      { id: "a", source: "local", modelId: "a", describe: async () => "x" }
    ]);
    await expect(bridge.apply({ input: [{ type: "input_image", image_url: image }] })).rejects.toThrow(/byte limit/);
    await expect(bridge.apply({ input: [{ type: "input_image", image_url: "https://169.254.169.254/latest/meta-data" }] })).rejects.toThrow(/allowlisted/);
  });
});
