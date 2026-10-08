import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const examples = JSON.parse(readFileSync("tests/examples.json", "utf8"));
const python = process.env.PYTHON || "python3";
let temporary, source, stateDir, processHandle, url;

async function waitForRender(page, name) {
  await expect(page.locator("#type"), name).toHaveText(/\S/);
  await expect(page.locator("#viewport > svg"), name).toBeVisible();
  await expect(page.locator("#error"), name).toBeHidden();
  await expect(page.locator("#new-comment button"), name).toBeEnabled();
}

test.beforeEach(async () => {
  temporary = mkdtempSync(join(tmpdir(), "diagram-browser-"));
  source = join(temporary, "diagram.mmd");
  stateDir = join(temporary, "state");
  writeFileSync(source, "flowchart TD\nA[Alpha] --> B[Beta]\n");
  processHandle = spawn(python, ["-m", "mmdr.cli", "--state-dir", stateDir, "open", source,
    "--workspace", temporary, "--no-browser"], { cwd: root });
  let output = "";
  url = await new Promise((resolve, reject) => {
    processHandle.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/REVIEW_URL=(\S+)/);
      if (match) resolve(match[1]);
    });
    processHandle.stderr.on("data", (chunk) => console.error(chunk.toString()));
    processHandle.on("exit", (code) => reject(new Error(`server exited ${code}: ${output}`)));
    setTimeout(() => reject(new Error("server startup timeout")), 10000).unref();
  });
});

test.afterEach(async () => {
  if (processHandle) {
    processHandle.kill("SIGTERM");
    await new Promise((resolve) => {
      if (processHandle.exitCode !== null) resolve();
      else processHandle.once("exit", resolve);
    });
  }
  if (temporary) rmSync(temporary, { recursive: true, force: true });
});

test("all registered Mermaid types render offline and every primitive is selectable", async ({ page }) => {
  const external = [];
  page.on("request", (request) => {
    if (!request.url().startsWith(new URL(url).origin)) external.push(request.url());
  });
  await page.goto(url);
  const fixtures = Object.entries(examples).map(([name, values]) => [name, values[0]]);
  fixtures.push(["info", "info"]);
  fixtures.push(["legacy-flowchart", "%%{init: {'flowchart': {'defaultRenderer': 'dagre-d3'}}}%%\ngraph TD\nA --> B"]);
  fixtures.push(["legacy-class", "%%{init: {'class': {'defaultRenderer': 'dagre-d3'}}}%%\nclassDiagram\nA <|-- B"]);
  fixtures.push(["legacy-state", "%%{init: {'state': {'defaultRenderer': 'dagre-d3'}}}%%\nstateDiagram\n[*] --> Ready\nReady --> [*]"]);
  fixtures.push(["elk", "flowchart-elk TD\nA --> B"]);
  fixtures.push(["railroad", 'railroad-beta\nexpression = terminal("hello") ;']);
  fixtures.push(["railroad-abnf", 'railroad-abnf-beta\nexpression = "hello" ;']);
  fixtures.push(["railroad-peg", 'railroad-peg-beta\nexpression <- "hello" ;']);
  const renderedTypes = [];
  for (const [name, content] of fixtures) {
    writeFileSync(source, content);
    await page.reload();
    await waitForRender(page, name);
    const type = await page.locator("#type").textContent();
    renderedTypes.push(type);
    const coverage = await page.evaluate(async () => {
      const { selectableElements } = await import("/anchors.js");
      const elements = selectableElements(document.querySelector("#viewport svg"));
      return { total: elements.length, tagged: elements.filter((element) => element.dataset.anchor).length };
    });
    expect(coverage.total, name).toBeGreaterThan(0);
    expect(coverage.tagged, name).toBe(coverage.total);
    const first = page.locator("#viewport [data-anchor]").first();
    await first.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("c");
    await page.locator("#content").fill(`Review context for ${name}`);
    await page.locator("#new-comment button").click();
    await expect(page.locator("#threads")).toContainText(`Review context for ${name}`);
  }
  const registered = await page.evaluate(async () => {
    const { default: mermaid } = await import("/vendor/mermaid.js");
    return mermaid.getRegisteredDiagramsMetadata().map((entry) => entry.id).filter((id) =>
      id !== "error" && id !== "---"
    );
  });
  expect(new Set(renderedTypes)).toEqual(new Set(registered));
  expect(external).toEqual([]);
});

test("render completion waits for anchor registration before reading the diagram type", async ({ page }) => {
  writeFileSync(source, examples.requirementDiagram[0]);
  let release;
  const registration = new Promise((resolve) => { release = resolve; });
  await page.route("**/api/anchors", async (route) => {
    await registration;
    await route.continue();
  });
  try {
    await page.goto(url, { waitUntil: "commit" });
    await expect(page.locator("#viewport > svg")).toBeVisible();
    await expect(page.locator("#type")).toHaveText("");
    release();
    await waitForRender(page, "requirement");
    await expect(page.locator("#type")).toHaveText("requirement");
    await page.getByRole("button", { name: "Whole diagram", exact: true }).click();
    await page.keyboard.press("c");
    await page.locator("#content").fill("Render is complete");
    await page.locator("#new-comment button").click();
    await expect(page.locator("#threads")).toContainText("Render is complete");
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});

test("zoom, threads, live revisions, escaped text, and CLI replies", async ({ page }) => {
  writeFileSync(source, "flowchart TD\nA[Alpha] --> B[Beta]\n");
  await page.goto(url);
  await expect(page.locator("#error")).toBeHidden();
  await expect(page.locator("#type")).toHaveText("flowchart-v2");
  await page.locator("#reset").click();
  await page.locator("#zoom-in").click();
  await expect(page.locator("#scale")).toHaveText("125%");
  await page.locator("#zoom-out").click();
  await expect(page.locator("#scale")).toHaveText("100%");
  await page.locator('[data-anchor="flowchart:A"]').first().focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("c");
  await page.locator("#content").fill("<script>not executable</script>");
  await page.locator("#new-comment button").click();
  await expect(page.locator("#threads")).toContainText("<script>not executable</script>");
  expect(await page.locator("#threads script").count()).toBe(0);
  const reply = page.locator(".thread").filter({ hasText: "<script>not executable</script>" });
  await page.locator("#content").fill("Human follow-up");
  await page.locator("#new-comment button").click();
  await expect(page.locator("#content")).toHaveValue("");
  const list = spawnSync(python, ["-m", "mmdr.cli", "--state-dir", stateDir, "list"], { encoding: "utf8" });
  expect(list.status).toBe(0);
  const session = JSON.parse(list.stdout)[0].id;
  const pending = spawnSync(python, ["-m", "mmdr.cli", "--state-dir", stateDir, "comments", "--session", session, "--pending"], { encoding: "utf8" });
  const comments = JSON.parse(pending.stdout);
  await page.locator("#content").fill("Unsent context");
  await page.locator("#content").focus();
  await page.locator("#content").evaluate((input) => input.setSelectionRange(4, 7));
  const result = spawnSync(python, ["-m", "mmdr.cli", "--state-dir", stateDir, "reply", "--session", session,
    "--to", comments.at(-1).id, "--username", "test-agent", "Agent explanation"], { encoding: "utf8" });
  expect(result.status).toBe(0);
  await expect(reply).toContainText("Agent explanation");
  await expect(page.locator("#content")).toHaveValue("Unsent context");
  await expect(page.locator("#content")).toBeFocused();
  expect(await page.locator("#content").evaluate((input) => [input.selectionStart, input.selectionEnd])).toEqual([4, 7]);
  writeFileSync(source, "flowchart TD\nA[Alpha revised] --> C[Gamma]\n");
  await expect(page.locator("#viewport")).toContainText("Alpha revised");
  await expect(reply).not.toContainText("Missing/ambiguous");
  writeFileSync(source, "flowchart TD\nC[Gamma] --> D[Delta]\n");
  await expect(reply).toContainText("Missing/ambiguous");
  await expect(reply.getByRole("button", { name: "Resolve", exact: true })).toHaveCount(0);
  await expect(page.locator("body")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  writeFileSync(source, "broken diagram");
  await expect(page.locator("#error")).toContainText("Render failed");
  await expect(page.locator("#viewport svg")).toBeVisible();
});

test("vim search, keyboard posting, and global thread navigation", async ({ page }) => {
  writeFileSync(source, "flowchart TD\nKeyboardA[Shared keyboard engine] --> KeyboardB[Shared keyboard adapter]\n");
  await page.goto(url);
  await expect(page.locator("#type")).toHaveText("flowchart-v2");
  await page.keyboard.press("/");
  await page.locator("#search").fill("Shared keyboard");
  await expect(page.locator("#selection")).toHaveText("Shared keyboard engine");
  await expect(page.locator("#search-status")).toHaveText("1/2");
  await page.keyboard.press("Enter");
  await page.keyboard.press("n");
  await expect(page.locator("#selection")).toHaveText("Shared keyboard adapter");
  await page.keyboard.press("N");
  await expect(page.locator("#selection")).toHaveText("Shared keyboard engine");
  await expect(page.locator("#vim-mode")).toHaveText("VISUAL");
  await expect(page.locator("#discussion")).toBeHidden();
  await page.keyboard.press("j");
  await expect(page.locator("#selection")).toContainText("KeyboardA_KeyboardB");
  await page.keyboard.press("j");
  await expect(page.locator("#selection")).toHaveText("Shared keyboard adapter");
  await page.keyboard.press("k");
  await expect(page.locator("#selection")).toContainText("KeyboardA_KeyboardB");
  await page.keyboard.press("k");
  await expect(page.locator("#selection")).toHaveText("Shared keyboard engine");
  await expect(page.locator("#discussion")).toBeHidden();
  await page.keyboard.press("c");
  await expect(page.locator("#content")).toBeFocused();
  await page.keyboard.type("Keyboard first line");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("second line");
  await page.keyboard.press("Enter");
  await expect(page.locator("#threads")).toContainText("Keyboard first line\nsecond line");
  await page.keyboard.press("c");
  await expect(page.locator("#content")).toBeFocused();
  await page.keyboard.type("Keyboard appended reply");
  await page.keyboard.press("Enter");
  await expect(page.locator("#threads")).toContainText("Keyboard appended reply");
  await expect(page.locator(".comment-marker[data-anchor='flowchart:KeyboardA']")).toHaveText("2");
  await expect(page.locator(".thread")).toHaveCount(1);
  await page.keyboard.press("n");
  await page.keyboard.press("c");
  await page.keyboard.type("Adapter thread");
  await page.keyboard.press("Enter");
  await expect(page.locator("#threads")).toContainText("Adapter thread");
  await page.keyboard.press("m");
  await expect(page.locator(".current-comment")).toBeFocused();
  const first = await page.locator(".current-comment").getAttribute("data-message");
  await page.keyboard.press("m");
  await expect(page.locator(".current-comment")).not.toHaveAttribute("data-message", first);
  await expect(page.locator(".current-comment")).toContainText("Keyboard appended reply");
  await page.keyboard.press("M");
  await expect(page.locator(".current-comment")).toHaveAttribute("data-message", first);
  await expect(page.locator("#comment-status")).toHaveText("1/3 comments");
});

test("context-aware pan, thread scrolling, deselection, and input modes", async ({ page }) => {
  await page.goto(url);
  await waitForRender(page);
  const canvas = page.locator("#canvas");
  const mode = page.locator("#vim-mode");
  const position = () => page.locator("#viewport").evaluate((element) =>
    [parseFloat(element.style.left), parseFloat(element.style.top)]);
  const history = page.locator("#threads");
  const scroll = () => history.evaluate((element) => element.scrollTop);
  await canvas.focus();
  await expect(mode).toHaveText("NORMAL");
  await expect(page.locator("#keyboard-status")).toHaveCSS("left", "0px");
  const origin = await position();
  for (const [key, offset] of [["h", [30, 0]], ["j", [30, -30]], ["k", [30, 0]], ["l", [0, 0]]]) {
    await page.keyboard.press(key);
    expect(await position()).toEqual(origin.map((value, index) => value + offset[index]));
    await expect(mode).toHaveText("NORMAL");
    await expect(page.locator("#viewport .selected")).toHaveCount(0);
  }
  await page.locator('[data-anchor="flowchart:A"]').first().focus();
  await page.keyboard.press("Enter");
  await canvas.focus();
  await expect(mode).toHaveText("VISUAL");
  await expect(mode).toHaveCSS("background-color", "rgb(240, 136, 62)");
  await expect(page.locator("#discussion")).toBeHidden();
  for (let index = 0; index < 6; index++) {
    await page.keyboard.press("c");
    await expect(mode).toHaveText("INSERT");
    await page.locator("#content").fill(`Message ${index}: ` + "context ".repeat(40));
    await page.keyboard.press("Enter");
    await expect(page.locator(".message")).toHaveCount(index + 1);
    await expect(canvas).toBeFocused();
  }
  await expect(mode).toHaveText("VISUAL");
  expect(await history.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(200);
  const selectedPosition = await position();
  for (const focus of [canvas, page.locator(".message").first()]) {
    await focus.focus();
    await history.evaluate((element) => { element.scrollTop = 60; });
    await page.keyboard.press("j");
    expect(await scroll()).toBe(90);
    await page.keyboard.press("k");
    expect(await scroll()).toBe(60);
    expect(await position()).toEqual(selectedPosition);
    await expect(page.locator("#selection")).toHaveText("Alpha");
  }
  await page.keyboard.press("m");
  await expect(page.locator(".current-comment")).toBeFocused();
  const inputPosition = await position();
  await history.evaluate((element) => { element.scrollTop = 60; });
  await page.keyboard.press("j");
  expect(await scroll()).toBe(90);
  await page.keyboard.press("k");
  expect(await scroll()).toBe(60);
  expect(await position()).toEqual(inputPosition);
  await page.keyboard.press("c");
  await page.locator("#content").fill("");
  await history.evaluate((element) => { element.scrollTop = 60; });
  await page.keyboard.type("hjkl");
  await expect(page.locator("#content")).toHaveValue("hjkl");
  expect(await scroll()).toBe(60);
  expect(await position()).toEqual(inputPosition);
  await page.keyboard.press("Escape");
  await expect(mode).toHaveText("VISUAL");
  await expect(page.locator("#discussion")).toBeVisible();
  await page.keyboard.press(":");
  await page.keyboard.type("hjkl");
  await expect(mode).toHaveText("COMMAND");
  await expect(page.locator("#command")).toHaveValue("hjkl");
  expect(await position()).toEqual(inputPosition);
  await page.keyboard.press("Escape");
  await expect(mode).toHaveText("VISUAL");
  for (const tag of ["input", "div"]) {
    await canvas.evaluate((element, tag) => {
      const control = document.createElement(tag);
      control.id = "editable-test";
      if (tag === "div") control.contentEditable = "true";
      element.append(control);
    }, tag);
    const control = page.locator("#editable-test");
    await control.focus();
    await page.keyboard.type("hjkl");
    expect(await control.evaluate((element) => element.value ?? element.textContent)).toBe("hjkl");
    expect(await position()).toEqual(inputPosition);
    expect(await scroll()).toBe(60);
    await page.keyboard.press("Escape");
    await expect(mode).toHaveText("VISUAL");
    await expect(page.locator("#discussion")).toBeVisible();
    await control.evaluate((element) => element.remove());
  }
  await page.keyboard.press("/");
  await page.locator("#search").fill("Alpha");
  await expect(mode).toHaveText("SEARCH");
  await page.keyboard.press("Escape");
  await expect(mode).toHaveText("VISUAL");
  await expect(page.locator("#selection")).toHaveText("Alpha");
  await expect(page.locator("#discussion")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(mode).toHaveText("NORMAL");
  await expect(page.locator("#discussion")).toBeHidden();
  await expect(page.locator("#viewport .selected")).toHaveCount(0);
  await expect(page.locator(".selection-path-glow")).toHaveCount(0);
  await expect(page.locator(".current-comment,.current-thread")).toHaveCount(0);
  await expect(page.locator("#comment-status")).toHaveText("6 comments");
  const deselectedPosition = await position();
  await page.keyboard.press("j");
  expect(await position()).toEqual([deselectedPosition[0], deselectedPosition[1] - 30]);
  await page.locator('[data-anchor="flowchart:A"]').first().focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#discussion")).toBeHidden();
  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  await expect(page.locator(".message")).toHaveCount(6);
  await canvas.focus();
  await expect(mode).toHaveText("VISUAL");
  await page.locator("#dismiss").click();
  await canvas.focus();
  await page.keyboard.press("j");
  await expect(page.locator("#selection")).not.toHaveText("Alpha");
  await expect(page.locator("#discussion")).toBeHidden();
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await expect(page.locator("#selection")).toHaveText("Whole diagram");
  await expect(page.locator("#content")).toBeFocused();
});

test("diagram comment leader posts and appends without a thread checkbox", async ({ page }) => {
  await page.goto(url);
  await expect(page.locator("#type")).toHaveText("flowchart-v2");
  await expect(page.locator("#show-all")).toHaveCount(0);
  await page.keyboard.press(";");
  await expect(page.locator("#command-status")).toHaveText(";");
  await page.keyboard.press("c");
  await expect(page.locator("#selection")).toHaveText("Whole diagram");
  await expect(page.locator("#content")).toBeFocused();
  await page.keyboard.type("Whole diagram keyboard context");
  await page.keyboard.press("Enter");
  await expect(page.locator("#threads")).toContainText("Whole diagram keyboard context");
  await page.keyboard.press(";");
  await page.keyboard.press("c");
  await expect(page.locator("#content")).toBeFocused();
  await page.keyboard.type("Whole diagram follow-up");
  await page.keyboard.press("Enter");
  await expect(page.locator("#threads")).toContainText("Whole diagram follow-up");
  await expect(page.locator(".thread")).toHaveCount(1);
});

test("class labels, path-only glow, native zoom and bounded chat layout", async ({ page }) => {
  writeFileSync(source, "classDiagram\nclass First {\n+name: String\n+run()\n}\nFirst --> Second\n");
  await page.goto(url);
  const first = page.getByRole("button", { name: "Comment on First", exact: true });
  await expect(first).toBeVisible();
  await first.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#selection")).toHaveText("First");
  await expect(page.locator("#discussion")).toBeHidden();
  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  expect(await page.locator("#discussion").evaluate((panel) => panel.getBoundingClientRect().height)).toBeLessThan(330);
  await expect(page.locator(".selection-path-glow.visible")).toHaveCount(1);
  expect(await page.locator(".selection-path-glow text,.selection-path-glow foreignObject,.selection-path-glow [data-anchor]").count()).toBe(0);
  const bounds = await first.evaluate((element) => {
    const box = element.getBBox();
    const glow = document.querySelector(".selection-path-glow.visible");
    const filter = document.getElementById(glow.dataset.glowFilter);
    return {
      x: Number(filter.getAttribute("x")), y: Number(filter.getAttribute("y")),
      width: Number(filter.getAttribute("width")), height: Number(filter.getAttribute("height")),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  });
  expect(bounds.x).toBeCloseTo(bounds.box.x - 24);
  expect(bounds.y).toBeCloseTo(bounds.box.y - 24);
  expect(bounds.width).toBeCloseTo(bounds.box.width + 48);
  expect(bounds.height).toBeCloseTo(bounds.box.height + 48);
  await page.locator("#reset").click();
  const original = Number(await page.locator("#viewport > svg").getAttribute("width"));
  await page.locator("#zoom-in").click();
  expect(Number(await page.locator("#viewport > svg").getAttribute("width"))).toBeCloseTo(original * 1.25);
  await expect(page.locator("#viewport")).toHaveCSS("transform", "none");
  await page.locator("#canvas").focus();
  for (let index = 0; index < 5; index++) await page.keyboard.press("l");
  await expect(page.locator(".selection-path-glow")).toHaveCount(1);
  await expect(page.locator("filter[id*='selection-blur']")).toHaveCount(1);
  await expect(page.locator("#canvas")).toHaveCSS("outline-style", "none");
  await page.keyboard.press("c");
  for (let index = 0; index < 10; index++) {
    await page.locator("#content").fill(`Chat message ${index}: ` + "context ".repeat(30));
    await page.locator("#new-comment button").click();
  }
  expect(await page.locator("#threads").evaluate((history) => history.scrollHeight > history.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && scrollY === 0)).toBe(true);
});

test("keyboard and button zoom preserve the canvas center after panning", async ({ page }) => {
  await page.goto(url);
  await waitForRender(page);
  await page.locator("#reset").click();
  await page.locator("#canvas").focus();
  await page.keyboard.press("h");
  await page.keyboard.press("j");
  const geometry = () => page.evaluate(() => {
    const canvas = document.querySelector("#canvas").getBoundingClientRect();
    const svg = document.querySelector("#viewport > svg").getBoundingClientRect();
    return {
      left: svg.left, top: svg.top, width: svg.width, height: svg.height,
      cx: canvas.left + canvas.width / 2, cy: canvas.top + canvas.height / 2,
    };
  });
  for (const action of ["=", "-", "+", "button-in", "button-out"]) {
    const before = await geometry();
    if (action.startsWith("button")) {
      await page.locator(action === "button-in" ? "#zoom-in" : "#zoom-out").click();
    } else {
      await page.locator("#canvas").focus();
      await page.keyboard.press(action);
    }
    const after = await geometry();
    const ratio = action === "-" || action === "button-out" ? 1 / 1.25 : 1.25;
    expect(after.width).toBeCloseTo(before.width * ratio, 1);
    expect(after.left + (before.cx - before.left) * ratio).toBeCloseTo(before.cx, 1);
    expect(after.top + (before.cy - before.top) * ratio).toBeCloseTo(before.cy, 1);
  }
  const before = await geometry();
  const canvas = await page.locator("#canvas").boundingBox();
  const pointer = { x: canvas.x + 80, y: canvas.y + 80 };
  await page.mouse.move(pointer.x, pointer.y);
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await geometry()).width).toBeGreaterThan(before.width);
  const after = await geometry();
  const ratio = after.width / before.width;
  expect(after.left + (pointer.x - before.left) * ratio).toBeCloseTo(pointer.x, 1);
  expect(after.top + (pointer.y - before.top) * ratio).toBeCloseTo(pointer.y, 1);
});

test("shortcut help is modal, preserves selection, and does not intercept typing", async ({ page }) => {
  await page.goto(url);
  await waitForRender(page);
  await page.locator('[data-anchor="flowchart:A"]').first().focus();
  await page.keyboard.press("Enter");
  await page.locator("#canvas").focus();
  await page.keyboard.press("?");
  const help = page.getByRole("dialog", { name: "Keyboard help" });
  await expect(help).toBeVisible();
  await expect(help).toContainText(":wq");
  await expect(help).toContainText("j/k scrolls");
  await page.keyboard.press("j");
  await expect(page.locator("#selection")).toHaveText("Alpha");
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(page.locator("#vim-mode")).toHaveText("VISUAL");
  await expect(page.locator("#selection")).toHaveText("Alpha");
  await page.getByRole("button", { name: "Keyboard help", exact: true }).click();
  await expect(help).toBeVisible();
  await page.getByRole("button", { name: "Close keyboard help" }).click();
  await expect(help).toBeHidden();
  await page.locator("#canvas").focus();
  await page.keyboard.press("?");
  await expect(help).toBeVisible();
  await help.dispatchEvent("keydown", { key: "Escape", bubbles: true });
  await expect(help).toBeHidden();
  await expect(page.locator("#selection")).toHaveText("Alpha");
  await page.locator("#canvas").focus();
  await page.keyboard.press("c");
  await page.keyboard.type("?");
  await expect(page.locator("#content")).toHaveValue("?");
  await expect(help).toBeHidden();
  await page.keyboard.press("Escape");
  await page.keyboard.press("/");
  await page.keyboard.type("?");
  await expect(page.locator("#search")).toHaveValue("?");
  await expect(help).toBeHidden();
  await page.keyboard.press("Escape");
  await page.keyboard.press(":");
  await page.keyboard.type("?");
  await expect(page.locator("#command")).toHaveValue("?");
  await expect(help).toBeHidden();
});

test("vim command line cancels, rejects unknown commands, and closes review", async ({ page }) => {
  await page.goto(url);
  await expect(page.locator("#type")).toHaveText("flowchart-v2");
  await page.keyboard.press(":");
  await page.keyboard.type("q");
  await expect(page.locator("#vim-mode")).toHaveText("COMMAND");
  await expect(page.locator("#command")).toHaveValue("q");
  await page.keyboard.press("Escape");
  await expect(page.locator("#command-bar")).toBeHidden();
  await expect(page.locator("#close")).toBeEnabled();
  await page.keyboard.press(":");
  await page.keyboard.type("invalid");
  await page.keyboard.press("Enter");
  await expect(page.locator("#command-status")).toContainText("E492");
  const closings = [];
  await page.route("**/api/close", async (route) => {
    closings.push(true);
    await route.continue();
  });
  for (const command of ["q", "wq", "x"]) {
    await page.keyboard.press(":");
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await expect(page.locator("#command-status")).toHaveText("Review closed");
    await expect(page.locator("#vim-mode")).toHaveText("CLOSED");
    await expect(page.locator("#vim-mode")).toHaveCSS("background-color", "rgb(248, 81, 73)");
    await expect(page.locator("#command-status")).toHaveCSS("color", "rgb(248, 81, 73)");
  }
  expect(closings).toHaveLength(3);
});
