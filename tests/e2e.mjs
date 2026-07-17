import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const baseUrl = process.env.LUNCH_CARDS_URL || "http://127.0.0.1:4173";
const browser = await chromium.launch({ headless: true });
const contexts = [];
const errors = [];

async function makePage(viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("response", response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  return page;
}

async function waitForHumanTurn(pages) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const page of pages) {
      const card = page.locator(".hand-zone .card:not([disabled])").first();
      if (await card.count()) return { page, card };
    }
    await pages[0].waitForTimeout(250);
  }
  throw new Error("No human received a playable turn");
}

async function testMultiplayerHearts() {
  const host = await makePage();
  const guestA = await makePage();
  const guestB = await makePage();
  const pages = [host, guestA, guestB];

  await host.goto(baseUrl, { waitUntil: "networkidle" });
  await host.getByLabel("Name").fill("QA Host");
  await host.getByLabel("Seats").fill("3");
  await host.getByRole("button", { name: "Create Session" }).click();
  await host.getByText("Session ready").waitFor();
  const code = (await host.locator(".hub-code strong").textContent()).trim();
  const invite = `${baseUrl}/?hub=${code}`;

  await Promise.all([
    guestA.goto(invite, { waitUntil: "networkidle" }),
    guestB.goto(invite, { waitUntil: "networkidle" })
  ]);
  await guestA.getByLabel("Your Name").fill("QA Morgan");
  await guestB.getByLabel("Your Name").fill("QA Riley");
  await Promise.all([
    guestA.getByRole("button", { name: "Join Session" }).click(),
    guestB.getByRole("button", { name: "Join Session" }).click()
  ]);
  await Promise.all(pages.map(page => page.getByText("3/3 seated").waitFor({ timeout: 10000 })));

  await guestA.getByLabel("Your Name").focus();
  await guestA.getByLabel("Your Name").press("End");
  await guestA.getByLabel("Your Name").pressSequentially(" Jr", { delay: 80 });
  await guestA.waitForTimeout(5500);
  assert.equal(await guestA.evaluate(() => document.activeElement?.id), "lobbyPlayerName");
  await guestA.getByRole("button", { name: "Save Name" }).click();
  await host.getByText("QA Morgan Jr", { exact: false }).waitFor({ timeout: 10000 });

  await Promise.all([
    guestA.getByRole("button", { name: "Ready Up" }).click(),
    guestB.getByRole("button", { name: "Ready Up" }).click()
  ]);
  const launch = host.getByRole("button", { name: "Launch Table" });
  await assert.doesNotReject(() => launch.waitFor({ state: "visible", timeout: 10000 }));
  await host.waitForFunction(() => !document.querySelector('[data-action="start-game"]')?.disabled);
  await launch.click();
  await Promise.all(pages.map(page => page.locator(".table").waitFor({ timeout: 12000 })));

  const hands = await Promise.all(pages.map(page => page.locator(".hand-zone .card").evaluateAll(cards => cards.map(card => card.dataset.card))));
  assert.equal(new Set(hands.flat()).size, hands.flat().length, "multiplayer hands must be one disjoint deal");
  await guestB.reload({ waitUntil: "networkidle" });
  await guestB.locator(".table").waitFor();
  const reloadedHand = await guestB.locator(".hand-zone .card").evaluateAll(cards => cards.map(card => card.dataset.card));
  assert.deepEqual(reloadedHand, hands[2], "reload must resume the same hand");

  for (const page of pages) {
    const cards = page.locator(".hand-zone .card");
    await cards.nth(0).click();
    await cards.nth(1).click();
    await cards.nth(2).click();
    await page.getByRole("button", { name: "Pass 3" }).click();
    await page.waitForTimeout(700);
  }
  await Promise.all(pages.map(page => page.getByRole("heading", { name: "Cards Received" }).waitFor({ timeout: 12000 })));
  await Promise.all(pages.map(page => page.getByRole("button", { name: "Place In Hand" }).click()));

  for (let play = 0; play < 3; play += 1) {
    const turn = await waitForHumanTurn(pages);
    await turn.card.click();
    await turn.page.waitForTimeout(700);
  }
  await host.locator(".played-card.is-winner").waitFor({ timeout: 10000 });
  await Promise.all(pages.map(page => page.locator(".log").getByText(/takes trick 1/).waitFor({ timeout: 10000 })));
  const logs = await Promise.all(pages.map(page => page.locator(".log").textContent()));
  assert(logs.every(log => /takes trick 1/.test(log)), "all clients must observe the same completed trick");

  await host.getByRole("button", { name: "Leave Table" }).click();
  await host.getByRole("button", { name: "Close Session" }).click();
  await host.getByRole("heading", { name: "Coworker Queue" }).waitFor();
  return code;
}

async function testSoloGames() {
  for (const game of ["Spades", "Euchre"]) {
    const page = await makePage({ width: 390, height: 844 });
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: new RegExp(`^${game}`) }).click();
    await page.getByLabel(new RegExp(`${game} CPU Difficulty`, "i")).selectOption("expert");
    await page.getByRole("button", { name: "Play Solo" }).click();
    await page.locator(".table").waitFor();
    if (game === "Spades") {
      await page.getByRole("heading", { name: "Your Bid" }).waitFor({ timeout: 10000 });
      await page.getByRole("button", { name: "Lock Bid" }).click();
    }
    await page.locator(".hand-zone").scrollIntoViewIfNeeded();
    assert((await page.locator(".hand-zone .card").count()) > 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    const accessibility = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
    assert.deepEqual(accessibility.violations.map(violation => violation.id), []);
    await page.screenshot({ path: `/tmp/lunchcards-${game.toLowerCase()}-mobile.png`, fullPage: true });
  }
}

async function testSetupAndSafeRendering() {
  const setup = await makePage();
  await setup.goto(baseUrl, { waitUntil: "networkidle" });
  const accessibility = await new AxeBuilder({ page: setup }).withTags(["wcag2a", "wcag2aa"]).analyze();
  assert.deepEqual(accessibility.violations.map(violation => violation.id), []);
  await setup.getByLabel("Seats").fill("8");
  await setup.getByLabel("Target Score").fill("75");
  await setup.getByLabel(/CPU Difficulty/i).selectOption("hard");
  assert.equal(await setup.getByLabel("Seats").inputValue(), "8");
  assert.equal(await setup.getByLabel("Target Score").inputValue(), "75");

  await setup.getByLabel("Name").fill('<img src=x onerror="window.__xss=1">');
  await setup.getByLabel("Seats").fill("3");
  await setup.getByRole("button", { name: "Create Session" }).click();
  await setup.getByText("Session ready").waitFor();
  assert.equal(await setup.locator("img").count(), 0);
  assert.equal(await setup.evaluate(() => window.__xss), undefined);
  await setup.getByRole("button", { name: "Close Session" }).click();
  await setup.getByRole("heading", { name: "Coworker Queue" }).waitFor();
}

async function testDesktopTableLayout() {
  const page = await makePage({ width: 1024, height: 768 });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByLabel("Seats").fill("8");
  await page.getByRole("button", { name: "Play Solo" }).click();
  await page.locator(".table").waitFor();
  const hand = await page.locator(".hand-zone").boundingBox();
  const seats = await page.locator(".seat").evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
  }));
  assert(seats.every(seat => seat.bottom <= hand.y || seat.top >= hand.y + hand.height), "desktop seats must not overlap the hand");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: "/tmp/lunchcards-hearts-8-desktop.png", fullPage: true });
}

async function testPwaOfflineShell() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const manifest = await page.evaluate(async () => fetch("./manifest.webmanifest").then(response => response.json()));
  assert.deepEqual(manifest.icons.map(icon => icon.sizes), ["192x192", "512x512"]);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.context().setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Lunch Cards" }).waitFor();
  await page.context().setOffline(false);
}

try {
  const code = await testMultiplayerHearts();
  await testSoloGames();
  await testSetupAndSafeRendering();
  await testDesktopTableLayout();
  await testPwaOfflineShell();
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: "passed", multiplayerCode: code, browserErrors: errors.length }));
} finally {
  await Promise.all(contexts.map(context => context.close()));
  await browser.close();
}
