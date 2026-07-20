import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { determinePokerWinners, solvePokerHand } from "../poker.js";

const card = (rank, suit) => ({ id: `${rank}-${suit}`, rank, suit, rankValue: ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"].indexOf(rank) + 2 });
const royal = [card("A", "spades"), card("K", "spades"), card("Q", "spades"), card("J", "spades"), card("10", "spades")];
assert.equal(solvePokerHand(royal).descr, "Royal Flush");

const board = [card("A", "clubs"), card("K", "diamonds"), card("7", "hearts"), card("4", "spades"), card("2", "clubs")];
const result = determinePokerWinners([
  { index: 0, cards: [card("A", "hearts"), card("A", "diamonds")] },
  { index: 1, cards: [card("K", "hearts"), card("K", "clubs")] }
], board);
assert.deepEqual(result.winners.map(winner => winner.index), [0]);

const baseUrl = process.env.LUNCH_CARDS_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
await context.addInitScript(() => {
  const nativeTimeout = window.setTimeout;
  window.setTimeout = (callback, delay, ...args) => nativeTimeout(callback, Math.min(Number(delay) || 0, 35), ...args);
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Texas Hold'em/ }).click();
  await page.getByLabel(/Hold'em CPU Difficulty/i).selectOption("expert");
  await page.getByRole("button", { name: "Play Solo" }).click();
  await page.locator(".poker-board").waitFor();
  assert.equal(await page.locator(".hand-zone .card").count(), 2);
  const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  assert.deepEqual(accessibility.violations.map(violation => violation.id), []);

  let humanActions = 0;
  for (let step = 0; step < 300; step += 1) {
    if (await page.getByRole("button", { name: /Next Hand|New Match/ }).count()) break;
    const check = page.getByRole("button", { name: "Check" });
    const call = page.getByRole("button", { name: /^Call/ });
    if (await check.count()) {
      await check.click();
      humanActions += 1;
    } else if (await call.count()) {
      await call.click();
      humanActions += 1;
    } else {
      await page.waitForTimeout(20);
    }
  }

  await page.getByRole("button", { name: /Next Hand|New Match/ }).waitFor({ timeout: 15000 });
  const chips = await page.locator(".score-row > strong:last-child").allTextContents();
  assert.equal(chips.reduce((sum, value) => sum + Number(value), 0), 2000, "chips must be conserved");
  assert(humanActions > 0, "the human must receive poker actions");
  assert.deepEqual(errors, []);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: "/tmp/lunchcards-holdem-mobile.png", fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: "/tmp/lunchcards-holdem-desktop.png", fullPage: true });
  console.log(JSON.stringify({ status: "passed", humanActions, chipTotal: 2000 }));
} finally {
  await context.close();
  await browser.close();
}
