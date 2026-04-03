import { test, expect } from "@playwright/test";
import { createMockContext } from "../helpers/mock-api";
import {
  getVisibleCardNames,
  expectCardVisible,
  expectCardNotVisible,
  clickColumnHeader,
} from "../helpers/card-table";
import { openSettings } from "../helpers/assertions";
import cardsFixture from "../fixtures/cards-40.json" with { type: "json" };

test.describe("Browse and filter", () => {
  test.beforeEach(async ({ page }) => {
    await createMockContext(page, "browse");
  });

  test("page loads with card table showing all cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Table is virtualized so not all 40 rows are in the DOM at once.
    // Verify the table rendered and spot-check cards from different
    // parts of the sorted list.
    await expectCardVisible(page, "Sol Ring");
    await expectCardVisible(page, "Lightning Bolt");
    await expectCardVisible(page, "Counterspell");

    const names = await getVisibleCardNames(page);
    expect(names.length).toBeGreaterThan(0);
  });

  test("name search filters cards and clear restores all", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await page.fill("#search", "bolt");
    // Name search is synchronous — verify via row filter (avoids badge text issues)
    await expectCardVisible(page, "Lightning Bolt");
    await expectCardNotVisible(page, "Counterspell");
    await expectCardNotVisible(page, "Sol Ring");

    // Clear search
    await page.click('[aria-label="Clear search"]');
    // After clearing, multiple cards should be visible again
    await expectCardVisible(page, "Lightning Bolt");
    await expectCardVisible(page, "Sol Ring");
  });

  test("type search filters to creatures only", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await page.fill("#search", "t:creature");
    // Scryfall operator search has a 500ms debounce
    // Scryfall operator search has a 500ms debounce — toPass retries handle the wait
    await expect(async () => {
      await expectCardVisible(page, "Llanowar Elves");
      await expectCardVisible(page, "Snapcaster Mage");
      await expectCardVisible(page, "Birds of Paradise");
    }).toPass({ timeout: 3000 });

    // Non-creatures should be gone
    await expectCardNotVisible(page, "Lightning Bolt");
    await expectCardNotVisible(page, "Counterspell");
  });

  test("oracle text search filters cards with draw", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await page.fill("#search", 'o:"draw"');
    await expect(async () => {
      await expectCardVisible(page, "Brainstorm");
      await expectCardVisible(page, "Cryptic Command");
      await expectCardVisible(page, "Faithless Looting");
    }).toPass({ timeout: 3000 });

    await expectCardNotVisible(page, "Lightning Bolt");
    await expectCardNotVisible(page, "Sol Ring");
  });

  test("color filter pills filter by color", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Color filter may be hidden on narrow viewports
    await page.setViewportSize({ width: 1400, height: 900 });

    await page.click('button[aria-label="Filter by Red"]');

    await expect(async () => {
      await expectCardVisible(page, "Lightning Bolt");
      await expectCardVisible(page, "Goblin Guide");
      await expectCardNotVisible(page, "Counterspell");
      await expectCardNotVisible(page, "Llanowar Elves");
    }).toPass({ timeout: 3000 });

    // Add blue filter — should show red OR blue cards
    await page.click('button[aria-label="Filter by Blue"]');

    await expect(async () => {
      await expectCardVisible(page, "Lightning Bolt");
      await expectCardVisible(page, "Counterspell");
      await expectCardVisible(page, "Brainstorm");
    }).toPass({ timeout: 3000 });
  });

  test("mana value search filters cheap cards", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await page.fill("#search", "mv<=1");
    await expect(async () => {
      await expectCardVisible(page, "Sol Ring");
      await expectCardVisible(page, "Lightning Bolt");
      await expectCardVisible(page, "Mana Crypt");
    }).toPass({ timeout: 3000 });

    // High-mv cards should be gone
    await expectCardNotVisible(page, "Jace, the Mind Sculptor");
    await expectCardNotVisible(page, "Wrath of God");
  });

  test("combined query shows only blue instants", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await page.fill("#search", "t:instant c:u");
    await expect(async () => {
      // 5 blue instants fit in viewport — use row count
      const rows = page.locator("tbody tr").filter({ has: page.locator("td") });
      const count = await rows.count();
      // virtualizer may include spacer rows; filter to real data rows
      expect(count).toBeGreaterThanOrEqual(5);
      await expectCardVisible(page, "Brainstorm");
      await expectCardVisible(page, "Counterspell");
      await expectCardVisible(page, "Growth Spiral");
    }).toPass({ timeout: 3000 });

    await expectCardNotVisible(page, "Lightning Bolt");
    await expectCardNotVisible(page, "Doom Blade");
  });

  test("column sorting changes card order", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    // Get the first data row's card name before sorting.
    // data-index is set on the <tr> element itself by the virtualizer.
    const firstRowBefore = await page
      .locator("tbody tr[data-index]")
      .first()
      .locator("td")
      .first()
      .textContent();

    // Click P# header to toggle sort direction
    await clickColumnHeader(page, "P#");

    // First row should change after re-sorting
    await expect(async () => {
      const firstRowAfter = await page
        .locator("tbody tr[data-index]")
        .first()
        .locator("td")
        .first()
        .textContent();
      expect(firstRowAfter).not.toEqual(firstRowBefore);
    }).toPass({ timeout: 3000 });
  });

  test("draft selection triggers card data refetch", async ({ page }) => {
    let cardsFetched = 0;

    // Override the cards route registered by createMockContext (Playwright
    // uses LIFO order, so this handler takes precedence)
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

    const fetchCountBefore = cardsFetched;

    await openSettings(page);
    await expect(page.getByText("Collect pick data from...")).toBeVisible();

    // Uncheck a draft — target the checkbox label specifically (not the
    // <option> elements in the draft-view dropdown that also contain the name)
    await page
      .locator("label")
      .filter({ hasText: "Gamma Draft" })
      .click();

    // Should trigger a new /api/cards fetch
    await expect(async () => {
      expect(cardsFetched).toBeGreaterThan(fetchCountBefore);
    }).toPass({ timeout: 3000 });
  });

  test("empty state when no drafts selected", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("table")).toBeVisible();

    await openSettings(page);
    await page.getByText("Select none").click();

    // DraftSelector shows "No drafts selected" warning, and the table
    // also has its own empty-state message. Use exact match to avoid
    // strict-mode violation from multiple matches.
    await expect(
      page.getByText("No drafts selected", { exact: true }),
    ).toBeVisible();
  });
});
