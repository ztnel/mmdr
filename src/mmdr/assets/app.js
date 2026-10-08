import mermaid from "/vendor/mermaid.js";
import { indexElements } from "/anchors.js";

const $ = (id) => document.getElementById(id);
let capability = location.hash.slice(1) || sessionStorage.getItem("review-capability");
if (capability) sessionStorage.setItem("review-capability", capability);
history.replaceState(null, "", "/");
let state = null;
let rendered = "";
let failed = "";
let anchors = [];
let selected = null;
let scale = 1, x = 0, y = 0;
let polling = false;
let threadFingerprint = "";
let renderCount = 0;
let searchIndex = -1;
let activeThread = null;
let activeMessage = null;
let showAllThreads = false;
let leaderPending = false;

function snap(key) {
  const element = owner(key);
  if (!element) return;
  const canvas = $("canvas").getBoundingClientRect();
  const bounds = element.getBoundingClientRect();
  x += canvas.width * .4 - (bounds.left + bounds.width / 2 - canvas.left);
  y += canvas.height / 2 - (bounds.top + bounds.height / 2 - canvas.top);
  transform();
}

function pan(dx, dy) {
  x += dx;
  y += dy;
  transform();
}

function jumpElement(key) {
  const directions = { h: [-1, 0], j: [0, 1], k: [0, -1], l: [1, 0] };
  const [dx, dy] = directions[key];
  const elements = anchors.map((anchor) => {
    const element = owner(anchor.key);
    if (!element) return null;
    const bounds = element.getBoundingClientRect();
    return { key: anchor.key, x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  }).filter(Boolean);
  if (!elements.length) return;
  const index = elements.findIndex((element) => element.key === selected);
  const current = elements[index];
  let next;
  if (current) {
    const candidates = elements.filter((element) => element.key !== selected).map((element) => {
      const vx = element.x - current.x, vy = element.y - current.y;
      const forward = vx * dx + vy * dy;
      const sideways = Math.abs(vx * dy - vy * dx);
      return { ...element, forward, score: Math.hypot(vx, vy) + sideways * 2 };
    }).filter((element) => element.forward > 1).sort((a, b) => a.score - b.score);
    next = candidates[0];
  }
  if (!next) {
    const step = dx + dy > 0 ? 1 : -1;
    next = elements[index < 0 ? (step > 0 ? 0 : elements.length - 1)
      : (index + step + elements.length) % elements.length];
  }
  showAllThreads = false;
  select(next.key);
  snap(next.key);
  $("canvas").focus({ preventScroll: true });
}

function updateMode() {
  const target = document.activeElement;
  const mode = state?.closed ? "CLOSED"
    : target === $("command") ? "COMMAND"
    : target === $("search") ? "SEARCH"
    : target?.matches("textarea,input,select") || target?.isContentEditable ? "INSERT"
    : selected ? "VISUAL" : "NORMAL";
  $("vim-mode").textContent = mode;
  $("vim-mode").classList.toggle("visual-mode", mode === "VISUAL");
  $("keyboard-status").classList.toggle("closed-mode", mode === "CLOSED");
}

function deselect() {
  selected = null;
  activeThread = null;
  activeMessage = null;
  showAllThreads = false;
  $("discussion").hidden = true;
  $("selection").textContent = "No selection";
  for (const element of $("viewport").querySelectorAll(".selected")) {
    element.classList.remove("selected");
  }
  renderThreads();
  updateSelectionGlow();
  updateCommentStatus();
  updateMode();
}

function searchMatches() {
  const query = $("search").value.trim().toLocaleLowerCase();
  return query ? anchors.filter((anchor) => anchor.label.toLocaleLowerCase().includes(query)) : [];
}

function jumpMatch(direction = 0) {
  const matches = searchMatches();
  if (!matches.length) {
    searchIndex = -1;
    $("search-status").textContent = $("search").value ? "No matches" : "Type to search";
    return;
  }
  searchIndex = direction ? (searchIndex + direction + matches.length) % matches.length : 0;
  $("search-status").textContent = `${searchIndex + 1}/${matches.length}`;
  showAllThreads = false;
  select(matches[searchIndex].key);
  snap(selected);
}

function comments() {
  return (state?.threads || []).flatMap((thread) =>
    thread.messages.map((message) => ({ thread, message }))
  ).sort((a, b) => a.message.seq - b.message.seq);
}

function updateCommentStatus() {
  const all = comments();
  const index = all.findIndex(({ message }) => message.id === activeMessage);
  $("comment-status").textContent = `${index >= 0 ? `${index + 1}/` : ""}${all.length} comments`;
}

function jumpComment(direction) {
  const all = comments();
  if (!all.length) { error("No comments yet"); return; }
  const index = all.findIndex(({ message }) => message.id === activeMessage);
  const next = index < 0 ? (direction > 0 ? 0 : all.length - 1)
    : (index + direction + all.length) % all.length;
  const { thread, message } = all[next];
  showAllThreads = false;
  select(thread.anchor, thread.id, message.id, true);
  snap(selected);
  const row = [...$("threads").querySelectorAll(".message")].find((item) => item.dataset.message === message.id);
  row?.scrollIntoView({ block: "nearest" });
  row?.focus({ preventScroll: true });
  updateCommentStatus();
}

function compose() {
  const threads = (state?.threads || []).filter((thread) => thread.anchor === selected && !thread.resolved);
  const thread = threads.find((item) => item.id === activeThread) || threads.at(-1);
  showAllThreads = false;
  select(selected || "diagram", thread?.id || null, activeMessage, true);
  const input = $("content");
  input.scrollIntoView({ block: "nearest" });
  input.focus({ preventScroll: true });
}

function error(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function wakeStatus(online, text) {
  $("wake-text").textContent = text;
  $("wake-dot").className = `wake-dot ${online ? "online" : "offline"}`;
  $("wake-dot").setAttribute("aria-label", `Agent ${online ? "waiting" : "not waiting"}`);
}

async function closeReview() {
  await api("close", {});
  await refresh(true);
  $("discussion").hidden = true;
  $("command-status").textContent = "Review closed";
  updateMode();
}

function leaveCommand() {
  $("command-bar").hidden = true;
  $("keyboard-status").classList.remove("command-mode");
  $("canvas").focus({ preventScroll: true });
  updateMode();
}

async function api(route, data) {
  const response = await fetch(`/api/${route}`, {
    method: data === undefined ? "GET" : "POST",
    headers: { "X-Review-Token": capability || "", "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `Request failed: ${response.status}`);
  return body;
}

function transform() {
  scale = Math.max(0.1, Math.min(8, scale));
  $("viewport").style.left = `${x}px`;
  $("viewport").style.top = `${y}px`;
  const svg = $("viewport").querySelector("svg");
  if (svg) {
    const bounds = svg.viewBox.baseVal;
    svg.setAttribute("width", (bounds.width || 600) * scale);
    svg.setAttribute("height", (bounds.height || 400) * scale);
  }
  $("scale").textContent = `${Math.round(scale * 100)}%`;
  positionDiscussions();
}

function zoomAt(next, cx, cy) {
  next = Math.max(.1, Math.min(8, next));
  const canvas = $("canvas").getBoundingClientRect();
  const svg = $("viewport").querySelector("svg");
  if (!svg) return;
  const bounds = svg.getBoundingClientRect();
  const ratio = next / scale;
  x += (cx - (bounds.left - canvas.left)) * (1 - ratio);
  y += (cy - (bounds.top - canvas.top)) * (1 - ratio);
  scale = next;
  transform();
}

function zoomCenter(factor) {
  zoomAt(scale * factor, $("canvas").clientWidth / 2, $("canvas").clientHeight / 2);
}

function owner(key) {
  return [...$("viewport").querySelectorAll("[data-anchor][tabindex]")].find((element) =>
    element.dataset.anchor === key
  );
}

function updateSelectionGlow() {
  updatePathGlow("selection-path-glow", selected);
}

function updatePathGlow(className, key, hover = false) {
  for (const previous of $("viewport").querySelectorAll(`.${className}`)) {
    previous.classList.remove("visible");
    setTimeout(() => {
      const filter = previous.ownerSVGElement?.querySelector(`#${previous.dataset.glowFilter}`);
      const defs = filter?.parentElement;
      filter?.remove();
      if (defs && !defs.childElementCount) defs.remove();
      previous.remove();
    }, 320);
  }
  const element = owner(key);
  if (!element) return;
  const glow = element.cloneNode(true);
  const shapes = "path,rect,circle,ellipse,polygon,polyline,line";
  for (const child of glow.querySelectorAll("text,foreignObject,image,defs")) child.remove();
  for (const child of [glow, ...glow.querySelectorAll("*")]) {
    for (const attribute of ["id", "data-anchor", "tabindex", "role", "aria-label", "marker-start", "marker-mid", "marker-end"]) {
      child.removeAttribute(attribute);
    }
    child.removeAttribute("class");
    if (child.matches(shapes)) {
      child.style.setProperty("fill", "none", "important");
      child.style.setProperty("stroke", "#39c5cf", "important");
      child.style.setProperty("stroke-width", "3px", "important");
    }
  }
  glow.classList.add(className);
  glow.setAttribute("aria-hidden", "true");
  const svg = element.ownerSVGElement;
  const filterId = `${svg.id}-selection-blur-${crypto.randomUUID()}`;
  glow.dataset.glowFilter = filterId;
  if (!svg.querySelector(`#${filterId}`)) {
    const ns = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(ns, "defs");
    const filter = document.createElementNS(ns, "filter");
    filter.id = filterId;
    const bounds = element.getBBox();
    filter.setAttribute("filterUnits", "userSpaceOnUse");
    const padding = hover ? 24 / scale : 24;
    filter.setAttribute("x", bounds.x - padding);
    filter.setAttribute("y", bounds.y - padding);
    filter.setAttribute("width", bounds.width + padding * 2);
    filter.setAttribute("height", bounds.height + padding * 2);
    const blur = document.createElementNS(ns, "feGaussianBlur");
    blur.setAttribute("stdDeviation", hover ? 3 / scale : 4);
    filter.append(blur);
    defs.append(filter);
    svg.prepend(defs);
  }
  glow.style.filter = `url(#${filterId})`;
  for (const shape of [glow, ...glow.querySelectorAll(shapes)].filter((item) => item.matches(shapes))) {
    shape.style.setProperty("stroke-width", `${hover ? 5 / scale : 7}px`, "important");
  }
  element.parentNode.append(glow);
  // Establish the transparent state before transitioning the path-only overlay.
  glow.getBoundingClientRect();
  requestAnimationFrame(() => glow.classList.add("visible"));
}

function threadPending(thread) {
  const lastAgent = Math.max(-1, ...thread.messages.filter((message) => message.role === "agent").map((message) => message.seq));
  return !thread.resolved && thread.messages.some((message) => message.role === "human" && message.seq > lastAgent);
}

function positionDiscussions() {
  const canvas = $("canvas").getBoundingClientRect();
  function point(key) {
    const element = owner(key);
    if (!element) return { x: 24, y: 24 };
    const bounds = element.getBoundingClientRect();
    return { x: bounds.right - canvas.left, y: bounds.top - canvas.top };
  }
  for (const marker of $("markers").children) {
    const anchor = point(marker.dataset.anchor);
    marker.style.left = `${anchor.x}px`;
    marker.style.top = `${anchor.y}px`;
  }
  if (!$("discussion").hidden) {
    const anchor = point(selected);
    const panel = $("discussion");
    const availableHeight = canvas.height - $("keyboard-status").offsetHeight - 16;
    panel.style.maxHeight = `${Math.max(0, Math.min(540, availableHeight))}px`;
    const left = anchor.x + panel.offsetWidth + 20 < canvas.width
      ? anchor.x + 20 : anchor.x - panel.offsetWidth - 20;
    panel.style.left = `${Math.max(8, Math.min(left, canvas.width - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(anchor.y, availableHeight - panel.offsetHeight + 8))}px`;
  }
}

function renderMarkers() {
  $("markers").replaceChildren();
  if (!state) return;
  for (const anchor of anchors) {
    const threads = state.threads.filter((thread) => thread.anchor === anchor.key && !thread.resolved && !thread.orphaned);
    const count = threads.reduce((sum, thread) => sum + thread.messages.length, 0);
    if (!count) continue;
    const pending = threads.some(threadPending);
    const marker = button(String(count), async () => {
      showAllThreads = false;
      select(anchor.key, null, null, true);
    });
    marker.className = `comment-marker ${pending ? "pending" : "answered"}`;
    marker.dataset.anchor = anchor.key;
    marker.setAttribute("aria-label", `${count} messages on ${anchor.label}: ${pending ? "pending agent reply" : "answered"}`);
    $("markers").append(marker);
  }
  positionDiscussions();
}

function fit() {
  const svg = $("viewport").querySelector("svg");
  if (!svg) return;
  const bounds = svg.viewBox.baseVal;
  scale = Math.min(
    ($("canvas").clientWidth - 40) / Math.max(1, bounds.width + 40),
    ($("canvas").clientHeight - 40) / Math.max(1, bounds.height + 40),
    2,
  );
  x = 0; y = 0;
  transform();
}

function select(key, threadId = null, messageId = null, openDiscussion = false) {
  hovered = null;
  updatePathGlow("hover-path-glow", null, true);
  selected = key;
  activeThread = threadId;
  activeMessage = messageId;
  $("discussion").hidden = !openDiscussion;
  const anchor = anchors.find((item) => item.key === key);
  $("selection").textContent = anchor?.label || "Whole diagram";
  $("anchor-hint").textContent = anchor && !anchor.stable
    ? "Revision-bound element: changes may require explicit thread reattachment."
    : "Threads follow the source element identity; removed elements remain available in All threads.";
  for (const element of $("viewport").querySelectorAll("[data-anchor][tabindex]")) {
    element.classList.toggle("selected", element.dataset.anchor === key);
  }
  renderThreads();
  updateSelectionGlow();
  positionDiscussions();
  updateCommentStatus();
  updateMode();
}

function button(text, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.addEventListener("click", () => action().catch((exc) => error(exc.message)));
  return element;
}

function renderThreads() {
  if (!state) return;
  const history = $("threads");
  const scroll = history.scrollTop;
  const atBottom = history.scrollHeight - history.clientHeight - scroll < 24;
  $("threads").replaceChildren();
  renderMarkers();
  for (const thread of state.threads) {
    if (activeThread && !showAllThreads && thread.id !== activeThread) continue;
    if (!showAllThreads && thread.anchor !== selected && !thread.orphaned) continue;
    const card = document.createElement("article");
    const pending = threadPending(thread);
    card.className = `thread ${pending ? "pending" : "answered"}${thread.orphaned ? " orphaned" : ""}${thread.resolved ? " resolved" : ""}`;
    card.dataset.thread = thread.id;
    card.tabIndex = 0;
    card.classList.toggle("current-thread", thread.id === activeThread);
    const title = document.createElement("h3");
    title.textContent = anchors.find((anchor) => anchor.key === thread.anchor)?.label || thread.label;
    card.append(title);
    const status = document.createElement("span");
    status.className = `thread-status ${pending ? "pending" : "answered"}`;
    status.textContent = `${thread.orphaned ? "Missing/ambiguous element · " : ""}${thread.resolved ? "Resolved" : pending ? "Pending agent reply" : "Answered"}`;
    card.append(status);
    for (const message of thread.messages) {
      const row = document.createElement("div");
      row.className = `message ${message.role === "agent" ? "agent-message" : "human-message"}`;
      row.dataset.message = message.id;
      row.tabIndex = 0;
      row.classList.toggle("current-comment", message.id === activeMessage);
      const byline = document.createElement("div");
      byline.className = "byline";
      byline.textContent = `${message.author} · ${new Date(message.created * 1000).toLocaleString()}`;
      const content = document.createElement("div");
      content.textContent = message.content;
      row.append(byline, content);
      card.append(row);
    }
    const actions = document.createElement("div");
    actions.className = "actions";
    if (thread.orphaned && selected && selected !== "diagram") {
      actions.append(button("Attach to selection", async () => {
        await api("reattach", { thread: thread.id, anchor: selected });
        await refresh(true);
      }));
    }
    if (actions.children.length) card.append(actions);
    $("threads").append(card);
  }
  positionDiscussions();
  history.scrollTop = atBottom ? history.scrollHeight : scroll;
}

async function render(next) {
  if (next.source_error) throw new Error(next.source_error);
  const parsed = await mermaid.parse(next.content);
  // The bundled legacy state renderer calls a removed db.getRootDoc API.
  const renderSource = parsed.diagramType === "state"
    ? next.content.replace(/^\s*stateDiagram\b/m, "stateDiagram-v2")
    : next.content;
  const { svg } = await mermaid.render(`review-diagram-${++renderCount}`, renderSource);
  const container = document.createElement("div");
  container.innerHTML = svg;
  const diagram = container.querySelector("svg");
  if (!diagram) throw new Error("Mermaid did not produce an SVG");
  for (const element of diagram.querySelectorAll("a")) {
    element.removeAttribute("href");
    element.removeAttribute("xlink:href");
  }
  for (const element of diagram.querySelectorAll("script,iframe,object,embed")) element.remove();
  for (const element of diagram.querySelectorAll("image,img")) {
    const href = element.getAttribute("href") || element.getAttribute("src") || element.getAttribute("xlink:href");
    if (href && !href.startsWith("data:")) element.remove();
  }
  const first = !rendered;
  $("viewport").replaceChildren(diagram);
  const bounds = diagram.viewBox.baseVal;
  diagram.setAttribute("width", bounds.width || 600);
  diagram.setAttribute("height", bounds.height || 400);
  anchors = indexElements(diagram, next.current_revision);
  await api("anchors", { revision: next.current_revision, anchors });
  rendered = next.current_revision;
  failed = "";
  if (selected && selected !== "diagram" && !anchors.some((item) => item.key === selected)) {
    selected = "diagram";
  }
  for (const element of diagram.querySelectorAll("[data-anchor][tabindex]")) {
    element.classList.toggle("selected", element.dataset.anchor === selected);
  }
  updateSelectionGlow();
  $("type").textContent = parsed.diagramType;
  $("type").title = parsed.diagramType === "state"
    ? "Legacy state syntax rendered with the compatible stateDiagram-v2 renderer"
    : parsed.diagramType;
  if (first) fit();
  else transform();
  error("");
}

async function refresh(force = false, rerender = false) {
  if (polling && !force) return;
  polling = true;
  try {
    const next = await api("state");
    $("source").textContent = `${next.source} · ${next.block}`;
    wakeStatus(next.agent_online === true, next.agent_status);
    if (next.source_error) {
      error(next.source_error);
    } else if (rerender || (next.current_revision !== rendered && next.current_revision !== failed)) {
      try { await render(next); }
      catch (exc) { failed = next.current_revision; error(`Render failed: ${exc.message}`); }
    }
    state = await api("state");
    updateCommentStatus();
    $("selection").textContent = selected
      ? anchors.find((anchor) => anchor.key === selected)?.label || "Whole diagram"
      : "No selection";
    updateMode();
    $("new-comment").querySelector("button").disabled = state.closed || rendered !== state.current_revision;
    $("close").disabled = state.closed;
    const fingerprint = JSON.stringify(state.threads);
    if (force || fingerprint !== threadFingerprint) {
      threadFingerprint = fingerprint;
      renderThreads();
    }
    positionDiscussions();
  } catch (exc) {
    wakeStatus(false, `server offline: ${exc.message}`);
  }
  finally { polling = false; }
}

$("new-comment").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("new-comment").querySelector("button");
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const candidates = (state?.threads || []).filter((thread) =>
      thread.anchor === selected && !thread.resolved
    );
    const thread = state?.threads.find((item) => item.id === activeThread) || candidates.at(-1);
    const payload = thread
      ? { content: $("content").value, parent: thread.messages.at(-1).id }
      : { content: $("content").value, anchor: selected, revision: rendered };
    const posted = await api("message", payload);
    activeThread = posted.thread;
    showAllThreads = false;
    $("content").value = "";
    await refresh(true);
    $("threads").scrollTop = $("threads").scrollHeight;
    $("canvas").focus({ preventScroll: true });
  } catch (exc) { error(exc.message); }
  finally { submit.disabled = !!state?.closed || rendered !== state?.current_revision; }
});
$("search").addEventListener("input", () => jumpMatch());
document.addEventListener("focusin", updateMode);
$("help-button").onclick = () => $("help").showModal();
$("help-close").onclick = () => $("help").close();
document.addEventListener("keydown", (event) => {
  if ($("help").open) {
    if (event.key === "Escape") {
      event.preventDefault();
      $("help").close();
    }
    return;
  }
  if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (event.key === "Escape") {
    event.preventDefault();
    leaderPending = false;
    $("command-status").textContent = "";
    if (target === $("command")) { leaveCommand(); return; }
    if (target === $("search")) $("search-bar").hidden = true;
    else if (!target.matches("textarea,input,select") && !target.isContentEditable) deselect();
    $("canvas").focus({ preventScroll: true });
    return;
  }
  if (target === $("command")) {
    if (event.key === "Enter") {
      event.preventDefault();
      const command = target.value.trim();
      leaveCommand();
      if (command === "e") {
        failed = "";
        refresh(true, true).then(() => {
          $("command-status").textContent = failed ? "Diagram render failed" : "Diagram refreshed";
        });
      } else if (["q", "wq", "x"].includes(command)) {
        closeReview().catch((exc) => { $("command-status").textContent = exc.message; });
      } else {
        $("command-status").textContent = `E492: Not an editor command: ${command}`;
      }
    }
    return;
  }
  if (target === $("search")) {
    if (event.key === "Enter") {
      event.preventDefault();
      $("search-bar").hidden = true;
      $("canvas").focus({ preventScroll: true });
    }
    return;
  }
  if (target.matches("textarea")) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      target.form.requestSubmit();
    }
    return;
  }
  if (target.matches("input,select") || target.isContentEditable) return;
  if (event.key === "?") {
    event.preventDefault();
    leaderPending = false;
    $("help").showModal();
    return;
  }
  if (leaderPending) {
    leaderPending = false;
    $("command-status").textContent = "";
    if (event.key === "c") {
      event.preventDefault();
      select("diagram");
      compose();
      return;
    }
  }
  if (event.key === ";") {
    event.preventDefault();
    leaderPending = true;
    $("command-status").textContent = ";";
    return;
  }
  if (!["/", ":", "n", "N", "c", "m", "M", "h", "j", "k", "l"].includes(event.key)) return;
  event.preventDefault();
  if (event.key === ":") {
    $("search-bar").hidden = true;
    $("command-status").textContent = "";
    $("command-bar").hidden = false;
    $("keyboard-status").classList.add("command-mode");
    $("command").value = "";
    $("command").focus();
  } else if (event.key === "/") {
    $("search-bar").hidden = false;
    $("search").focus();
    $("search").select();
  } else if (event.key === "n" || event.key === "N") {
    jumpMatch(event.key === "n" ? 1 : -1);
  } else if (event.key === "c") compose();
  else if (["h", "j", "k", "l"].includes(event.key)) {
    if ((event.key === "j" || event.key === "k") && !$("discussion").hidden) {
      $("threads").scrollTop += event.key === "j" ? 30 : -30;
    } else if (selected) {
      jumpElement(event.key);
    } else {
      const directions = { h: [30, 0], j: [0, -30], k: [0, 30], l: [-30, 0] };
      pan(...directions[event.key]);
    }
  }
  else jumpComment(event.key === "m" ? 1 : -1);
});
$("zoom-in").onclick = () => zoomCenter(1.25);
$("zoom-out").onclick = () => zoomCenter(1 / 1.25);
$("fit").onclick = fit;
$("reset").onclick = () => { scale = 1; x = 0; y = 0; transform(); };
$("whole").onclick = () => { showAllThreads = false; select("diagram"); };
$("all-threads").onclick = () => { showAllThreads = true; select("diagram"); };
$("dismiss").onclick = () => { $("discussion").hidden = true; };
new ResizeObserver(positionDiscussions).observe($("canvas"));
$("close").onclick = async () => {
  try { await closeReview(); }
  catch (exc) { error(exc.message); }
};
$("canvas").addEventListener("click", (event) => {
  if (event.composedPath().includes($("markers"))) return;
  if (event.target.closest("#discussion,#markers,#keyboard-status")) return;
  if (event.detail > 0) return;
  const anchor = event.target.closest("[data-anchor]");
  if (anchor) select(anchor.dataset.anchor);
});
$("canvas").addEventListener("keydown", (event) => {
  if (event.target.closest("#discussion,#markers,#keyboard-status")) return;
  if (event.key === "Enter" || event.key === " ") {
    const anchor = event.target.closest("[data-anchor]");
    if (anchor) { event.preventDefault(); select(anchor.dataset.anchor); }
  }
  if (event.key === "+" || event.key === "=") zoomCenter(1.25);
  if (event.key === "-") zoomCenter(1 / 1.25);
  if (event.key === "0") fit();
  const arrows = { ArrowLeft: [30, 0], ArrowRight: [-30, 0], ArrowUp: [0, 30], ArrowDown: [0, -30] };
  if (arrows[event.key]) {
    event.preventDefault(); pan(...arrows[event.key]);
  }
});
$("canvas").addEventListener("wheel", (event) => {
  if (event.target.closest("#discussion,#keyboard-status")) return;
  event.preventDefault();
  const box = $("canvas").getBoundingClientRect();
  const cx = event.clientX - box.left, cy = event.clientY - box.top;
  zoomAt(scale * Math.exp(-event.deltaY / 500), cx, cy);
}, { passive: false });
let drag = null;
let hovered = null;
$("canvas").addEventListener("pointermove", (event) => {
  if (drag) return;
  const anchor = event.target.closest("#viewport [data-anchor]");
  const key = anchor?.dataset.anchor !== selected ? anchor?.dataset.anchor : null;
  if (key === hovered) return;
  hovered = key;
  updatePathGlow("hover-path-glow", key, true);
});
$("canvas").addEventListener("pointerleave", () => {
  if (drag) return;
  hovered = null;
  updatePathGlow("hover-path-glow", null, true);
});
$("canvas").addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0 || drag) return;
  if (event.target.closest("#discussion,#markers,#keyboard-status")) return;
  const anchor = event.target.closest("[data-anchor]");
  event.preventDefault();
  drag = {
    pointerId: event.pointerId, px: event.clientX, py: event.clientY, x, y,
    anchor: anchor?.dataset.anchor, moved: false,
  };
  $("canvas").setPointerCapture(event.pointerId);
});
$("canvas").addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!drag.moved) {
    if (Math.hypot(event.clientX - drag.px, event.clientY - drag.py) < 4) return;
    drag.moved = true;
  }
  x = drag.x + event.clientX - drag.px; y = drag.y + event.clientY - drag.py; transform();
});
function endDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  const pressed = drag;
  drag = null;
  hovered = null;
  updatePathGlow("hover-path-glow", null, true);
  if ($("canvas").hasPointerCapture(event.pointerId)) {
    $("canvas").releasePointerCapture(event.pointerId);
  }
  if (event.type === "pointerup" && !pressed.moved && pressed.anchor &&
      Math.hypot(event.clientX - pressed.px, event.clientY - pressed.py) < 4) {
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const anchor = target?.closest("#viewport [data-anchor]");
    if (anchor?.dataset.anchor === pressed.anchor) {
      select(pressed.anchor);
      $("canvas").focus({ preventScroll: true });
    }
  }
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);
$("canvas").addEventListener("lostpointercapture", endDrag);

await refresh(true);
setInterval(() => refresh(), 800);
