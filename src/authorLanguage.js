import { createTooltip, showTooltip, hideTooltip, formatNumber } from "./utils.js";

const NODE_COLORS = {
  author: "#f97316",
  language: "#0ea5e9",
};

const MAX_STATIC_TICKS = 450;
const ZOOM_EXTENT = [0.4, 5];

export function renderAuthorLanguageNetwork(containerSelector, data, options = {}) {
  const { minWeight = 5, layout = "static", onFocusChange } = options;
  const container = d3.select(containerSelector);
  const element = container.node();
  const { width } = element.getBoundingClientRect();
  const chartWidth = width || 960;
  const chartHeight = Math.max(520, chartWidth * 0.6);
  const layoutMode = layout === "animated" ? "animated" : "static";
  const dataSignature = `${data.nodes?.length || 0}-${data.links?.length || 0}-${data.meta?.edgeCount || 0}`;
  const signature = JSON.stringify({ chartWidth, chartHeight, layoutMode, dataSignature });

  let state = element.__authorLanguageState;
  if (!state || state.signature !== signature) {
    container.selectAll("*").remove();
    state = buildAuthorLanguageState(container, data, {
      width: chartWidth,
      height: chartHeight,
      layoutMode,
      signature,
      onFocusChange,
    });
    element.__authorLanguageState = state;
  } else {
    state.onFocusChange = onFocusChange;
  }

  applyAuthorLanguageFilter(state, minWeight);
  drawAuthorLanguage(state);
  state.onFocusChange?.(Boolean(state.focusNodeId));
  return state.filteredSnapshot;
}

function buildAuthorLanguageState(container, data, config) {
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
  const legend = container.append("div").attr("class", "legend-panel");
  legend
    .selectAll("div.legend-item")
    .data([
      { label: "Author", color: NODE_COLORS.author },
      { label: "Language", color: NODE_COLORS.language },
    ])
    .join("div")
    .attr("class", "legend-item")
    .each(function (d) {
      const row = d3.select(this);
      row.append("span").attr("class", "legend-dot").style("background", d.color);
      row.append("span").text(d.label);
    });

  const nodes = data.nodes.map((node) => ({ ...node }));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const links = data.links
    .map((link) => ({
      ...link,
      source: nodeById.get(link.source) || nodeById.get(link.source?.id),
      target: nodeById.get(link.target) || nodeById.get(link.target?.id),
      sourceId: typeof link.source === "string" ? link.source : link.source.id,
      targetId: typeof link.target === "string" ? link.target : link.target.id,
    }))
    .filter((link) => link.source && link.target);

  const maxWeight = d3.max(nodes, (d) => d.totalWeight) || 1;
  const radiusScale = d3.scaleSqrt().domain([1, maxWeight]).range([4, 22]);
  const maxLinkWeight = d3.max(links, (d) => d.weight) || 1;

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(links)
        .id((d) => d.id)
        .distance((d) => 220 - Math.min(d.weight * 4, 150))
        .strength((d) => Math.min(0.2 + d.weight / 100, 0.8))
    )
    .force("charge", d3.forceManyBody().strength(-90))
    .force("center", d3.forceCenter(config.width / 2, config.height / 2))
    .force("collision", d3.forceCollide().radius((d) => radiusScale(d.totalWeight) + 6));

  const state = {
    canvas,
    context,
    tooltip,
    legend,
    nodes,
    links,
    radiusScale,
    maxLinkWeight,
    width: config.width,
    height: config.height,
    layoutMode: config.layoutMode,
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
  };

  if (config.layoutMode === "static") {
    simulation.stop();
    const iterations = Math.min(MAX_STATIC_TICKS, Math.max(120, Math.round(nodes.length)));
    for (let i = 0; i < iterations; i += 1) {
      simulation.tick();
    }
  } else {
    simulation.on("tick", () => drawAuthorLanguage(state));
  }

  setupAuthorLanguageZoom(state);
  setupAuthorLanguagePointer(state);
  return state;
}

function applyAuthorLanguageFilter(state, minWeight) {
  state.minWeight = minWeight;
  const visibleNodes = new Set();
  const linksSnapshot = [];
  state.links.forEach((link) => {
    const visible = link.weight >= minWeight;
    link.visible = visible;
    if (visible) {
      visibleNodes.add(link.source.id);
      visibleNodes.add(link.target.id);
      linksSnapshot.push({ source: link.sourceId, target: link.targetId, weight: link.weight });
    }
  });

  const nodesSnapshot = [];
  state.nodes.forEach((node) => {
    node.visible = visibleNodes.has(node.id);
    if (node.visible) {
      nodesSnapshot.push({
        id: node.id,
        label: node.label,
        type: node.type,
        totalWeight: node.totalWeight,
        linkCount: node.linkCount,
      });
    }
  });

  state.filteredSnapshot = { nodes: nodesSnapshot, links: linksSnapshot };
  state.quadtree = d3.quadtree(state.nodes.filter((node) => node.visible), (d) => d.x, (d) => d.y);

  if (state.focusNodeId) {
    if (!visibleNodes.has(state.focusNodeId)) {
      clearAuthorLanguageFocusState(state, { silentDraw: true });
    } else {
      state.focusVisible = computeAuthorLanguageFocusSet(state, state.focusNodeId);
    }
  }

  if (state.hoverNode && !isNodeRenderable(state, state.hoverNode)) {
    state.hoverNode = null;
  }
}

function drawAuthorLanguage(state) {
  const ctx = state.context;
  clearCanvas(ctx, state.width, state.height);

  ctx.save();
  ctx.translate(state.transform.x, state.transform.y);
  ctx.scale(state.transform.k, state.transform.k);

  const zoomScale = state.transform.k || 1;
  ctx.strokeStyle = "rgba(30,58,138,0.25)";
  state.links.forEach((link) => {
    if (!isLinkRenderable(state, link)) return;
    ctx.globalAlpha = 0.35;
    const width = (0.4 + (link.weight / state.maxLinkWeight) * 4.2) / zoomScale;
    ctx.lineWidth = Math.max(0.2, width);
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
  });

  ctx.globalAlpha = 1;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.font = "10px 'Segoe UI', sans-serif";
  state.nodes.forEach((node) => {
    if (!isNodeRenderable(state, node)) return;
    const radius = state.radiusScale(node.totalWeight);
    ctx.fillStyle = NODE_COLORS[node.type] || "#64748b";
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
    ctx.fill();

    const isFocusNode = state.focusNodeId === node.id;
    const isHoverNode = state.hoverNode === node;
    if (isFocusNode || isHoverNode) {
      const strokeWidth = isFocusNode ? Math.max(1.6, 3.2 / zoomScale) : Math.max(1, 2 / zoomScale);
      ctx.lineWidth = strokeWidth;
      ctx.strokeStyle = isFocusNode ? "#ea580c" : "#0f172a";
      ctx.stroke();
    }

    if (radius >= 7) {
      ctx.fillStyle = "#0f172a";
      ctx.fillText(node.label, node.x, node.y - radius - 2);
    }
  });

  ctx.restore();
}

function setupAuthorLanguagePointer(state) {
  const selection = d3.select(state.canvas);
  selection
    .on("mousemove", (event) => {
      if (!state.quadtree) return;
      const [worldX, worldY] = screenToWorld(event, state);
      const radius = 18 / (state.transform.k || 1);
      const found = state.quadtree.find(worldX, worldY, radius);
      if (found && isNodeRenderable(state, found)) {
        state.hoverNode = found;
        showTooltip(
          state.tooltip,
          `<strong>${found.label}</strong><br/>Type: ${found.type}<br/>Translations: ${formatNumber(
            found.totalWeight
          )}<br/>Connected languages: ${found.linkCount}`,
          event
        );
      } else {
        state.hoverNode = null;
        hideTooltip(state.tooltip);
      }
      drawAuthorLanguage(state);
    })
    .on("mouseleave", () => {
      state.hoverNode = null;
      hideTooltip(state.tooltip);
      drawAuthorLanguage(state);
    })
    .on("click", (event) => {
      if (!state.quadtree) return;
      const [worldX, worldY] = screenToWorld(event, state);
      const radius = 18 / (state.transform.k || 1);
      const found = state.quadtree.find(worldX, worldY, radius);
      if (found && isNodeRenderable(state, found)) {
        setAuthorLanguageFocus(state, found);
      }
    });
}

function setupAuthorLanguageZoom(state) {
  const selection = d3.select(state.canvas);
  const zoom = d3
    .zoom()
    .scaleExtent(ZOOM_EXTENT)
    .on("zoom", (event) => {
      state.transform = event.transform;
      drawAuthorLanguage(state);
    });

  selection.call(zoom).call(zoom.transform, state.transform);
  state.zoom = zoom;
}

function screenToWorld(event, state) {
  const [mx, my] = d3.pointer(event, state.canvas);
  const k = state.transform.k || 1;
  const x = (mx - state.transform.x) / k;
  const y = (my - state.transform.y) / k;
  return [x, y];
}

function clearCanvas(ctx, width, height) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.restore();
}

export function clearAuthorLanguageFocus(containerSelector) {
  const element = document.querySelector(containerSelector);
  if (!element) return;
  const state = element.__authorLanguageState;
  if (state) {
    clearAuthorLanguageFocusState(state);
  }
}

function setAuthorLanguageFocus(state, node) {
  if (!node) {
    clearAuthorLanguageFocusState(state);
    return;
  }
  state.focusNodeId = node.id;
  state.focusVisible = computeAuthorLanguageFocusSet(state, node.id);
  state.hoverNode = node;
  state.onFocusChange?.(true);
  drawAuthorLanguage(state);
}

function clearAuthorLanguageFocusState(state, { silentDraw = false } = {}) {
  if (!state.focusNodeId) return;
  state.focusNodeId = null;
  state.focusVisible = null;
  if (state.hoverNode && !isNodeRenderable(state, state.hoverNode)) {
    state.hoverNode = null;
  }
  state.onFocusChange?.(false);
  if (!silentDraw) {
    drawAuthorLanguage(state);
  }
}

function computeAuthorLanguageFocusSet(state, focusId) {
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
