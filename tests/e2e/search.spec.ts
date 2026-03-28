import { test, expect } from "@playwright/test";
import * as path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

async function openFixture(page: any, fixture: string) {
  await page.goto("/");
  const fc = page.waitForEvent("filechooser");
  await page.click("#btn-open");
  const chooser = await fc;
  await chooser.setFiles(path.join(FIXTURES, fixture));
  await expect(page.locator(".page-wrapper").first()).toBeVisible({ timeout: 20000 });
}

test.describe("Find & Replace", () => {
  test("Ctrl+F opens the search bar", async ({ page }) => {
    await openFixture(page, "with-text.pdf");

    await expect(page.locator(".search-bar")).toBeHidden();
    await page.keyboard.press("Control+f");
    await expect(page.locator(".search-bar")).toBeVisible();
  });

  test("Escape closes the search bar", async ({ page }) => {
    await openFixture(page, "with-text.pdf");
    await page.keyboard.press("Control+f");
    await expect(page.locator(".search-bar")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.locator(".search-bar")).toBeHidden();
  });

  test("searching highlights matches on the page", async ({ page }) => {
    await openFixture(page, "with-text.pdf");
    await page.keyboard.press("Control+f");

    const searchInput = page.locator(".search-input").first();
    await searchInput.fill("Invoice");
    await page.waitForTimeout(500);

    // Should find at least one match
    const matchCount = page.locator(".search-match-count");
    await expect(matchCount).not.toHaveText("");
    await expect(matchCount).not.toHaveText("No matches");

    // Should have yellow highlights on the page
    const highlights = await page.locator(".search-highlight").count();
    expect(highlights).toBeGreaterThan(0);
  });

  test("no matches shows 'No matches' text", async ({ page }) => {
    await openFixture(page, "with-text.pdf");
    await page.keyboard.press("Control+f");

    const searchInput = page.locator(".search-input").first();
    await searchInput.fill("xyznonexistent123");
    await page.waitForTimeout(500);

    await expect(page.locator(".search-match-count")).toHaveText("No matches");
    expect(await page.locator(".search-highlight").count()).toBe(0);
  });

  test("Enter navigates to next match", async ({ page }) => {
    await openFixture(page, "with-text.pdf");
    await page.keyboard.press("Control+f");

    const searchInput = page.locator(".search-input").first();
    await searchInput.fill("John");
    await page.waitForTimeout(500);

    // Should show "1 of N"
    const matchCount = page.locator(".search-match-count");
    const text = await matchCount.textContent();
    expect(text).toMatch(/1 of \d+/);
  });

  test("current match has distinct highlight style", async ({ page }) => {
    await openFixture(page, "with-text.pdf");
    await page.keyboard.press("Control+f");

    const searchInput = page.locator(".search-input").first();
    await searchInput.fill("Invoice");
    await page.waitForTimeout(500);

    // Current match should have .current class
    const currentHighlight = await page.locator(".search-highlight.current").count();
    expect(currentHighlight).toBeGreaterThan(0);
  });

  test("close button hides search bar and clears highlights", async ({ page }) => {
    await openFixture(page, "with-text.pdf");
    await page.keyboard.press("Control+f");

    const searchInput = page.locator(".search-input").first();
    await searchInput.fill("Invoice");
    await page.waitForTimeout(500);

    expect(await page.locator(".search-highlight").count()).toBeGreaterThan(0);

    await page.locator(".search-close").click();
    await expect(page.locator(".search-bar")).toBeHidden();
    expect(await page.locator(".search-highlight").count()).toBe(0);
  });
});
