/**
 * Screenshot utility for verifying the app output.
 *
 * Usage:
 *   pnpm screenshot [url] [output] [--hover]
 *
 * Examples:
 *   pnpm screenshot                          # Capture localhost:3000 to screenshot.png
 *   pnpm screenshot http://localhost:3000    # Same as above
 *   pnpm screenshot http://localhost:3000 my-screenshot.png
 *   pnpm screenshot http://localhost:3000 hover.png --hover  # Hover over first card
 */

import { chromium } from "@playwright/test";

async function takeScreenshot() {
  const args = process.argv.slice(2);
  const hoverMode = args.includes("--hover");
  const nonFlagArgs = args.filter((a) => !a.startsWith("--"));

  const url = nonFlagArgs[0] || "http://localhost:3000";
  const output = nonFlagArgs[1] || "screenshot.png";

  console.log(`Capturing ${url} to ${output}${hoverMode ? " (with hover)" : ""}...`);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });

  try {
    await page.goto(url, { waitUntil: "networkidle" });

    // Wait a bit for any dynamic content to render
    await page.waitForTimeout(1000);

    if (hoverMode) {
      // Find the first card name cell and hover over it
      const firstCard = page.locator("table tbody tr").first().locator("td").first();
      await firstCard.hover();
      await page.waitForTimeout(500);
    }

    await page.screenshot({
      path: output,
      fullPage: false, // Just viewport when hovering
    });

    console.log(`Screenshot saved to ${output}`);
  } catch (error) {
    console.error("Failed to capture screenshot:", error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

takeScreenshot();
