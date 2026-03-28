import { test, expect } from "@playwright/test";
import * as path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

test.describe("Annotation Display & Selection", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.click("#btn-open");
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(FIXTURES, "with-annotations.pdf"));

    // Wait for page to render and annotations to load
    await expect(page.locator(".page-wrapper")).toHaveCount(1, { timeout: 20000 });
    // Wait for annotation overlays to appear
    await expect(page.locator(".annot-overlay").first()).toBeVisible({ timeout: 10000 });
  });

  test("displays annotation overlays for all annotations in fixture", async ({ page }) => {
    // with-annotations.pdf has 4 annotations: FreeText, Square, Text, Highlight
    const overlays = page.locator(".annot-overlay");
    await expect(overlays).toHaveCount(4);
  });

  test("renders different overlay types correctly", async ({ page }) => {
    // Check that we have the expected annotation types
    await expect(page.locator(".annot-type-freetext")).toHaveCount(1);
    await expect(page.locator(".annot-type-square")).toHaveCount(1);
    await expect(page.locator(".annot-type-text")).toHaveCount(1);
    await expect(page.locator(".annot-type-highlight")).toHaveCount(1);
  });

  test("sticky note renders as icon overlay", async ({ page }) => {
    const icon = page.locator(".annot-icon");
    await expect(icon).toHaveCount(1);

    // Should have fixed 24x24 size
    const box = await icon.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBe(24);
    expect(box!.height).toBe(24);
  });

  test("highlight renders as quadpoint overlay", async ({ page }) => {
    const hl = page.locator(".annot-quadpoint");
    await expect(hl).toHaveCount(1);
    await expect(hl).toHaveClass(/annot-type-highlight/);
  });

  test("clicking an annotation selects it", async ({ page }) => {
    // Click the FreeText annotation
    const freetext = page.locator(".annot-type-freetext");
    await freetext.click();

    await expect(freetext).toHaveClass(/selected/);
  });

  test("clicking an annotation shows resize handles for geometric types", async ({ page }) => {
    // Click the Square annotation (geometric, should get handles)
    const square = page.locator(".annot-type-square");
    await square.click();

    await expect(square).toHaveClass(/selected/);
    // Should have 8 resize handles
    const handles = square.locator(".resize-handle");
    await expect(handles).toHaveCount(8);
  });

  test("sticky note does not show resize handles when selected", async ({ page }) => {
    const icon = page.locator(".annot-icon");
    await icon.click();

    await expect(icon).toHaveClass(/selected/);
    const handles = icon.locator(".resize-handle");
    await expect(handles).toHaveCount(0);
  });

  test("clicking empty space deselects annotation", async ({ page }) => {
    // Select an annotation first
    const square = page.locator(".annot-type-square");
    await square.click();
    await expect(square).toHaveClass(/selected/);

    // Click empty area on the overlay container
    const container = page.locator(".annotation-overlay-container");
    await container.click({ position: { x: 5, y: 5 } });

    await expect(square).not.toHaveClass(/selected/);
  });

  test("selecting annotation opens properties panel", async ({ page }) => {
    // Panel should be closed initially
    const panel = page.locator("#properties-panel");
    await expect(panel).not.toHaveClass(/open/);

    // Click the sticky note
    const icon = page.locator(".annot-icon");
    await icon.click();

    // Panel should now be open
    await expect(panel).toHaveClass(/open/);
  });

  test("properties panel shows correct annotation type", async ({ page }) => {
    const freetext = page.locator(".annot-type-freetext");
    await freetext.click();

    const typeEl = page.locator(".props-type");
    await expect(typeEl).toHaveText("FreeText");
  });

  test("properties panel shows comment text for sticky note", async ({ page }) => {
    const icon = page.locator(".annot-icon");
    await icon.click();

    const textarea = page.locator('.props-textarea[data-prop="contents"]');
    await expect(textarea).toHaveValue("Test sticky note comment");
  });

  test("properties panel shows comment text for highlight", async ({ page }) => {
    const hl = page.locator(".annot-quadpoint");
    await hl.click();

    const textarea = page.locator('.props-textarea[data-prop="contents"]');
    await expect(textarea).toHaveValue("Highlighted text comment");
  });

  test("deselecting annotation closes properties panel", async ({ page }) => {
    // Select
    const icon = page.locator(".annot-icon");
    await icon.click();
    await expect(page.locator("#properties-panel")).toHaveClass(/open/);

    // Deselect
    const container = page.locator(".annotation-overlay-container");
    await container.click({ position: { x: 5, y: 5 } });

    await expect(page.locator("#properties-panel")).not.toHaveClass(/open/);
  });
});

test.describe("Annotation Display with Comments", () => {
  test("with-comments.pdf shows author in properties panel", async ({ page }) => {
    await page.goto("/");
    const fileChooserPromise = page.waitForEvent("filechooser");
    await page.click("#btn-open");
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(path.join(FIXTURES, "with-comments.pdf"));

    await expect(page.locator(".page-wrapper")).toHaveCount(1, { timeout: 20000 });
    await expect(page.locator(".annot-overlay").first()).toBeVisible({ timeout: 10000 });

    // Click an annotation that has author
    const icons = page.locator(".annot-icon");
    await icons.first().click();

    // Properties panel should show author
    const panel = page.locator("#properties-panel");
    await expect(panel).toHaveClass(/open/);
    await expect(panel.locator(".props-readonly").first()).toContainText(/(Alice|Bob)/);
  });
});
