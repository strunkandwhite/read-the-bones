import { test, expect } from "@playwright/test";
import { mockApiRoutes } from "./helpers/mock-api";
import {
  getVisibleCardNames,
  expectCardVisible,
  expectCardNotVisible,
  clickColumnHeader,
} from "./helpers/card-table";
import cardsFixture from "./fixtures/cards.json" with { type: "json" };

test.beforeEach(async ({ page }) => {
  await mockApiRoutes(page);
});

test("page loads and displays card table", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toContainText("Read the Bones");
  await expect(page.locator("table")).toBeVisible();

  await expectCardVisible(page, "Lightning Bolt");
  await expectCardVisible(page, "Counterspell");
  await expectCardVisible(page, "Sol Ring");

  const names = await getVisibleCardNames(page);
  expect(names.length).toBe(8);
});

test("search filters cards by name", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  await page.fill("#search", "bolt");
  // Name search is synchronous (no debounce)
  await expectCardVisible(page, "Lightning Bolt");
  await expectCardNotVisible(page, "Counterspell");
  await expectCardNotVisible(page, "Sol Ring");

  const names = await getVisibleCardNames(page);
  expect(names.length).toBe(1);
});

test("search filters by type syntax", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  await page.fill("#search", "t:creature");
  // Scryfall operator search has a 500ms debounce
  await expect(async () => {
    await expectCardVisible(page, "Llanowar Elves");
    await expectCardNotVisible(page, "Lightning Bolt");
  }).toPass({ timeout: 2000 });

  const names = await getVisibleCardNames(page);
  expect(names.length).toBe(1);
});

test("color filter pills filter cards", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // The color filter is hidden below xl breakpoint — ensure wide viewport
  await page.setViewportSize({ width: 1400, height: 900 });

  await page.getByLabel("Filter by Red").click();
  await expectCardVisible(page, "Lightning Bolt");
  await expectCardNotVisible(page, "Counterspell");
  await expectCardNotVisible(page, "Llanowar Elves");
});

test("column sorting works", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // Default sort is by P# ascending (best pick score first)
  const namesBefore = await getVisibleCardNames(page);

  // Click P# header to toggle to descending
  await clickColumnHeader(page, "P#");
  const namesAfter = await getVisibleCardNames(page);

  // Order should be reversed
  expect(namesBefore).not.toEqual(namesAfter);
});

test("draft selection triggers card data refetch", async ({ page }) => {
  let cardsFetched = 0;

  // Override cards route to track fetches — registered after beforeEach's mockApiRoutes for LIFO priority
  await page.route("**/api/cards*", async (route) => {
    cardsFetched++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(cardsFixture),
    });
  });

  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  const fetchCountBeforeInteraction = cardsFetched;

  // Open settings modal
  await page.getByLabel("Settings").click();
  await expect(page.getByText("Collect pick data from...")).toBeVisible();

  // Uncheck a draft — the label format is "YYYY-MM-DD: Draft Name"
  await page.getByText("2026-02-01: Beta Draft").click();

  // Should trigger a new /api/cards fetch beyond the initial page load
  await expect(async () => {
    expect(cardsFetched).toBeGreaterThan(fetchCountBeforeInteraction);
  }).toPass({ timeout: 2000 });
});

test("empty state when no drafts selected", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("table")).toBeVisible();

  // Open settings and click "Select none"
  await page.getByLabel("Settings").click();
  await page.getByText("Select none").click();

  await expect(
    page.getByText("No drafts selected", { exact: true }),
  ).toBeVisible();
});
