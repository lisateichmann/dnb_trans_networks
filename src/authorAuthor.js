import { createTooltip, showTooltip, hideTooltip, formatNumber } from "./utils.js";

const COMMUNITY_COLORS = d3.schemeTableau10 || [
  "#1d4ed8",
  "#10b981",
  "#f97316",
  "#ec4899",
  "#8b5cf6",
  "#0ea5e9",
  "#facc15",
  "#14b8a6",
  "#ef4444",
  "#6366f1",
  "#4ade80",
  "#fb7185",
];

const CENTRALITY_TIER_STYLES = {
  central: { label: "Central core", band: "rgba(15,23,42,0.18)", stroke: "#0f172a" },
  periphery: { label: "Periphery", band: "rgba(37,99,235,0.1)", stroke: "#2563eb" },
  outer: { label: "Outer periphery", band: "rgba(14,165,233,0.1)", stroke: "#0891b2" },
};

const CENTRALITY_TIER_ORDER = ["outer", "periphery", "central"];
const CENTRALITY_LABELS = {
  degree: "Degree centrality",
  betweenness: "Betweenness centrality",
  closeness: "Closeness centrality",
  eigenvector: "Eigenvector centrality",
};

const MAX_STATIC_TICKS = 600;
const ZOOM_EXTENT = [0.35, 5];

export function renderAuthorAuthorNetwork(containerSelector, data, options = {}) {
  const {
    minWeight = 3,
    communityAlgorithm = "none",
    layout = "static",
    clusterMode = "communities",
    centralityMetric = "none",
    onFocusChange,
  } = options;

  const container = d3.select(containerSelector);
  const element = container.node();
  const { width } = element.getBoundingClientRect();
  const chartWidth = width || 960;
  const chartHeight = Math.max(540, chartWidth * 0.6);
  const layoutMode = layout === "animated" ? "animated" : "static";
  const clusterSetting = clusterMode === "none" ? "none" : "communities";
  const clusterCommunityKey =
    clusterSetting === "communities" && communityAlgorithm !== "none"
      ? communityAlgorithm
      : null;
  const availableCentralityMetrics = [...new Set(data.meta?.centralityMetrics ?? [])];
  if (!availableCentralityMetrics.length && Array.isArray(data.nodes)) {
    const fallback = new Set();
    data.nodes.forEach((node) => {
      Object.keys(node.centrality ?? {}).forEach((metric) => fallback.add(metric));
    });
    fallback.forEach((metric) => availableCentralityMetrics.push(metric));
  }

  const dataSignature = data.meta?.edgeCount ?? data.links?.length ?? 0;
  const signature = JSON.stringify({
    chartWidth,
    chartHeight,
    layoutMode,
    clusterSetting,
    clusterCommunityKey,
    dataSignature,
  });

  let state = element.__authorAuthorState;
  if (!state || state.signature !== signature) {
    container.selectAll("*").remove();
    state = buildAuthorAuthorState(container, data, {
      width: chartWidth,
      height: chartHeight,
      layoutMode,
      clusterSetting,
       clusterCommunityKey,
      signature,
      centralityMetric,
      availableCentralityMetrics,
      onFocusChange,
    });
    element.__authorAuthorState = state;
  } else {
    state.onFocusChange = onFocusChange;
  }

  state.availableCentralityMetrics = availableCentralityMetrics;
  updateCommunityColor(state, communityAlgorithm);
  updateCentralityMode(state, centralityMetric);
  applyWeightFilter(state, minWeight);
  renderLegend(state);
  drawScene(state);
  state.onFocusChange?.(Boolean(state.focusNodeId));

  return state.filteredSnapshot;
}

function buildAuthorAuthorState(container, data, config) {
  const pixelRatio = window.devicePixelRatio || 1;
  const canvas = container
    .append("canvas")
    .attr("width", config.width * pixelRatio)
    .attr("height", config.height * pixelRatio)
    .style("width", `${config.width}px`)
    .style("height", `${config.height}px`)
    .node();
  const context = canvas.getContext("2d");
  context.scale(pixelRatio, pixelRatio);

  const tooltip = createTooltip();
  const legendContainer = container.append("div").attr("class", "legend-panel");
  const colorScale = d3.scaleOrdinal(COMMUNITY_COLORS);

  const nodes = data.nodes.map((node) => ({ ...node }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links = data.links
    .map((link) => ({
      ...link,
      source: nodeById.get(link.source) || nodeById.get(link.source.id),
      target: nodeById.get(link.target) || nodeById.get(link.target.id),
      sourceId: typeof link.source === "string" ? link.source : link.source.id,
      targetId: typeof link.target === "string" ? link.target : link.target.id,
    }))
    .filter((link) => link.source && link.target);

  const maxWeight = d3.max(nodes, (d) => d.totalWeight) || 1;
  const radiusScale = d3.scaleSqrt().domain([1, maxWeight]).range([3, 18]);
  const maxLinkWeight = d3.max(links, (d) => d.weight) || 1;

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(links)
        .id((d) => d.id)
        .distance((d) => 220 - Math.min(d.weight * 3, 140))
        .strength((d) => Math.min(0.05 + d.weight / 80, 0.5))
    )
    .force("charge", d3.forceManyBody().strength(-110))
    .force("center", d3.forceCenter(config.width / 2, config.height / 2))
    .force("collision", d3.forceCollide().radius((d) => radiusScale(d.totalWeight) + 6));

  const state = {
    canvas,
    context,
    tooltip,
    legendContainer,
    colorScale,
    radiusScale,
    maxLinkWeight,
    nodes,
    links,
    width: config.width,
    height: config.height,
    layoutMode: config.layoutMode,
    clusterSetting: config.clusterSetting,
    simulation,
    signature: config.signature,
    filteredSnapshot: { nodes: [], links: [] },
    quadtree: null,
    hoverNode: null,
    transform: d3.zoomIdentity,
    zoom: null,
    focusNodeId: null,
    focusVisible: null,
    onFocusChange: config.onFocusChange,
    centralityMetric: config.centralityMetric && config.centralityMetric !== "none" ? config.centralityMetric : null,
    availableCentralityMetrics: config.availableCentralityMetrics || [],
    centralityBands: null,
  };

  applyClusterForce(state, config.clusterCommunityKey);

  if (config.layoutMode === "static") {
    simulation.stop();
    const iterations = Math.min(MAX_STATIC_TICKS, Math.max(150, Math.round(nodes.length * 0.8)));
    for (let i = 0; i < iterations; i += 1) {
      simulation.tick();
    }
  } else {
    simulation.on("tick", () => drawScene(state));
  }

  setupAuthorAuthorZoom(state);
  setupPointerEvents(state);
  return state;
}

function applyClusterForce(state, clusterCommunityKey) {
  const { simulation, nodes, width, height, clusterSetting } = state;
  if (clusterSetting !== "communities" || !clusterCommunityKey) {
    simulation.force("clusterX", null).force("clusterY", null);
    return;
  }

  const communities = Array.from(
    new Set(
      nodes.map((node) => node.communities?.[clusterCommunityKey]).filter((value) => value !== undefined && value >= 0)
    )
  );
  if (communities.length === 0) {
    simulation.force("clusterX", null).force("clusterY", null);
    return;
  }

  const ringRadius = Math.max(120, Math.min(width, height) / 2 - 60);
  const centerX = width / 2;
  const centerY = height / 2;
  const clusterCenters = new Map();
  communities.forEach((community, index) => {
    const angle = (index / communities.length) * Math.PI * 2;
    clusterCenters.set(community, {
      x: centerX + ringRadius * Math.cos(angle),
      y: centerY + ringRadius * Math.sin(angle),
    });
  });
  const fallback = { x: centerX, y: centerY };

  simulation.force(
    "clusterX",
    d3
      .forceX((node) => clusterCenters.get(node.communities?.[clusterCommunityKey])?.x ?? fallback.x)
      .strength(0.35)
  );
  simulation.force(
    "clusterY",
    d3
      .forceY((node) => clusterCenters.get(node.communities?.[clusterCommunityKey])?.y ?? fallback.y)
      .strength(0.35)
  );
}

function updateCommunityColor(state, communityAlgorithm) {
  state.communityKey = communityAlgorithm === "none" ? null : communityAlgorithm;
}

function updateCentralityMode(state, metric) {
  const desiredMetric = metric && metric !== "none" ? metric : null;
  const hasData = desiredMetric
    ? state.nodes.some((node) => node.centralityTier?.[desiredMetric])
    : false;

  if (!hasData) {
    state.centralityMetric = null;
    state.centralityBands = null;
    state.simulation.force("centralityRadial", null);
    if (state.layoutMode === "animated") {
      state.simulation.alphaTarget(0);
    }
    return;
  }

  state.centralityMetric = desiredMetric;
  applyCentralityRadialForce(state);
}

function applyCentralityRadialForce(state) {
  if (!state.centralityMetric) return;
  const minSide = Math.min(state.width, state.height);
  const maxRadius = Math.max(140, minSide / 2 - 30);
  const peripheryRadius = maxRadius * 0.72;
  const coreRadius = peripheryRadius * 0.6;
  const radiusByTier = {
    outer: maxRadius,
    periphery: peripheryRadius,
    central: coreRadius,
  };

  const radialForce = d3
    .forceRadial(
      (node) => radiusByTier[node.centralityTier?.[state.centralityMetric]] ?? maxRadius,
      state.width / 2,
      state.height / 2
    )
    .strength(0.12);

  state.simulation.force("centralityRadial", radialForce);

  if (state.layoutMode === "static") {
    state.simulation.alpha(0.85).restart();
    const iterations = Math.min(260, Math.max(140, Math.round(state.nodes.length * 0.6)));
    for (let i = 0; i < iterations; i += 1) {
      state.simulation.tick();
    }
    state.simulation.stop();
  } else {
    state.simulation.alphaTarget(0.4).restart();
  }

  state.centralityBands = {
    centerX: state.width / 2,
    centerY: state.height / 2,
    tiers: CENTRALITY_TIER_ORDER.map((tier) => ({
      tier,
      label: CENTRALITY_TIER_STYLES[tier].label,
      radius:
        tier === "outer"
          ? maxRadius
          : tier === "periphery"
          ? peripheryRadius
          : coreRadius,
      color: CENTRALITY_TIER_STYLES[tier].band,
    })),
  };
}

function applyWeightFilter(state, minWeight) {
  state.minWeight = minWeight;
  const visibleNodes = new Set();
  const filteredLinks = [];
  state.links.forEach((link) => {
    const isVisible = link.weight >= minWeight;
    link.visible = isVisible;
    if (isVisible) {
      visibleNodes.add(link.source.id);
      visibleNodes.add(link.target.id);
      filteredLinks.push({ source: link.sourceId, target: link.targetId, weight: link.weight });
    }
  });

  const filteredNodes = [];
  state.nodes.forEach((node) => {
    node.visible = visibleNodes.has(node.id);
    if (node.visible) {
      filteredNodes.push({
        id: node.id,
        label: node.label,
        type: node.type,
        totalWeight: node.totalWeight,
        languageCount: node.languageCount,
        communities: node.communities,
        languages: node.languages,
        centrality: node.centrality,
        centralityTier: node.centralityTier,
      });
    }
  });

  state.filteredSnapshot = { nodes: filteredNodes, links: filteredLinks };
  state.quadtree = d3.quadtree(state.nodes.filter((node) => node.visible), (d) => d.x, (d) => d.y);

  if (state.focusNodeId) {
    if (!visibleNodes.has(state.focusNodeId)) {
      clearAuthorAuthorFocusState(state, { silentDraw: true });
    } else {
      state.focusVisible = computeAuthorAuthorFocusSet(state, state.focusNodeId);
    }
  }

  if (state.hoverNode && !isNodeRenderable(state, state.hoverNode)) {
    state.hoverNode = null;
  }
}

function renderLegend(state) {
  if (!state.legendContainer) return;
  state.legendContainer.selectAll("*").remove();
  renderCommunityLegend(state);
  renderCentralityLegend(state);
}

function renderCommunityLegend(state) {
  if (!state.communityKey) return;
  const communities = Array.from(
    new Set(
      state.nodes
        .map((node) => node.communities?.[state.communityKey])
        .filter((value) => value !== undefined && value !== null && value >= 0)
    )
  ).sort((a, b) => a - b);
  if (communities.length === 0) {
    return;
  }

  state.legendContainer
    .append("div")
    .attr("class", "legend-title")
    .text(`${state.communityKey.charAt(0).toUpperCase()}${state.communityKey.slice(1)} communities`);

  const items = state.legendContainer
    .selectAll("div.legend-item.community")
    .data(communities.slice(0, 10))
    .join("div")
    .attr("class", "legend-item community");

  items
    .append("span")
    .attr("class", "legend-dot")
    .style("background", (community) => state.colorScale(community));

  items
    .append("span")
    .text((community) => `Community ${community}`);

  if (communities.length > 10) {
    state.legendContainer
      .append("div")
      .attr("class", "legend-more")
      .text(`+${communities.length - 10} more`);
  }
}

function renderCentralityLegend(state) {
  if (!state.centralityMetric) return;
  const tiers = CENTRALITY_TIER_ORDER.filter((tier) => CENTRALITY_TIER_STYLES[tier]);
  if (!tiers.length) return;

  state.legendContainer
    .append("div")
    .attr("class", "legend-title")
    .text(`${formatCentralityLabel(state.centralityMetric)} tiers`);

  const items = state.legendContainer
    .selectAll("div.legend-item.centrality")
    .data(tiers)
    .join("div")
    .attr("class", "legend-item centrality");

  items
    .append("span")
    .attr("class", "legend-dot")
    .style("background", (tier) => CENTRALITY_TIER_STYLES[tier].stroke);

  items
    .append("span")
    .text((tier) => CENTRALITY_TIER_STYLES[tier].label);
}

function drawScene(state) {
  const ctx = state.context;
  clearCanvas(ctx, state.width, state.height);

  ctx.save();
  ctx.translate(state.transform.x, state.transform.y);
  ctx.scale(state.transform.k, state.transform.k);

  if (state.centralityBands) {
    drawCentralityBands(state, ctx);
  }

  const zoomScale = state.transform.k || 1;
  ctx.strokeStyle = "rgba(148,163,184,0.25)";
  state.links.forEach((link) => {
    if (!isLinkRenderable(state, link)) return;
    ctx.globalAlpha = 0.35;
    const lineWidth = (0.2 + (link.weight / state.maxLinkWeight) * 2.2) / zoomScale;
    ctx.lineWidth = Math.max(0.15, lineWidth);
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
  });

  ctx.globalAlpha = 1;
  ctx.font = "9px 'Segoe UI', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  state.nodes.forEach((node) => {
    if (!isNodeRenderable(state, node)) return;
    const radius = state.radiusScale(node.totalWeight);
    ctx.fillStyle = getNodeColor(node, state);
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();

    if (state.centralityMetric) {
      const tierStyle = CENTRALITY_TIER_STYLES[node.centralityTier?.[state.centralityMetric]];
      if (tierStyle) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 0.8, 0, Math.PI * 2);
        ctx.lineWidth = Math.max(1, 1.6 / zoomScale);
        ctx.strokeStyle = tierStyle.stroke;
        ctx.stroke();
      }
    }

    const isFocusNode = state.focusNodeId === node.id;
    const isHoverNode = state.hoverNode === node;
    if (isFocusNode || isHoverNode) {
      const strokeWidth = isFocusNode ? Math.max(1.5, 3 / zoomScale) : Math.max(1, 2 / zoomScale);
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = isFocusNode ? "#111" : "#111";
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 1.2, 0, Math.PI * 2);
      ctx.stroke();
    }

    if (radius >= 6) {
      ctx.fillStyle = "#0f172a";
      ctx.fillText(node.label, node.x, node.y - radius - 2);
    }
  });

  ctx.restore();
}

function drawCentralityBands(state, ctx) {
  const data = state.centralityBands;
  if (!data) return;
  ctx.save();
  data.tiers.forEach((band) => {
    ctx.beginPath();
    ctx.fillStyle = band.color;
    ctx.globalAlpha = 1;
    ctx.arc(data.centerX, data.centerY, band.radius, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}

function getNodeColor(node, state) {
  if (!state.communityKey) {
    return "#3b82f6";
  }
  const communityId = node.communities?.[state.communityKey];
  if (communityId === undefined || communityId < 0) {
    return "#94a3b8";
  }
  return state.colorScale(communityId);
}

function setupPointerEvents(state) {
  const selection = d3.select(state.canvas);
  selection
    .on("mousemove", (event) => {
      if (!state.quadtree) return;
      const [worldX, worldY] = screenToWorld(event, state);
      const searchRadius = 15 / (state.transform.k || 1);
      const found = state.quadtree.find(worldX, worldY, searchRadius);
      if (found && isNodeRenderable(state, found)) {
        state.hoverNode = found;
        const communityId = state.communityKey ? found.communities?.[state.communityKey] : null;
        const centralityMetric = state.centralityMetric;
        let centralityLine = "";
        if (centralityMetric) {
          const tierKey = found.centralityTier?.[centralityMetric];
          const tierLabel = tierKey ? (CENTRALITY_TIER_STYLES[tierKey]?.label ?? tierKey) : null;
          const score = found.centrality?.[centralityMetric];
          if (typeof score === "number") {
            centralityLine = `<br/>${formatCentralityLabel(centralityMetric)}: ${score.toFixed(3)}${tierLabel ? ` (${tierLabel})` : ""}`;
          }
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
          }${state.communityKey ? `<br/>Community: ${communityId ?? "n/a"}` : ""}${centralityLine}`,
          event
        );
      } else {
        state.hoverNode = null;
        hideTooltip(state.tooltip);
      }
      drawScene(state);
    })
    .on("mouseleave", () => {
      state.hoverNode = null;
      hideTooltip(state.tooltip);
      drawScene(state);
    })
    .on("click", (event) => {
      if (!state.quadtree) return;
      const [worldX, worldY] = screenToWorld(event, state);
      const searchRadius = 15 / (state.transform.k || 1);
      const found = state.quadtree.find(worldX, worldY, searchRadius);
      if (found && isNodeRenderable(state, found)) {
        setAuthorAuthorFocus(state, found);
      }
    });
}

function setupAuthorAuthorZoom(state) {
  const selection = d3.select(state.canvas);
  const zoom = d3
    .zoom()
    .scaleExtent(ZOOM_EXTENT)
    .on("zoom", (event) => {
      state.transform = event.transform;
      drawScene(state);
    });

  selection.call(zoom).call(zoom.transform, state.transform);
  state.zoom = zoom;
}

function screenToWorld(event, state) {
  const [mx, my] = d3.pointer(event, state.canvas);
  const k = state.transform.k || 1;
  return [(mx - state.transform.x) / k, (my - state.transform.y) / k];
}

function clearCanvas(ctx, width, height) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.restore();
}

export function clearAuthorAuthorFocus(containerSelector) {
  const element = document.querySelector(containerSelector);
  if (!element) return;
  const state = element.__authorAuthorState;
  if (state) {
    clearAuthorAuthorFocusState(state);
  }
}

function setAuthorAuthorFocus(state, node) {
  if (!node) {
    clearAuthorAuthorFocusState(state);
    return;
  }
  state.focusNodeId = node.id;
  state.focusVisible = computeAuthorAuthorFocusSet(state, node.id);
  state.hoverNode = node;
  state.onFocusChange?.(true);
  drawScene(state);
}

function clearAuthorAuthorFocusState(state, { silentDraw = false } = {}) {
  if (!state.focusNodeId) return;
  state.focusNodeId = null;
  state.focusVisible = null;
  if (state.hoverNode && !isNodeRenderable(state, state.hoverNode)) {
    state.hoverNode = null;
  }
  state.onFocusChange?.(false);
  if (!silentDraw) {
    drawScene(state);
  }
}

function computeAuthorAuthorFocusSet(state, focusId) {
  const allowed = new Set([focusId]);
  state.links.forEach((link) => {
    if (!link.visible) return;
    if (link.source.id === focusId) {
      allowed.add(link.target.id);
    } else if (link.target.id === focusId) {
      allowed.add(link.source.id);
    }
  });
  return allowed;
}

function isNodeRenderable(state, node) {
  if (!node.visible) return false;
  if (!state.focusNodeId) return true;
  return state.focusVisible?.has(node.id);
}

function isLinkRenderable(state, link) {
  if (!link.visible) return false;
  if (!state.focusNodeId) return true;
  return (
    state.focusVisible?.has(link.source.id) && state.focusVisible?.has(link.target.id)
  );
}

function formatCentralityLabel(metric) {
  if (!metric) return "Centrality";
  return CENTRALITY_LABELS[metric] || `${metric.charAt(0).toUpperCase()}${metric.slice(1)} centrality`;
}
