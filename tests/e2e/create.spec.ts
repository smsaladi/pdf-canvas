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

test.describe("Annotation Creation", () => {
  test("toolbar shows all tool buttons", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-tool="select"]')).toBeVisible();
    await expect(page.locator('[data-tool="note"]')).toBeVisible();
    await expect(page.locator('[data-tool="freetext"]')).toBeVisible();
    await expect(page.locator('[data-tool="highlight"]')).toBeVisible();
    await expect(page.locator('[data-tool="rectangle"]')).toBeVisible();
    await expect(page.locator('[data-tool="circle"]')).toBeVisible();
    await expect(page.locator('[data-tool="line"]')).toBeVisible();
    await expect(page.locator('[data-tool="ink"]')).toBeVisible();
  });

  test("select tool is active by default", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator('[data-tool="select"]')).toHaveClass(/active/);
  });

  test("clicking a tool button activates it", async ({ page }) => {
    await page.goto("/");
    await page.locator('[data-tool="rectangle"]').click();
    await expect(page.locator('[data-tool="rectangle"]')).toHaveClass(/active/);
    await expect(page.locator('[data-tool="select"]')).not.toHaveClass(/active/);
  });

  test("save button exists and is clickable", async ({ page }) => {
    await openFixture(page, "blank.pdf");
    await expect(page.locator("#btn-save")).toBeVisible();
  });

  test("undo/redo buttons exist", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#btn-undo")).toBeVisible();
    await expect(page.locator("#btn-redo")).toBeVisible();
    // Initially disabled
    await expect(page.locator("#btn-undo")).toBeDisabled();
    await expect(page.locator("#btn-redo")).toBeDisabled();
  });

  test("create sticky note by clicking with note tool", async ({ page }) => {
    await openFixture(page, "blank.pdf");

    // Wait for overlay container to exist
    await expect(page.locator(".annotation-overlay-container")).toBeVisible({ timeout: 10000 });

    const initialCount = await page.locator(".annot-overlay").count();

    // Select the note tool
    await page.locator('[data-tool="note"]').click();

    // Click on the page to place a note
    const container = page.locator(".annotation-overlay-container");
    await container.click({ position: { x: 200, y: 200 } });

    // Wait for annotation creation
    await page.waitForTimeout(1500);

    // Should have one more overlay
    const newCount = await page.locator(".annot-overlay").count();
    expect(newCount).toBe(initialCount + 1);

    // Should be an icon-type (sticky note)
    await expect(page.locator(".annot-icon")).toHaveCount(1);

    // Tool should switch back to select
    await expect(page.locator('[data-tool="select"]')).toHaveClass(/active/);
  });

  test("create rectangle by click+drag", async ({ page }) => {
    await openFixture(page, "blank.pdf");
    await expect(page.locator(".annotation-overlay-container")).toBeVisible({ timeout: 10000 });

    const initialCount = await page.locator(".annot-overlay").count();

    // Select rectangle tool
    await page.locator('[data-tool="rectangle"]').click();

    // Click and drag on the page
    const container = page.locator(".annotation-overlay-container");
    const box = await container.boundingBox();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.down();
    await page.mouse.move(box!.x + 300, box!.y + 200, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(1500);

    const newCount = await page.locator(".annot-overlay").count();
    expect(newCount).toBe(initialCount + 1);
    await expect(page.locator(".annot-type-square")).toHaveCount(1);
  });

  test("create FreeText by click+drag", async ({ page }) => {
    await openFixture(page, "blank.pdf");
    await expect(page.locator(".annotation-overlay-container")).toBeVisible({ timeout: 10000 });

    await page.locator('[data-tool="freetext"]').click();

    const container = page.locator(".annotation-overlay-container");
    const box = await container.boundingBox();
    await page.mouse.move(box!.x + 50, box!.y + 50);
    await page.mouse.down();
    await page.mouse.move(box!.x + 250, box!.y + 100, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(1500);

    await expect(page.locator(".annot-type-freetext")).toHaveCount(1);
  });

  test("create highlight by click+drag", async ({ page }) => {
    await openFixture(page, "blank.pdf");
    await expect(page.locator(".annotation-overlay-container")).toBeVisible({ timeout: 10000 });

    await page.locator('[data-tool="highlight"]').click();

    const container = page.locator(".annotation-overlay-container");
    const box = await container.boundingBox();
    await page.mouse.move(box!.x + 50, box!.y + 300);
    await page.mouse.down();
    await page.mouse.move(box!.x + 400, box!.y + 320, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(1500);

    await expect(page.locator(".annot-type-highlight")).toHaveCount(1);
  });

  test("created annotation is auto-selected and properties panel opens", async ({ page }) => {
    await openFixture(page, "blank.pdf");
    await expect(page.locator(".annotation-overlay-container")).toBeVisible({ timeout: 10000 });

    await page.locator('[data-tool="rectangle"]').click();

    const container = page.locator(".annotation-overlay-container");
    const box = await container.boundingBox();
    await page.mouse.move(box!.x + 100, box!.y + 100);
    await page.mouse.down();
    await page.mouse.move(box!.x + 300, box!.y + 200, { steps: 5 });
    await page.mouse.up();

    await page.waitForTimeout(1500);

    // Properties panel should be open
    await expect(page.locator("#properties-panel")).toHaveClass(/open/);
    await expect(page.locator(".props-type")).toHaveText("Square");
  });

  test("undo-delete restores the annotation", async ({ page }) => {
    await openFixture(page, "with-annotations.pdf");
    await expect(page.locator(".annot-overlay").first()).toBeVisible({ timeout: 10000 });

    const countBefore = await page.locator(".annot-overlay").count();

    // Select and delete the square
    await page.locator(".annot-type-square").click();
    await page.keyboard.press("Delete");
    await page.waitForTimeout(1000);

    expect(await page.locator(".annot-overlay").count()).toBe(countBefore - 1);

    // Undo
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(1500);

    // Should be restored
    expect(await page.locator(".annot-overlay").count()).toBe(countBefore);
  });
});
