const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cron = require("node-cron");

const CONFIG_PATH = path.join(__dirname, "config.json");
const LOG_FILE = path.join(__dirname, "fetcher.log");

let config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + "\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchM3U8(url) {
  log(`Fetching: ${url}`);
  const res = await axios.get(url, {
    timeout: 30000,
    responseType: "text",
    headers: { "User-Agent": config.userAgent }
  });
  return res.data;
}

function parseM3U8(content) {
  const lines = content.split("\n").map((l) => l.trim());
  const channels = [];
  let currentExtinf = "";

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      currentExtinf = line;
    } else if (line && !line.startsWith("#")) {
      const nameMatch = currentExtinf.match(/,([^,]+)$/);
      const name = nameMatch ? nameMatch[1].trim() : "";
      const logoMatch = currentExtinf.match(/tvg-logo="([^"]*)"/);
      const logo = logoMatch ? logoMatch[1] : "";
      const groupMatch = currentExtinf.match(/group-title="([^"]*)"/);
      const group = groupMatch ? groupMatch[1] : "";
      const tvgIdMatch = currentExtinf.match(/tvg-id="([^"]*)"/);
      const tvgId = tvgIdMatch ? tvgIdMatch[1] : "";

      const quality = name.match(/\((\d+p)\)/);
      const resolution = quality ? parseInt(quality[1]) : 0;

      channels.push({ name, url: line, logo, group, tvgId, resolution, raw: currentExtinf });
      currentExtinf = "";
    }
  }
  return channels;
}

function deduplicate(channels) {
  const seen = new Map();
  const unique = [];
  for (const ch of channels) {
    const key = ch.url.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, ch);
      unique.push(ch);
    } else {
      const existing = seen.get(key);
      if (ch.resolution > existing.resolution) {
        const idx = unique.indexOf(existing);
        unique[idx] = ch;
        seen.set(key, ch);
      }
    }
  }
  return unique;
}

function prioritize1080p(channels) {
  const best = new Map();
  for (const ch of channels) {
    const name = ch.name.replace(/\s*\(\d+p\)\s*$/, "").trim().toLowerCase();
    const existing = best.get(name);
    if (!existing || ch.resolution > existing.resolution) {
      best.set(name, ch);
    }
  }
  return Array.from(best.values());
}

function generateM3U8(channels) {
  let output = '#EXTM3U\n';
  for (const ch of channels) {
    const attrs = [];
    if (ch.tvgId) attrs.push(`tvg-id="${ch.tvgId}"`);
    if (ch.logo) attrs.push(`tvg-logo="${ch.logo}"`);
    if (ch.group) attrs.push(`group-title="${ch.group}"`);
    const attrStr = attrs.length ? " " + attrs.join(" ") : "";
    output += `#EXTINF:-1${attrStr},${ch.name}\n${ch.url}\n`;
  }
  return output;
}

async function runFetch() {
  log("===== BD Channels Fetch Started =====");
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch { }

  const allChannels = [];
  const sources = config.sources || [];

  for (const url of sources) {
    try {
      const content = await fetchM3U8(url);
      const channels = parseM3U8(content);
      log(`Parsed ${channels.length} channels from ${url}`);
      allChannels.push(...channels);
    } catch (e) {
      log(`Failed to fetch ${url}: ${e.message}`);
    }
  }

  const unique = deduplicate(allChannels);
  log(`After dedup: ${unique.length} channels`);

  let final;
  if (config.prefer1080p) {
    final = prioritize1080p(unique);
    log(`After 1080p prioritization: ${final.length} channels`);
  } else {
    final = unique;
  }

  const m3u8 = generateM3U8(final);
  const outputPath = path.join(__dirname, config.output || "bd_channels.m3u8");
  fs.writeFileSync(outputPath, m3u8, "utf8");
  log(`Saved ${final.length} channels to ${outputPath}`);
  log("===== BD Channels Fetch Finished =====");
}

if (process.argv.includes("--once")) {
  runFetch().catch((e) => log(`Error: ${e.message}`));
} else {
  runFetch().catch((e) => log(`Error: ${e.message}`));
  const interval = config.autoFetchInterval || 360;
  log(`Auto-fetch every ${interval} minutes (next run in ${interval} mins)`);
  cron.schedule(`*/${interval} * * * *`, () => {
    runFetch().catch((e) => log(`Error: ${e.message}`));
  });
}
