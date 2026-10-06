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
  await page.keyboard.press("j");
  await expect(page.locator("#selection")).toContainText("KeyboardA_KeyboardB");
  await page.keyboard.press("j");
  await expect(page.locator("#selection")).toHaveText("Shared keyboard adapter");
  await page.keyboard.press("k");
  await expect(page.locator("#selection")).toContainText("KeyboardA_KeyboardB");
  await page.keyboard.press("k");
  await expect(page.locator("#selection")).toHaveText("Shared keyboard engine");
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
  for (let index = 0; index < 10; index++) {
    await page.locator("#content").fill(`Chat message ${index}: ` + "context ".repeat(30));
    await page.locator("#new-comment button").click();
  }
  expect(await page.locator("#threads").evaluate((history) => history.scrollHeight > history.clientHeight)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight && scrollY === 0)).toBe(true);
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
    await route.fulfill({ contentType: "application/json", body: '{"closed":true}' });
  });
  for (const command of ["q", "wq", "x"]) {
    await page.keyboard.press(":");
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
    await expect(page.locator("#command-status")).toHaveText("Review closed");
  }
  expect(closings).toHaveLength(3);
});
