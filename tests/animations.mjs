import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

const baseUrl = process.env.LUNCH_CARDS_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", error => errors.push(error.message));
page.on("console", message => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Play Solo" }).click();
  await page.locator(".table").waitFor();

  const passCards = page.locator('.hand-zone [data-action="select-pass"]:not([disabled])');
  await passCards.nth(0).click();
  await passCards.nth(1).click();
  await passCards.nth(2).click();
  await page.getByRole("button", { name: "Pass 3" }).click();
  await page.locator(".card.is-passing-out").first().waitFor();
  assert.equal(await page.locator(".card.is-passing-out").count(), 3);
  assert.match(await page.locator(".card.is-passing-out").first().evaluate(element => getComputedStyle(element).animationName), /pass-card-out/);

  await page.getByRole("heading", { name: "Cards Received" }).waitFor();
  assert.equal(await page.locator(".received-hand .card.is-arriving").count(), 3);
  assert.match(await page.locator(".received-hand .card").first().evaluate(element => getComputedStyle(element).animationName), /receive-card-in/);
  await page.getByRole("button", { name: "Place In Hand" }).click();
  await page.locator(".received-hand .card.is-accepting").first().waitFor();
  assert.match(await page.locator(".received-hand .card").first().evaluate(element => getComputedStyle(element).animationName), /accept-received-card/);

  for (let step = 0; step < 30; step += 1) {
    if (await page.locator(".trick-zone.is-collecting").count()) break;
    const playable = page.locator(".hand-zone .card:not([disabled])").first();
    if (await playable.count()) await playable.click();
    else await page.waitForTimeout(100);
  }

  const collecting = page.locator(".trick-zone.is-collecting");
  await collecting.waitFor({ timeout: 10000 });
  assert.equal(await collecting.locator(".played-card").count(), 4, "the final card must remain visible during collection");
  assert.equal(await collecting.locator(".played-card.is-winner").count(), 1);
  assert.match(await collecting.locator(".played-card").first().evaluate(element => getComputedStyle(element).animationName), /collect-trick/);

  const winnerName = (await collecting.locator(".played-card.is-winner small").textContent()).trim();
  const winnerSeatClass = await page.locator(".seat", { hasText: winnerName }).first().getAttribute("class");
  const winnerPosition = winnerSeatClass.match(/pos-(?:bottom|top|left|right)(?:-(?:left|right))?/)[0];
  assert((await collecting.getAttribute("class")).includes(`collect-${winnerPosition}`), "collection must travel toward the winner's locally rotated seat");
  await page.screenshot({ path: "/tmp/lunchcards-trick-collection-mobile.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", winnerName, winnerPosition }));
} finally {
  await context.close();
  await browser.close();
}
