const fs = require("fs/promises");
const path = require("path");

const INPUT_PATH = process.argv[2] || "./kyuchek.yaml";
const OUTPUT_PATH = process.argv[3] || "./kyuchek.valid.yaml";
const REQUEST_TIMEOUT_MS = 10000;
const SEARCH_CANDIDATE_LIMIT = 15;
const SEARCH_QUERY_LIMIT = 8;
const SEARCH_QUERY_CONCURRENCY = 4;
const VALIDATION_CONCURRENCY = 6;
const METADATA_CONCURRENCY = 3;
const videoMetadataCache = new Map();

async function main() {
  const inputAbs = path.resolve(INPUT_PATH);
  const outputAbs = path.resolve(OUTPUT_PATH);

  const source = await fs.readFile(inputAbs, "utf8");
  const lines = source.split(/\r?\n/);
  const outLines = [];

  const stats = {
    total: 0,
    kept: 0,
    replaced: 0,
    dropped: 0,
    nonYoutube: 0,
    commentsKept: 0,
  };

  const totalLines = lines.filter(
    (l) => parseYamlListVideoLine(l) && !isCommentLine(l),
  ).length;
  process.stdout.write(`Scanning ${totalLines} video entries...\n`);

  for (const line of lines) {
    if (isCommentLine(line)) {
      outLines.push(line);
      stats.commentsKept += 1;
      continue;
    }

    const parsed = parseYamlListVideoLine(line);
    if (!parsed) {
      outLines.push(line);
      continue;
    }

    if (parsed.isThumbLine) {
      outLines.push(line);
      continue;
    }

    stats.total += 1;
    const progress = `[${stats.total}/${totalLines}]`;

    if (!isYouTubeUrl(parsed.url)) {
      console.log(`${progress} SKIP (non-YouTube) ${parsed.url}`);
      stats.nonYoutube += 1;
      stats.dropped += 1;
      outLines.push(commentOutYamlLine(line));
      continue;
    }

    process.stdout.write(
      `${progress} Checking: ${parsed.title || parsed.url} ... `,
    );
    const validity = await validateYouTubeUrl(parsed.url);
    if (validity.ok) {
      process.stdout.write("OK\n");
      outLines.push(line);
      stats.kept += 1;
      continue;
    }

    process.stdout.write(`INVALID (${validity.reason})\n`);
    process.stdout.write(
      `${progress} Searching replacement for: ${parsed.title || "(no title)"} ... `,
    );
    const replacement = await findReplacement(parsed);
    if (replacement) {
      process.stdout.write(
        `FOUND (score=${replacement.score.toFixed(2)}) -> ${replacement.url}\n`,
      );
      outLines.push(buildYamlVideoLine(parsed, replacement.url));
      stats.replaced += 1;
      continue;
    }

    process.stdout.write("NOT FOUND - commenting out\n");
    stats.dropped += 1;
    outLines.push(commentOutYamlLine(line));
  }

  await fs.writeFile(outputAbs, `${outLines.join("\n")}\n`);

  console.log("Validation complete");
  console.log(`Input:  ${inputAbs}`);
  console.log(`Output: ${outputAbs}`);
  console.log(`Total videos checked: ${stats.total}`);
  console.log(`Kept: ${stats.kept}`);
  console.log(`Replaced: ${stats.replaced}`);
  console.log(`Dropped: ${stats.dropped}`);
  console.log(`Dropped non-YouTube: ${stats.nonYoutube}`);
  console.log(`Comments preserved: ${stats.commentsKept}`);
}

function isCommentLine(line) {
  return /^\s*#/.test(line);
}

function commentOutYamlLine(line) {
  if (isCommentLine(line)) return line;
  const m = line.match(/^(\s*)(.*)$/);
  if (!m) return `# ${line}`;
  return `${m[1]}# ${m[2]}`;
}

function parseYamlListVideoLine(line) {
  const m = line.match(/^(\s*)-\s+(.*)$/);
  if (!m) return null;

  const indent = m[1];
  const body = m[2];

  if (!body || body.startsWith("#")) return null;

  const thumbMatch = body.match(/^thumb\s*:\s*(.+?)\s*$/);
  if (thumbMatch) {
    return {
      isThumbLine: true,
      indent,
      title: "thumb",
      url: stripWrappingQuotes(thumbMatch[1]),
      originalLine: line,
    };
  }

  // Handle plain URL entries before key:value parsing (because https:// includes a colon).
  const bareUrlMatch = body.match(/^(https?:\/\/\S+)/i);
  if (bareUrlMatch) {
    return {
      isThumbLine: false,
      indent,
      title: "",
      url: stripWrappingQuotes(bareUrlMatch[1]),
      originalLine: line,
    };
  }

  const keyedMatch = body.match(/^(.*?)\s*:\s*(https?:\/\/\S+)/i);
  if (!keyedMatch) return null;

  const title = keyedMatch[1].trim();
  const url = stripWrappingQuotes(keyedMatch[2].trim());

  return {
    isThumbLine: false,
    indent,
    title,
    url,
    originalLine: line,
  };
}

function buildYamlVideoLine(parsed, newUrl) {
  const clean = newUrl.trim();
  if (!parsed.title) return `${parsed.indent}- ${clean}`;
  return `${parsed.indent}- ${parsed.title}: ${clean}`;
}

function stripWrappingQuotes(value) {
  const t = value.trim();
  if (
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"'))
  ) {
    return t.slice(1, -1).trim();
  }
  return t;
}

function looksLikeUrl(value) {
  return /^(https?:\/\/)/i.test(value);
}

function isYouTubeUrl(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
    return host === "youtube.com" || host === "youtu.be";
  } catch {
    return false;
  }
}

function extractVideoId(raw) {
  try {
    const u = new URL(raw);
    const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");

    if (host === "youtu.be") {
      const id = u.pathname.replace(/^\//, "").trim();
      return isValidVideoId(id) ? id : null;
    }

    if (host === "youtube.com") {
      if (u.pathname === "/watch") {
        const id = u.searchParams.get("v");
        return isValidVideoId(id) ? id : null;
      }
      if (u.pathname.startsWith("/embed/")) {
        const id = u.pathname.split("/")[2];
        return isValidVideoId(id) ? id : null;
      }
      if (u.pathname.startsWith("/shorts/")) {
        const id = u.pathname.split("/")[2];
        return isValidVideoId(id) ? id : null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function isValidVideoId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

async function validateYouTubeUrl(url) {
  return validateYouTubeUrlWithOptions(url, {
    includePublishDate: false,
    checkAgeRestricted: true,
  });
}

async function validateYouTubeUrlWithOptions(url, options) {
  const id = extractVideoId(url);
  if (!id) return { ok: false, reason: "invalid-id" };

  const watchUrl = `https://www.youtube.com/watch?v=${id}`;
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;

  const response = await fetchWithTimeout(endpoint);
  if (!response.ok) return { ok: false, reason: `oembed-${response.status}` };
  const data = await safeJson(response);

  const checkAgeRestricted = !options || options.checkAgeRestricted !== false;

  const needsMetadata =
    options &&
    (options.includePublishDate ||
      options.includeViewCount ||
      options.includeLikes);
  const metadata =
    checkAgeRestricted || needsMetadata
      ? await getWatchMetadata(id, watchUrl)
      : {
          publishDate: null,
          viewCount: null,
          likeCount: null,
          ageRestricted: false,
        };
  if (metadata.ageRestricted) return { ok: false, reason: "age-restricted" };
  const publishDate =
    options && options.includePublishDate ? metadata.publishDate : null;
  const viewCount =
    options && options.includeViewCount ? metadata.viewCount : null;
  const likeCount = options && options.includeLikes ? metadata.likeCount : null;

  return {
    ok: true,
    id,
    url: watchUrl,
    title: data && data.title ? data.title : "",
    publishDate,
    ageScore: computeAgeScore(publishDate),
    viewCount,
    viewsScore: computeViewsScore(viewCount),
    likeCount,
    likesScore: computeLikesScore(likeCount),
  };
}

async function getWatchMetadata(id, watchUrl) {
  if (videoMetadataCache.has(id)) return videoMetadataCache.get(id);

  const metadata = await fetchWatchMetadata(watchUrl);
  videoMetadataCache.set(id, metadata);
  return metadata;
}

async function fetchWatchMetadata(watchUrl) {
  const response = await fetchWithTimeout(watchUrl);
  if (!response.ok)
    return {
      publishDate: null,
      viewCount: null,
      likeCount: null,
      ageRestricted: false,
    };

  const html = await response.text();
  if (!html)
    return {
      publishDate: null,
      viewCount: null,
      likeCount: null,
      ageRestricted: false,
    };

  const publishDate =
    extractPublishDateFromLdJson(html) ||
    extractPublishDateFromMeta(html) ||
    null;
  const viewCount =
    extractViewCountFromLdJson(html) ??
    extractViewCountFromVideoDetails(html) ??
    null;
  const likeCount =
    extractLikesFromLdJson(html) ?? extractLikesFromVideoDetails(html) ?? null;
  const ageRestricted = isAgeRestrictedHtml(html);

  return { publishDate, viewCount, likeCount, ageRestricted };
}

async function findReplacement(entry) {
  const queries = buildSearchQueries(entry).slice(0, SEARCH_QUERY_LIMIT);
  if (!queries.length) return null;

  const originalNorm = normalizeText(entry.title || "");

  // Pass 1: fetch all search result pages in parallel, then validate candidates
  // via oEmbed in parallel. Score by text only — no watch-page metadata fetches yet.
  const searchResults = await mapWithConcurrency(
    queries,
    SEARCH_QUERY_CONCURRENCY,
    (q) => searchYouTubeCandidates(q),
  );

  const seenIds = new Set();
  const uniqueCandidates = [];
  for (const candidates of searchResults) {
    for (const candidate of candidates) {
      if (!candidate.id || seenIds.has(candidate.id)) continue;
      seenIds.add(candidate.id);
      uniqueCandidates.push(candidate);
    }
  }

  const validations = await mapWithConcurrency(
    uniqueCandidates,
    VALIDATION_CONCURRENCY,
    async (candidate) => {
      const valid = await validateYouTubeUrlWithOptions(candidate.url, {
        includePublishDate: false,
        checkAgeRestricted: false,
      });
      if (!valid.ok) return null;
      const candNorm = normalizeText(valid.title || "");
      const textScore = computeTextScore(originalNorm, candNorm);
      return { id: candidate.id, url: valid.url, title: candNorm, textScore };
    },
  );

  const textScored = validations.filter(Boolean);
  if (!textScored.length) return null;

  // Pass 2: take only the top 5 by text score and fetch full metadata in parallel.
  textScored.sort((a, b) => b.textScore - a.textScore);
  const topCandidates = textScored.slice(0, 5);

  const scored = await mapWithConcurrency(
    topCandidates,
    METADATA_CONCURRENCY,
    async (c) => {
      const watchUrl = `https://www.youtube.com/watch?v=${c.id}`;
      const meta = await getWatchMetadata(c.id, watchUrl);
      if (meta.ageRestricted) return null;
      const score = similarityScore(
        originalNorm,
        c.title,
        "",
        computeAgeScore(meta.publishDate),
        computeViewsScore(meta.viewCount),
        computeLikesScore(meta.likeCount),
      );
      return { url: c.url, score };
    },
  );

  const scoredCandidates = scored.filter(Boolean);
  if (!scoredCandidates.length) return null;

  scoredCandidates.sort((a, b) => b.score - a.score);
  const best = scoredCandidates[0];
  return best && best.score >= 0.5 ? best : null;
}

function computeTextScore(original, candidate) {
  if (!original || !candidate) return 0;
  const origTokens = [...tokenSet(original)];
  const candTokens = [...tokenSet(candidate)];
  if (!origTokens.length) return 0;

  let matchedCount = 0;
  for (const ot of origTokens) {
    let bestMatch = 0;
    for (const ct of candTokens) {
      const sim = levenshteinSimilarity(ot, ct);
      if (sim > bestMatch) bestMatch = sim;
    }
    if (bestMatch >= 0.75) matchedCount++;
  }
  const fuzzyRecall = matchedCount / origTokens.length;
  const exactTokenScore = tokenSetSimilarity(original, candidate);
  return Math.min(1, 0.6 * fuzzyRecall + 0.4 * exactTokenScore);
}

function buildSearchQueries(entry) {
  const title = (entry.title || "").trim();
  if (!title) return [];

  const parts = title
    .split(" - ")
    .map((s) => s && s.trim())
    .filter(Boolean);
  const [artist, song] = parts;
  const isUnknownArtist = !artist || /^unknown$/i.test(artist);
  const queries = [];

  if (!isUnknownArtist && song) {
    queries.push(`${artist} ${song}`);
    queries.push(`${artist} ${song} official`);
    queries.push(`${artist} ${song} live`);
    queries.push(`${artist} ${song} кючек`);
    queries.push(`${artist} ${song} chalga`);
    queries.push(song);
    queries.push(artist);
  } else if (song) {
    queries.push(song);
    queries.push(`${song} official`);
    queries.push(`${song} кючек`);
    queries.push(`${song} chalga`);
  }

  queries.push(title);
  queries.push(`${title} official`);
  queries.push(`${title} кючек`);

  return dedupe(queries.filter(Boolean));
}

function dedupe(arr) {
  return [...new Set(arr)];
}

async function searchYouTubeCandidates(query) {
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const response = await fetchWithTimeout(url);
  if (!response.ok) return [];

  const html = await response.text();
  const ids = extractVideoIdsFromSearchHtml(html).slice(
    0,
    SEARCH_CANDIDATE_LIMIT,
  );
  return ids.map((id) => ({
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
  }));
}

function extractVideoIdsFromSearchHtml(html) {
  // Collect IDs that appear in a Shorts context and exclude them
  const shortsIds = new Set();
  for (const m of html.match(/\/shorts\/([A-Za-z0-9_-]{11})/g) || []) {
    const id = m.slice(8);
    if (isValidVideoId(id)) shortsIds.add(id);
  }

  const matches = html.match(/"videoId":"([A-Za-z0-9_-]{11})"/g) || [];
  const unique = new Set();

  for (const m of matches) {
    const id = m.slice(11, 22);
    if (isValidVideoId(id) && !shortsIds.has(id)) unique.add(id);
  }

  return [...unique];
}

function transliterateBg(s) {
  const map = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sht",
    ъ: "a",
    ь: "",
    ю: "yu",
    я: "ya",
  };
  return [...s].map((c) => map[c] ?? c).join("");
}

function normalizeText(s) {
  if (!s) return "";
  return transliterateBg(s.toLowerCase())
    .replace(/[\[\](){}'".,!?|/\\:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenSet(s) {
  return new Set(
    normalizeText(s)
      .split(" ")
      .filter((token) => token.length > 1),
  );
}

function similarityScore(
  original,
  candidate,
  query,
  ageScoreInput,
  viewsScoreInput,
  likesScoreInput,
) {
  if (!original || !candidate) return 0;

  const textScore = computeTextScore(original, candidate);
  const ageScore = clampAgeScore(ageScoreInput);
  const viewsScore = clampAgeScore(viewsScoreInput);
  const likesScore = clampAgeScore(likesScoreInput);

  // 65% textual similarity (primary), 10% likes, 10% age, 15% views.
  return Math.min(
    1,
    0.65 * textScore + 0.1 * likesScore + 0.1 * ageScore + 0.15 * viewsScore,
  );
}

function tokenSetSimilarity(original, candidate) {
  const a = tokenSet(original);
  const b = tokenSet(candidate);
  if (!a.size || !b.size) return 0;

  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection += 1;
  }

  const recall = intersection / a.size;
  const union = new Set([...a, ...b]).size;
  const jaccard = intersection / union;

  // Favor recall (does candidate contain all original tokens?) over precision.
  return 0.6 * recall + 0.4 * jaccard;
}

function levenshteinSimilarity(original, candidate) {
  const dist = levenshteinDistance(original, candidate);
  const maxLen = Math.max(original.length, candidate.length);
  if (maxLen === 0) return 1;
  return Math.max(0, 1 - dist / maxLen);
}

function levenshteinDistance(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost,
      );
    }
  }

  return dp[m][n];
}

function clampAgeScore(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return 0;
  if (score < 0) return 0;
  if (score > 1) return 1;
  return score;
}

function computeAgeScore(publishDate) {
  if (!publishDate) return 0;

  const published = new Date(publishDate);
  if (Number.isNaN(published.getTime())) return 0;

  const now = new Date();
  const years =
    (now.getTime() - published.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (years <= 0) return 0;

  // Normalize so ~20+ year old videos get full age score.
  return Math.min(1, years / 20);
}

function computeViewsScore(viewCount) {
  if (
    typeof viewCount !== "number" ||
    Number.isNaN(viewCount) ||
    viewCount <= 0
  )
    return 0;

  // Log-scale normalization: ~100M+ views reaches the cap.
  return Math.min(1, Math.log10(viewCount + 1) / 8);
}

function computeLikesScore(likeCount) {
  if (
    typeof likeCount !== "number" ||
    Number.isNaN(likeCount) ||
    likeCount <= 0
  )
    return 0;

  // Log-scale normalization: ~10M+ likes reaches the cap.
  return Math.min(1, Math.log10(likeCount + 1) / 7);
}

function extractPublishDateFromLdJson(html) {
  const m = html.match(/"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"/);
  return m ? m[1] : null;
}

function extractPublishDateFromMeta(html) {
  const m = html.match(
    /itemprop="datePublished"\s+content="(\d{4}-\d{2}-\d{2})"/,
  );
  return m ? m[1] : null;
}

function extractViewCountFromLdJson(html) {
  const m = html.match(/"interactionCount"\s*:\s*"(\d+)"/);
  if (!m) return null;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractViewCountFromVideoDetails(html) {
  const m = html.match(/"viewCount"\s*:\s*"(\d+)"/);
  if (!m) return null;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLikesFromLdJson(html) {
  const m = html.match(
    /"aggregateRating"\s*:\s*{[^}]*"ratingCount"\s*:\s*"(\d+)"/,
  );
  if (!m) return null;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractLikesFromVideoDetails(html) {
  const m = html.match(/"likeCount"\s*:\s*"(\d+)"/);
  if (!m) return null;
  const parsed = Number(m[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAgeRestrictedHtml(html) {
  return (
    /og:restrictions:age/i.test(html) ||
    /"isAgeRestricted"\s*:\s*true/i.test(html) ||
    /playerAgeGateContent/i.test(html) ||
    /age[_-]?verification/i.test(html) ||
    /AGE_VERIFICATION_REQUIRED/i.test(html)
  );
}

async function safeJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || !items.length) return [];
  const limit = Math.max(1, Math.min(concurrency || 1, items.length));
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) break;
      try {
        results[i] = await mapper(items[i], i);
      } catch {
        results[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetryStatus(status) {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    status === 599
  );
}

async function fetchWithTimeout(url) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          "user-agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "accept-language": "bg,en-US;q=0.9,en;q=0.8",
        },
      });
      if (!shouldRetryStatus(response.status) || attempt === maxAttempts)
        return response;
    } catch {
      if (attempt === maxAttempts)
        return { ok: false, status: 599, text: async () => "" };
    } finally {
      clearTimeout(timeout);
    }

    await sleep(250 * attempt);
  }

  return { ok: false, status: 599, text: async () => "" };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
