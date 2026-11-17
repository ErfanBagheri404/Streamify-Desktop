// Minimal M3U/M3U8 parser + writer for the desktop app. No dependencies.
// The renderer matches EXTINF artist/title metadata against its local library,
// so we only need duration, artist, title and the path/url line.
const path = require("path");

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB cap
const MAX_ENTRIES = 200000;

function parseM3u(text, baseDir) {
  const warnings = [];
  const entries = [];

  if (typeof text !== "string") {
    warnings.push("Invalid input: expected string");
    return { entries, warnings };
  }

  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    warnings.push("File too large; only the first portion was parsed");
    text = text.slice(0, MAX_FILE_BYTES);
  }

  const lines = text.split(/\r?\n/);
  let pendingInfo = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF:")) {
      // Duration ends at the first comma outside a quoted attribute value, so
      // `tvg-name="A,B"` doesn't split the metadata in half.
      const body = line.slice("#EXTINF:".length);
      let comma = -1;
      let quoted = false;
      for (let c = 0; c < body.length; c++) {
        const ch = body[c];
        if (ch === '"') quoted = !quoted;
        else if (ch === "," && !quoted) {
          comma = c;
          break;
        }
      }
      const duration = comma >= 0 ? parseFloat(body.slice(0, comma)) : NaN;
      if (!Number.isFinite(duration)) {
        warnings.push(`Line ${i + 1}: malformed EXTINF`);
        continue;
      }
      const info = comma >= 0 ? body.slice(comma + 1).trim() : "";
      let artist;
      let title = info;
      const sep = info.indexOf(" - ");
      if (sep > 0) {
        artist = info.slice(0, sep).trim();
        title = info.slice(sep + 3).trim();
      }
      pendingInfo = {
        duration: Number.isFinite(duration) ? duration : undefined,
        artist,
        title,
      };
      continue;
    }

    if (line.startsWith("#")) {
      // Comment / other directive; ignore.
      continue;
    }

    // Path or URL line.
    let p = line.replace(/\\/g, "/");
    if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(p) && !path.isAbsolute(p) && baseDir) {
      p = path.resolve(baseDir, p).replace(/\\/g, "/");
    }

    const entry = { path: p };
    if (pendingInfo) {
      if (pendingInfo.duration !== undefined) entry.duration = pendingInfo.duration;
      if (pendingInfo.artist) entry.artist = pendingInfo.artist;
      if (pendingInfo.title) entry.title = pendingInfo.title;
      pendingInfo = null;
    }
    entries.push(entry);
    if (entries.length >= MAX_ENTRIES) {
      warnings.push("Entry limit reached; remaining lines were ignored");
      break;
    }
  }

  if (pendingInfo) {
    warnings.push("EXTINF line without a following path");
  }

  return { entries, warnings };
}

function writeM3u({ name, tracks }) {
  const lines = ["#EXTM3U"];
  const list = Array.isArray(tracks) ? tracks : [];

  for (const track of list) {
    const artist = track.artist ? String(track.artist).trim() : "";
    const title = track.title ? String(track.title).trim() : "";
    const display = artist ? `${artist} - ${title}` : title;
    const duration = Number.isFinite(track.duration) ? Math.round(track.duration) : -1;
    lines.push(`#EXTINF:${duration},${display}`);
    // Path/url line. Use the track URL when present so the playlist stays playable.
    const target = track.url || track.audioUrl || display || name || "";
    lines.push(target);
  }

  return lines.join("\n") + "\n";
}

module.exports = { parseM3u, writeM3u };
