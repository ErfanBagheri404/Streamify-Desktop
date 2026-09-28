import { describe, it, expect } from "vitest";
import {
  pickAudioFormatUrl,
  pickThumbnailUrl,
} from "../src/routes/ytdlp-pick";
import { parseYtDlpJson, toYtDlpResult, findYtDlpBinary } from "../src/routes/ytdlp";

describe("pickAudioFormatUrl", () => {
  it("prefers m4a over opus/webm", () => {
    const url = pickAudioFormatUrl([
      { url: "a.webm", ext: "webm", vcodec: "none", abr: 160 },
      { url: "b.m4a", ext: "m4a", vcodec: "none", abr: 128 },
    ]);
    expect(url).toBe("b.m4a");
  });

  it("falls back to webm, then highest bitrate", () => {
    expect(
      pickAudioFormatUrl([
        { url: "a.webm", ext: "webm", vcodec: "none", abr: 160 },
      ])
    ).toBe("a.webm");
    expect(
      pickAudioFormatUrl([
        { url: "a.webm", ext: "webm", vcodec: "none", abr: 100 },
        { url: "b.webm", ext: "webm", vcodec: "none", abr: 220 },
      ])
    ).toBe("b.webm");
  });

  it("ignores video formats and entries without a url", () => {
    expect(
      pickAudioFormatUrl([
        { url: "v.mp4", ext: "mp4", vcodec: "h264", abr: 300 },
        { ext: "m4a", vcodec: "none", abr: 128 },
      ])
    ).toBeNull();
  });

  it("returns null for missing formats", () => {
    expect(pickAudioFormatUrl(undefined)).toBeNull();
    expect(pickAudioFormatUrl([])).toBeNull();
  });

  it("uses tbr when abr is absent", () => {
    expect(
      pickAudioFormatUrl([
        { url: "a.m4a", ext: "m4a", vcodec: "none", tbr: 90 },
        { url: "b.m4a", ext: "m4a", vcodec: "none", tbr: 190 },
      ])
    ).toBe("b.m4a");
  });
});

describe("pickThumbnailUrl", () => {
  it("prefers the direct thumbnail field", () => {
    expect(
      pickThumbnailUrl({ thumbnail: "https://x/t.jpg", thumbnails: [{ url: "y" }] })
    ).toBe("https://x/t.jpg");
  });

  it("takes the largest entry of the thumbnails list", () => {
    expect(
      pickThumbnailUrl({ thumbnails: [{ url: "small" }, { url: "large" }] })
    ).toBe("large");
  });

  it("returns empty string when nothing is available", () => {
    expect(pickThumbnailUrl({})).toBe("");
  });
});

describe("findYtDlpBinary", () => {
  const realResources = (process as any).resourcesPath;
  const realEnv = process.env.STREAMIFY_YTDLP_PATH;
  const restore = () => {
    if (realResources === undefined) delete (process as any).resourcesPath;
    else (process as any).resourcesPath = realResources;
    if (realEnv === undefined) delete process.env.STREAMIFY_YTDLP_PATH;
    else process.env.STREAMIFY_YTDLP_PATH = realEnv;
  };

  it("prefers an explicit override", () => {
    process.env.STREAMIFY_YTDLP_PATH = "/custom/yt-dlp";
    (process as any).resourcesPath = "/app/resources";
    expect(findYtDlpBinary()).toBe("/custom/yt-dlp");
    restore();
  });

  it("resolves the packaged location under resourcesPath", () => {
    delete process.env.STREAMIFY_YTDLP_PATH;
    (process as any).resourcesPath = "/app/resources";
    const found = findYtDlpBinary();
    expect(found).toContain("/app/resources");
    expect(found).toContain("bin");
    expect(found.endsWith(".exe")).toBe(process.platform === "win32");
    restore();
  });

  it("falls back to the repo resources dir when not packaged", () => {
    delete process.env.STREAMIFY_YTDLP_PATH;
    delete (process as any).resourcesPath;
    const found = findYtDlpBinary();
    expect(found).toContain(`resources${"/"}bin`);
    restore();
  });
});

describe("parseYtDlpJson", () => {
  it("parses a plain JSON dump", () => {
    expect(parseYtDlpJson('{"id":"abc","title":"T"}')?.id).toBe("abc");
  });

  it("parses the last JSON line of a noisy dump", () => {
    const out = "WARNING: something\nERROR: line\n{\"id\":\"xyz\",\"title\":\"T\"}";
    expect(parseYtDlpJson(out)?.id).toBe("xyz");
  });

  it("returns null for garbage", () => {
    expect(parseYtDlpJson("")).toBeNull();
    expect(parseYtDlpJson("not json at all")).toBeNull();
  });
});

describe("toYtDlpResult", () => {
  it("maps metadata into the provider result shape", () => {
    const result = toYtDlpResult(
      "vid",
      {
        id: "vid",
        title: "Song",
        uploader: "Artist",
        duration: 210,
        thumbnail: "https://x/t.jpg",
        formats: [{ url: "s.m4a", ext: "m4a", vcodec: "none", abr: 128 }],
      },
      "youtube"
    );
    expect(result).toMatchObject({
      id: "vid",
      title: "Song",
      author: "Artist",
      lengthSeconds: 210,
      streamUrl: "s.m4a",
      source: "youtube",
    });
  });

  it("falls back to channel when uploader is absent", () => {
    const result = toYtDlpResult(
      "v",
      { title: "S", channel: "Chan", formats: [{ url: "s", vcodec: "none" }] },
      "youtube"
    );
    expect(result?.author).toBe("Chan");
  });

  it("returns null when no audio format is playable", () => {
    expect(
      toYtDlpResult("v", { title: "S", formats: [] }, "youtube")
    ).toBeNull();
    expect(toYtDlpResult("v", null, "youtube")).toBeNull();
  });
});
