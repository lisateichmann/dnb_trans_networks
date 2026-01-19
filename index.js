import './styles.css';
import { createTooltip, showTooltip, hideTooltip, formatNumber } from "./utils.js";
import pako from 'pako';

const DATA_URL = 'data/author_author_graph.json';
const LANGUAGE_CSV_URL = 'data.csv';
const LANGUAGE_LANGUAGE_URL = 'data/language_language_graph.json';

const COMMUNITY_COLORS = [
  "#f87171", // vivid red
  "#facc15", // warm yellow
  "#38bdf8", // bright blue
  "#fb923c",
  "#fde047",
  "#93c5fd",
  "#f472b6",
  "#34d399",
  "#c084fc",
  "#fed7aa",
  "#4ade80",
  "#a5b4fc",
];

const CENTRALITY_TIER_ORDER = ["outer", "periphery", "core"];

const TOP_20_AUTHORS = [
  "Hesse,Hermann",
  "Kafka,Franz",
  "Goethe,JohannWolfgangvon",
  "Mann,Thomas",
  "Bernhard,Thomas",
  "Handke,Peter",
  "Rilke,RainerMaria",
  "Zweig,Stefan",
  "Konsalik,HeinzG.",
  "Roth,Joseph",
  "Courths-Mahler,Hedwig",
  "Remarque,ErichMaria",
  "Link,Charlotte",
  "Grass,Günter",
  "Böll,Heinrich",
  "Brecht,Bertolt",
  "Jelinek,Elfriede",
  "Dürrenmatt,Friedrich",
  "Walser,Robert",
  "Hoffmann,E.T.A."
];

const MIN_TIER_BAND_RATIO = 0.12;
const DEFAULT_CENTRALIZATION_THRESHOLDS = {
  core: 8.0,
  periphery: 3.5,
};
const CENTRALIZATION_QUANTILES = {
  periphery: 0.4,
  core: 0.85,
};
const CENTRALIZATION_TIER_LABELS = {
  outer: "Outer periphery",
  periphery: "Periphery",
  core: "Core",
};
const TIER_NODE_COLORS = {
  core: "#fbbf24",
  periphery: "#60a5fa",
  outer: "#64748b",
};

// Global language color scale for consistent colors across visualizations
let LANGUAGE_COLOR_SCALE = null;

const ZOOM_EXTENT = [0.4, 4];
const MAX_LANGUAGE_RATIO_BARS = 120;
const MAX_LANGUAGE_RATIO_DISPLAY = MAX_LANGUAGE_RATIO_BARS;
const MAX_CLUSTER_LANGUAGE_CHIPS = 6;
const MAX_SEARCH_SUGGESTIONS = 8;
const MAX_SEARCH_HIGHLIGHTS = 25;

function getLanguageColorScale(languageIds) {
  if (!LANGUAGE_COLOR_SCALE) {
    const sortedIds = [...languageIds].sort();
    LANGUAGE_COLOR_SCALE = d3.scaleOrdinal()
      .domain(sortedIds)
      .range(d3.schemeSet3);
  }
  return LANGUAGE_COLOR_SCALE;
}

let centralizationThresholds = { ...DEFAULT_CENTRALIZATION_THRESHOLDS };

// Build adjacency map for quick lookup of outgoing neighbors
function buildAdjacencyMap(links) {
  const map = new Map();
  links.forEach(link => {
    if (link.sourceNode && link.targetNode) {
      if (!map.has(link.sourceNode.id)) map.set(link.sourceNode.id, new Set());
      map.get(link.sourceNode.id).add(link.targetNode.id);
    }
  });
  return map;
}

// Returns the normalized or raw centralization score for a node
function getCentralizationScore(node) {
  if (!node) return NaN;
  if (typeof node.centralizationScoreNormalized === 'number') return node.centralizationScoreNormalized;
  if (typeof node.centralizationScore === 'number') return node.centralizationScore;
  return NaN;
}
// Normalize a language key: trims, lowercases, and removes non-alphanumerics for consistent comparison
function normalizeLanguageKey(language) {
  if (!language) return "";
  return String(language).trim().toLowerCase().replace(/[^a-z0-9_\-]/gi, "");
}

// Returns the centralization tier (core, periphery, outer) for a given score
function getCentralizationTier(score, thresholds = getCentralizationThresholds()) {
  if (!Number.isFinite(score)) return "outer";
  if (score >= thresholds.core) return "core";
  if (score >= thresholds.periphery) return "periphery";
  return "outer";
}

function getCentralizationThresholds() {
  return { ...centralizationThresholds };
}

function setCentralizationThresholds(next) {
  if (!next) return;
  const current = getCentralizationThresholds();
  centralizationThresholds = {
    core: Number.isFinite(next.core) ? next.core : current.core,
    periphery: Number.isFinite(next.periphery) ? next.periphery : current.periphery,
  };
  if (centralizationThresholds.core <= centralizationThresholds.periphery) {
    centralizationThresholds.core = centralizationThresholds.periphery + 0.01;
  }
}

// Updates state.selectionVisibleNodes to include selected nodes and their neighbors (if not shared-only)
function updateSelectionNeighborhood(state) {
  if (!state.selectedIds || state.selectedIds.size === 0) {
    state.selectionVisibleNodes = null;
    return;
  }
  const allowed = new Set(state.selectedIds);
  const requireShared = state.onlySharedSelectionLinks && state.selectedIds.size > 1;
  if (!requireShared) {
    state.links.forEach((link) => {
      if (!link.visible) return;
      const sourceId = link.sourceNode?.id;
      const targetId = link.targetNode?.id;
      if (!sourceId || !targetId) return;
      if (state.selectedIds.has(sourceId) || state.selectedIds.has(targetId)) {
        allowed.add(sourceId);
        allowed.add(targetId);
      }
    });
  }
  state.selectionVisibleNodes = allowed;
}

function computeCentralizationThresholds(values = []) {
  if (!Array.isArray(values) || !values.length) {
    return getCentralizationThresholds();
  }
  const filtered = values
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (!filtered.length) {
    return getCentralizationThresholds();
  }

  const quantileValue = (p) => d3.quantileSorted(filtered, p);
  const periphery = quantileValue(CENTRALIZATION_QUANTILES.periphery);
  const core = quantileValue(CENTRALIZATION_QUANTILES.core);
  const thresholds = {
    periphery: Number.isFinite(periphery) ? periphery : DEFAULT_CENTRALIZATION_THRESHOLDS.periphery,
    core: Number.isFinite(core) ? core : DEFAULT_CENTRALIZATION_THRESHOLDS.core,
  };
  if (thresholds.core <= thresholds.periphery) {
    thresholds.core = thresholds.periphery + 0.01;
  }
  setCentralizationThresholds(thresholds);
  return thresholds;
}

function findAuthorMatches(nodes, query) {
  const normalizedQuery = (query || "").trim().toLowerCase();
  if (!normalizedQuery) return [];
  const matches = [];
  nodes.forEach((node) => {
    const label = (node.label || `${node.id ?? ""}`).trim();
    if (!label) return;
    const normalizedLabel = label.toLowerCase();
    const index = normalizedLabel.indexOf(normalizedQuery);
    if (index === -1) return;
    const rank = normalizedLabel === normalizedQuery ? 0 : index === 0 ? 1 : 2;
    matches.push({
      node,
      rank,
      weight: Number(node.totalWeight) || 0,
      matchIndex: index,
      label,
    });
  });
  matches.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.matchIndex !== b.matchIndex) return a.matchIndex - b.matchIndex;
    if (a.weight !== b.weight) return b.weight - a.weight;
    return (a.label || "").localeCompare(b.label || "");
  });
  return matches.map((entry) => entry.node);
}

function ensureNodeLanguageSet(node) {
  if (node._languageSet) return node._languageSet;
  const set = new Set();
  (node.languages || []).forEach((entry) => {
    const key = normalizeLanguageKey(entry.language);
    if (key) set.add(key);
  });
  node._languageSet = set;
  return set;
}


// Get a canonical language community key for a node using the node.languageCommunity property only.
function getLanguageCommunityKey(node) {
  return node?.languageCommunity;
}

function collectAvailableLanguageKeys(rawData) {
  const languages = new Set();
  (rawData?.nodes || []).forEach((node) => {
    (node.languages || []).forEach((entry) => {
      const key = normalizeLanguageKey(entry?.language);
      if (!key) return;
      const weight = Number(entry.weight);
      if (!Number.isFinite(weight) || weight <= 0) return;
      languages.add(key);
    });
  });
  return languages;
}

function inferCommunityKeys(nodes) {
  const counts = new Map();
  nodes.forEach((node) => {
    const assignments = node.communities || {};
    Object.entries(assignments).forEach(([key, value]) => {
      if (value === undefined || value === null || value < 0) return;
      counts.set(key, (counts.get(key) || 0) + 1);
    });
  });
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([key]) => key);
}

function selectDefaultCentralityMetric(meta) {
  const metrics = Array.isArray(meta?.centralityMetrics) ? meta.centralityMetrics : [];
  if (metrics.includes("degree")) return "degree";
  return metrics[0] || null;
}

// Friendly labels for centrality metrics (used by tooltips and UI)
const CENTRALITY_LABELS = {
  degree: "Degree centrality",
  closeness: "Closeness centrality",
  betweenness: "Betweenness centrality",
  eigenvector: "Eigenvector centrality",
  pagerank: "PageRank",
  strength: "Strength",
};

function formatCentralityLabel(metric) {
  if (!metric) return "Centrality";
  return (
    CENTRALITY_LABELS[metric] ||
    `${metric.charAt(0).toUpperCase()}${metric.slice(1)} centrality`
  );
}

async function loadData() {
  return loadJSONWithGzFallback(DATA_URL);
}

// Generic helper: try fetching <url>.gz and decompress client-side; fallback to JSON fetch
async function loadJSONWithGzFallback(url) {
  const gzUrl = url + '.gz';

  // Try fetching the gz directly first (preferred)
  try {
    const gzRes = await fetch(gzUrl);
    if (gzRes && gzRes.ok) {
      const ct = gzRes.headers.get('content-type') || '';
      console.debug(`Fetched gz for ${gzUrl} (content-type: ${ct})`);
      const buffer = await gzRes.arrayBuffer();
      try {
        const uint8 = new Uint8Array(buffer);
        const text = pako.ungzip(uint8, { to: 'string' });
        return JSON.parse(text);
      } catch (ungzipErr) {
        console.warn(`Failed to decompress ${gzUrl}:`, ungzipErr);
        // Fall through to try normal JSON
      }
    }
  } catch (err) {
    console.warn(`Gzip fetch failed for ${gzUrl}, will try plain JSON:`, err);
  }

  // Fetch plain JSON (may be a Git LFS pointer on gh-pages). If we get a pointer, try the gz again.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}`);

  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json') || contentType.includes('application/vnd.api+json') || contentType.includes('application/ld+json')) {
    return res.json();
  }

  // Some deployments (Git LFS/pointers) will return a pointer text rather than JSON. Inspect the body.
  const text = await res.text();
  // Git LFS pointer format begins with 'version https://git-lfs.github.com/spec/v1'
  if (text && text.startsWith('version https://git-lfs.github.com/spec/v1')) {
    console.warn(`${url} appears to be a Git LFS pointer; attempting to load ${gzUrl} instead`);
    try {
      const gzRes2 = await fetch(gzUrl);
      if (gzRes2 && gzRes2.ok) {
        const buffer = await gzRes2.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        const text2 = pako.ungzip(uint8, { to: 'string' });
        return JSON.parse(text2);
      }
    } catch (err) {
      console.warn(`Retry fetching/decompressing ${gzUrl} failed:`, err);
      throw new Error(`Failed to load JSON (LFS pointer returned) and gz fallback failed for ${url}`);
    }
  }

  // If content isn't JSON and not a pointer, try to parse anyway to raise a helpful error
  try {
    return JSON.parse(text);
  } catch (parseErr) {
    console.error(`Failed to parse ${url} — content-type: ${contentType}, first chars: ${text.slice(0,80)}`);
    throw parseErr;
  }
}

function buildRings(width, height) {
  const minSide = Math.min(width, height);
  const maxRadius = Math.max(360, minSide / 2 - 10);
  const minRadius = Math.max(18, maxRadius * 0.04);
  const usableBand = maxRadius - minRadius;
  const coreRadius = minRadius + usableBand * 0.38;
  const peripheryRadius = minRadius + usableBand * 0.74;

  const tiers = [
    { tier: "outer", radius: maxRadius, innerRadius: peripheryRadius },
    { tier: "periphery", radius: peripheryRadius, innerRadius: coreRadius },
    { tier: "core", radius: coreRadius, innerRadius: minRadius },
  ];

  return {
    centerX: width / 2,
    centerY: height / 2,
    maxRadius,
    minRadius,
    tiers,
  };
}

function getTierRangeLabel(tier, thresholds = getCentralizationThresholds()) {
  if (tier === "core") return `≥ ${thresholds.core.toFixed(1)}`;
  if (tier === "periphery") return `${thresholds.periphery.toFixed(1)}–${thresholds.core.toFixed(1)}`;
  // outer and any other tiers represent scores below the periphery threshold
  return `< ${thresholds.periphery.toFixed(1)}`;
}

function getNodeFill(node, state) {
  // Color reflects centralization tier only (core, periphery, outer)
  const tier = node._centralizationTier;
  return TIER_NODE_COLORS[tier] || "#d1d5db";
}

function canonicalLinkKey(idA, idB) {
  const a = idA === undefined || idA === null ? "" : String(idA);
  const b = idB === undefined || idB === null ? "" : String(idB);
  return a < b ? `${a}||${b}` : `${b}||${a}`;
}

function getLinkBetween(state, sourceId, targetId) {
  if (!state?.linkByPair) return null;
  return state.linkByPair.get(canonicalLinkKey(sourceId, targetId)) || null;
}

function getNodeOpacity(node, state) {
  // If hovering, fade all except hovered node and its neighbors
  if (state.hoverNode) {
    if (node.id === state.hoverNode.id) return 1;
    if (state.hoverNeighbors && state.hoverNeighbors.has(node.id)) return 1;
    return 0.18;
  }
  if (!state.useTranslationOpacity) return 1;
  const extent = state.translationWeightExtent;
  if (!extent || extent.length !== 2) return 1;
  const [minTotal, maxTotal] = extent;
  if (!Number.isFinite(minTotal) || !Number.isFinite(maxTotal) || maxTotal <= 0) return 1;
  const adjustedMin = Math.max(1e-6, minTotal);
  const total = Math.max(1e-6, Number(node.totalWeight) || 0);
  const logMin = Math.log(adjustedMin);
  const logMax = Math.log(maxTotal);
  const range = Math.max(logMax - logMin, 1e-6);
  const logValue = Math.log(total);
  const normalized = Math.max(0, Math.min(1, (logValue - logMin) / range));
  const MIN_ALPHA = 0.35;
  return MIN_ALPHA + normalized * (1 - MIN_ALPHA);
}

function projectToRings(nodes, rings, communityKey) {
  // Assign nodes to rings based on their languageCommunity key (override ring placement)
  const ringBuckets = {
    core: new Map(), // languageCommunity '1'
    periphery: new Map(), // languageCommunity '2'
    outer: new Map(), // languageCommunity '0' and bridges
  };

  const ringScores = {
    core: [],
    periphery: [],
    outer: [],
  };

  nodes.forEach((node) => {
    const score = getCentralizationScore(node);
    node._centralizationValue = Number.isFinite(score) ? score : Number.NaN;
    // Do not assign _centralizationTier by centralization score anymore

    const comm = node[communityKey] != null ? String(node[communityKey]) : "";
    let ring = "outer";
    let groupKey = comm || "_noise";
    if (comm === "0") {
      ring = "core";
    } else if (comm === "1" || comm === "2") {
      ring = "periphery";
    } else {
      ring = "outer";
    }
    groupKey = comm || "_noise";

    if (!ringBuckets[ring].has(groupKey)) ringBuckets[ring].set(groupKey, []);
    ringBuckets[ring].get(groupKey).push(node);

    if (Number.isFinite(node._centralizationValue)) ringScores[ring].push(node._centralizationValue);
  });

  // For each ring, distribute all nodes evenly around the full circle at the middle of the band
  const bandRanges = {};
  rings.tiers.forEach((tier) => {
    bandRanges[tier.tier] = {
      inner: tier.innerRadius ?? rings.minRadius,
      outer: tier.radius ?? rings.maxRadius,
    };
  });

  // Place nodes with languageCommunity inside the core ring, others randomly in canvas
  const width = rings.centerX * 2;
  const height = rings.centerY * 2;
  const core = rings.tiers.find(t => t.tier === "core");
  const inner = core.innerRadius ?? rings.minRadius;
  const outer = core.radius ?? rings.maxRadius;
  nodes.forEach(node => {
    // Assign centralization tier strictly by languageCommunity (string)
    const comm = node.languageCommunity ? node.languageCommunity : "";

    if (comm === "1") {
      node._centralizationTier = 'core';
    } else if (comm === "2") {
      node._centralizationTier = 'periphery';
    } else {
      // All others (including bridges and community 0) go to outer
      node._centralizationTier = 'outer';
    }

    // Place node in the band matching its tier
    const band = rings.tiers.find(t => t.tier === node._centralizationTier);
    if (band) {
      const inner = band.innerRadius ?? rings.minRadius;
      const outer = band.radius ?? rings.maxRadius;
      const r = inner + Math.random() * (outer - inner);
      const angle = Math.random() * 2 * Math.PI;
      node.x = node._initialX = rings.centerX + r * Math.cos(angle);
      node.y = node._initialY = rings.centerY + r * Math.sin(angle);
    } else {
      // Fallback: scatter elsewhere
      node.x = node._initialX = Math.random() * width;
      node.y = node._initialY = Math.random() * height;
    }
  });
}


function applyCollisionForces(nodes, rings) {
  const iterations = 80;
  const minDistance = 14;
  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      const nodeA = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeB = nodes[j];
        let dx = nodeB.x - nodeA.x;
        let dy = nodeB.y - nodeA.y;
        let dist = Math.hypot(dx, dy) || 0.0001;
        if (dist >= minDistance) continue;
        const overlap = (minDistance - dist) / 2;
        dx /= dist;
        dy /= dist;
        nodeA.x -= dx * overlap;
        nodeA.y -= dy * overlap;
        nodeB.x += dx * overlap;
        nodeB.y += dy * overlap;
      }
      clampToRing(nodeA, rings);
    }
  }
}

function clampToRing(node, rings, overflow = node._overflowMargin || 0) {
  const dx = node.x - rings.centerX;
  const dy = node.y - rings.centerY;
  let dist = Math.hypot(dx, dy);
  // If node is at origin, place it at inner radius + small offset
  if (dist === 0) {
    const defaultRadius = Math.max(rings.minRadius - overflow, rings.minRadius);
    node.x = rings.centerX + defaultRadius;
    node.y = rings.centerY;
    return;
  }
  // Use _bandKey (set by projectToRings) to determine band
  let band = node._bandKey ? rings.bands?.[node._bandKey] : null;
  const bandMin = (band?.inner ?? rings.minRadius) - overflow;
  const bandMax = (band?.outer ?? rings.maxRadius) + overflow;

  // Also ensure not to go beyond global ring bounds with overflow
  const globalMin = Math.max(rings.minRadius - overflow, 0);
  const globalMax = rings.maxRadius + overflow;

  const clamped = Math.max(globalMin, Math.min(globalMax, Math.max(bandMin, Math.min(bandMax, dist))));
  if (Math.abs(clamped - dist) > 0.001) {
    const scale = clamped / dist;
    node.x = rings.centerX + dx * scale;
    node.y = rings.centerY + dy * scale;
  }
}

async function loadLanguageRatiosFromCSV() {
  if (languageRatioCache) return languageRatioCache;
  if (languageRatioPromise) return languageRatioPromise;

  languageRatioPromise = (async () => {
    // Try fetching compressed CSV first
    const gzUrl = LANGUAGE_CSV_URL + '.gz';
    let csvText = null;
    try {
      const gzRes = await fetch(gzUrl);
      if (gzRes && gzRes.ok) {
        const buffer = await gzRes.arrayBuffer();
        const uint8 = new Uint8Array(buffer);
        csvText = pako.ungzip(uint8, { to: 'string' });
      }
    } catch (err) {
      console.warn('Failed to fetch/decompress CSV gz, falling back to plain CSV fetch:', err);
    }

    if (!csvText) {
      const res = await fetch(LANGUAGE_CSV_URL);
      if (!res.ok) throw new Error(`Failed to load ${LANGUAGE_CSV_URL}`);
      csvText = await res.text();
    }

    const rows = d3.csvParse(csvText);
    const counts = new Map();
    rows.forEach((row) => {
      const lang = (row.language || '').trim();
      if (!lang) return;
      counts.set(lang, (counts.get(lang) || 0) + 1);
    });
    const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0);
    if (!total) {
      languageRatioCache = [];
      return languageRatioCache;
    }
    languageRatioCache = Array.from(counts.entries()).map(([language, count]) => ({
      language,
      ratio: count / total,
    }));
    return languageRatioCache;
  })().catch((error) => {
    console.error('Unable to compute language ratios from CSV', error);
    languageRatioCache = [];
    return languageRatioCache;
  }).finally(() => {
    if (!languageRatioCache) languageRatioPromise = null;
  });

  return languageRatioPromise;
}

function createLanguageRatioEntry(language, ratio) {
  const key = normalizeLanguageKey(language);
  if (!key || !Number.isFinite(ratio) || ratio <= 0) return null;
  return {
    language,
    ratio,
    key,
  };
}

async function computeLanguageRatioEntries(rawData) {
  const availableLanguageKeys = collectAvailableLanguageKeys(rawData);
  // Always keep bilingual/multilingual ids even if not present in author nodes
  ["ger", "mul"].forEach((id) => availableLanguageKeys.add(id));
  const normalizeEntries = (entries) => {
    if (!Array.isArray(entries) || !entries.length) return [];
    let filtered = entries;
    if (availableLanguageKeys.size) {
      const next = entries.filter((entry) => availableLanguageKeys.has(entry.key));
      if (next.length) filtered = next;
    }
    const total = filtered.reduce((sum, entry) => sum + (Number(entry.ratio) || 0), 0);
    if (total > 0 && Math.abs(total - 1) > 1e-6) {
      filtered = filtered.map((entry) => ({ ...entry, ratio: entry.ratio / total }));
    }
    return filtered;
  };

  const metaRatios = rawData?.meta?.languagePopularity?.ratios;
  if (metaRatios && Object.keys(metaRatios).length) {
    const entries = Object.entries(metaRatios)
      .map(([language, value]) => createLanguageRatioEntry(language, Number(value)))
      .filter(Boolean);
    return normalizeEntries(entries);
  }

  const csvRatios = await loadLanguageRatiosFromCSV();
  if (csvRatios.length) {
    const entries = csvRatios
      .map((entry) => createLanguageRatioEntry(entry.language, Number(entry.ratio)))
      .filter(Boolean);
    return normalizeEntries(entries);
  }

  const totals = new Map();
  (rawData?.nodes || []).forEach((node) => {
    (node.languages || []).forEach((entry) => {
      if (!entry?.language) return;
      const weight = Number(entry.weight);
      if (!Number.isFinite(weight) || weight <= 0) return;
      totals.set(entry.language, (totals.get(entry.language) || 0) + weight);
    });
  });

  const grandTotal = Array.from(totals.values()).reduce((sum, value) => sum + value, 0);
  if (!grandTotal) return [];

  const entries = Array.from(totals.entries())
    .map(([language, total]) => createLanguageRatioEntry(language, total / grandTotal))
    .filter(Boolean);
  return normalizeEntries(entries);
}

function buildHistogram(container, values, options = {}) {
  const {
    binFormatter,
    onHover,
    onBins,
    interactive = false,
    initialRange = null,
    onRangeChange,
  } = options;
  const selection = d3.select(container);
  const node = selection.node();
  selection.selectAll("*").remove();
  if (!node) return;
  const width = Math.max(140, node.clientWidth || node.offsetWidth || 160);
  const height = Math.max(40, node.clientHeight || node.offsetHeight || 60);

  if (!values.length) {
    selection.append("svg").attr("width", width).attr("height", height);
    return;
  }

  let [minValue, maxValue] = d3.extent(values);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return;
  if (minValue === maxValue) maxValue = minValue + 1;

  const binCount = Math.min(20, Math.max(4, Math.round(Math.sqrt(values.length)))) || 10;
  const bins = d3.bin().domain([minValue, maxValue]).thresholds(binCount)(values);
  if (typeof onBins === "function") {
    onBins(bins, { minValue, maxValue });
  }

  const topPadding = 6;
  const bottomPadding = 4;
  const chartHeight = height - topPadding - bottomPadding;
  const xScale = d3.scaleLinear().domain([minValue, maxValue]).range([0, width]);
  const maxBinCount = d3.max(bins, (d) => d.length) || 1;
  const yScale = d3.scaleLinear().domain([0, maxBinCount]).range([chartHeight, 0]);

  const svg = selection.append("svg").attr("width", width).attr("height", height);

  const bars = svg
    .append("g")
    .attr("transform", `translate(0, ${topPadding})`)
    .selectAll("rect")
    .data(bins)
    .join("rect")
    .attr("x", (d) => xScale(d.x0) + 0.5)
    .attr("y", (d) => yScale(d.length))
    .attr("width", (d) => Math.max(1, xScale(d.x1) - xScale(d.x0) - 1))
    .attr("height", (d) => Math.max(1, chartHeight - yScale(d.length)));

  if (typeof binFormatter === "function") {
    bars.attr("title", (d, i) => binFormatter(d, i, bins));
  }

  if (typeof onHover === "function") {
    bars
      .on("mouseenter", (event, d) => onHover(d, bins, event))
      .on("mousemove", (event, d) => onHover(d, bins, event))
      .on("mouseleave", (event) => onHover(null, bins, event));
  }

  const clampRange = (range) => {
    if (!Array.isArray(range) || range.length !== 2) return [minValue, maxValue];
    const start = Math.max(minValue, Math.min(maxValue, range[0]));
    const end = Math.max(start + Number.EPSILON, Math.min(maxValue, range[1]));
    return [start, end];
  };

  const updateBarHighlight = (range) => {
    const [start, end] = clampRange(range);
    bars.classed(
      "active",
      (d) => (d.x1 ?? maxValue) > start && (d.x0 ?? minValue) < end
    );
  };

  if (interactive) {
    let currentRange = clampRange(initialRange || [minValue, maxValue]);
    updateBarHighlight(currentRange);

    const brush = d3
      .brushX()
      .extent([
        [0, topPadding],
        [width, topPadding + chartHeight],
      ])
      .on("brush end", (event) => {
        if (!event.selection) {
          currentRange = [minValue, maxValue];
        } else {
          const [x0, x1] = event.selection;
          currentRange = clampRange([xScale.invert(x0), xScale.invert(x1)]);
        }
        updateBarHighlight(currentRange);
        if (typeof onRangeChange === "function") {
          onRangeChange(currentRange.slice(), { bins, minValue, maxValue });
        }
      });

    const brushLayer = svg.append("g").attr("class", "hist-brush");
    brushLayer.call(brush);
    brushLayer.call(brush.move, currentRange.map((value) => xScale(value)));
  }
}

function renderLanguageRatioBars(container, entries, options = {}) {
  if (!container) return;
  const { onSelectionChange, selectedKeys } = options;
  const activeSelection = selectedKeys instanceof Set ? selectedKeys : new Set();
  const selection = d3.select(container);
  selection.selectAll("*").remove();

  selection.on("wheel", null);

  const data = entries
    .filter((entry) => entry.language && Number.isFinite(entry.ratio) && entry.ratio > 0)
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, Math.min(MAX_LANGUAGE_RATIO_BARS, MAX_LANGUAGE_RATIO_DISPLAY));

  if (!data.length) {
    selection
      .append("div")
      .attr("class", "selection-hint")
      .text("Language ratio bar chart unavailable.");
    return;
  }

  const node = selection.node();
  const baseWidth = Math.max(360, node?.clientWidth || node?.offsetWidth || 400);
  const height = Math.max(110, node?.clientHeight || node?.offsetHeight || 130);
  const margin = { top: 14, right: 8, bottom: 36, left: 8 };
  const chartHeight = height - margin.top - margin.bottom;
  const barGap = 1;
  const minBarWidth = 34;
  const estimatedWidth = margin.left + margin.right + data.length * (minBarWidth + barGap);
  const width = Math.max(baseWidth, estimatedWidth);

  const xScale = d3
    .scaleBand()
    .domain(data.map((d) => d.key))
    .range([margin.left, width - margin.right])
    .paddingInner(0)
    .paddingOuter(0);

  const yScale = d3
    .scaleLinear()
    .domain([0, d3.max(data, (d) => d.ratio) || 1])
    .range([height - margin.bottom, margin.top]);

  const svg = selection.append("svg").attr("width", width).attr("height", height);

  const formatPercent = (value) => `${(value * 100).toFixed(1)}%`;

  const bandWidth = xScale.bandwidth() || 0;
  const gap = Math.min(barGap, Math.max(0, bandWidth - 3));
  const barWidth = Math.max(3, bandWidth - gap);
  const barOffset = (bandWidth - barWidth) / 2;

  const bars = svg
    .append("g")
    .selectAll("rect")
    .data(data, (d) => d.key)
    .join("rect")
    .attr("class", "bar")
    .attr("x", (d) => (xScale(d.key) || margin.left) + barOffset)
    .attr("width", barWidth)
    .attr("y", (d) => yScale(d.ratio))
    .attr("height", (d) => Math.max(2, (height - margin.bottom) - yScale(d.ratio)))
    .classed("selected", (d) => activeSelection.has(d.key))
    .style("cursor", "pointer")
    .on("click", (event, d) => {
      if (typeof onSelectionChange === "function") {
        onSelectionChange(d, {
          multi: event.ctrlKey || event.metaKey,
          event,
        });
      }
    });

  bars.append("title").text((d) => `${(d.language || "n/a").toUpperCase()}: ${formatPercent(d.ratio)}`);

  svg
    .append("g")
    .selectAll("text.lang-value")
    .data(data, (d) => d.key)
    .join("text")
    .attr("class", "lang-value")
    .style("pointer-events", "none")
    .attr("x", (d) => (xScale(d.key) || margin.left) + barOffset + barWidth / 2)
    .attr("y", (d) => Math.max(margin.top + 8, yScale(d.ratio) - 4))
    .attr("text-anchor", "middle")
    .attr("fill", "#f8fafc")
    .attr("font-size", 10)
    .text((d) => formatPercent(d.ratio));

  svg
    .append("g")
    .selectAll("text.lang-label")
    .data(data, (d) => d.key)
    .join("text")
    .attr("class", "lang-label")
    .style("pointer-events", "none")
    .attr("x", (d) => (xScale(d.key) || margin.left) + barOffset + barWidth / 2)
    .attr("y", height - margin.bottom + 14)
    .attr("text-anchor", "middle")
    .attr("fill", "#cbd5f5")
    .attr("font-size", 10)
    .text((d) => (d.language || "n/a").toUpperCase());
}

function computeCommunityLanguageSummaries(nodes, communityKey) {
  const summaries = new Map();

  nodes.forEach((node) => {
    // Use languageCommunity property only — no fallback
    const commKey = getLanguageCommunityKey(node);
    if (commKey === null) return; // skip nodes without languageCommunity

    ensureNodeLanguageSet(node);
    let commId = String(commKey);

    // Group bridge communities using "->" notation only
    const isThreeBridge = commId === "0->1->2";
    const isBridge = commId.includes("->");

    if (isThreeBridge) {
      commId = "3-bridges";
    } else if (isBridge) {
      // This covers 0->1, 0->2, 1->2
      commId = "2-bridges";
    }
    
    if (!summaries.has(commId)) {
      summaries.set(commId, {
        id: commId,
        authorCount: 0,
        totalLanguageWeight: 0,
        languageCounts: new Map(),
      });
    }
    const summary = summaries.get(commId);
    summary.authorCount += 1;
    (node.languages || []).forEach((entry) => {
      const key = normalizeLanguageKey(entry.language);
      if (!key) return;
      const weight = Number(entry.weight) || 1;
      summary.totalLanguageWeight += weight;
      const current = summary.languageCounts.get(key) || {
        key,
        label: (entry.language || "").trim() || key,
        count: 0,
      };
      current.count += weight;
      summary.languageCounts.set(key, current);
    });
  });

  return Array.from(summaries.values())
    .map((summary) => {
      const languages = Array.from(summary.languageCounts.values())
        .sort((a, b) => b.count - a.count)
        .map((entry) => ({
          key: entry.key,
          language: entry.label,
          count: entry.count,
          ratio: summary.totalLanguageWeight ? entry.count / summary.totalLanguageWeight : 0,
        }));
      return {
        id: summary.id,
        authorCount: summary.authorCount,
        languages,
        languageSet: new Set(languages.map((d) => d.key)),
      };
    })
    // Custom sort: 0, 1, 2, 2-bridges, 3-bridges
    .sort((a, b) => {
      const order = ["0", "1", "2", "2-bridges", "3-bridges"];
      const aIdx = order.indexOf(a.id);
      const bIdx = order.indexOf(b.id);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.id.localeCompare(b.id, undefined, { numeric: true });
    });
}

function renderClusterLanguageFilter(container, summaries, colorScale, onSelectionChange) {
  if (!container) return null;
  const selection = d3.select(container);
  selection.selectAll("*").remove();

  if (!summaries.length) {
    selection
      .append("div")
      .attr("class", "selection-hint")
      .text("Community metadata unavailable.");
    return null;
  }

  const cards = selection
    .selectAll("button.cluster-filter-card")
    .data(summaries, (d) => d.id)
    .join("button")
    .attr("type", "button")
    .attr("class", "cluster-filter-card")
    .style("background", d => {
      // Color by centrality tier for visual consistency
      // Use the tier of the cluster (d.tier or d.centralizationTier or similar)
      let tier = d.tier || d.centralizationTier;
      if (!tier && typeof d.id === 'string') {
        // Guess tier from id if possible (e.g., '0' = core, '1'/'2' = periphery)
        if (d.id === '0') tier = 'core';
        else if (d.id === '1' || d.id === '2') tier = 'periphery';
        else tier = 'outer';
      }
      const base = TIER_NODE_COLORS[tier] || '#d1d5db';
      // Convert hex to rgba with lower alpha for a light background
      if (/^#[0-9a-fA-F]{6}$/.test(base)) {
        const r = parseInt(base.slice(1, 3), 16);
        const g = parseInt(base.slice(3, 5), 16);
        const b = parseInt(base.slice(5, 7), 16);
        return `rgba(${r},${g},${b},0.13)`;
      }
      return base;
    });

  cards.each(function (d) {
    const card = d3.select(this);
    card.selectAll("*").remove();
    const header = card.append("div").attr("class", "cluster-filter-row");
    // Determine tier color for swatch
    let tier = d.tier || d.centralizationTier;
    if (!tier && typeof d.id === 'string') {
      if (d.id === '0') tier = 'core';
      else if (d.id === '1' || d.id === '2') tier = 'periphery';
      else tier = 'outer';
    }
    const swatchColor = TIER_NODE_COLORS[tier] || '#d1d5db';
    
    let displayName;
    if (d.id === '2-bridges') {
      displayName = 'Two-community bridges';
    } else if (d.id === '3-bridges') {
      displayName = 'Three-community bridge';
    } else {
      displayName = `Community ${d.id}`;
    }
    
    header
      .append("strong")
      .html(
        `<span class="cluster-filter-swatch" style="background:${swatchColor}"></span>` +
        displayName
      );
    header.append("span").text(`${d.authorCount} authors`);

    const languageList = card.append("div").attr("class", "cluster-filter-languages");
    if (d.languages.length) {
      languageList
        .selectAll("span")
        .data(d.languages.slice(0, MAX_CLUSTER_LANGUAGE_CHIPS))
        .join("span")
        .text((lang) => `${(lang.language || "n/a").toUpperCase()} ${(lang.ratio * 100).toFixed(1)}%`);
    } else {
      languageList.text("No language annotations for this community.");
    }
  });

  let currentSelection = new Set();
  let suppressNotification = true;

  const emitSelection = () => {
    cards.classed("selected", (d) => currentSelection.has(d.id));
    if (suppressNotification) {
      suppressNotification = false;
      return;
    }
    if (typeof onSelectionChange === "function") {
      onSelectionChange(new Set(currentSelection));
    }
  };

  cards.on("click", (event, d) => {
    event.preventDefault();
    const next = new Set(currentSelection);
    if (next.has(d.id)) next.delete(d.id);
    else next.add(d.id);
    currentSelection = next;
    emitSelection();
  });

  emitSelection();

  return {
    clear() {
      currentSelection = new Set();
      emitSelection();
    },
    setSelection(ids) {
      currentSelection = new Set(ids);
      emitSelection();
    },
    getSelection() {
      return new Set(currentSelection);
    },
    toggleCluster(clusterId) {
      const next = new Set(currentSelection);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      currentSelection = next;
      emitSelection();
    }
  };
}

function computeCommunities(nodes, communityKey) {
  const communities = new Set();
  nodes.forEach((node) => {
    const cid = node.communities?.[communityKey];
    if (cid !== undefined && cid !== null && cid >= 0) communities.add(cid);
  });
  return Array.from(communities).sort((a, b) => a - b);
}

function drawLegend(ctx, width, height, communities, colorScale) {
  if (!communities.length && !CENTRALITY_TIER_ORDER.length) return;

  const padding = 16;
  const lineHeight = 14;
  const columnWidth = 160;
  const startX = width - padding - columnWidth;
  let y = padding + 4;

  ctx.save();
  ctx.translate(0, 0);
  ctx.font = "11px 'Segoe UI', system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";

  // Store tier click regions for interactivity
  const tierRegions = [];

  // Community legend removed (we now surface cluster info via the cluster cards)

  if (CENTRALITY_TIER_ORDER.length) {
    y += 6;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("LanguageCentrality tiers (click to filter)", startX, y);
    y += lineHeight;

    CENTRALITY_TIER_ORDER.forEach((tier) => {
      const label = CENTRALIZATION_TIER_LABELS[tier];
      if (!label) return;

      const tierStartY = y;
      const tierColor = TIER_NODE_COLORS[tier];

      // Store click region
      tierRegions.push({
        tier,
        x: startX,
        y: tierStartY,
        width: 150,
        height: lineHeight
      });

      // Draw simple filled circle with tier color
      ctx.fillStyle = tierColor;
      ctx.beginPath();
      ctx.arc(startX + 6, y + 6, 5, 0, Math.PI * 2);
      ctx.fill();

      ctx.fillStyle = "#d1d5db";
      ctx.fillText(`${label} (${getTierRangeLabel(tier)})`, startX + 16, y);
      y += lineHeight;
    });

    // Add clickable hint
    ctx.fillStyle = "#9ca3af";
    ctx.font = "9px 'Segoe UI', system-ui, sans-serif";
    ctx.fillText("Click tier to toggle filter", startX, y);
    ctx.font = "11px 'Segoe UI', system-ui, sans-serif";
  }

  ctx.restore();

  // Return tier regions for click handling
  return tierRegions;
}

function filterByWeightState(state, range) {
  const minWeight = Number.isFinite(range?.min) ? range.min : 0;
  const maxWeight = Number.isFinite(range?.max) ? range.max : Number.POSITIVE_INFINITY;
  state.weightRange = { min: minWeight, max: maxWeight };
  const visibleNodeIds = new Set();
  state.links.forEach((link) => {
    const weight = Number(link.weight) || 0;
    const isVisible = weight >= minWeight && weight <= maxWeight;
    link.visible = isVisible;
    if (isVisible) {
      visibleNodeIds.add(link.sourceNode.id);
      visibleNodeIds.add(link.targetNode.id);
    }
  });
  state.nodes.forEach((node) => {
    node.visible = visibleNodeIds.has(node.id);
  });
}

function updateClusterVisibility(state) {
  const filterActive = state.clusterFilter && state.clusterFilter.size;
  let focusStillVisible = !filterActive || !state.focusNodeId;
  const idsToRemove = [];

  const nodeClusterKey = (node) => {
    // Always use node.languageCommunity (preserve order for arrays). Do NOT fallback to numeric communities.
    const key = getLanguageCommunityKey(node);
    if (key === null) return null;

    // Map to grouped bridge IDs using "->" notation only
    const keyStr = String(key);
    const isThreeBridge = keyStr === "0->1->2";
    const isBridge = keyStr.includes("->");

    if (isThreeBridge) {
      return "3-bridges";
    }
    if (isBridge) {
      return "2-bridges";
    }
    return keyStr;
  };

  state.nodes.forEach((node) => {
    const key = nodeClusterKey(node);
    node.clusterVisible = !filterActive || (key !== null && state.clusterFilter.has(key));
    if (node.clusterVisible && node.id === state.focusNodeId) {
      focusStillVisible = true;
    }
    if (!node.clusterVisible && state.selectedIds?.has(node.id)) {
      idsToRemove.push(node.id);
    }
  });
  idsToRemove.forEach((id) => state.selectedIds.delete(id));
  if (!focusStillVisible) {
    state.focusNodeId = null;
    state.focusVisible = null;
  }
  if (filterActive && state.hoverNode && state.hoverNode.clusterVisible === false) {
    state.hoverNode = null;
    hideTooltip(state.tooltip);
  }
}

function nodesShareLanguage(nodeA, nodeB) {
  if (!nodeA || !nodeB) return false;
  const setA = ensureNodeLanguageSet(nodeA);
  const setB = ensureNodeLanguageSet(nodeB);
  if (!setA.size || !setB.size) return false;
  for (const lang of setA) {
    if (setB.has(lang)) return true;
  }
  return false;
}

function passesClusterEdgeFilter(state, link) {
  if (state.selectionVisibleNodes && state.selectionVisibleNodes.size) return true;
  if (!state.clusterFilter || state.clusterFilter.size === 0) return true;


  const sourceCluster = getLanguageCommunityKey(link.sourceNode);
  const targetCluster = getLanguageCommunityKey(link.targetNode);

  if (!state.clusterFilter.has(sourceCluster) || !state.clusterFilter.has(targetCluster)) return false;
  if (sourceCluster !== targetCluster) return false;
  return nodesShareLanguage(link.sourceNode, link.targetNode);
}

function createChordDiagram(languageData, options = {}) {
  const {
    onLanguageClick,
    container: containerSelector = "#chordDiagram",
    width: customWidth = 320,
    height: customHeight = 320
  } = options;

  const container = d3.select(containerSelector);
  container.selectAll("*").remove();

  if (!languageData || !languageData.nodes || !languageData.links) {
    container.append("p")
      .style("color", "#9ca3af")
      .style("font-size", "0.75rem")
      .text("No language flow data available.");
    return;
  }

  // Create or reuse tooltip for chord diagram
  let chordTooltip = d3.select("body").select(".chord-diagram-tooltip");
  if (chordTooltip.empty()) {
    chordTooltip = d3.select("body")
      .append("div")
      .attr("class", "tooltip chord-diagram-tooltip")
      .style("position", "absolute")
      .style("padding", "0.5rem 0.8rem")
      .style("background", "rgba(30, 41, 59, 0.95)")
      .style("color", "#fff")
      .style("border-radius", "4px")
      .style("pointer-events", "none")
      .style("font-size", "0.85rem")
      .style("box-shadow", "0 8px 16px rgba(15, 23, 42, 0.4)")
      .style("z-index", "99999")
      .style("opacity", 0);
  }

  const width = customWidth;
  const height = customHeight;
  const outerRadius = Math.min(width, height) * 0.45;
  const innerRadius = outerRadius - 20;

  // Filter to top languages by weight, but always include bilingual/multilingual ids
  const preferredLanguageIds = new Set(["ger", "mul"]);
  const languageWeights = new Map();
  languageData.nodes.forEach(node => {
    languageWeights.set(node.id, node.totalWeight || 0);
  });

  const sortedLanguages = Array.from(languageWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .map(d => d[0]);

  const topLanguages = sortedLanguages.slice(0, 15);
  const preferredLanguages = sortedLanguages.filter(id => preferredLanguageIds.has(id));

  const mergedLanguages = [...topLanguages, ...preferredLanguages]
    .filter((id, idx, arr) => arr.indexOf(id) === idx);

  const topLanguageSet = new Set(mergedLanguages);

  // Build matrix and track connections
  const languageIndex = new Map(mergedLanguages.map((lang, i) => [lang, i]));
  const matrix = Array(mergedLanguages.length).fill(0).map(() => Array(mergedLanguages.length).fill(0));
  const connectionCounts = new Map(); // track how many connections each language has

  languageData.links.forEach(link => {
    const sourceIdx = languageIndex.get(link.source);
    const targetIdx = languageIndex.get(link.target);
    if (sourceIdx !== undefined && targetIdx !== undefined) {
      matrix[sourceIdx][targetIdx] = link.weight || 0;
      connectionCounts.set(link.source, (connectionCounts.get(link.source) || 0) + 1);
      connectionCounts.set(link.target, (connectionCounts.get(link.target) || 0) + 1);
    }
  });

  // Optimize ordering to minimize crossings using a simple heuristic
  // Calculate connection strengths and reorder based on weighted connections
  const connectionStrength = new Map();
  mergedLanguages.forEach((lang, idx) => {
    let totalWeight = 0;
    let weightedSum = 0;
    matrix[idx].forEach((weight, targetIdx) => {
      if (weight > 0) {
        totalWeight += weight;
        weightedSum += weight * targetIdx;
      }
    });
    matrix.forEach((row, sourceIdx) => {
      const weight = row[idx];
      if (weight > 0) {
        totalWeight += weight;
        weightedSum += weight * sourceIdx;
      }
    });
    connectionStrength.set(idx, totalWeight > 0 ? weightedSum / totalWeight : idx);
  });

  // Create optimized ordering
  const optimizedOrder = mergedLanguages
    .map((lang, idx) => ({ lang, idx, strength: connectionStrength.get(idx) || idx }))
    .sort((a, b) => a.strength - b.strength)
    .map(d => d.idx);

  // Reorder matrix according to optimized ordering
  const reorderedMatrix = optimizedOrder.map(i =>
    optimizedOrder.map(j => matrix[i][j])
  );
  const reorderedLanguages = optimizedOrder.map(i => mergedLanguages[i]);

  const svg = container.append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [-width / 2, -height / 2, width, height]);

  const chordGenerator = d3.chord()
    .padAngle(0.04)
    .sortSubgroups(d3.descending)
    .sortChords(d3.descending);

  const arcGenerator = d3.arc()
    .innerRadius(innerRadius)
    .outerRadius(outerRadius);

  const ribbonGenerator = d3.ribbon()
    .radius(innerRadius);

  const color = getLanguageColorScale(reorderedLanguages);

  const chords = chordGenerator(reorderedMatrix);

  const group = svg.append("g")
    .selectAll("g")
    .data(chords.groups)
    .join("g");

  group.append("path")
    .attr("fill", d => color(reorderedLanguages[d.index]))
    .attr("d", arcGenerator)
    .attr("stroke", "none")
    .style("cursor", "pointer")
    .attr("class", "chord-arc")
    .attr("data-lang-index", d => d.index)
    .on("mouseenter", function (event, d) {
      const lang = reorderedLanguages[d.index];
      const langNode = languageData.nodes.find(n => n.id === lang);


      // Get connected languages
      const connectedLangs = new Set();
      chords.forEach(chord => {
        if (chord.source.index === d.index) {
          connectedLangs.add(reorderedLanguages[chord.target.index]);
        }
        if (chord.target.index === d.index) {
          connectedLangs.add(reorderedLanguages[chord.source.index]);
        }
      });


      // Fade unconnected arcs using fill-opacity
      svg.selectAll(".chord-arc")
        .each(function (arcData) {
          const arcLang = reorderedLanguages[arcData.index];
          const shouldBeVisible = arcData.index === d.index || connectedLangs.has(arcLang);
        })
        .attr("fill-opacity", function (arcData) {
          const arcLang = reorderedLanguages[arcData.index];
          return arcData.index === d.index || connectedLangs.has(arcLang) ? 1 : 0.15;
        })
        .attr("stroke-width", function (arcData) {
          return arcData.index === d.index ? 2 : 1;
        })
        .attr("stroke", function (arcData) {
          return arcData.index === d.index ? "#fbbf24" : "rgba(15, 23, 42, 0.3)";
        });

      // Emphasize connected text labels, fade unconnected ones
      svg.selectAll(".chord-label")
        .style("opacity", function (labelData) {
          const labelLang = reorderedLanguages[labelData.index];
          return labelData.index === d.index || connectedLangs.has(labelLang) ? 1 : 0.2;
        })
        .style("font-weight", function (labelData) {
          return labelData.index === d.index ? "bold" : "normal";
        });

      // Emphasize connected ribbons
      svg.selectAll(".ribbon")
        .style("opacity", chord =>
          chord.source.index === d.index || chord.target.index === d.index ? 1.0 : 0.15
        );

      // Enhanced tooltip
      const authorCount = langNode?.authorCount || 0;
      const connections = connectedLangs.size;
      let tooltipHTML = `<strong>${lang.toUpperCase()}</strong><br/>`;
      tooltipHTML += `${formatNumber(d.value)} translations<br/>`;
      tooltipHTML += `${formatNumber(authorCount)} authors<br/>`;
      tooltipHTML += `${connections} connected language${connections !== 1 ? 's' : ''}<br/>`;
      tooltipHTML += `<em style="font-size: 0.85em; color: #cbd5e1;">Click to filter network</em>`;

      chordTooltip
        .style("opacity", 1)
        .html(tooltipHTML)
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseleave", function () {
      svg.selectAll(".ribbon").style("opacity", 1.0);
      svg.selectAll(".chord-arc")
        .attr("fill-opacity", 1)
        .attr("stroke-width", 1)
        .attr("stroke", "rgba(15, 23, 42, 0.3)");
      svg.selectAll(".chord-label")
        .style("opacity", 1)
        .style("font-weight", "normal");
      chordTooltip.style("opacity", 0);
    })
    .on("click", function (event, d) {
      const lang = reorderedLanguages[d.index];
      const langKey = normalizeLanguageKey(lang);
      if (typeof onLanguageClick === "function") {
        onLanguageClick(langKey, event);
      }
    });

  // Add SVG title elements for native tooltips
  group.append("title")
    .text(d => {
      const lang = reorderedLanguages[d.index];
      const langNode = languageData.nodes.find(n => n.id === lang);
      const authorCount = langNode?.authorCount || 0;
      return `${lang.toUpperCase()}\n${formatNumber(d.value)} translations\n${formatNumber(authorCount)} authors`;
    });

  group.append("text")
    .each(d => { d.angle = (d.startAngle + d.endAngle) / 2; })
    .attr("dy", "0.35em")
    .attr("transform", d => `
      rotate(${(d.angle * 180 / Math.PI - 90)})
      translate(${outerRadius + 8})
      ${d.angle > Math.PI ? "rotate(180)" : ""}
    `)
    .attr("text-anchor", d => d.angle > Math.PI ? "end" : "start")
    .text(d => reorderedLanguages[d.index].toUpperCase())
    .style("font-size", "9px")
    .style("fill", "#e5e7eb")
    .style("pointer-events", "none")
    .attr("class", "chord-label");

  svg.append("g")
    .attr("fill-opacity", 1.0)
    .selectAll("path")
    .data(chords)
    .join("path")
    .attr("d", ribbonGenerator)
    .attr("fill", d => color(reorderedLanguages[d.source.index]))
    .attr("stroke", "none")
    .attr("class", "ribbon")
    .style("cursor", "pointer")
    .on("mouseenter", function (event, d) {
      // Fade all ribbons except the hovered one
      svg.selectAll(".ribbon").style("opacity", 0.15);
      d3.select(this).style("opacity", 1.0);

      const sourceLang = reorderedLanguages[d.source.index];
      const targetLang = reorderedLanguages[d.target.index];
      const value = reorderedMatrix[d.source.index][d.target.index];
      chordTooltip
        .style("opacity", 1)
        .html(`<strong>${sourceLang.toUpperCase()}</strong> ↔ <strong>${targetLang.toUpperCase()}</strong><br/>${formatNumber(value)} shared author${value !== 1 ? 's' : ''}`)
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mousemove", function (event) {
      chordTooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseleave", function () {
      // Reset all ribbons to full opacity
      svg.selectAll(".ribbon").style("opacity", 1.0);
      chordTooltip.style("opacity", 0);
    });
}

function createRadialChart(languageData, options = {}) {
  const {
    container: containerSelector = "#radialChart",
    width: customWidth = 400,
    height: customHeight = 400
  } = options;

  const container = d3.select(containerSelector);
  container.selectAll("*").remove();

  if (!languageData || !languageData.nodes) {
    container.append("p")
      .style("color", "#9ca3af")
      .style("font-size", "0.75rem")
      .text("No language data available.");
    return;
  }

  // Create or reuse tooltip
  let radialTooltip = d3.select("body").select(".radial-tooltip");
  if (radialTooltip.empty()) {
    radialTooltip = d3.select("body")
      .append("div")
      .attr("class", "tooltip radial-tooltip")
      .style("position", "absolute")
      .style("padding", "0.5rem 0.8rem")
      .style("background", "rgba(30, 41, 59, 0.95)")
      .style("color", "#fff")
      .style("border-radius", "4px")
      .style("pointer-events", "none")
      .style("font-size", "0.85rem")
      .style("box-shadow", "0 8px 16px rgba(15, 23, 42, 0.4)")
      .style("z-index", "99999")
      .style("opacity", 0);
  }

  const width = customWidth;
  const height = customHeight;
  const radius = Math.min(width, height) / 2;
  const outerRadius = radius * 0.9;
  const innerRadius = outerRadius * 0.6; // Donut thickness
  const centerRadius = 30; // German center circle

  // Filter and sort languages by translation count
  // Keep bilingual (ger) and multilingual (mul) even if they fall outside the top 30
  const preferredLanguageIds = new Set(["ger", "mul"]);
  const filteredLanguages = languageData.nodes
    .filter(node => node.id !== "deu" && node.totalWeight > 0)
    .sort((a, b) => b.totalWeight - a.totalWeight);

  const topLanguages = filteredLanguages.slice(0, 30);
  const preferredLanguages = filteredLanguages.filter(node => preferredLanguageIds.has(node.id));

  const languages = [...topLanguages, ...preferredLanguages]
    .filter((node, idx, arr) => arr.findIndex(n => n.id === node.id) === idx)
    .sort((a, b) => b.totalWeight - a.totalWeight);

  // Use global color scale for consistency with chord diagram
  const allLanguageIds = languageData.nodes.map(n => n.id);
  const color = getLanguageColorScale(allLanguageIds);

  // Create pie layout
  const pie = d3.pie()
    .value(d => d.totalWeight)
    .padAngle(0.01)
    .sort(null);

  const data = pie(languages);

  const svg = container.append("svg")
    .attr("width", width)
    .attr("height", height)
    .attr("viewBox", [-width / 2, -height / 2, width, height]);

  // Create arc generators
  const outerArc = d3.arc()
    .innerRadius(innerRadius)
    .outerRadius(outerRadius);

  const ribbonArc = d3.arc()
    .innerRadius(centerRadius)
    .outerRadius(innerRadius);

  // Draw ribbons (from center to inner radius)
  const ribbons = svg.selectAll(".radial-ribbon")
    .data(data)
    .join("path")
    .attr("class", "radial-ribbon")
    .attr("d", ribbonArc)
    .attr("fill", d => color(d.data.id))
    .attr("opacity", 0.5)
    .attr("stroke", "none")
    .attr("data-lang-id", d => d.data.id)
    .style("cursor", "pointer")
    .on("mouseenter", function (event, d) {
      svg.selectAll(".radial-ribbon").attr("opacity", 0.15);
      svg.selectAll(".radial-arc").attr("opacity", 0.3);
      d3.select(this).attr("opacity", 0.9);
      svg.selectAll(`.radial-arc[data-lang-id="${d.data.id}"]`).attr("opacity", 1);

      radialTooltip
        .style("opacity", 1)
        .html(`<strong>${d.data.id.toUpperCase()}</strong><br/>${formatNumber(d.data.authorCount)} authors<br/>${formatNumber(d.data.totalWeight)} translations`)
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mousemove", function (event) {
      radialTooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseleave", function () {
      svg.selectAll(".radial-ribbon").attr("opacity", 0.5);
      svg.selectAll(".radial-arc").attr("opacity", 1);
      radialTooltip.style("opacity", 0);
    });

  // Draw outer arcs (donut segments)
  const arcs = svg.selectAll(".radial-arc")
    .data(data)
    .join("path")
    .attr("class", "radial-arc")
    .attr("d", outerArc)
    .attr("fill", d => color(d.data.id))
    .attr("opacity", 1)
    .attr("stroke", "none")
    .attr("data-lang-id", d => d.data.id)
    .style("cursor", "pointer")
    .on("mouseenter", function (event, d) {
      svg.selectAll(".radial-ribbon").attr("opacity", 0.15);
      svg.selectAll(".radial-arc").attr("opacity", 0.3);
      d3.select(this).attr("opacity", 1);
      svg.selectAll(`.radial-ribbon[data-lang-id="${d.data.id}"]`).attr("opacity", 0.9);

      radialTooltip
        .style("opacity", 1)
        .html(`<strong>${d.data.id.toUpperCase()}</strong><br/>${formatNumber(d.data.authorCount)} authors<br/>${formatNumber(d.data.totalWeight)} translations`)
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mousemove", function (event) {
      radialTooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseleave", function () {
      svg.selectAll(".radial-ribbon").attr("opacity", 0.5);
      svg.selectAll(".radial-arc").attr("opacity", 1);
      radialTooltip.style("opacity", 0);
    });

  // Add labels
  svg.selectAll(".radial-label")
    .data(data)
    .join("text")
    .attr("class", "radial-label")
    .attr("transform", d => {
      const angle = (d.startAngle + d.endAngle) / 2;
      const x = Math.cos(angle - Math.PI / 2) * (outerRadius + 10);
      const y = Math.sin(angle - Math.PI / 2) * (outerRadius + 10);
      return `translate(${x},${y})`;
    })
    .attr("text-anchor", d => {
      const angle = (d.startAngle + d.endAngle) / 2;
      return angle > Math.PI ? "end" : "start";
    })
    .attr("dominant-baseline", "middle")
    .attr("font-size", "9px")
    .attr("fill", "#e5e7eb")
    .attr("font-weight", "500")
    .style("pointer-events", "none")
    .text(d => d.data.id.toUpperCase());

  // Draw German center
  const germanGroup = svg.append("g").attr("class", "german-center");

  germanGroup.append("circle")
    .attr("r", centerRadius)
    .attr("fill", "rgba(15, 23, 42, 0.85)")
    .attr("stroke", "none");

  germanGroup.append("text")
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "middle")
    .attr("font-size", "14px")
    .attr("font-weight", "bold")
    .attr("fill", "#e5e7eb")
    .text("GER");

  germanGroup.append("text")
    .attr("y", centerRadius + 15)
    .attr("text-anchor", "middle")
    .attr("font-size", "9px")
    .attr("fill", "#94a3b8")
    .attr("font-weight", "600")
    .text("Source Language");
}

async function init() {
  const container = d3.select("#clusterChart");
  const element = container.node();
  const rect = element.getBoundingClientRect();
  const chartWidth = rect.width || 1100;
  const chartHeight = rect.height || 640;

  const pixelRatio = window.devicePixelRatio || 1;
  const canvas = container
    .append("canvas")
    .attr("width", chartWidth * pixelRatio)
    .attr("height", chartHeight * pixelRatio)
    .style("width", `${chartWidth}px`)
    .style("height", `${chartHeight}px`)
    .node();

  const ctx = canvas.getContext("2d");
  ctx.scale(pixelRatio, pixelRatio);

  const tooltip = createTooltip();
  const colorScale = d3.scaleOrdinal(COMMUNITY_COLORS);

  const histogramContainer = document.getElementById("authorAuthorHistogram");
  const weightRangeLabel = document.getElementById("authorAuthorRangeValue");
  const centralizationHistogram = document.getElementById("centralizationHistogram");
  const centralizationRangeLabel = document.getElementById("centralizationRangeValue");
  const centralizationStats = document.getElementById("centralizationStats");
  const authorSearchInput = document.getElementById("authorSearchInput");
  const authorSearchSuggestions = document.getElementById("authorSearchSuggestions");
  const languageRatioStats = document.getElementById("languageRatioStats");
  const languageRatioBarChart = document.getElementById("languageRatioBarChart");
  const clearSelectionBtn = document.getElementById("clearSelection");
  const showEdgesToggle = document.getElementById("showEdgesToggle");
  const translationOpacityToggle = document.getElementById("translationOpacityToggle");
  const sharedEdgesToggle = document.getElementById("sharedEdgesOnly");
  const clusterLanguageFilter = document.getElementById("clusterLanguageFilter");
  const resetClusterFilterBtn = document.getElementById("resetClusterFilter");
  const authorDetailPanel = document.getElementById("authorDetailPanel");
  const legendContainer = null; // legend now drawn on canvas
  const metadataGrid = document.getElementById("metadataGrid");

  const rawData = await loadData();

  // Compute and log network metadata
  const networkMetadata = computeNetworkMetadata(rawData);
  if (typeof renderNetworkMetadata === "function") {
    renderNetworkMetadata(rawData);
  }

  // Compute network metadata (node count, link count, avg degree, density, etc.)
  function computeNetworkMetadata(rawData) {
    if (!rawData || !Array.isArray(rawData.nodes) || !Array.isArray(rawData.links)) {
      return {};
    }
    const nodeCount = rawData.nodes.length;
    const linkCount = rawData.links.length;
    const languageCount = rawData.meta.languagePopularity.languageCount;
    // For undirected graphs, each link connects two nodes
    const possibleLinks = nodeCount * (nodeCount - 1) / 2;
    const density = possibleLinks > 0 ? linkCount / possibleLinks : 0;
    // Compute degree for each node
    const degreeMap = new Map();
    rawData.links.forEach(link => {
      degreeMap.set(link.source, (degreeMap.get(link.source) || 0) + 1);
      degreeMap.set(link.target, (degreeMap.get(link.target) || 0) + 1);
    });
    const degrees = Array.from(degreeMap.values());
    const avgDegree = degrees.length ? degrees.reduce((a, b) => a + b, 0) / degrees.length : 0;
    const maxDegree = degrees.length ? Math.max(...degrees) : 0;
    const minDegree = degrees.length ? Math.min(...degrees) : 0;
    const modularity = rawData?.meta?.greedyModularity;

    return {
      nodeCount,
      linkCount,
      languageCount,
      density: Number(density.toFixed(4)),
      avgDegree: Number(avgDegree.toFixed(2)),
      maxDegree,
      minDegree,
      modularity
    };
  }

  function renderNetworkMetadata(authorData) {
    if (!metadataGrid) return;
    const a = computeNetworkMetadata(authorData || {});

    const intOrNA = (v) => (v === undefined || v === null || Number.isNaN(Number(v)) ? "N/A" : formatNumber(v));
    const decOrNA = (v, d = 2) => (Number.isFinite(v) ? Number(v).toFixed(d) : "N/A");

    metadataGrid.innerHTML = `
      <div class="metadata-header"><strong>Metric</strong></div>
      <div class="metadata-header"><strong>Translation Network</strong></div>

      <div class="metric-label">Num. Authors</div>
      <div class="metric-value">${intOrNA(a.nodeCount)}</div>

      <div class="metric-label">Num. Shared Translations</div>
      <div class="metric-value">${intOrNA(a.linkCount)}</div>

      <div class="metric-label">Num. Languages</div>
      <div class="metric-value">${intOrNA(a.languageCount)}</div>

      <div class="metric-label">Avg. Degree</div>
      <div class="metric-value">${decOrNA(a.avgDegree, 2)}</div>

      <div class="metric-label">Max degree</div>
      <div class="metric-value">${intOrNA(a.maxDegree)}</div>
      
      <div class="metric-label">Min degree</div>
      <div class="metric-value">${intOrNA(a.minDegree)}</div>
      
      <div class="metric-label">Density</div>
      <div class="metric-value">${decOrNA(a.density, 4)}</div>

      <div class="metric-label">Modularity (Greedy)</div>
      <div class="metric-value">${decOrNA(a.modularity, 4)}</div>
    `;
  }

  const nodeById = new Map();
  const nodes = rawData.nodes.map((original) => {
    const node = { ...original };
    ensureNodeLanguageSet(node);
    node._labelNormalized = (node.label || `${node.id || ""}`).trim().toLowerCase();
    const keys = [];
    if (original.id !== undefined && original.id !== null) {
      keys.push(original.id);
      keys.push(String(original.id));
      const numericId = Number(original.id);
      if (!Number.isNaN(numericId)) {
        keys.push(numericId);
      }
    }
    keys.forEach((key) => nodeById.set(key, node));
    return node;
  });

  const linkByPair = new Map();
  const links = rawData.links
    .map((link) => {
      const sourceNode = nodeById.get(link.source);
      const targetNode = nodeById.get(link.target);
      if (!sourceNode || !targetNode) return null;
      const entry = {
        ...link,
        sourceNode,
        targetNode,
      };
      linkByPair.set(canonicalLinkKey(sourceNode.id, targetNode.id), entry);
      return entry;
    })
    .filter(Boolean);
  const communityKeys = inferCommunityKeys(nodes);
  const defaultCommunityKey = communityKeys[0] || null;
  const defaultCentralityMetric = selectDefaultCentralityMetric(rawData.meta);
  const translationWeightExtent = d3.extent(nodes, (node) => Number(node.totalWeight) || 0);

  // Build adjacency map for fast neighbor lookup (place here, after links, before state)
  const adjacencyMap = buildAdjacencyMap(links);

  const state = {
    canvas,
    ctx,
    width: chartWidth,
    height: chartHeight,
    tooltip,
    colorScale,
    communityKey: defaultCommunityKey,
    centralityMetric: defaultCentralityMetric,
    transform: d3.zoomIdentity,
    hoverNode: null,
    focusNodeId: null,
    focusVisible: null,
    selectedIds: new Set(),
    selectionVisibleNodes: null,
    weightRange: null,
    centralizationRange: null,
    languageFilter: null,
    rings: buildRings(chartWidth, chartHeight),
    baseData: rawData,
    nodes,
    links,
    nodeById,
    linkByPair,
    radiusScale: null,
    maxLinkWeight: 1,
    quadtree: null,
    clusterFilter: new Set(),
    clusterFilterController: null,
    communitySummaries: [],
    onlySharedSelectionLinks: false,
    showEdges: false,
    searchMatches: null,
    searchQuery: "",
    useTranslationOpacity: false,
    translationWeightExtent,
    detailHoverConnection: null,
    tierFilter: new Set(),
    legendTierRegions: [],
    adjacencyMap,
    top20Filter: false,
  };

  const allWeights = links
    .map((link) => Number(link.weight || 0))
    .filter((v) => Number.isFinite(v) && v > 0);

  const formatWeightValue = (value) => {
    if (!Number.isFinite(value)) {
      return value === Number.POSITIVE_INFINITY ? "∞" : "?";
    }
    return Math.abs(value - Math.round(value)) < 1e-3 ? String(Math.round(value)) : value.toFixed(1);
  };

  const updateWeightRangeLabel = (range) => {
    if (!weightRangeLabel) return;
    if (!Array.isArray(range) || range.length !== 2) {
      weightRangeLabel.textContent = "Showing all connection weights.";
      return;
    }
    const [start, end] = range;
    weightRangeLabel.textContent = `Showing links with weights ${formatWeightValue(start)}–${formatWeightValue(end)}`;
  };

  const formatCentralizationValue = (value) => {
    if (!Number.isFinite(value)) return "?";
    return value.toFixed(3);
  };

  const updateCentralizationRangeLabel = (range) => {
    if (!centralizationRangeLabel) return;
    if (!Array.isArray(range) || range.length !== 2) {
      centralizationRangeLabel.textContent = "Showing authors across all languageCentrality scores.";
      return;
    }
    const [start, end] = range;
    centralizationRangeLabel.textContent = `Showing authors with languageCentrality scores ${formatCentralizationValue(
      start
    )}–${formatCentralizationValue(end)}`;
  };

  const weightExtent = d3.extent(allWeights);
  let activeWeightRange = null;
  let weightFilterReady = false;

  if (histogramContainer && allWeights.length) {
    const [globalMin = 1, globalMax = 1] = weightExtent;
    const suggestedMin = Math.min(globalMax, Math.max(globalMin, 3));
    activeWeightRange = [suggestedMin, globalMax];
    updateWeightRangeLabel(activeWeightRange);

    buildHistogram(histogramContainer, allWeights, {
      interactive: true,
      initialRange: activeWeightRange,
      onRangeChange: (range) => {
        activeWeightRange = range.slice();
        updateWeightRangeLabel(activeWeightRange);
        if (weightFilterReady) {
          applyWeightFilterAndRedraw(activeWeightRange);
        }
      },
    });
  } else {
    updateWeightRangeLabel(activeWeightRange);
  }

  if (!activeWeightRange && weightExtent && weightExtent.every((value) => Number.isFinite(value))) {
    activeWeightRange = weightExtent.slice();
    updateWeightRangeLabel(activeWeightRange);
  }

  const centralizationValues = nodes
    .map((node) =>
      Number(
        node.centralizationScoreNormalized ?? node.centralizationScore ?? Number.NaN
      )
    )
    .filter((value) => Number.isFinite(value));
  let activeCentralizationRange = null;
  let centralizationFilterReady = false;
  if (centralizationHistogram) {
    if (centralizationValues.length) {
      const thresholds = computeCentralizationThresholds(centralizationValues);
      setCentralizationThresholds(thresholds);
      const [centralMin = 0, centralMax = 1] = d3.extent(centralizationValues);
      activeCentralizationRange = [centralMin, centralMax];
      updateCentralizationRangeLabel(activeCentralizationRange);

      buildHistogram(centralizationHistogram, centralizationValues, {
        interactive: true,
        initialRange: activeCentralizationRange,
        onRangeChange: (range) => {
          activeCentralizationRange = range.slice();
          updateCentralizationRangeLabel(activeCentralizationRange);
          if (centralizationFilterReady) {
            applyCentralizationFilter(activeCentralizationRange);
          }
        },
      });

      if (centralizationStats) {
        const median = d3.median(centralizationValues) ?? 0;
        const mean = d3.mean(centralizationValues) ?? 0;
        const min = d3.min(centralizationValues) ?? 0;
        const max = d3.max(centralizationValues) ?? 0;
        const tierSummary = `Core ${getTierRangeLabel("core", thresholds)} • Periphery ${getTierRangeLabel(
          "periphery",
          thresholds
        )} • Outer ${getTierRangeLabel("outer", thresholds)}`;
        centralizationStats.textContent = `Median ${median.toFixed(3)} • Mean ${mean.toFixed(
          3
        )} • Range ${min.toFixed(3)}–${max.toFixed(3)}. ${tierSummary}`;
      }
    } else {
      updateCentralizationRangeLabel(null);
      if (centralizationStats) {
        centralizationStats.textContent = "Centralization scores unavailable.";
      }
    }
  } else {
    updateCentralizationRangeLabel(null);
  }

  let languageRatioEntries = [];
  try {
    languageRatioEntries = await computeLanguageRatioEntries(rawData);
  } catch (error) {
    console.error("Failed to compute language ratios", error);
    languageRatioEntries = [];
  }
  if (languageRatioStats) {
    const fmt = (value) => `${(value * 100).toFixed(2)}%`;
    if (languageRatioEntries.length) {
      const median = d3.median(languageRatioEntries, (d) => d.ratio) ?? 0;
      const mean = d3.mean(languageRatioEntries, (d) => d.ratio) ?? 0;
      const max = d3.max(languageRatioEntries, (d) => d.ratio) ?? 0;
      languageRatioStats.textContent = `Median ${fmt(median)} • Mean ${fmt(mean)} • Max ${fmt(
        max
      )} • ${languageRatioEntries.length} languages • Click bars to filter (Ctrl+click for multi).`;
    } else {
      languageRatioStats.textContent = "Language ratio data unavailable.";
    }
  }

  const handleLanguageFilterToggle = (entry, meta = {}) => {
    if (!entry?.key) return;
    const multi = Boolean(meta.multi);
    const next = new Set(state.languageFilter || []);
    if (multi) {
      if (next.has(entry.key)) next.delete(entry.key);
      else next.add(entry.key);
    } else {
      if (next.size === 1 && next.has(entry.key)) {
        next.clear();
      } else {
        next.clear();
        next.add(entry.key);
      }
    }
    state.languageFilter = next.size ? next : null;
    if (state.languageFilter && state.selectedIds.size) {
      for (const selectedId of Array.from(state.selectedIds)) {
        const node = state.nodeById?.get(selectedId);
        if (!node) {
          state.selectedIds.delete(selectedId);
          continue;
        }
        const languageSet = ensureNodeLanguageSet(node);
        let intersects = false;
        for (const lang of state.languageFilter) {
          if (languageSet.has(lang)) {
            intersects = true;
            break;
          }
        }
        if (!intersects) {
          state.selectedIds.delete(selectedId);
        }
      }
    }
    updateLanguageRatioFilterDisplay();
    updateSelectionNeighborhood(state);
    updateAuthorDetailPanel();
    updateFilterStatus();
    draw();
  };

  const updateLanguageRatioFilterDisplay = () => {
    if (!languageRatioBarChart) return;
    try {
      renderLanguageRatioBars(languageRatioBarChart, languageRatioEntries, {
        selectedKeys: state.languageFilter,
        onSelectionChange: handleLanguageFilterToggle,
      });
    } catch (error) {
      console.error("Failed to render language ratio bar chart", error);
      d3.select(languageRatioBarChart)
        .selectAll("*")
        .remove()
        .append("div")
        .attr("class", "selection-hint")
        .text("Language ratio bar chart failed to render.");
    }
  };

  updateLanguageRatioFilterDisplay();

  // Update filter status bar
  const updateFilterStatus = () => {
    const filterStatusItems = d3.select("#filterStatusItems");
    if (filterStatusItems.empty()) return;

    filterStatusItems.selectAll("*").remove();

    // Language filters
    if (state.languageFilter && state.languageFilter.size > 0) {
      const languages = Array.from(state.languageFilter).sort();
      languages.forEach(lang => {
        const badge = filterStatusItems.append("div")
          .attr("class", "filter-status-item filter-type-language");

        badge.append("span")
          .attr("class", "filter-label")
          .text(`Language: ${lang}`);

        badge.append("button")
          .attr("type", "button")
          .attr("class", "filter-status-item-remove")
          .attr("aria-label", "Remove language filter")
          .attr("title", "Remove this filter")
          .text("×")
          .on("click", () => {
            state.languageFilter.delete(lang);
            if (state.languageFilter.size === 0) {
              state.languageFilter = null;
            }
            updateLanguageRatioFilterDisplay();
            updateSelectionNeighborhood(state);
            updateAuthorDetailPanel();
            updateFilterStatus();
            draw();
          });
      });
    }

    // Cluster filters
    if (state.clusterFilter && state.clusterFilter.size > 0) {
      const clusters = Array.from(state.clusterFilter).sort();
      clusters.forEach(cluster => {
        const badge = filterStatusItems.append("div")
          .attr("class", "filter-status-item filter-type-cluster");

        badge.append("span")
          .attr("class", "filter-label")
          .text(`Cluster: ${cluster}`);

        badge.append("button")
          .attr("type", "button")
          .attr("class", "filter-status-item-remove")
          .attr("aria-label", "Remove cluster filter")
          .attr("title", "Remove this filter")
          .text("×")
          .on("click", () => {
            state.clusterFilter.delete(cluster);
            if (state.clusterFilterController) {
              state.clusterFilterController.toggleCluster(cluster);
            }
            updateClusterVisibility(state);
            updateAuthorDetailPanel();
            updateFilterStatus();
            draw();
          });
      });
    }

    // Weight range filter
    if (state.weightRange && (state.weightRange.min > 0 || state.weightRange.max < Number.POSITIVE_INFINITY)) {
      const badge = filterStatusItems.append("div")
        .attr("class", "filter-status-item filter-type-weight");

      const minStr = state.weightRange.min.toFixed(2);
      const maxStr = state.weightRange.max === Number.POSITIVE_INFINITY ? "∞" : state.weightRange.max.toFixed(2);

      badge.append("span")
        .attr("class", "filter-label")
        .text(`Weight: ${minStr} - ${maxStr}`);

      badge.append("button")
        .attr("type", "button")
        .attr("class", "filter-status-item-remove")
        .attr("aria-label", "Remove weight filter")
        .attr("title", "Remove this filter")
        .text("×")
        .on("click", () => {
          state.weightRange = { min: 0, max: Number.POSITIVE_INFINITY };
          filterByWeightState(state, state.weightRange);
          updateSelectionNeighborhood(state);
          updateFilterStatus();
          draw();
        });
    }

    // LanguageCentrality range filter
    if (state.centralizationRange) {
      const badge = filterStatusItems.append("div")
        .attr("class", "filter-status-item filter-type-languagecentrality");

      const minStr = state.centralizationRange.min.toFixed(3);
      const maxStr = state.centralizationRange.max.toFixed(3);

      badge.append("span")
        .attr("class", "filter-label")
        .text(`LanguageCentrality: ${minStr} - ${maxStr}`);

      badge.append("button")
        .attr("type", "button")
        .attr("class", "filter-status-item-remove")
        .attr("aria-label", "Remove centralization filter")
        .attr("title", "Remove this filter")
        .text("×")
        .on("click", () => {
          state.centralizationRange = null;
          updateFilterStatus();
          draw();
        });
    }

    // Tier filters
    if (state.tierFilter && state.tierFilter.size > 0) {
      const tiers = Array.from(state.tierFilter).sort();
      tiers.forEach(tier => {
        const badge = filterStatusItems.append("div")
          .attr("class", "filter-status-item filter-type-languagecentrality");

        const label = CENTRALIZATION_TIER_LABELS[tier] || tier;
        badge.append("span")
          .attr("class", "filter-label")
          .text(`Tier: ${label}`);

        badge.append("button")
          .attr("type", "button")
          .attr("class", "filter-status-item-remove")
          .attr("aria-label", "Remove tier filter")
          .attr("title", "Remove this filter")
          .text("×")
          .on("click", () => {
            state.tierFilter.delete(tier);
            updateFilterStatus();
            draw();
          });
      });
    }

    // Selected nodes
    if (state.selectedIds && state.selectedIds.size > 0) {
      const badge = filterStatusItems.append("div")
        .attr("class", "filter-status-item filter-type-selection");

      const count = state.selectedIds.size;
      const label = count === 1 ? "1 node selected" : `${count} nodes selected`;

      badge.append("span")
        .attr("class", "filter-label")
        .text(label);

      badge.append("button")
        .attr("type", "button")
        .attr("class", "filter-status-item-remove")
        .attr("aria-label", "Clear selection")
        .attr("title", "Clear selection")
        .text("×")
        .on("click", () => {
          state.selectedIds.clear();
          state.focusNodeId = null;
          state.focusVisible = null;
          updateSelectionNeighborhood(state);
          updateAuthorDetailPanel();
          updateFilterStatus();
          draw();
        });
    }

    // Optional toggles
    const toggles = [];
    if (!state.showEdges) toggles.push("Edges hidden");
    if (state.useTranslationOpacity) toggles.push("Translation opacity");
    if (state.onlySharedSelectionLinks) toggles.push("Shared links only");
    if (state.top20Filter) toggles.push("Top 20 authors");

    toggles.forEach(label => {
      const badge = filterStatusItems.append("div")
        .attr("class", "filter-status-item filter-type-option");

      badge.append("span")
        .attr("class", "filter-label")
        .text(label);
    });

    // Show/hide the status bar
    const statusBar = d3.select("#filterStatusBar");
    const hasFilters = state.languageFilter?.size > 0
      || state.clusterFilter?.size > 0
      || (state.weightRange && (state.weightRange.min > 0 || state.weightRange.max < Number.POSITIVE_INFINITY))
      || state.centralizationRange
      || state.selectedIds?.size > 0
      || state.tierFilter?.size > 0
      || !state.showEdges
      || state.useTranslationOpacity
      || state.onlySharedSelectionLinks
      || state.top20Filter;

    statusBar.style("display", hasFilters ? "flex" : "none");
  };

  // Clear all filters button
  d3.select("#clearAllFilters").on("click", () => {
    state.languageFilter = null;
    state.clusterFilter = new Set();
    state.weightRange = { min: 0, max: Number.POSITIVE_INFINITY };
    state.centralizationRange = null;
    state.tierFilter = new Set();
    state.selectedIds.clear();
    state.focusNodeId = null;
    state.focusVisible = null;
    state.top20Filter = false;

    // Reset UI controls
    if (state.clusterFilterController) {
      state.clusterFilterController.clear();
    }
    const top20AuthorsBtn = document.getElementById("top20AuthorsBtn");
    if (top20AuthorsBtn) {
      top20AuthorsBtn.textContent = "Show Top 20 Authors";
      top20AuthorsBtn.classList.remove("active");
    }
    updateLanguageRatioFilterDisplay();
    filterByWeightState(state, state.weightRange);
    updateClusterVisibility(state);
    updateSelectionNeighborhood(state);
    updateAuthorDetailPanel();
    updateFilterStatus();
    draw();
  });

  updateFilterStatus();

  // Load and render chord diagram with click handler
  let languageLanguageData = null;
  try {
    languageLanguageData = await loadJSONWithGzFallback(LANGUAGE_LANGUAGE_URL);
    createChordDiagram(languageLanguageData, {
      onLanguageClick: (langKey, event) => {
        // Trigger language filter toggle
        const entry = { key: langKey, language: langKey };
        const multi = event.ctrlKey || event.metaKey;
        handleLanguageFilterToggle(entry, { multi });
      }
    });
    // Refresh header metadata (author-author only)
    try {
      if (typeof renderNetworkMetadata === "function") {
        renderNetworkMetadata(rawData);
      }
    } catch (e) {
      console.warn("Failed to render network metadata:", e);
    }
  } catch (error) {
    console.warn("Could not load language-language data for chord diagram:", error);
  }

  // Maximize chord diagram button handler
  const maximizeChordBtn = document.getElementById("maximizeChordBtn");
  const chordModal = document.getElementById("chordModal");
  const closeChordModal = document.getElementById("closeChordModal");

  if (maximizeChordBtn && chordModal && closeChordModal && languageLanguageData) {
    maximizeChordBtn.addEventListener("click", () => {
      chordModal.style.display = "flex";
      // Render larger chord diagram in modal
      createChordDiagram(languageLanguageData, {
        container: "#chordDiagramLarge",
        width: 600,
        height: 600,
        onLanguageClick: (langKey, event) => {
          const entry = { key: langKey, language: langKey };
          const multi = event.ctrlKey || event.metaKey;
          handleLanguageFilterToggle(entry, { multi });
          // Keep modal open after filtering
        }
      });
    });

    closeChordModal.addEventListener("click", () => {
      chordModal.style.display = "none";
      // Clear the large diagram
      d3.select("#chordDiagramLarge").selectAll("*").remove();
    });

    // Close modal when clicking outside
    chordModal.addEventListener("click", (event) => {
      if (event.target === chordModal) {
        chordModal.style.display = "none";
        d3.select("#chordDiagramLarge").selectAll("*").remove();
      }
    });

    // Close modal with Escape key
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && chordModal.style.display === "flex") {
        chordModal.style.display = "none";
        d3.select("#chordDiagramLarge").selectAll("*").remove();
      }
    });
  }


  // Load and render radial chart
  if (languageLanguageData) {
    createRadialChart(languageLanguageData, {
      container: "#radialChart",
      width: 400,
      height: 400
    });
  }

  // Maximize radial chart button handler
  const maximizeRadialBtn = document.getElementById("maximizeRadialBtn");
  const radialModal = document.getElementById("radialModal");

  if (maximizeRadialBtn && radialModal && languageLanguageData) {
    const closeRadialModalBtn = document.getElementById("closeRadialModal");

    maximizeRadialBtn.addEventListener("click", () => {
      radialModal.style.display = "flex";
      // Render larger radial chart in modal
      createRadialChart(languageLanguageData, {
        container: "#radialChartZoomed",
        width: 600,
        height: 600
      });
    });

    if (closeRadialModalBtn) {
      closeRadialModalBtn.addEventListener("click", () => {
        radialModal.style.display = "none";
        d3.select("#radialChartZoomed").selectAll("*").remove();
      });
    }

    // Close modal when clicking outside
    radialModal.addEventListener("click", (event) => {
      if (event.target === radialModal) {
        radialModal.style.display = "none";
        d3.select("#radialChartZoomed").selectAll("*").remove();
      }
    });

    // Close modal with Escape key
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && radialModal.style.display === "flex") {
        radialModal.style.display = "none";
        d3.select("#radialChartZoomed").selectAll("*").remove();
      }
    });
  }


  function resolveNodeByAnyId(candidateId) {
    if (candidateId === undefined || candidateId === null) return null;
    if (nodeById.has(candidateId)) return nodeById.get(candidateId);
    const numericId = Number(candidateId);
    if (!Number.isNaN(numericId) && nodeById.has(numericId)) {
      return nodeById.get(numericId);
    }
    const stringId = String(candidateId);
    if (nodeById.has(stringId)) {
      return nodeById.get(stringId);
    }
    return null;
  }

  function handleDetailConnectionHover(sourceId, targetId) {
    if (!sourceId || !targetId) {
      if (state.detailHoverConnection) {
        state.detailHoverConnection = null;
        draw();
      }
      return;
    }
    const sourceNode = resolveNodeByAnyId(sourceId);
    const targetNode = resolveNodeByAnyId(targetId);
    if (!sourceNode || !targetNode) {
      if (state.detailHoverConnection) {
        state.detailHoverConnection = null;
        draw();
      }
      return;
    }
    const link = getLinkBetween(state, sourceNode.id, targetNode.id);
    state.detailHoverConnection = {
      sourceNode,
      targetNode,
      link,
    };
    draw();
  }

  function getPrimaryDetailNode() {
    if (state.focusNodeId && state.nodeById.has(state.focusNodeId)) {
      return state.nodeById.get(state.focusNodeId);
    }
    for (const id of state.selectedIds) {
      const node = state.nodeById.get(id);
      if (node) return node;
    }
    return null;
  }

  function getTopConnections(node, limit = 5) {
    if (!node) return [];
    const ties = [];
    state.links.forEach((link) => {
      let other = null;
      if (link.sourceNode?.id === node.id) other = link.targetNode;
      else if (link.targetNode?.id === node.id) other = link.sourceNode;
      if (!other) return;
      const weight = Number(link.weight) || 0;
      if (weight <= 0) return;
      ties.push({ id: other.id, label: other.label || other.id, weight });
    });
    return ties
      .sort((a, b) => b.weight - a.weight || (a.label || "").localeCompare(b.label || ""))
      .slice(0, limit);
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderList(items) {
    return `<ul class="author-detail-list">${items
      .map(
        (item) =>
          `<li><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.detail)}</span></li>`
      )
      .join("")}</ul>`;
  }

  function formatPercent(ratio) {
    const clamped = Math.max(0, Math.min(1, ratio)) || 0;
    return `${(clamped * 100).toFixed(1)}%`;
  }

  function updateAuthorDetailPanel() {
    if (!authorDetailPanel) return;
    handleDetailConnectionHover(null);

    // Get all selected nodes
    const selectedNodes = Array.from(state.selectedIds)
      .map(id => state.nodeById.get(id))
      .filter(n => n);

    if (selectedNodes.length === 0) {
      authorDetailPanel.innerHTML =
        '<p class="author-detail-empty">Select an author to see translation stats and relationship insights.</p>';
      return;
    }

    // Single author: show detailed view
    if (selectedNodes.length === 1) {
      renderSingleAuthorDetail(selectedNodes[0]);
      return;
    }

    // Multiple authors: show comparison view
    renderMultiAuthorComparison(selectedNodes);
  }

  function renderSingleAuthorDetail(node) {
    const totalTranslations = Number(node.totalWeight) || 0;
    const languages = (node.languages || [])
      .map((entry) => ({
        language: (entry.language || "").trim(),
        weight: Number(entry.weight) || 0,
      }))
      .filter((entry) => entry.language && entry.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 4);

    const languageItems = languages.map((entry) => {
      const ratio = totalTranslations > 0 ? entry.weight / totalTranslations : 0;
      return {
        label: entry.language.toUpperCase(),
        detail: `${formatNumber(entry.weight)} • ${formatPercent(ratio)}`,
      };
    });

    const connectionEntries = getTopConnections(node, 5).filter(
      (entry) => entry.id !== undefined && entry.id !== null
    );
    const connections = connectionEntries.map((entry) => ({
      id: entry.id,
      label: entry.label || "n/a",
      detail: `${formatNumber(entry.weight)} weight`,
    }));

    const centralityMetricLabel = formatCentralityLabel(state.centralityMetric);
    const centralityScore = state.centralityMetric
      ? Number(node.centrality?.[state.centralityMetric])
      : Number.NaN;

    const normalizedCentralization = Number(node.centralizationScoreNormalized);
    const rawCentralization = Number(node.centralizationScore);
    const tier = node._centralizationTier;
    const tierLabel = CENTRALIZATION_TIER_LABELS[tier] || "Centrality tier";
    const communityId = state.communityKey != null ? node.communities?.[state.communityKey] : null;
    const communityLabel =
      communityId === null || communityId === undefined ? "Unassigned community" : `Community ${communityId}`;

    const topLanguageLabel = languageItems[0]?.label || null;
    const metaLineParts = [communityLabel];
    if (topLanguageLabel) {
      metaLineParts.push(`Lead language ${topLanguageLabel}`);
    } else if ((node.languages || []).length) {
      metaLineParts.push(`${(node.languages || []).length} languages`);
    }
    const metaLine = metaLineParts.join(" • ");

    const languagesMarkup = languageItems.length
      ? renderList(languageItems)
      : '<p class="author-detail-empty">No translation breakdown available.</p>';
    const connectionsMarkup = connections.length
      ? `<ul class="author-detail-list author-detail-connections">${connections
        .map(
          (entry) =>
            `<li data-connection-id="${escapeHtml(String(entry.id))}" tabindex="0"><strong>${escapeHtml(
              entry.label
            )}</strong><span>${escapeHtml(entry.detail)}</span></li>`
        )
        .join("")}</ul>`
      : '<p class="author-detail-empty">No weighted connections recorded.</p>';

    authorDetailPanel.innerHTML = `
      <div class="author-detail-header">
        <div>
          <p class="author-detail-name">${escapeHtml(node.label || node.id)}</p>
          <p class="author-detail-meta">${escapeHtml(metaLine)}</p>
        </div>
        <span class="author-detail-badge">${escapeHtml(tierLabel)}</span>
      </div>
      <div class="author-detail-metrics">
        <div class="author-detail-metric">
          <span>Total translations</span>
          <strong>${formatNumber(totalTranslations)}</strong>
        </div>
        <div class="author-detail-metric">
          <span>${escapeHtml(centralityMetricLabel)}</span>
          <strong>${Number.isFinite(centralityScore) ? centralityScore.toFixed(3) : "n/a"}</strong>
        </div>
        <div class="author-detail-metric">
          <span>Centralization</span>
          <strong>${Number.isFinite(normalizedCentralization)
        ? normalizedCentralization.toFixed(3)
        : Number.isFinite(rawCentralization)
          ? rawCentralization.toFixed(3)
          : "n/a"
      }</strong>
        </div>
      </div>
      <div class="author-detail-section">
        <h3>Top languages</h3>
        ${languagesMarkup}
      </div>
      <div class="author-detail-section">
        <h3>Strongest ties</h3>
        ${connectionsMarkup}
      </div>
    `;

    const connectionItems = authorDetailPanel.querySelectorAll(
      ".author-detail-connections li[data-connection-id]"
    );
    if (connectionItems.length === 0) {
      handleDetailConnectionHover(null);
    } else {
      connectionItems.forEach((item) => {
        const targetId = item.getAttribute("data-connection-id");
        item.addEventListener("mouseenter", () => handleDetailConnectionHover(node.id, targetId));
        item.addEventListener("mouseleave", () => handleDetailConnectionHover(null));
        item.addEventListener("focus", () => handleDetailConnectionHover(node.id, targetId));
        item.addEventListener("blur", () => handleDetailConnectionHover(null));
      });
    }
  }

  function renderMultiAuthorComparison(nodes) {
    const count = nodes.length;
    const names = nodes.map(n => n.label || n.id).join(", ");
    const truncatedNames = names.length > 60 ? names.substring(0, 57) + "..." : names;

    // Calculate shared connections (intersection)
    const connectionsByAuthor = nodes.map(node => {
      const connections = new Map();
      state.links.forEach((link) => {
        let other = null;
        if (link.sourceNode?.id === node.id) other = link.targetNode;
        else if (link.targetNode?.id === node.id) other = link.sourceNode;
        if (other && !nodes.find(n => n.id === other.id)) {
          connections.set(other.id, {
            id: other.id,
            label: other.label || other.id,
            weight: Number(link.weight) || 0
          });
        }
      });
      return connections;
    });

    // Intersection: connections shared by ALL selected authors
    const sharedConnections = new Map();
    if (connectionsByAuthor.length > 0) {
      connectionsByAuthor[0].forEach((conn, id) => {
        const sharedByAll = connectionsByAuthor.slice(1).every(authorConns => authorConns.has(id));
        if (sharedByAll) {
          // Sum weights across all authors
          const totalWeight = connectionsByAuthor.reduce((sum, authorConns) => {
            return sum + (authorConns.get(id)?.weight || 0);
          }, 0);
          sharedConnections.set(id, { ...conn, weight: totalWeight });
        }
      });
    }

    // Union: all unique connections
    const allConnections = new Map();
    connectionsByAuthor.forEach(authorConns => {
      authorConns.forEach((conn, id) => {
        if (allConnections.has(id)) {
          allConnections.get(id).weight += conn.weight;
        } else {
          allConnections.set(id, { ...conn });
        }
      });
    });

    // Calculate shared languages (intersection)
    const languagesByAuthor = nodes.map(node => {
      const langs = new Map();
      (node.languages || []).forEach(entry => {
        const lang = (entry.language || "").trim();
        const weight = Number(entry.weight) || 0;
        if (lang && weight > 0) {
          langs.set(lang, weight);
        }
      });
      return langs;
    });

    // Intersection: languages used by ALL authors
    const sharedLanguages = new Map();
    if (languagesByAuthor.length > 0) {
      languagesByAuthor[0].forEach((weight, lang) => {
        const sharedByAll = languagesByAuthor.slice(1).every(authorLangs => authorLangs.has(lang));
        if (sharedByAll) {
          const totalWeight = languagesByAuthor.reduce((sum, authorLangs) => {
            return sum + (authorLangs.get(lang) || 0);
          }, 0);
          sharedLanguages.set(lang, totalWeight);
        }
      });
    }

    // Union: all unique languages
    const allLanguages = new Map();
    languagesByAuthor.forEach(authorLangs => {
      authorLangs.forEach((weight, lang) => {
        if (allLanguages.has(lang)) {
          allLanguages.set(lang, allLanguages.get(lang) + weight);
        } else {
          allLanguages.set(lang, weight);
        }
      });
    });

    // Format shared connections
    const topSharedConnections = Array.from(sharedConnections.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);

    const sharedConnectionsMarkup = topSharedConnections.length
      ? `<ul class="author-detail-list author-detail-connections">${topSharedConnections
        .map(entry =>
          `<li data-connection-id="${escapeHtml(String(entry.id))}" tabindex="0">
              <strong>${escapeHtml(entry.label)}</strong>
              <span>${formatNumber(entry.weight)} combined</span>
            </li>`
        ).join("")}</ul>`
      : '<p class="author-detail-empty">No shared connections found.</p>';

    // Format all connections
    const topAllConnections = Array.from(allConnections.values())
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);

    const allConnectionsMarkup = topAllConnections.length
      ? `<ul class="author-detail-list">${topAllConnections
        .map(entry =>
          `<li><strong>${escapeHtml(entry.label)}</strong><span>${formatNumber(entry.weight)} combined</span></li>`
        ).join("")}</ul>`
      : '<p class="author-detail-empty">No connections found.</p>';

    // Format shared languages
    const topSharedLanguages = Array.from(sharedLanguages.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const sharedLanguagesMarkup = topSharedLanguages.length
      ? `<ul class="author-detail-list">${topSharedLanguages
        .map(([lang, weight]) =>
          `<li><strong>${escapeHtml(lang.toUpperCase())}</strong><span>${formatNumber(weight)} combined</span></li>`
        ).join("")}</ul>`
      : '<p class="author-detail-empty">No shared languages found.</p>';

    // Format all languages
    const topAllLanguages = Array.from(allLanguages.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);

    const allLanguagesMarkup = topAllLanguages.length
      ? `<ul class="author-detail-list">${topAllLanguages
        .map(([lang, weight]) =>
          `<li><strong>${escapeHtml(lang.toUpperCase())}</strong><span>${formatNumber(weight)} combined</span></li>`
        ).join("")}</ul>`
      : '<p class="author-detail-empty">No languages found.</p>';

    // Calculate summary metrics
    const totalTranslations = nodes.reduce((sum, n) => sum + (Number(n.totalWeight) || 0), 0);
    const avgCentralization = nodes.reduce((sum, n) => {
      const norm = Number(n.centralizationScoreNormalized);
      return sum + (Number.isFinite(norm) ? norm : 0);
    }, 0) / nodes.length;

    authorDetailPanel.innerHTML = `
      <div class="author-detail-header">
        <div>
          <p class="author-detail-name">${count} Authors Selected</p>
          <p class="author-detail-meta" title="${escapeHtml(names)}">${escapeHtml(truncatedNames)}</p>
        </div>
        <span class="author-detail-badge">Comparison</span>
      </div>
      <div class="author-detail-metrics">
        <div class="author-detail-metric">
          <span>Combined translations</span>
          <strong>${formatNumber(totalTranslations)}</strong>
        </div>
        <div class="author-detail-metric">
          <span>Shared connections</span>
          <strong>${sharedConnections.size}</strong>
        </div>
        <div class="author-detail-metric">
          <span>Avg. centralization</span>
          <strong>${Number.isFinite(avgCentralization) ? avgCentralization.toFixed(3) : "n/a"}</strong>
        </div>
      </div>
      <div class="author-detail-section">
        <h3>Shared Languages (${sharedLanguages.size})</h3>
        ${sharedLanguagesMarkup}
      </div>
      <div class="author-detail-section">
        <h3>All Languages (${allLanguages.size})</h3>
        ${allLanguagesMarkup}
      </div>
      <div class="author-detail-section">
        <h3>Shared Connections (${sharedConnections.size})</h3>
        ${sharedConnectionsMarkup}
      </div>
      <div class="author-detail-section">
        <h3>All Connections (${allConnections.size})</h3>
        ${allConnectionsMarkup}
      </div>
    `;

    // Add hover handlers for shared connections
    const connectionItems = authorDetailPanel.querySelectorAll(
      ".author-detail-connections li[data-connection-id]"
    );
    connectionItems.forEach((item) => {
      const targetId = item.getAttribute("data-connection-id");
      item.addEventListener("mouseenter", () => {
        // Highlight connection from all selected nodes
        nodes.forEach(node => handleDetailConnectionHover(node.id, targetId));
      });
      item.addEventListener("mouseleave", () => handleDetailConnectionHover(null));
      item.addEventListener("focus", () => {
        nodes.forEach(node => handleDetailConnectionHover(node.id, targetId));
      });
      item.addEventListener("blur", () => handleDetailConnectionHover(null));
    });
  }

  updateAuthorDetailPanel();

  function initializePositions() {
    state.maxLinkWeight = d3.max(state.links, (d) => d.weight) || 1;
    state.radiusScale = () => 7.5;

    projectToRings(state.nodes, state.rings, state.communityKey);

    state.quadtree = d3.quadtree(state.nodes, (d) => d.x, (d) => d.y);
    state.communities = computeCommunities(state.nodes, state.communityKey);
  }

  // cluster language filter wiring occurs after initial layout setup

  function applyWeightFilterAndRedraw(range) {
    if (Array.isArray(range) && range.length === 2) {
      state.weightRange = { min: range[0], max: range[1] };
    } else if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
      state.weightRange = { min: range.min, max: range.max };
    } else if (!state.weightRange) {
      state.weightRange = { min: 0, max: Number.POSITIVE_INFINITY };
    }

    filterByWeightState(state, state.weightRange);
    updateSelectionNeighborhood(state);
    updateFilterStatus();
    draw();
  }

  function applyCentralizationFilter(range) {
    if (Array.isArray(range) && range.length === 2) {
      state.centralizationRange = { min: range[0], max: range[1] };
    } else if (range && Number.isFinite(range.min) && Number.isFinite(range.max)) {
      state.centralizationRange = { min: range.min, max: range.max };
    } else {
      state.centralizationRange = null;
    }

    updateFilterStatus();
    draw();
  }

  function focusNodeById(nodeId) {
    if (!nodeId) return;
    let node = nodeById.get(nodeId);
    if (!node && nodeId !== null && nodeId !== undefined) {
      const numericId = Number(nodeId);
      if (!Number.isNaN(numericId)) {
        node = nodeById.get(numericId);
      }
    }
    if (!node) return;
    state.focusNodeId = nodeId;
    state.selectedIds.clear();
    state.selectedIds.add(nodeId);
    const allowed = new Set([nodeId]);
    state.links.forEach((link) => {
      if (link.sourceNode?.id === nodeId) allowed.add(link.targetNode.id);
      else if (link.targetNode?.id === nodeId) allowed.add(link.sourceNode.id);
    });
    state.focusVisible = allowed;
    updateSelectionNeighborhood(state);
    updateAuthorDetailPanel();
    updateFilterStatus();
    draw();
  }

  let currentSearchResults = [];

  function renderSearchSuggestions(matches) {
    if (!authorSearchSuggestions) return;
    const selection = d3
      .select(authorSearchSuggestions)
      .selectAll("button")
      .data(matches, (d) => d.id);

    selection
      .join((enter) => enter.append("button").attr("type", "button"), (update) => update, (exit) => exit.remove())
      .attr("data-node-id", (d) => d.id)
      .text((d) => d.label || d.id);

    if (matches.length) {
      authorSearchSuggestions.classList.add("visible");
    } else {
      authorSearchSuggestions.classList.remove("visible");
    }
  }

  function applySearchQuery(query) {
    state.searchQuery = query;
    const trimmed = (query || "").trim();
    if (!trimmed) {
      currentSearchResults = [];
      state.searchMatches = null;
      renderSearchSuggestions([]);
      draw();
      return;
    }
    const matches = findAuthorMatches(state.nodes, trimmed);
    currentSearchResults = matches;
    const highlightMatches = matches.slice(0, MAX_SEARCH_HIGHLIGHTS);
    state.searchMatches = highlightMatches.length
      ? new Set(highlightMatches.map((node) => node.id))
      : null;
    renderSearchSuggestions(matches.slice(0, MAX_SEARCH_SUGGESTIONS));
    draw();
  }

  // Helper function to update hover neighbors
  function updateHoverNeighbors() {
    // Use adjacency map for fast lookup of outgoing neighbors
    state.hoverNeighbors = (state.hoverNode && state.adjacencyMap)
      ? state.adjacencyMap.get(state.hoverNode.id) || new Set()
      : null;
  }

  function draw() {
    const { ctx, width, height } = state;
    const selectionActive = state.selectedIds && state.selectedIds.size > 0;
    const requireSharedLinks = state.onlySharedSelectionLinks && state.selectedIds.size > 1;
    const detailHighlight = state.detailHoverConnection;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.restore();

    ctx.save();
    ctx.translate(state.transform.x, state.transform.y);
    ctx.scale(state.transform.k, state.transform.k);

    const zoomScale = state.transform.k || 1;

    // Draw concentric bands with dashed outlines instead of fills
    state.rings.tiers.forEach((band) => {
      const tierColor = TIER_NODE_COLORS[band.tier] || "#94a3b8";
      ctx.strokeStyle = tierColor;
      ctx.lineWidth = Math.max(2, 3 / zoomScale);
      ctx.setLineDash([8, 4]);
      ctx.beginPath();
      ctx.arc(state.rings.centerX, state.rings.centerY, band.radius, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);

    const highlightedLinks = [];

    // Always show hovered node's outgoing edges and targets, regardless of filters or showEdges toggle
    const hoverNodeId = state.hoverNode ? state.hoverNode.id : null;
    if (state.showEdges || hoverNodeId) {
      state.links.forEach((link) => {
        const { sourceNode, targetNode } = link;
        if (!sourceNode || !targetNode) return;
        // If hovering, always show outgoing edges and targets
        let isHoverEdge = false;
        if (hoverNodeId && sourceNode.id === hoverNodeId) {
          isHoverEdge = true;
        }
        // Always require both nodes to be visible, even for hovered edges
        if (!(isNodeVisible(state, sourceNode) && isNodeVisible(state, targetNode))) {
          return;
        }
        const visible =
          (isHoverEdge || (
            state.showEdges &&
            link.visible &&
            passesClusterEdgeFilter(state, link)
          ));
        if (!visible) return;
        let sourceSelected = false;
        let targetSelected = false;
        if (selectionActive) {
          sourceSelected = state.selectedIds.has(sourceNode.id);
          targetSelected = state.selectedIds.has(targetNode.id);
          if (requireSharedLinks) {
            if (!(sourceSelected && targetSelected)) return;
          } else if (!sourceSelected && !targetSelected) {
            return;
          }
        }
        // Explicitly highlight outgoing links from hovered node with subtle yellow
        let edgeAlpha = 0.01 + Math.min(1, Math.max(0.05, link.weight / state.maxLinkWeight)) * 0.08;
        let edgeColor = `rgba(255, 255, 255, ${edgeAlpha})`;
        let thickYellow = false;
        if (isHoverEdge) {
          edgeColor = '#fbbf24';
          edgeAlpha = 0.35;
          thickYellow = true;
        } else if (state.hoverNode && (targetNode.id === hoverNodeId)) {
          edgeColor = '#fbbf24';
          edgeAlpha = 0.35;
        } else if (state.hoverNode) {
          edgeAlpha = 0.008;
          edgeColor = `rgba(255,255,255,${edgeAlpha})`;
        }
        ctx.strokeStyle = edgeColor;
        const isHighlighted = isHoverEdge || (state.hoverNode && targetNode.id === hoverNodeId);
        const lineWidth = thickYellow ? Math.max(0.8, 1.5 / zoomScale) : (0.1 + Math.min(1, Math.max(0.05, link.weight / state.maxLinkWeight)) * 1.2) / zoomScale;
        ctx.lineWidth = state.hoverNode && !isHighlighted ? Math.max(0.05, lineWidth * 0.3) : Math.max(0.1, lineWidth);
        ctx.beginPath();
        ctx.moveTo(sourceNode.x, sourceNode.y);
        ctx.lineTo(targetNode.x, targetNode.y);
        ctx.stroke();

        if (selectionActive && (sourceSelected || targetSelected)) {
          highlightedLinks.push(link);
        }
      });

      if (highlightedLinks.length) {
        highlightedLinks.forEach((link) => {
          const { sourceNode, targetNode } = link;
          if (!sourceNode || !targetNode) return;
          if (!isNodeVisible(state, sourceNode) || !isNodeVisible(state, targetNode)) return;
          const bothSelected =
            state.selectedIds.has(sourceNode.id) && state.selectedIds.has(targetNode.id);
          ctx.strokeStyle = bothSelected
            ? "rgba(255, 255, 255, 0.8)"
            : "rgba(255, 255, 255, 0.45)";
          const baseWidth = bothSelected ? 2.6 : 1.8;
          ctx.lineWidth = Math.max(0.6, baseWidth / zoomScale);
          ctx.beginPath();
          ctx.moveTo(sourceNode.x, sourceNode.y);
          ctx.lineTo(targetNode.x, targetNode.y);
          ctx.stroke();
        });
      }
    }

    // Draw nodes
    ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";

    const searchMatchesActive = state.searchMatches && state.searchMatches.size > 0;

    state.nodes.forEach((node) => {
      if (!isNodeVisible(state, node)) return;
      const tier = node._centralizationTier;
      const radius = tier === "core" ? 6.2 : tier === "periphery" ? 5.2 : 4.2;
      const color = getNodeFill(node, state);

      const nodeOpacity = getNodeOpacity(node, state);

      // Draw filled circle
      ctx.save();
      ctx.globalAlpha = nodeOpacity;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();


      const isFocus = state.focusNodeId === node.id;
      const isHover = state.hoverNode === node;
      const isSelected = state.selectedIds?.has(node.id);
      const isSearchMatch = searchMatchesActive && state.searchMatches.has(node.id);
      const isDetailHover =
        detailHighlight &&
        (detailHighlight.sourceNode?.id === node.id || detailHighlight.targetNode?.id === node.id);
      // Highlight target nodes of hovered node with yellow border (efficient lookup)
      const isHoverNeighbor = state.hoverNode && state.hoverNeighbors && state.hoverNeighbors.has(node.id);
      if (isFocus || isHover || isSelected || isSearchMatch || isDetailHover || isHoverNeighbor) {
        let strokeWidth = isFocus || isSelected || isSearchMatch ? Math.max(1.5, 3 / zoomScale) : Math.max(1, 2 / zoomScale);
        if (isHoverNeighbor) strokeWidth = Math.max(2.5, 3.5 / zoomScale);
        ctx.lineWidth = strokeWidth;
        if (isSelected) ctx.strokeStyle = "#22c55e";
        else if (isDetailHover) ctx.strokeStyle = "#fbbf24";
        else if (isSearchMatch) ctx.strokeStyle = "#38bdf8";
        else if (isHoverNeighbor) ctx.strokeStyle = "#fbbf24";
        else ctx.strokeStyle = tier === "core" ? "#f8fafc" : "#cbd5f5";
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 1.3, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Show labels for selected, focused, hovered node, and for hover neighbors
      const showLabel = isSelected || isFocus || isHover || isHoverNeighbor;
      if (showLabel) {
        ctx.fillStyle = "#e5e7eb";
        ctx.fillText(node.label, node.x, node.y - radius - 2);
      }
    });

    if (
      detailHighlight?.sourceNode &&
      detailHighlight?.targetNode &&
      isNodeVisible(state, detailHighlight.sourceNode) &&
      isNodeVisible(state, detailHighlight.targetNode)
    ) {
      ctx.save();
      ctx.strokeStyle = "#fbbf24";
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = Math.max(1.5, 4 / zoomScale);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(detailHighlight.sourceNode.x, detailHighlight.sourceNode.y);
      ctx.lineTo(detailHighlight.targetNode.x, detailHighlight.targetNode.y);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();

    // Draw legend inside canvas (top-right corner) without zoom/pan transforms
    state.legendTierRegions = drawLegend(ctx, width, height, state.communities || [], state.colorScale);
  }

  function isNodeVisible(state, node) {
    if (!node.visible) return false;

    // Check top 20 authors filter
    if (state.top20Filter) {
      const authorName = node.id || "";
      if (!TOP_20_AUTHORS.includes(authorName)) return false;
    }

    // Check tier filter
    if (state.tierFilter && state.tierFilter.size > 0) {
      const tier = node._centralizationTier;
      if (!state.tierFilter.has(tier)) return false;
    }

    if (state.languageFilter && state.languageFilter.size) {
      const languageSet = ensureNodeLanguageSet(node);
      let hasLanguage = false;
      for (const lang of state.languageFilter) {
        if (languageSet.has(lang)) {
          hasLanguage = true;
          break;
        }
      }
      if (!hasLanguage) return false;
    }
    if (state.centralizationRange) {
      const value = Number.isFinite(node._centralizationValue)
        ? node._centralizationValue
        : getCentralizationScore(node);
      if (Number.isFinite(value)) {
        if (value < state.centralizationRange.min || value > state.centralizationRange.max) {
          return false;
        }
      }
    }
    if (state.selectionVisibleNodes && state.selectionVisibleNodes.size) {
      if (!state.selectionVisibleNodes.has(node.id)) return false;
      // When selection filter is active we ignore cluster/focus filters for clarity.
      return true;
    }
    if (state.clusterFilter?.size && node.clusterVisible === false) return false;
    if (!state.focusNodeId) return true;
    return state.focusVisible?.has(node.id);
  }

  function screenToWorld(event) {
    const [mx, my] = d3.pointer(event, state.canvas);
    const k = state.transform.k || 1;
    return [(mx - state.transform.x) / k, (my - state.transform.y) / k];
  }

  d3.select(canvas)
    .on("mousemove", (event) => {
      if (!state.quadtree) return;
      const [x, y] = screenToWorld(event);
      const found = state.quadtree.find(x, y, 18 / (state.transform.k || 1));
      if (found && isNodeVisible(state, found)) {
        state.hoverNode = found;
        updateHoverNeighbors();
        // Tooltip: show languageCommunity as community, and tier label
        const communityValue = found.languageCommunity != null ? String(found.languageCommunity) : "n/a";
        let tierLabel = "";
        let tierColor = "#64748b";
        if (found._centralizationTier === "core") { tierLabel = "Core (community 0)"; tierColor = "#fbbf24"; }
        else if (found._centralizationTier === "periphery") { tierLabel = "Periphery (community 1/2)"; tierColor = "#60a5fa"; }
        else { tierLabel = "Outer (other)"; tierColor = "#64748b"; }
        const languages = (found.languages || [])
          .slice()
          .sort((a, b) => b.weight - a.weight)
          .map((entry) => `${entry.language} <span style='color:#94a3b8'>(${entry.weight})</span>`)
          .slice(0, 6)
          .join(", ");
        showTooltip(
          state.tooltip,
          `<div style="font-size:1.08em;"><strong>${found.label}</strong></div>` +
          `<div style="margin:4px 0 2px 0;"><b>Total translations:</b> <span style='color:#fbbf24'>${formatNumber(found.totalWeight)}</span></div>` +
          `<div style="margin:2px 0 2px 0;"><b>Languages:</b> ${languages || "<span style='color:#94a3b8'>n/a</span>"}</div>` +
          `<div style="margin:2px 0 2px 0;"><b>Community:</b> <span style='color:#38bdf8;font-weight:600;'>${communityValue}</span></div>` +
          `<div style="margin:2px 0 0 0;"><b>Tier:</b> <span style='color:${tierColor};font-weight:600;'>${tierLabel}</span></div>`,
          event
        );
      } else {
        state.hoverNode = null;
        updateHoverNeighbors();
        hideTooltip(state.tooltip);
      }
      draw();
    })
    .on("mouseleave", () => {
      state.hoverNode = null;
      updateHoverNeighbors();
      hideTooltip(state.tooltip);
      draw();
    })
    .on("click", (event) => {
      // Check if click is on legend tier filter
      const rect = canvas.getBoundingClientRect();
      const clickX = event.clientX - rect.left;
      const clickY = event.clientY - rect.top;

      for (const region of state.legendTierRegions) {
        if (clickX >= region.x && clickX <= region.x + region.width &&
          clickY >= region.y && clickY <= region.y + region.height) {
          // Toggle tier filter
          if (state.tierFilter.has(region.tier)) {
            state.tierFilter.delete(region.tier);
          } else {
            state.tierFilter.add(region.tier);
          }
          updateFilterStatus();
          draw();
          return;
        }
      }

      if (!state.quadtree) return;
      const [x, y] = screenToWorld(event);
      const found = state.quadtree.find(x, y, 18 / (state.transform.k || 1));
      if (!found || !isNodeVisible(state, found)) {
        if (!event.ctrlKey && !event.metaKey) {
          state.focusNodeId = null;
          state.focusVisible = null;
          state.selectedIds.clear();
          updateSelectionNeighborhood(state);
          updateAuthorDetailPanel();
          updateFilterStatus();
        }
        draw();
        return;
      }

      if (event.ctrlKey || event.metaKey) {
        // Multi-select toggle without changing focus filter
        if (state.selectedIds.has(found.id)) {
          state.selectedIds.delete(found.id);
        } else {
          state.selectedIds.add(found.id);
        }
        updateSelectionNeighborhood(state);
        updateFilterStatus();
      } else {
        // Single focus & selection
        state.focusNodeId = found.id;
        state.selectedIds.clear();
        state.selectedIds.add(found.id);
        const allowed = new Set([found.id]);
        state.links.forEach((link) => {
          if (link.sourceNode?.id === found.id) allowed.add(link.targetNode.id);
          else if (link.targetNode?.id === found.id) allowed.add(link.sourceNode.id);
        });
        state.focusVisible = allowed;
        updateSelectionNeighborhood(state);
        updateFilterStatus();
      }
      updateAuthorDetailPanel();
      draw();
    });

  const zoom = d3
    .zoom()
    .scaleExtent(ZOOM_EXTENT)
    .on("zoom", (event) => {
      state.transform = event.transform;
      draw();
    });

  d3.select(canvas).call(zoom).call(zoom.transform, state.transform);

  initializePositions();
  state.communitySummaries = computeCommunityLanguageSummaries(state.nodes, state.communityKey);

  if (clusterLanguageFilter) {
    const controller = renderClusterLanguageFilter(
      clusterLanguageFilter,
      state.communitySummaries,
      state.colorScale,
      (selection) => {
        state.clusterFilter = selection;
        updateClusterVisibility(state);
        // Only process visible nodes for layout and display
        const visibleNodes = state.nodes.filter(n => n.clusterVisible !== false);
        // Only re-layout visible nodes within fixed rings (do not update ring radii)
        projectToRings(visibleNodes, state.rings, state.communityKey);
        state.quadtree = d3.quadtree(visibleNodes, (d) => d.x, (d) => d.y);
        updateAuthorDetailPanel();
        updateFilterStatus();
        draw();
      }
    );
    state.clusterFilterController = controller;
    if (resetClusterFilterBtn) {
      if (controller) {
        resetClusterFilterBtn.addEventListener("click", () => controller.clear());
      } else {
        resetClusterFilterBtn.disabled = true;
        resetClusterFilterBtn.textContent = "No filters";
      }
    }
  } else if (resetClusterFilterBtn) {
    resetClusterFilterBtn.style.display = "none";
  }

  if (activeCentralizationRange && activeCentralizationRange.length === 2) {
    state.centralizationRange = {
      min: activeCentralizationRange[0],
      max: activeCentralizationRange[1],
    };
  } else {
    state.centralizationRange = null;
  }

  if (authorSearchSuggestions) {
    authorSearchSuggestions.addEventListener("mousedown", (event) => {
      const button = event.target.closest("button[data-node-id]");
      if (!button) return;
      event.preventDefault();
      const nodeId = button.dataset.nodeId || button.getAttribute("data-node-id");
      focusNodeById(nodeId);
      authorSearchSuggestions.classList.remove("visible");
    });
  }

  if (authorSearchInput) {
    let searchDebounceId = null;
    authorSearchInput.addEventListener("input", (event) => {
      const value = event.target.value;
      if (searchDebounceId) window.clearTimeout(searchDebounceId);
      searchDebounceId = window.setTimeout(() => applySearchQuery(value), 150);
    });
    authorSearchInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        if (currentSearchResults.length) {
          focusNodeById(currentSearchResults[0].id);
          authorSearchSuggestions?.classList.remove("visible");
        }
      } else if (event.key === "Escape") {
        if (!authorSearchInput.value) return;
        event.preventDefault();
        authorSearchInput.value = "";
        applySearchQuery("");
      }
    });
    authorSearchInput.addEventListener("focus", () => {
      if (authorSearchSuggestions && currentSearchResults.length) {
        authorSearchSuggestions.classList.add("visible");
      }
    });
    authorSearchInput.addEventListener("blur", () => {
      setTimeout(() => authorSearchSuggestions?.classList.remove("visible"), 150);
    });
  } else {
    renderSearchSuggestions([]);
  }

  updateClusterVisibility(state);
  updateAuthorDetailPanel();
  centralizationFilterReady = true;
  weightFilterReady = true;
  const fallbackRange =
    activeWeightRange && activeWeightRange.length === 2
      ? activeWeightRange
      : weightExtent && weightExtent.every((value) => Number.isFinite(value))
        ? weightExtent
        : [0, Number.POSITIVE_INFINITY];
  applyWeightFilterAndRedraw(fallbackRange);
  applySearchQuery(authorSearchInput?.value || "");

  if (clearSelectionBtn) {
    clearSelectionBtn.addEventListener("click", () => {
      state.selectedIds.clear();
      state.focusNodeId = null;
      state.focusVisible = null;
      updateSelectionNeighborhood(state);
      updateAuthorDetailPanel();
      updateFilterStatus();
      draw();
    });
  }

  if (showEdgesToggle) {
    showEdgesToggle.checked = false;
    showEdgesToggle.addEventListener("change", () => {
      state.showEdges = Boolean(showEdgesToggle.checked);
      updateFilterStatus();
      draw();
    });
  }

  if (translationOpacityToggle) {
    translationOpacityToggle.checked = state.useTranslationOpacity;
    translationOpacityToggle.addEventListener("change", () => {
      state.useTranslationOpacity = Boolean(translationOpacityToggle.checked);
      updateFilterStatus();
      draw();
    });
  }

  const top20AuthorsBtn = document.getElementById("top20AuthorsBtn");
  if (top20AuthorsBtn) {
    top20AuthorsBtn.addEventListener("click", () => {
      state.top20Filter = !state.top20Filter;
      top20AuthorsBtn.textContent = state.top20Filter ? "Show All Authors" : "Show Top 20 Authors";
      top20AuthorsBtn.classList.toggle("active", state.top20Filter);
      updateFilterStatus();
      draw();
    });
  }

  // Download PNG functionality
  const downloadPngBtn = document.getElementById("downloadPngBtn");
  if (downloadPngBtn) {
    downloadPngBtn.addEventListener("click", () => {
      // Create a temporary canvas for export at 3x resolution for better quality
      const scale = 3;
      const tempCanvas = document.createElement("canvas");
      tempCanvas.width = state.canvas.width * scale;
      tempCanvas.height = state.canvas.height * scale;
      const tempCtx = tempCanvas.getContext("2d");

      // Copy current canvas content onto transparent background with scaling
      tempCtx.scale(scale, scale);
      tempCtx.drawImage(state.canvas, 0, 0);
      tempCtx.setTransform(1, 0, 0, 1, 0, 0);

      // Replace dark background and light text colors
      const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
      const data = imageData.data;

      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const a = data[i + 3];

        // Calculate brightness/luminance
        const brightness = (r + g + b) / 3;
        
        // Replace dark background (navy/black) with white
        if (brightness < 50 && a > 200) {
          // Dark background -> white
          data[i] = 255;
          data[i + 1] = 255;
          data[i + 2] = 255;
        }
        // Replace light text colors with dark gray for readability
        else if (a > 100 && brightness > 150) {
          // Check if it's relatively neutral (not very saturated color like yellow/blue)
          const maxRGB = Math.max(r, g, b);
          const minRGB = Math.min(r, g, b);
          const saturation = maxRGB > 0 ? (maxRGB - minRGB) / maxRGB : 0;
          
          // If it's fairly desaturated (neutral gray-like) or it's very light
          if (saturation < 0.3 || brightness > 200) {
            // Replace with darker color for better readability
            data[i] = 20;
            data[i + 1] = 20;
            data[i + 2] = 20;
          }
        }
      }

      tempCtx.putImageData(imageData, 0, 0);

      // Apply text enhancement: add subtle white outline around dark text for legibility
      const enhancedData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
      const eData = enhancedData.data;
      const width = tempCanvas.width;
      const height = tempCanvas.height;
      
      // Create a copy to check original pixels
      const originalData = new Uint8ClampedArray(eData);

      for (let y = 1; y < height - 1; y++) {
        for (let x = 1; x < width - 1; x++) {
          const idx = (y * width + x) * 4;
          const r = originalData[idx];
          const g = originalData[idx + 1];
          const b = originalData[idx + 2];
          const a = originalData[idx + 3];
          
          // Detect dark text pixels (r,g,b close to 20,20,20)
          if (a > 150 && r < 50 && g < 50 && b < 50 && Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
            // Add subtle light outline in adjacent pixels to create contrast
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nIdx = ((y + dy) * width + (x + dx)) * 4;
                const nr = originalData[nIdx];
                const ng = originalData[nIdx + 1];
                const nb = originalData[nIdx + 2];
                const na = originalData[nIdx + 3];
                
                // If neighbor is white/light (background), add subtle gray outline
                if (nr > 200 && ng > 200 && nb > 200 && na > 150) {
                  eData[nIdx] = Math.max(0, nr - 40);
                  eData[nIdx + 1] = Math.max(0, ng - 40);
                  eData[nIdx + 2] = Math.max(0, nb - 40);
                }
              }
            }
          }
        }
      }

      tempCtx.putImageData(enhancedData, 0, 0);

      // Convert to PNG and download
      tempCanvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "author-network-visualization.png";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
      }, "image/png");
    });
  }

  if (sharedEdgesToggle) {
    sharedEdgesToggle.addEventListener("change", (event) => {
      state.onlySharedSelectionLinks = event.target.checked;
      updateSelectionNeighborhood(state);
      updateFilterStatus();
      draw();
    });
  }

  // Helper function to export SVG chart as PNG with transparent background and darkened text
  function exportChartToPNG(containerId, filename) {
    const container = document.getElementById(containerId);
    if (!container) return;

    const svgElement = container.querySelector("svg");
    if (!svgElement) return;

    const width = parseInt(svgElement.getAttribute("width")) || 600;
    const height = parseInt(svgElement.getAttribute("height")) || 600;

    // Clone the SVG to avoid modifying the original
    const svgClone = svgElement.cloneNode(true);

    // Force all text elements to black for maximum contrast
    const textElements = svgClone.querySelectorAll("text, tspan");
    textElements.forEach((textEl) => {
      // Override any existing fill with inline style for maximum specificity
      textEl.setAttribute("fill", "#000000");
      textEl.style.fill = "#000000";
    });

    // Create canvas at 2x resolution for better quality
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d", { alpha: true });

    // Transparent background
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Serialize and render the modified SVG
    const svgString = new XMLSerializer().serializeToString(svgClone);
    const svg = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(svg);

    const img = new Image();
    img.onload = function () {
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(url);

      // Download as PNG
      canvas.toBlob((blob) => {
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(downloadUrl);
      }, "image/png");
    };
    img.src = url;
  }

  // Event listeners for chord diagram download
  const downloadChordPngBtn = document.getElementById("downloadChordPngBtn");
  if (downloadChordPngBtn) {
    downloadChordPngBtn.addEventListener("click", () => {
      exportChartToPNG("chordDiagramLarge", "shared-authors-by-language.png");
    });
  }

  // Event listeners for radial chart download
  const downloadRadialPngBtn = document.getElementById("downloadRadialPngBtn");
  if (downloadRadialPngBtn) {
    downloadRadialPngBtn.addEventListener("click", () => {
      exportChartToPNG("radialChartZoomed", "target-languages-radial.png");
    });
  }
}

init().catch((error) => {
  console.error(error);
  const main = document.querySelector("main");
  const banner = document.createElement("div");
  banner.style.background = "#fee2e2";
  banner.style.color = "#991b1b";
  banner.style.padding = "1rem";
  banner.style.margin = "1rem";
  banner.style.borderRadius = "8px";
  banner.textContent = `Error Occurred: (${error.message})`;
  main.prepend(banner);
});
