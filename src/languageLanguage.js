import { createTooltip, showTooltip, hideTooltip, formatNumber, filterByWeight } from "./utils.js";

export function renderLanguageLanguageNetwork(containerSelector, data, options = {}) {
  const { minWeight = 50, layout = "static" } = options;
  const layoutMode = layout === "animated" ? "animated" : "static";
  const filtered = filterByWeight(data, minWeight);

  const nodes = filtered.nodes.map((node) => ({ ...node }));
  const links = filtered.links.map((link) => ({ ...link }));

  const container = d3.select(containerSelector);
  container.selectAll("*").remove();
  const { width } = container.node().getBoundingClientRect();
  const height = Math.max(520, width * 0.55);

  // TODO: Translation flow of the languages (source -> target) using chord diagram.
  // ger - is bi-lingual 
  // mul - is multi-lingual

  const svg = container.append("svg").attr("viewBox", [0, 0, width, height]);
  const tooltip = createTooltip();

  svg
    .append("defs")
    .append("marker")
    .attr("id", "arrowhead")
    .attr("viewBox", "0 -5 10 10")
    .attr("refX", 18)
    .attr("refY", 0)
    .attr("markerWidth", 6)
    .attr("markerHeight", 6)
    .attr("orient", "auto")
    .append("path")
    .attr("d", "M0,-5L10,0L0,5")
    .attr("fill", "#0f766e");

  const radiusScale = d3
    .scaleSqrt()
    .domain([1, d3.max(nodes, (d) => d.totalWeight) || 1])
    .range([6, 26]);

  const linkWidthScale = d3
    .scaleLinear()
    .domain(d3.extent(links, (d) => d.weight))
    .range([0.4, 4]);

  const simulation = d3
    .forceSimulation(nodes)
    .force(
      "link",
      d3
        .forceLink(links)
        .id((d) => d.id)
        .distance((d) => 260 - Math.min(d.weight * 3, 140))
        .strength((d) => Math.min(0.1 + d.weight / 150, 0.6))
    )
    .force("charge", d3.forceManyBody().strength(-160))
    .force("center", d3.forceCenter(width / 2, height / 2))
    .force("collision", d3.forceCollide().radius((d) => radiusScale(d.totalWeight) + 6));

  if (layoutMode === "static") {
    simulation.stop();
  }

  const link = svg
    .append("g")
    .attr("stroke", "#0f766e")
    .attr("stroke-opacity", 0.5)
    .selectAll("line")
    .data(links)
    .join("line")
    .attr("class", "link-language")
    .attr("stroke-width", (d) => linkWidthScale(d.weight))
    .attr("marker-end", "url(#arrowhead)");

  link
    .on("mouseover", (event, d) => {
      showTooltip(
        tooltip,
        `<strong>${d.source.id} -> ${d.target.id}</strong><br/>Shared authors: ${d.weight}`,
        event
      );
    })
    .on("mouseout", () => hideTooltip(tooltip));

  const node = svg
    .append("g")
    .selectAll("circle")
    .data(nodes)
    .join("circle")
    .attr("r", (d) => radiusScale(d.totalWeight))
    .attr("fill", "#10b981")
    .attr("stroke", "#064e3b")
    .attr("stroke-width", 1.2)
    .call(
      d3
        .drag()
        .on("start", (event, d) => {
          if (layoutMode === "animated" && !event.active) simulation.alphaTarget(0.3).restart();
          d.fx = d.x;
          d.fy = d.y;
        })
        .on("drag", (event, d) => {
          d.fx = event.x;
          d.fy = event.y;
          if (layoutMode === "static") {
            d.x = event.x;
            d.y = event.y;
            updatePositions();
          }
        })
        .on("end", (event, d) => {
          if (layoutMode === "animated" && !event.active) simulation.alphaTarget(0);
          if (layoutMode === "animated") {
            d.fx = null;
            d.fy = null;
          }
        })
    );

  node
    .on("mouseover", (event, d) => {
      showTooltip(
        tooltip,
        `<strong>${d.label}</strong><br/>Total shared-weight: ${formatNumber(
          d.totalWeight
        )}<br/>Connections: ${d.linkCount}`,
        event
      );
    })
    .on("mouseout", () => hideTooltip(tooltip));

  const label = svg
    .append("g")
    .selectAll("text")
    .data(nodes)
    .join("text")
    .text((d) => d.label)
    .attr("font-size", 10)
    .attr("fill", "#083344")
    .attr("text-anchor", "middle");

  function updatePositions() {
    link
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);

    node.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
    label.attr("x", (d) => d.x).attr("y", (d) => d.y - radiusScale(d.totalWeight) - 4);
  }

  if (layoutMode === "static") {
    const iterations = Math.min(350, Math.max(70, Math.round(nodes.length)));
    for (let i = 0; i < iterations; i += 1) {
      simulation.tick();
    }
    updatePositions();
  } else {
    simulation.on("tick", updatePositions);
  }

  return {
    nodes: filtered.nodes,
    links: filtered.links,
  };
}
