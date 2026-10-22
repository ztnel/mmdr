// Post-render readback: contrast, overlap, density, and a PNG capture.
const PAGE_BACKGROUND = [13, 17, 23, 1];
const MIN_CONTRAST = 4.5;
const LIMITS = { nodes: 25, labels: 60, width: 2400, height: 2400 };
const SHAPES = "rect,path,polygon,circle,ellipse";

function parseColor(value) {
  const match = /rgba?\(([^)]+)\)/.exec(value || "");
  if (!match) return null;
  const [r, g, b, a = 1] = match[1].split(/[,/ ]+/).filter(Boolean).map(Number);
  return [r, g, b, a];
}

function over(top, bottom) {
  const alpha = top[3] + bottom[3] * (1 - top[3]);
  if (!alpha) return [0, 0, 0, 0];
  const mix = (i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha;
  return [mix(0), mix(1), mix(2), alpha];
}

function luminance([r, g, b]) {
  const channel = (value) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function labelElements(svg) {
  const found = [];
  for (const text of svg.querySelectorAll("text")) {
    if (text.textContent.trim() && !text.closest("defs")) found.push(text);
  }
  for (const html of svg.querySelectorAll("foreignObject *")) {
    const own = [...html.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (own) found.push(html);
  }
  return found;
}

function foreground(element) {
  const style = getComputedStyle(element);
  const isSvg = element instanceof SVGElement;
  const color = parseColor(isSvg ? style.fill : style.color);
  if (!color) return null;
  const opacity = Number(style.opacity);
  color[3] *= Number.isFinite(opacity) ? opacity : 1;
  return color;
}

function backdrop(label, shapes, rect) {
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  let color = PAGE_BACKGROUND;
  for (const shape of shapes) {
    if (!(shape.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (shape.contains(label)) continue;
    const box = shape.getBoundingClientRect();
    if (cx < box.left || cx > box.right || cy < box.top || cy > box.bottom) continue;
    const style = getComputedStyle(shape);
    const fill = parseColor(style.fill);
    if (!fill) continue;
    const opacity = Number(style.fillOpacity);
    fill[3] *= (Number.isFinite(opacity) ? opacity : 1) * (Number(style.opacity) || 0);
    if (fill[3] > 0) color = over(fill, color);
  }
  return color;
}

function intersection(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

const area = (r) => r.width * r.height;

function findOverlaps(items) {
  const found = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const shared = intersection(a.rect, b.rect);
      if (shared > 0.15 * Math.min(area(a.rect), area(b.rect))) found.push([a.label, b.label]);
    }
  }
  return found;
}

export function analyze(svg) {
  const shapes = [...svg.querySelectorAll(SHAPES)].filter((s) => !s.closest("defs,marker"));
  const labels = labelElements(svg).map((element) => {
    const rect = element.getBoundingClientRect();
    return { element, rect, label: element.textContent.trim().replace(/\s+/g, " ").slice(0, 60) };
  }).filter((item) => item.rect.width > 0 && item.rect.height > 0);

  const lowContrast = [];
  for (const { element, rect, label } of labels) {
    const fg = foreground(element);
    if (!fg) continue;
    const bg = backdrop(element, shapes, rect);
    const ratio = contrastRatio(over(fg, bg), bg);
    if (ratio < MIN_CONTRAST) lowContrast.push({ label, ratio: Math.round(ratio * 100) / 100 });
  }

  const nodes = [...svg.querySelectorAll("g.node, g.statediagram-state, g.classGroup")]
    .map((element) => ({ element, rect: element.getBoundingClientRect(),
      label: element.textContent.trim().replace(/\s+/g, " ").slice(0, 60) }))
    .filter((item) => item.rect.width > 0 && item.rect.height > 0);
  const overlaps = [...findOverlaps(labels), ...findOverlaps(nodes)];

  const box = svg.viewBox.baseVal;
  const density = {
    nodes: nodes.length, labels: labels.length, width: Math.round(box.width), height: Math.round(box.height),
  };
  const busy = density.nodes > LIMITS.nodes || density.labels > LIMITS.labels
    || density.width > LIMITS.width || density.height > LIMITS.height;

  const findings = [];
  if (lowContrast.length) {
    findings.push(`${lowContrast.length} label(s) below ${MIN_CONTRAST}:1 contrast; use lighter text or darker fills`);
  }
  if (overlaps.length) findings.push(`${overlaps.length} overlapping element pair(s)`);
  if (busy) findings.push("diagram is busy; split it into smaller diagrams");
  return {
    passed: !findings.length, findings, lowContrast: lowContrast.slice(0, 20),
    overlaps: overlaps.slice(0, 20), density, busy,
  };
}

function inlineStyles(source, clone) {
  const properties = ["fill", "stroke", "stroke-width", "color", "font-family", "font-size",
    "font-weight", "opacity", "fill-opacity", "stroke-opacity", "display", "text-anchor",
    "dominant-baseline", "stroke-dasharray"];
  const from = [source, ...source.querySelectorAll("*")], to = [clone, ...clone.querySelectorAll("*")];
  from.forEach((element, index) => {
    const style = getComputedStyle(element);
    to[index].setAttribute("style", properties.map((p) => `${p}:${style.getPropertyValue(p)}`).join(";"));
  });
}

export async function capture(svg, maxSide = 1600) {
  const box = svg.viewBox.baseVal;
  const width = box.width || 600, height = box.height || 400;
  const clone = svg.cloneNode(true);
  inlineStyles(svg, clone);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", width);
  clone.setAttribute("height", height);
  const scale = Math.min(2, maxSide / Math.max(width, height));
  const markup = new XMLSerializer().serializeToString(clone);
  const image = new Image();
  image.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(markup);
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const context = canvas.getContext("2d");
  context.fillStyle = "#0d1117";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png").split(",")[1];
}
