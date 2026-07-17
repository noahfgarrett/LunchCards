import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const baseUrl = process.env.LUNCH_CARDS_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });

async function play(gameName, difficulty) {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    let seed = 424242;
    Math.random = () => ((seed = seed * 1664525 + 1013904223 >>> 0) / 4294967296);
    const nativeTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, Math.min(Number(delay) || 0, 25), ...args);
  });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if (gameName !== "Hearts") await page.getByRole("button", { name: new RegExp(`^${gameName}`) }).click();
  await page.getByLabel(new RegExp(`${gameName} CPU Difficulty`, "i")).selectOption(difficulty);
  await page.getByRole("button", { name: "Play Solo" }).click();

  for (let step = 0; step < 500; step += 1) {
    if (await page.getByRole("button", { name: "Next Round" }).count()) break;
    const received = page.getByRole("button", { name: "Place In Hand" });
    const bid = page.getByRole("button", { name: "Lock Bid" });
    const trump = page.locator('[data-action="trump-order"]').first();
    const pass = page.getByRole("button", { name: "Pass 3" });
    const card = page.locator(".hand-zone .card:not([disabled])").first();
    if (await received.count()) await received.click();
    else if (await bid.count()) await bid.click();
    else if (await trump.count()) await trump.click();
    else if (await pass.count()) {
      const cards = page.locator('.hand-zone [data-action="select-pass"]:not([disabled])');
      await cards.nth(0).click();
      await cards.nth(1).click();
      await cards.nth(2).click();
      await pass.click();
    } else if (await card.count()) await card.click();
    else await page.waitForTimeout(20);
  }
  await page.getByRole("button", { name: "Next Round" }).waitFor({ timeout: 15000 });
  const result = {
    log: await page.locator(".log").innerText(),
    scores: await page.locator(".score-list").innerText()
  };
  await context.close();
  return result;
}

try {
  const results = {};
  for (const game of ["Hearts", "Spades", "Euchre"]) {
    const easy = await play(game, "easy");
    const expert = await play(game, "expert");
    assert.notDeepEqual(expert, easy, `${game} Easy and Expert must make meaningfully different decisions`);
    results[game] = { different: true };
  }
  console.log(JSON.stringify(results));
} finally {
  await browser.close();
}
