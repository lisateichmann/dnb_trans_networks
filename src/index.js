import './styles.css';
import { createTooltip, showTooltip, hideTooltip, formatNumber } from "../src/utils.js";

const DATA_URL = new URL("../data/author_author_graph.json", import.meta.url).href;
const LANGUAGE_CSV_URL = new URL("../data.csv", import.meta.url).href;
const LANGUAGE_LANGUAGE_URL = new URL("../data/language_language_graph.json", import.meta.url).href;

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

const CENTRALITY_TIER_ORDER = ["outer", "periphery", "central"];
const MIN_TIER_BAND_RATIO = 0.12;
const DEFAULT_CENTRALIZATION_THRESHOLDS = {
  central: 8.2,
  periphery: 3.8,
};
const CENTRALIZATION_QUANTILES = {
  periphery: 0.4,
  central: 0.85,
};
const CENTRALIZATION_TIER_LABELS = {
  outer: "Outer periphery",
  periphery: "Periphery",
  central: "Core",
};
const TIER_NODE_COLORS = {
  central: "#fbbf24",
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

function getCentralizationThresholds() {
  return { ...centralizationThresholds };
}

function setCentralizationThresholds(next) {
  if (!next) return;
  const current = getCentralizationThresholds();
  centralizationThresholds = {
    central: Number.isFinite(next.central) ? next.central : current.central,
    periphery: Number.isFinite(next.periphery) ? next.periphery : current.periphery,
  };
  if (centralizationThresholds.central <= centralizationThresholds.periphery) {
    centralizationThresholds.central = centralizationThresholds.periphery + 0.01;
  }
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
  const central = quantileValue(CENTRALIZATION_QUANTILES.central);
  const thresholds = {
    periphery: Number.isFinite(periphery) ? periphery : DEFAULT_CENTRALIZATION_THRESHOLDS.periphery,
    central: Number.isFinite(central) ? central : DEFAULT_CENTRALIZATION_THRESHOLDS.central,
  };
  if (thresholds.central <= thresholds.periphery) {
    thresholds.central = thresholds.periphery + 0.01;
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

let languageRatioCache = null;
let languageRatioPromise = null;

function normalizeLanguageKey(language) {
  return (language || "").trim().toLowerCase();
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

function formatCentralityLabel(metric) {
  if (!metric) return "Centrality";
  return (
    CENTRALITY_LABELS[metric] ||
    `${metric.charAt(0).toUpperCase()}${metric.slice(1)} centrality`
  );
}

async function loadData() {
  const res = await fetch(DATA_URL);
  if (!res.ok) throw new Error(`Failed to load ${DATA_URL}`);
  return res.json();
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
    { tier: "central", radius: coreRadius, innerRadius: minRadius },
  ];

  return {
    centerX: width / 2,
    centerY: height / 2,
    maxRadius,
    minRadius,
    tiers,
  };
}

function adjustRingBandsToCounts(rings, tierScores) {
  if (!rings?.tiers?.length) return;
  const orderedTiers = ["central", "periphery", "outer"];
  const totalCount = orderedTiers.reduce(
    (sum, tier) => sum + ((tierScores?.[tier] || []).length || 0),
    0
  );
  const usableBand = Math.max(1, rings.maxRadius - rings.minRadius);
  const fallbackRatio = 1 / orderedTiers.length;
  const baseRatios = orderedTiers.map((tier) => {
    const count = (tierScores?.[tier] || []).length || 0;
    const share = totalCount > 0 ? count / totalCount : fallbackRatio;
    return Math.max(MIN_TIER_BAND_RATIO, share);
  });
  const ratioSum = baseRatios.reduce((sum, ratio) => sum + ratio, 0) || 1;

  let cursor = rings.minRadius;
  orderedTiers.forEach((tierName, index) => {
    const tier = rings.tiers.find((band) => band.tier === tierName);
    if (!tier) return;
    const ratio = baseRatios[index] / ratioSum;
    const width =
      index === orderedTiers.length - 1 ? rings.maxRadius - cursor : Math.max(usableBand * ratio, usableBand * 0.05);
    tier.innerRadius = cursor;
    tier.radius = cursor + width;
    cursor = tier.radius;
  });

  const outerTier = rings.tiers.find((band) => band.tier === "outer");
  if (outerTier) outerTier.radius = rings.maxRadius;
}

function getCentralizationScore(node) {
  const normalized = Number(node.centralizationScoreNormalized);
  if (Number.isFinite(normalized)) return normalized;
  const raw = Number(node.centralizationScore);
  if (Number.isFinite(raw)) return raw;
  return Number.NaN;
}

function getCentralizationTier(score, thresholds = getCentralizationThresholds()) {
  if (!Number.isFinite(score)) return "outer";
  if (score >= thresholds.central) return "central";
  if (score >= thresholds.periphery) return "periphery";
  return "outer";
}

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

function getTierRangeLabel(tier, thresholds = getCentralizationThresholds()) {
  if (tier === "central") return `≥ ${thresholds.central.toFixed(1)}`;
  if (tier === "periphery")
    return `${thresholds.periphery.toFixed(1)}–${thresholds.central.toFixed(1)}`;
  return `< ${thresholds.periphery.toFixed(1)}`;
}

function mixCommunityColor(baseColor, tier) {
  const color = d3.color(baseColor || "#cbd5f5");
  if (!color) return TIER_NODE_COLORS[tier] || "#f8fafc";
  const adjustment = tier === "central" ? 1.1 : tier === "periphery" ? 0.85 : 0.7;
  const blended = color.copy({ opacity: 1 });
  return blended.brighter(adjustment).formatRgb();
}

function getNodeFill(node, state) {
  const tier = node._centralizationTier || getCentralizationTier(getCentralizationScore(node));
  const cid = state.communityKey ? node.communities?.[state.communityKey] : null;
  if (cid !== undefined && cid !== null && cid >= 0) {
    return mixCommunityColor(state.colorScale(cid), tier);
  }
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
  const tierScores = {
    outer: [],
    periphery: [],
    central: [],
  };

  const communityBuckets = new Map();
  nodes.forEach((node) => {
    const communityId = node.communities?.[communityKey] ?? -1;
    if (!communityBuckets.has(communityId)) {
      communityBuckets.set(communityId, []);
    }
    communityBuckets.get(communityId).push(node);

    const score = getCentralizationScore(node);
    node._centralizationValue = Number.isFinite(score) ? score : Number.NaN;
    const tier = getCentralizationTier(node._centralizationValue);
    node._centralizationTier = tier;
    if (Number.isFinite(node._centralizationValue)) {
      tierScores[tier].push(node._centralizationValue);
    }
  });

  const tierExtents = {};
  Object.entries(tierScores).forEach(([tier, values]) => {
    if (values.length) {
      const [minValue, maxValue] = d3.extent(values);
      tierExtents[tier] = { min: minValue, max: maxValue };
    } else {
      tierExtents[tier] = { min: 0, max: 0 };
    }
  });

  adjustRingBandsToCounts(rings, tierScores);

  const bandRanges = {};
  rings.tiers.forEach((tier) => {
    bandRanges[tier.tier] = {
      inner: tier.innerRadius ?? rings.minRadius,
      outer: tier.radius ?? rings.maxRadius,
    };
  });

  const clampRadius = (radius) => Math.max(rings.minRadius, Math.min(rings.maxRadius, radius));
  const getBandForTier = (tier) =>
    bandRanges[tier] || bandRanges.outer || { inner: rings.minRadius, outer: rings.maxRadius };

  nodes.forEach((node) => {
    const tier = node._centralizationTier || "outer";
    const band = getBandForTier(tier);
    const extent = tierExtents[tier] || { min: 0, max: 0 };
    const inner = band.inner ?? rings.minRadius;
    const outer = band.outer ?? rings.maxRadius;
    const bandSpan = Math.max(1e-3, outer - inner);
    let ratio = 0.5;
    if (Number.isFinite(node._centralizationValue) && extent.max !== extent.min) {
      const clampedScore = Math.max(extent.min, Math.min(extent.max, node._centralizationValue));
      ratio = (extent.max - clampedScore) / (extent.max - extent.min);
    }
    node._centralizationNormalized = 1 - ratio;
    node._targetRadius = clampRadius(inner + ratio * bandSpan);
  });

  const sortByScoreDesc = (a, b) => {
    const aScore = Number.isFinite(a._centralizationValue) ? a._centralizationValue : -Infinity;
    const bScore = Number.isFinite(b._centralizationValue) ? b._centralizationValue : -Infinity;
    return bScore - aScore;
  };

  const entries = Array.from(communityBuckets.entries());
  const visibleCommunities = entries.filter(([cid]) => cid >= 0);
  const noiseCommunities = entries.filter(([cid]) => cid < 0);
  const orderedCommunities = visibleCommunities.length ? visibleCommunities : entries;

  const fullCircle = Math.PI * 2;
  const sectorCount = orderedCommunities.length || 1;
  const gapAngle = fullCircle * 0.02;
  const sectorAngle = (fullCircle - gapAngle * sectorCount) / sectorCount;

  orderedCommunities.forEach(([cid, bucket], index) => {
    if (!bucket.length) return;
    bucket.sort(sortByScoreDesc);
    const startAngle = index * (sectorAngle + gapAngle);
    bucket.forEach((node, idx) => {
      const t = bucket.length === 1 ? 0.5 : idx / (bucket.length - 1);
      const angleJitter = (Math.random() - 0.5) * (sectorAngle / Math.max(6, bucket.length));
      const angle = startAngle + t * sectorAngle + angleJitter;
      const radialJitter = node._targetRadius * 0.03 * (Math.random() - 0.5);
      const radius = clampRadius(node._targetRadius + radialJitter);
      node.x = rings.centerX + radius * Math.cos(angle);
      node.y = rings.centerY + radius * Math.sin(angle);
    });
  });

  noiseCommunities.forEach(([, bucket]) => {
    bucket.sort(sortByScoreDesc);
    bucket.forEach((node) => {
      const angle = Math.random() * fullCircle;
      const radialJitter = node._targetRadius * 0.05 * (Math.random() - 0.5);
      const radius = clampRadius(node._targetRadius + radialJitter);
      node.x = rings.centerX + radius * Math.cos(angle);
      node.y = rings.centerY + radius * Math.sin(angle);
    });
  });

  applyCollisionForces(nodes, rings);
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

function clampToRing(node, rings) {
  const dx = node.x - rings.centerX;
  const dy = node.y - rings.centerY;
  let dist = Math.hypot(dx, dy);
  if (dist === 0) {
    node.x = rings.centerX + rings.minRadius;
    node.y = rings.centerY;
    return;
  }
  const tierBand = rings.tiers.find((band) => band.tier === node._centralizationTier);
  const tierMin = tierBand?.innerRadius ?? rings.minRadius;
  const tierMax = tierBand?.radius ?? rings.maxRadius;
  const clamped = Math.max(tierMin, Math.min(tierMax, dist));
  if (Math.abs(clamped - dist) > 0.001) {
    const scale = clamped / dist;
    node.x = rings.centerX + dx * scale;
    node.y = rings.centerY + dy * scale;
  }
}

async function loadLanguageRatiosFromCSV() {
  if (languageRatioCache) return languageRatioCache;
  if (languageRatioPromise) return languageRatioPromise;
  languageRatioPromise = d3
    .csv(LANGUAGE_CSV_URL)
    .then((rows) => {
      const counts = new Map();
      rows.forEach((row) => {
        const lang = (row.language || "").trim();
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
    })
    .catch((error) => {
      console.error("Unable to compute language ratios from CSV", error);
      languageRatioCache = [];
      return languageRatioCache;
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
    // Support multi-community (bridge) assignments as an array or string
    let commKey = node.languageCommunity;
    if (!commKey) {
      // fallback to old logic if not present
      const cid = node.communities?.[communityKey];
      if (cid === undefined || cid === null || cid < 0) return;
      commKey = String(cid);
    }
    // If commKey is an array, join with arrows
    if (Array.isArray(commKey)) {
      commKey = commKey.join('→');
    }
    if (!commKey) return;
    ensureNodeLanguageSet(node);
    if (!summaries.has(commKey)) {
      summaries.set(commKey, {
        id: commKey,
        authorCount: 0,
        totalLanguageWeight: 0,
        languageCounts: new Map(),
      });
    }
    const summary = summaries.get(commKey);
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
    // Custom sort: 0,1,2, 0→1, 0→2, 1→2, 0→1→2
    .sort((a, b) => {
      const order = ["0","1","2","0→1","0→2","1→2","0→1→2"];
      const aIdx = order.indexOf(a.id);
      const bIdx = order.indexOf(b.id);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      // fallback: single first, then bridges, then lexically
      const aParts = a.id.split('→').length;
      const bParts = b.id.split('→').length;
      if (aParts !== bParts) return aParts - bParts;
      return a.id.localeCompare(b.id, undefined, {numeric: true});
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
      // Use the colorScale for the main color, with more transparency for a lighter tint
      const base = colorScale(d.id);
      // Convert hex to rgba with lower alpha
      if (/^#[0-9a-fA-F]{6}$/.test(base)) {
        const r = parseInt(base.slice(1,3),16);
        const g = parseInt(base.slice(3,5),16);
        const b = parseInt(base.slice(5,7),16);
        return `rgba(${r},${g},${b},0.10)`;
      }
      return base;
    });

  cards.each(function (d) {
    const card = d3.select(this);
    card.selectAll("*").remove();
    const header = card.append("div").attr("class", "cluster-filter-row");
    header
      .append("strong")
      .html(
        `<span class="cluster-filter-swatch" style="background:${colorScale(d.id)}"></span>` +
        (d.id.includes('→') ? `Bridge ${d.id}` : `Community ${d.id}`)
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

  if (communities.length) {
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Communities", startX, y);
    y += lineHeight;

    const maxToShow = 8;
    communities.slice(0, maxToShow).forEach((c) => {
      ctx.fillStyle = colorScale(c);
      ctx.beginPath();
      ctx.arc(startX + 5, y + 5, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#d1d5db";
      ctx.fillText(`Community ${c}`, startX + 14, y);
      y += lineHeight;
    });

    if (communities.length > maxToShow) {
      ctx.fillStyle = "#9ca3af";
      ctx.fillText(`+${communities.length - maxToShow} more`, startX, y);
      y += lineHeight;
    }
  }

  if (CENTRALITY_TIER_ORDER.length) {
    y += 6;
    ctx.fillStyle = "#e5e7eb";
    ctx.fillText("Centralization tiers (click to filter)", startX, y);
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
  state.nodes.forEach((node) => {
    const cid = node.communities?.[state.communityKey];
    node.clusterVisible = !filterActive || state.clusterFilter.has(cid);
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
  const sourceCluster = link.sourceNode?.communities?.[state.communityKey];
  const targetCluster = link.targetNode?.communities?.[state.communityKey];
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

  // Filter to top languages by weight
  const languageWeights = new Map();
  languageData.nodes.forEach(node => {
    languageWeights.set(node.id, node.totalWeight || 0);
  });

  const topLanguages = Array.from(languageWeights.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(d => d[0]);

  const topLanguageSet = new Set(topLanguages);

  // Build matrix and track connections
  const languageIndex = new Map(topLanguages.map((lang, i) => [lang, i]));
  const matrix = Array(topLanguages.length).fill(0).map(() => Array(topLanguages.length).fill(0));
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
  topLanguages.forEach((lang, idx) => {
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
  const optimizedOrder = topLanguages
    .map((lang, idx) => ({ lang, idx, strength: connectionStrength.get(idx) || idx }))
    .sort((a, b) => a.strength - b.strength)
    .map(d => d.idx);

  // Reorder matrix according to optimized ordering
  const reorderedMatrix = optimizedOrder.map(i => 
    optimizedOrder.map(j => matrix[i][j])
  );
  const reorderedLanguages = optimizedOrder.map(i => topLanguages[i]);

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
    .on("mouseenter", function(event, d) {
      const lang = reorderedLanguages[d.index];
      const langNode = languageData.nodes.find(n => n.id === lang);
      
      console.log("Hovering arc:", lang, "index:", d.index);
      
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

      console.log("Connected languages:", Array.from(connectedLangs));

      // Fade unconnected arcs using fill-opacity
      svg.selectAll(".chord-arc")
        .each(function(arcData) {
          const arcLang = reorderedLanguages[arcData.index];
          const shouldBeVisible = arcData.index === d.index || connectedLangs.has(arcLang);
          console.log(`Arc ${arcLang} (index ${arcData.index}): shouldBeVisible=${shouldBeVisible}`);
        })
        .attr("fill-opacity", function(arcData) {
          const arcLang = reorderedLanguages[arcData.index];
          return arcData.index === d.index || connectedLangs.has(arcLang) ? 1 : 0.15;
        })
        .attr("stroke-width", function(arcData) {
          return arcData.index === d.index ? 2 : 1;
        })
        .attr("stroke", function(arcData) {
          return arcData.index === d.index ? "#fbbf24" : "rgba(15, 23, 42, 0.3)";
        });

      // Emphasize connected text labels, fade unconnected ones
      svg.selectAll(".chord-label")
        .style("opacity", function(labelData) {
          const labelLang = reorderedLanguages[labelData.index];
          return labelData.index === d.index || connectedLangs.has(labelLang) ? 1 : 0.2;
        })
        .style("font-weight", function(labelData) {
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
    .on("mouseleave", function() {
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
    .on("click", function(event, d) {
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
    .on("mouseenter", function(event, d) {
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
    .on("mousemove", function(event) {
      chordTooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseleave", function() {
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

  // Filter and sort languages by translation count (excluding German)
  const languages = languageData.nodes
    .filter(node => node.id !== "ger" && node.id !== "deu" && node.totalWeight > 0)
    .sort((a, b) => b.totalWeight - a.totalWeight)
    .slice(0, 30);

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
    .on("mouseenter", function(event, d) {
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
    .on("mousemove", function(event) {
      radialTooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseleave", function() {
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
    .on("mouseenter", function(event, d) {
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
    .on("mousemove", function(event) {
      radialTooltip
        .style("left", `${event.pageX + 12}px`)
        .style("top", `${event.pageY + 12}px`);
    })
    .on("mouseleave", function() {
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

  const rawData = await loadData();

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
    showEdges: true,
    searchMatches: null,
    searchQuery: "",
    useTranslationOpacity: false,
    translationWeightExtent,
    detailHoverConnection: null,
    tierFilter: new Set(),
    legendTierRegions: [],
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
      centralizationRangeLabel.textContent = "Showing authors across all centralization scores.";
      return;
    }
    const [start, end] = range;
    centralizationRangeLabel.textContent = `Showing authors with scores ${formatCentralizationValue(
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
        const tierSummary = `Core ${getTierRangeLabel("central", thresholds)} • Periphery ${getTierRangeLabel(
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
          .attr("class", "filter-remove")
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
          .attr("class", "filter-remove")
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
        .attr("class", "filter-remove")
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

    // Centralization range filter
    if (state.centralizationRange) {
      const badge = filterStatusItems.append("div")
        .attr("class", "filter-status-item filter-type-centrality");
      
      const minStr = state.centralizationRange.min.toFixed(3);
      const maxStr = state.centralizationRange.max.toFixed(3);
      
      badge.append("span")
        .attr("class", "filter-label")
        .text(`Centrality: ${minStr} - ${maxStr}`);
      
      badge.append("button")
        .attr("class", "filter-remove")
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
          .attr("class", "filter-status-item filter-type-centrality");
        
        const label = CENTRALIZATION_TIER_LABELS[tier] || tier;
        badge.append("span")
          .attr("class", "filter-label")
          .text(`Tier: ${label}`);
        
        badge.append("button")
          .attr("class", "filter-remove")
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
        .attr("class", "filter-remove")
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
      || state.onlySharedSelectionLinks;
    
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
    
    // Reset UI controls
    if (state.clusterFilterController) {
      state.clusterFilterController.clear();
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
    languageLanguageData = await d3.json(LANGUAGE_LANGUAGE_URL);
    createChordDiagram(languageLanguageData, {
      onLanguageClick: (langKey, event) => {
        // Trigger language filter toggle
        const entry = { key: langKey, language: langKey };
        const multi = event.ctrlKey || event.metaKey;
        handleLanguageFilterToggle(entry, { multi });
      }
    });
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
    const tier = node._centralizationTier || getCentralizationTier(getCentralizationScore(node));
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
          <strong>${
            Number.isFinite(normalizedCentralization)
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

    if (state.showEdges) {
      // Draw links with weight-aware alpha for clarity
      state.links.forEach((link) => {
        const { sourceNode, targetNode } = link;
        if (!sourceNode || !targetNode) return;
        const visible =
          link.visible &&
          passesClusterEdgeFilter(state, link) &&
          isNodeVisible(state, sourceNode) &&
          isNodeVisible(state, targetNode);
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
        const intensity = Math.min(1, Math.max(0.05, link.weight / state.maxLinkWeight));
        const alpha = 0.02 + intensity * 0.18;
        ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
        const lineWidth = (0.2 + intensity * 2) / zoomScale;
        ctx.lineWidth = Math.max(0.15, lineWidth);
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
      const tier = node._centralizationTier || getCentralizationTier(getCentralizationScore(node));
      const radius = tier === "central" ? 6.2 : tier === "periphery" ? 5.2 : 4.2;
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
      
      // Add tier-colored outline for better visibility (drawn without opacity)
      const tierColor = TIER_NODE_COLORS[tier] || "#94a3b8";
      ctx.save();
      ctx.globalAlpha = nodeOpacity * 0.9;
      ctx.strokeStyle = tierColor;
      ctx.lineWidth = Math.max(1.2, 1.8 / zoomScale);
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      const isFocus = state.focusNodeId === node.id;
      const isHover = state.hoverNode === node;
      const isSelected = state.selectedIds?.has(node.id);
      const isSearchMatch = searchMatchesActive && state.searchMatches.has(node.id);
      const isDetailHover =
        detailHighlight &&
        (detailHighlight.sourceNode?.id === node.id || detailHighlight.targetNode?.id === node.id);
      if (isFocus || isHover || isSelected || isSearchMatch || isDetailHover) {
        const strokeWidth = isFocus || isSelected || isSearchMatch ? Math.max(1.5, 3 / zoomScale) : Math.max(1, 2 / zoomScale);
        ctx.lineWidth = strokeWidth;
        if (isSelected) ctx.strokeStyle = "#22c55e";
        else if (isDetailHover) ctx.strokeStyle = "#fbbf24";
        else if (isSearchMatch) ctx.strokeStyle = "#38bdf8";
        else ctx.strokeStyle = tier === "central" ? "#f8fafc" : "#cbd5f5";
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 1.3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Show labels only for selected or focused nodes
      if (isSelected || isFocus) {
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
    
    // Check tier filter
    if (state.tierFilter && state.tierFilter.size > 0) {
      const tier = node._centralizationTier || getCentralizationTier(getCentralizationScore(node));
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
        const communityId = found.communities?.[state.communityKey];
        let centralityLine = "";
        const metric = state.centralityMetric;
        if (metric && typeof found.centrality?.[metric] === "number") {
          const score = found.centrality[metric];
          const tier = found.centralityTier?.[metric];
          const tierLabel =
            tier === "central" ? "Central core" : tier === "periphery" ? "Periphery" : "Outer periphery";
          centralityLine = `<br/>${formatCentralityLabel(metric)}: ${score.toFixed(3)}$${
            tier ? ` (${tierLabel})` : ""
          }`;
        }
        let centralizationLine = "";
        const normalizedCentralization = Number(found.centralizationScoreNormalized);
        const rawCentralization = Number(found.centralizationScore);
        if (Number.isFinite(normalizedCentralization) || Number.isFinite(rawCentralization)) {
          const parts = [];
          if (Number.isFinite(normalizedCentralization)) {
            parts.push(`${normalizedCentralization.toFixed(3)} normalized`);
          }
          if (Number.isFinite(rawCentralization)) {
            parts.push(`${rawCentralization.toFixed(3)} weighted`);
          }
          const tierLabel =
            CENTRALIZATION_TIER_LABELS[
              found._centralizationTier || getCentralizationTier(normalizedCentralization)
            ];
          const tierSuffix = tierLabel ? ` • ${tierLabel}` : "";
          centralizationLine = `<br/>Centralization: ${parts.join(" • ")}${tierSuffix}`;
        }
        const languages = (found.languages || [])
          .slice()
          .sort((a, b) => b.weight - a.weight)
          .map((entry) => `${entry.language} (${entry.weight})`)
          .slice(0, 6)
          .join(", ");
        showTooltip(
          state.tooltip,
          `<strong>${found.label}</strong><br/>Total translations: ${formatNumber(found.totalWeight)}<br/>Languages: ${
            languages || "n/a"
          }${state.communityKey ? `<br/>Community: ${communityId ?? "n/a"}` : ""}${centralityLine}${centralizationLine}`,
          event
        );
      } else {
        state.hoverNode = null;
        hideTooltip(state.tooltip);
      }
      draw();
    })
    .on("mouseleave", () => {
      state.hoverNode = null;
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
    showEdgesToggle.checked = true;
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

  if (sharedEdgesToggle) {
    sharedEdgesToggle.addEventListener("change", (event) => {
      state.onlySharedSelectionLinks = event.target.checked;
      updateSelectionNeighborhood(state);
      updateFilterStatus();
      draw();
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
  banner.textContent = `Unable to load data. Run prepare_data.py with community and centrality metrics enabled. (${error.message})`;
  main.prepend(banner);
});
