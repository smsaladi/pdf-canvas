import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

test.describe("Open PDF", () => {
  test("shows welcome screen initially", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#welcome")).toBeVisible();
    await expect(page.locator(".welcome-content h1")).toHaveText("PDF Canvas");
  });

  test("opens a PDF via file chooser and renders pages", async ({ page }) => {
    await page.goto("/");

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.click("#btn-open");
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(FIXTURES, "multi-page.pdf"));

    await expect(page.locator("#welcome")).toBeHidden();
    await expect(page.locator(".page-wrapper")).toHaveCount(12, { timeout: 10000 });
    await expect(page.locator("#page-display")).toContainText("/ 12");
  });

  test("opens a single-page PDF and renders it", async ({ page }) => {
    await page.goto("/");

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.click("#btn-open");
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(FIXTURES, "blank.pdf"));

    await expect(page.locator(".page-wrapper")).toHaveCount(1, { timeout: 15000 });
    await expect(page.locator("#welcome")).toBeHidden();

    // Verify the canvas has correct dimensions (612 * 1.5 = 918, 792 * 1.5 = 1188)
    const canvas = page.locator(".page-canvas");
    await expect(canvas).toHaveAttribute("width", "918");
    await expect(canvas).toHaveAttribute("height", "1188");
  });

  test("drag-over shows visual indicator", async ({ page }) => {
    await page.goto("/");

    // We can at least test the dragover visual feedback
    await page.evaluate(() => {
      const event = new Event("dragover", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: {} });
      // We need to call preventDefault to allow drop
      event.preventDefault = () => {};
      document.documentElement.dispatchEvent(event);
    });

    await expect(page.locator("#viewport")).toHaveClass(/drag-over/);
  });

  test("zoom buttons change zoom level", async ({ page }) => {
    await page.goto("/");

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.click("#btn-open");
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(FIXTURES, "multi-page.pdf"));

    await expect(page.locator(".page-wrapper").first()).toBeVisible({ timeout: 10000 });

    await expect(page.locator("#zoom-display")).toHaveText("150%");

    await page.click("#btn-zoom-in");
    await expect(page.locator("#zoom-display")).toHaveText("175%");

    await page.click("#btn-zoom-out");
    await page.click("#btn-zoom-out");
    await expect(page.locator("#zoom-display")).toHaveText("125%");
  });

  test("scroll through multi-page document", async ({ page }) => {
    await page.goto("/");

    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.click("#btn-open");
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(FIXTURES, "multi-page.pdf"));

    await expect(page.locator(".page-wrapper")).toHaveCount(12, { timeout: 10000 });

    await page.locator("#viewport").evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });

    await page.waitForTimeout(200);

    const pageText = await page.locator("#page-display").textContent();
    const currentPage = parseInt(pageText!.split("/")[0].trim());
    expect(currentPage).toBeGreaterThan(1);
  });
});
