import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const baseUrl = process.env.LUNCH_CARDS_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const results = [];

async function playRound(gameName) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const nativeTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, Math.min(Number(delay) || 0, 30), ...args);
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if (gameName !== "Hearts") await page.getByRole("button", { name: new RegExp(`^${gameName}`) }).click();
  await page.getByLabel(new RegExp(`${gameName} CPU Difficulty`, "i")).selectOption("expert");
  await page.getByRole("button", { name: "Play Solo" }).click();
  await page.locator(".table").waitFor();

  let humanPlays = 0;
  for (let step = 0; step < 500; step += 1) {
    if (await page.getByRole("button", { name: "Next Round" }).count()) break;
    const received = page.getByRole("button", { name: "Place In Hand" });
    if (await received.count()) {
      await received.click();
      continue;
    }
    const bid = page.getByRole("button", { name: "Lock Bid" });
    if (await bid.count()) {
      await bid.click();
      continue;
    }
    const trump = page.locator('[data-action="trump-order"]').first();
    if (await trump.count()) {
      await trump.click();
      continue;
    }
    const pass = page.getByRole("button", { name: "Pass 3" });
    if (await pass.count()) {
      const cards = page.locator('.hand-zone [data-action="select-pass"]:not([disabled])');
      await cards.nth(0).click();
      await cards.nth(1).click();
      await cards.nth(2).click();
      await pass.click();
      continue;
    }
    const card = page.locator(".hand-zone .card:not([disabled])").first();
    if (await card.count()) {
      await card.click();
      humanPlays += 1;
      continue;
    }
    await page.waitForTimeout(20);
  }

  await page.getByRole("button", { name: "Next Round" }).waitFor({ timeout: 15000 });
  const log = await page.locator(".log").textContent();
  assert(humanPlays > 0, `${gameName} must accept human card plays`);
  assert.equal(errors.length, 0, `${gameName} emitted browser errors: ${errors.join(" | ")}`);
  results.push({ game: gameName, humanPlays, completed: true, logLines: log.split("\n").filter(Boolean).length });
  await context.close();
}

try {
  for (const game of ["Hearts", "Spades", "Euchre"]) await playRound(game);
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
