import {
  renderAuthorLanguageNetwork,
  clearAuthorLanguageFocus,
} from "./authorLanguage.js";
import {
  renderAuthorAuthorNetwork,
  clearAuthorAuthorFocus,
} from "./authorAuthor.js";
import { renderLanguageLanguageNetwork } from "./languageLanguage.js";
import { downloadJSON } from "./utils.js";

const AUTHOR_DATA_URL = "./data/author_language_graph.json";
const LANGUAGE_DATA_URL = "./data/language_language_graph.json";
const AUTHOR_AUTHOR_DATA_URL = "./data/author_author_graph.json";


let authorData = null;
let languageData = null;
let authorAuthorData = null;
let authorFiltered = null;
let languageFiltered = null;
let authorAuthorFiltered = null;


const authorSlider = document.getElementById("authorMinWeight");
const authorSliderValue = document.getElementById("authorMinWeightValue");
const authorAuthorSlider = document.getElementById("authorAuthorMinWeight");
const authorAuthorSliderValue = document.getElementById("authorAuthorMinWeightValue");
const languageSlider = document.getElementById("languageMinWeight");
const languageSliderValue = document.getElementById("languageMinWeightValue");
const authorDownloadBtn = document.getElementById("downloadAuthorJson");
const authorAuthorDownloadBtn = document.getElementById("downloadAuthorAuthorJson");
const languageDownloadBtn = document.getElementById("downloadLanguageJson");
const authorFocusClearBtn = document.getElementById("authorFocusClear");
const authorAuthorFocusClearBtn = document.getElementById("authorAuthorFocusClear");
const communitySelect = document.getElementById("communityAlgorithm");
const layoutSelect = document.getElementById("layoutMode");
const clusterSelect = document.getElementById("clusterMode");
const centralitySelect = document.getElementById("centralityMode");

const histogramRegistry = {
  author: {
    containerId: "authorHistogram",
    slider: authorSlider,
    getData: () => authorData,
  },
  authorAuthor: {
    containerId: "authorAuthorHistogram",
    slider: authorAuthorSlider,
    getData: () => authorAuthorData,
  },
  language: {
    containerId: "languageHistogram",
    slider: languageSlider,
    getData: () => languageData,
  },
};

const histogramState = new Map();

function getLayoutMode() {
  return layoutSelect?.value === "animated" ? "animated" : "static";
}

function getClusterMode() {
  return clusterSelect?.value === "none" ? "none" : "communities";
}

function updateButtonState(button, hasFocus) {
  if (!button) return;
  button.disabled = !hasFocus;
}

function updateSliderRange(slider, maxValue) {
  if (!slider || !Number.isFinite(maxValue)) return;
  const newMax = Math.max(1, Math.round(maxValue));
  slider.max = String(newMax);
  if (Number(slider.value) > newMax) {
    slider.value = String(newMax);
  }
}

function populateCentralityOptions(metrics = []) {
  if (!centralitySelect) return;
  const existing = new Set(Array.from(centralitySelect.options).map((option) => option.value));
  metrics.forEach((metric) => {
    if (!metric || existing.has(metric)) return;
    const option = document.createElement("option");
    option.value = metric;
    option.textContent = metric.charAt(0).toUpperCase() + metric.slice(1);
    centralitySelect.appendChild(option);
  });
  centralitySelect.disabled = metrics.length === 0;
  if (metrics.length === 0) {
    centralitySelect.value = "none";
  }
}

function getLinkWeights(graph) {
  if (!graph?.links?.length) return [];
  return graph.links
    .map((link) => Number(link.weight ?? link.value ?? link.count ?? 0))
    .filter((value) => Number.isFinite(value) && value >= 0);
}

function drawWeightHistogram(key) {
  const config = histogramRegistry[key];
  if (!config) return;
  const graph = config.getData?.();
  const container = d3.select(`#${config.containerId}`);
  if (container.empty()) return;
  const node = container.node();
  if (!node) return;
  const width = Math.max(120, node.clientWidth || node.offsetWidth || 140);
  const height = Math.max(36, node.clientHeight || node.offsetHeight || 48);
  container.selectAll("*").remove();

  const values = getLinkWeights(graph);
  if (!values.length) {
    histogramState.delete(key);
    container.append("svg").attr("width", width).attr("height", height);
    return;
  }

  let [minValue, maxValue] = d3.extent(values);
  if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) {
    histogramState.delete(key);
    return;
  }
  if (minValue === maxValue) {
    maxValue = minValue + 1;
  }

  if (config.slider) {
    const sliderMax = Number(config.slider.max);
    if (!Number.isFinite(sliderMax) || sliderMax < maxValue) {
      updateSliderRange(config.slider, maxValue);
    }
  }

  const binCount = Math.min(20, Math.max(4, Math.round(Math.sqrt(values.length))))
    || 10;
  const bins = d3.bin().domain([minValue, maxValue]).thresholds(binCount)(values);

  const topPadding = 4;
  const bottomPadding = 2;
  const chartHeight = Math.max(10, height - topPadding - bottomPadding);
  const xScale = d3.scaleLinear().domain([minValue, maxValue]).range([0, width]);
  const maxBinCount = d3.max(bins, (d) => d.length) || 1;
  const yScale = d3.scaleLinear().domain([0, maxBinCount]).range([chartHeight, 0]);

  const svg = container.append("svg").attr("width", width).attr("height", height);
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

  const marker = svg
    .append("line")
    .attr("class", "hist-threshold")
    .attr("y1", topPadding)
    .attr("y2", topPadding + chartHeight);

  histogramState.set(key, {
    bars,
    marker,
    xScale,
    domain: [minValue, maxValue],
  });

  updateHistogramThreshold(key, Number(config.slider.value));
}

function updateHistogramThreshold(key, threshold) {
  const state = histogramState.get(key);
  if (!state) return;
  const [minValue, maxValue] = state.domain;
  const clamped = Math.max(minValue, Math.min(maxValue, threshold));
  const x = state.xScale(clamped);
  state.marker.attr("x1", x).attr("x2", x);
  state.bars.classed("active", (d) => (d.x1 ?? maxValue) >= threshold);
}

function renderHistograms() {
  if (!authorData && !authorAuthorData && !languageData) return;
  drawWeightHistogram("author");
  drawWeightHistogram("authorAuthor");
  drawWeightHistogram("language");
}

const handleAuthorFocusChange = (hasFocus) => updateButtonState(authorFocusClearBtn, hasFocus);
const handleAuthorAuthorFocusChange = (hasFocus) =>
  updateButtonState(authorAuthorFocusClearBtn, hasFocus);

function renderAuthor() {
  if (!authorData) return;
  const minWeight = Number(authorSlider.value);
  authorSliderValue.textContent = minWeight;
  updateHistogramThreshold("author", minWeight);
  authorFiltered = renderAuthorLanguageNetwork("#authorLanguageChart", authorData, {
    minWeight,
    layout: getLayoutMode(),
    onFocusChange: handleAuthorFocusChange,
  });
}

function renderLanguage() {
  if (!languageData) return;
  const minWeight = Number(languageSlider.value);
  languageSliderValue.textContent = minWeight;
  updateHistogramThreshold("language", minWeight);
  languageFiltered = renderLanguageLanguageNetwork("#languageLanguageChart", languageData, {
    minWeight,
    layout: getLayoutMode(),
  });
}

function renderAuthorAuthor() {
  if (!authorAuthorData) return;
  const minWeight = Number(authorAuthorSlider.value);
  authorAuthorSliderValue.textContent = minWeight;
  updateHistogramThreshold("authorAuthor", minWeight);
  const communityAlgorithm = communitySelect.value;
  const centralityMetric = centralitySelect?.value || "none";
  const showEdgesToggle = document.getElementById("showEdgesToggle");
  const showEdges = showEdgesToggle ? showEdgesToggle.checked : false;
  authorAuthorFiltered = renderAuthorAuthorNetwork("#authorAuthorChart", authorAuthorData, {
    minWeight,
    communityAlgorithm,
    layout: getLayoutMode(),
    clusterMode: getClusterMode(),
    centralityMetric,
    showEdges,
    onFocusChange: handleAuthorAuthorFocusChange,
  });

  // Listen for toggle changes
  if (showEdgesToggle && !showEdgesToggle._listenerSet) {
    showEdgesToggle.addEventListener("change", renderAuthorAuthor);
    showEdgesToggle._listenerSet = true;
  }
}


function updateNetworkMetadata() {
  const metadataSection = document.getElementById("networkMetadata");
  const grid = metadataSection?.querySelector(".metadata-grid");
  if (metadataSection) metadataSection.style.display = "block";

  // Success: hide loading, show grid
  if (loadingMsg) loadingMsg.style.display = "none";
  if (grid) grid.style.display = "grid";

  // Get DOM elements
  const modularityEl = document.getElementById("modularityScore");
  const avgDegreeEl = document.getElementById("averageDegree");
  const numAuthorsEl = document.getElementById("numAuthors");
  const numLanguagesEl = document.getElementById("numLanguages");
  const numRelationshipsEl = document.getElementById("numRelationships");
  if (!authorAuthorData) return;
  // Modularity
  let modularity = authorAuthorData?.meta?.modularity;
  modularityEl.textContent = (typeof modularity === "number") ? modularity.toFixed(3) : "–";
  // Authors
  const nodes = authorAuthorData.nodes || [];
  numAuthorsEl.textContent = nodes.length || "–";
  // Relationships (edges)
  const links = authorAuthorData.links || [];
  numRelationshipsEl.textContent = links.length || "–";
  // Average degree (use degreeCentrality if available)
  let avgDegree = 0;
  if (nodes.length) {
    if (nodes[0] && typeof nodes[0].degreeCentrality === "number") {
      avgDegree = nodes.reduce((sum, n) => sum + (n.degreeCentrality || 0), 0) / nodes.length;
    } else if (links.length) {
      avgDegree = (2 * links.length) / nodes.length;
    }
  }
  avgDegreeEl.textContent = avgDegree ? avgDegree.toFixed(2) : "–";
  // Languages (unique from nodes)
  const langSet = new Set();
  nodes.forEach((n) => {
    if (n.language) langSet.add(n.language);
    if (Array.isArray(n.languages)) n.languages.forEach((l) => langSet.add(l));
  });
  numLanguagesEl.textContent = langSet.size || "–";
}

async function init() {
  try {
    const [authorJson, languageJson, authorAuthorJson] = await Promise.all([
      fetch(AUTHOR_DATA_URL).then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${AUTHOR_DATA_URL}`);
        return res.json();
      }),
      fetch(LANGUAGE_DATA_URL).then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${LANGUAGE_DATA_URL}`);
        return res.json();
      }),
      fetch(AUTHOR_AUTHOR_DATA_URL).then((res) => {
        if (!res.ok) throw new Error(`Failed to load ${AUTHOR_AUTHOR_DATA_URL}`);
        return res.json();
      }),
    ]);

    authorData = authorJson;
    languageData = languageJson;
    authorAuthorData = authorAuthorJson;
    
    console.log("Data loaded:", { authorData, languageData, authorAuthorData });

    updateSliderRange(authorSlider, authorData?.meta?.maxEdgeWeight ?? authorData?.maxWeight ?? 40);
    updateSliderRange(languageSlider, languageData?.meta?.maxEdgeWeight ?? languageData?.maxWeight ?? 200);
    updateSliderRange(
      authorAuthorSlider,
      authorAuthorData?.meta?.maxEdgeWeight ?? authorAuthorData?.maxWeight ?? 15
    );
    updateNetworkMetadata();
    populateCentralityOptions(authorAuthorData?.meta?.centralityMetrics ?? []);
    renderHistograms();
    renderAuthor();
    renderLanguage();
    renderAuthorAuthor();
  } catch (error) {
    console.error(error);
    // Also show the main error banner
    const main = document.querySelector("main");
    const banner = document.createElement("div");
    banner.style.background = "#fee2e2";
    banner.style.color = "#991b1b";
    banner.style.padding = "1rem";
    banner.style.margin = "1rem";
    banner.style.borderRadius = "8px";
    banner.textContent = `Unable to load data. Run prepare_data.py first. (${error.message})`;
    main.prepend(banner);
  }
}

authorSlider.addEventListener("input", renderAuthor);
languageSlider.addEventListener("input", renderLanguage);
authorAuthorSlider.addEventListener("input", renderAuthorAuthor);
communitySelect.addEventListener("change", renderAuthorAuthor);
layoutSelect?.addEventListener("change", () => {
  renderAuthor();
  renderLanguage();
  renderAuthorAuthor();
});
clusterSelect?.addEventListener("change", renderAuthorAuthor);
centralitySelect?.addEventListener("change", renderAuthorAuthor);

authorDownloadBtn.addEventListener("click", () => {
  if (authorFiltered) {
    downloadJSON("author_language_filtered.json", authorFiltered);
  }
});

authorFocusClearBtn?.addEventListener("click", () => {
  clearAuthorLanguageFocus("#authorLanguageChart");
});

authorAuthorDownloadBtn.addEventListener("click", () => {
  if (authorAuthorFiltered) {
    downloadJSON("author_author_filtered.json", authorAuthorFiltered);
  }
});

authorAuthorFocusClearBtn?.addEventListener("click", () => {
  clearAuthorAuthorFocus("#authorAuthorChart");
});

languageDownloadBtn.addEventListener("click", () => {
  if (languageFiltered) {
    downloadJSON("language_language_filtered.json", languageFiltered);
  }
});

window.addEventListener("resize", () => {
  renderAuthor();
  renderLanguage();
  renderAuthorAuthor();
  renderHistograms();
});

init();
