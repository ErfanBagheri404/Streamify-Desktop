// Assert-based self-check for electron/m3u.js — run: node electron/m3u.check.js
const assert = require("assert");
const { parseM3u, writeM3u } = require("./m3u.js");

// --- writeM3u: header, EXTINF, "Artist - Title", url line when present ---
const written = writeM3u({
  name: "My Mix",
  tracks: [
    { artist: "A Band", title: "Song One", duration: 121 },
    { artist: "", title: "No Artist", duration: 0 },
    { artist: "B", title: "A - Title with dash", duration: 59, url: "https://x/y.mp3" },
  ],
});
const lines = written.split("\n");
assert.ok(written.startsWith("#EXTM3U\n"), "must start with #EXTM3U");
assert.ok(written.endsWith("\n"), "trailing newline");
assert.strictEqual(lines[1], "#EXTINF:121,A Band - Song One");
assert.strictEqual(lines[2], "A Band - Song One", "no-url track falls back to display line");
assert.strictEqual(lines[3], "#EXTINF:0,No Artist");
assert.strictEqual(lines[4], "No Artist");
assert.strictEqual(lines[5], "#EXTINF:59,B - A - Title with dash");
assert.strictEqual(lines[6], "https://x/y.mp3", "track.url used as path line");
assert.strictEqual(writeM3u({ name: "Empty", tracks: [] }), "#EXTM3U\n");
assert.strictEqual(writeM3u({ name: "NoTracks" }), "#EXTM3U\n", "missing tracks guarded");

// --- parseM3u: CRLF, relative/absolute/backslash paths, comments, missing EXTINF ---
const input = [
  "#EXTM3U",
  "#EXTINF:121,A Band - Song One",
  "song one.mp3",
  "#EXTINF:45,Artist/With\\Slash - Title",
  "..\\music\\other.mp3",
  "",
  "# comment only",
  "#EXTINF:300,No Info",
  "C:\\Music\\abs.mp3",
  "no-extinf.mp3",
].join("\r\n");
const parsed = parseM3u(input, "C:/Base/List");
assert.strictEqual(parsed.entries.length, 4, "entries count: " + JSON.stringify(parsed.entries));
assert.strictEqual(parsed.warnings.length, 0, "no warnings: " + JSON.stringify(parsed.warnings));
assert.strictEqual(parsed.entries[0].path, "C:/Base/List/song one.mp3", "relative path resolved");
assert.strictEqual(parsed.entries[0].artist, "A Band");
assert.strictEqual(parsed.entries[0].title, "Song One");
assert.strictEqual(parsed.entries[0].duration, 121);
assert.strictEqual(parsed.entries[1].path, "C:/Base/music/other.mp3", "backslash relative path");
assert.strictEqual(parsed.entries[1].artist, "Artist/With\\Slash", "backslash kept inside metadata");
assert.strictEqual(parsed.entries[1].title, "Title");
assert.strictEqual(parsed.entries[1].duration, 45);
assert.strictEqual(parsed.entries[2].path, "C:/Music/abs.mp3", "absolute Windows path untouched");
assert.strictEqual(parsed.entries[2].title, "No Info");
assert.strictEqual(parsed.entries[2].duration, 300);
assert.strictEqual(parsed.entries[3].path, "C:/Base/List/no-extinf.mp3", "missing EXTINF still parsed");
assert.strictEqual(parsed.entries[3].title, undefined, "no EXTINF -> no title");

// ' - ' inside title: only first separator splits artist
const dash = parseM3u("#EXTM3U\n#EXTINF:100,X - A - B\nx.mp3", "D:/L");
assert.strictEqual(dash.entries[0].artist, "X");
assert.strictEqual(dash.entries[0].title, "A - B");

// url line is not resolved against baseDir
const urlOnly = parseM3u("#EXTM3U\n#EXTINF:10,R - T\nhttps://cdn/a.mp3", "D:/L");
assert.strictEqual(urlOnly.entries[0].path, "https://cdn/a.mp3");

// --- malformed input, guards, warnings ---
const junk = parseM3u("not a playlist\n#EXTINF:abc,Bad - Meta\n", "E:/L");
assert.strictEqual(junk.entries.length, 1, "path-less junk line becomes an entry");
assert.strictEqual(junk.entries[0].path, "E:/L/not a playlist");
assert.ok(
  junk.warnings.some((w) => /malformed/i.test(w)),
  "malformed EXTINF reported: " + JSON.stringify(junk.warnings)
);
const dangling = parseM3u("#EXTM3U\n#EXTINF:100,R - T", "E:/L");
assert.strictEqual(dangling.entries.length, 0, "EXTINF without path dropped");
assert.ok(dangling.warnings.some((w) => /without a following path/i.test(w)), "dangling warning");
assert.deepStrictEqual(parseM3u("", "E:/L"), { entries: [], warnings: [] }, "empty input");
assert.ok(parseM3u(null, "E:/L").entries.length === 0, "non-string input guarded");
const big = parseM3u("#EXTM3U\n" + "#EXTINF:1,a - b\nx.mp3\n".repeat(200000), "E:/L");
assert.ok(
  big.warnings.some((w) => /too large/i.test(w)),
  "oversize warning: " + JSON.stringify(big.warnings.slice(0, 3))
);
assert.ok(big.entries.length > 0, "oversize input still parses the first portion");

// --- round trip: write -> parse ---
const target = writeM3u({
  name: "Round Trip",
  tracks: [
    { artist: "R", title: "T", duration: 77, url: "https://cdn/a.mp3" },
    { artist: "R", title: "T2", duration: 88 },
  ],
});
const rt = parseM3u(target, "F:/Lists");
assert.strictEqual(rt.warnings.length, 0, JSON.stringify(rt.warnings));
assert.strictEqual(rt.entries.length, 2);
assert.strictEqual(rt.entries[0].artist, "R");
assert.strictEqual(rt.entries[0].title, "T");
assert.strictEqual(rt.entries[0].duration, 77);
assert.strictEqual(rt.entries[0].path, "https://cdn/a.mp3", "url line preserved");
assert.strictEqual(rt.entries[1].title, "T2");
assert.strictEqual(rt.entries[1].duration, 88);
assert.strictEqual(rt.entries[1].path, "F:/Lists/R - T2", "relative target resolved against baseDir");

console.log("m3u.check.js: all assertions passed");
