// Integration tests for embedded image operations: detect, move/resize, delete, export
import { test, expect, describe } from "vitest";
import * as mupdf from "mupdf";
import * as fs from "node:fs";
import * as path from "node:path";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");

function loadFixture(name: string): mupdf.PDFDocument {
  const bytes = fs.readFileSync(path.join(FIXTURES, name));
  return new mupdf.PDFDocument(bytes);
}

/** Run Device.fillImage to enumerate images on a page */
function traceImages(page: mupdf.PDFPage): Array<{ ctm: mupdf.Matrix }> {
  const results: Array<{ ctm: mupdf.Matrix }> = [];
  const device = new mupdf.Device({
    fillImage(_image: mupdf.Image, ctm: mupdf.Matrix) {
      results.push({ ctm: [...ctm] as mupdf.Matrix });
    },
  } as any);
  page.runPageContents(device, mupdf.Matrix.identity);
  try { (device as any).close(); } catch {}
  return results;
}

/** Read content streams from a page */
function readStreams(page: mupdf.PDFPage): string[] {
  const contentsRef = page.getObject().get("Contents");
  const streams: string[] = [];
  if (contentsRef.isArray()) {
    for (let i = 0; i < contentsRef.length; i++) {
      const ref = contentsRef.get(i);
      streams.push(ref.isStream() ? ref.readStream().asString() : "");
    }
  } else if (contentsRef.isStream()) {
    streams.push(contentsRef.readStream().asString());
  }
  return streams;
}

/** Write content streams back to a page */
function writeStreams(page: mupdf.PDFPage, streams: string[]): void {
  const contentsRef = page.getObject().get("Contents");
  if (contentsRef.isArray()) {
    for (let i = 0; i < Math.min(contentsRef.length, streams.length); i++) {
      const ref = contentsRef.get(i);
      if (ref.isStream()) ref.writeStream(streams[i]);
    }
  } else if (contentsRef.isStream() && streams.length > 0) {
    contentsRef.writeStream(streams[0]);
  }
}

describe("Image Detection", () => {
  test("Device.fillImage detects embedded image in with-image.pdf", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const images = traceImages(page);

    expect(images.length).toBe(1);
    // Original cm: 200 0 0 150 100 300
    // MuPDF applies page Y-flip, so Device CTM differs from raw cm values
    expect(Math.abs(images[0].ctm[0])).toBeCloseTo(200, 0); // width
    expect(Math.abs(images[0].ctm[3])).toBeCloseTo(150, 0); // height
    expect(images[0].ctm[4]).toBeCloseTo(100, 0); // x is unchanged
  });

  test("XObject resource is classified as Image subtype", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const resources = page.getObject().get("Resources");
    const xobjects = resources.get("XObject");
    const im0 = xobjects.get("Im0");
    expect(im0.get("Subtype").asName()).toBe("Image");
  });

  test("blank.pdf has no embedded images", () => {
    const doc = loadFixture("blank.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const images = traceImages(page);
    expect(images.length).toBe(0);
  });
});

describe("Image Move/Resize via Content Stream", () => {
  test("modifying cm values changes image position on re-trace", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    // Get original traced position
    let images = traceImages(page);
    const origX = images[0].ctm[4];
    const origY = images[0].ctm[5];

    // Modify the cm — shift x by +150, y by +100 in content stream space
    const streams = readStreams(page);
    expect(streams[0]).toContain("200 0 0 150 100 300 cm");
    streams[0] = streams[0].replace("200 0 0 150 100 300 cm", "200 0 0 150 250 400 cm");
    writeStreams(page, streams);

    // Re-trace — x should shift by 150 in trace space too
    images = traceImages(page);
    expect(images[0].ctm[4]).toBeCloseTo(origX + 150, 0);
    // Dimensions preserved
    expect(Math.abs(images[0].ctm[0])).toBeCloseTo(200, 0);
    expect(Math.abs(images[0].ctm[3])).toBeCloseTo(150, 0);
  });

  test("modifying cm values changes image size on re-trace", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    const streams = readStreams(page);
    streams[0] = streams[0].replace("200 0 0 150 100 300 cm", "400 0 0 300 100 300 cm");
    writeStreams(page, streams);

    const images = traceImages(page);
    expect(images[0].ctm[0]).toBeCloseTo(400, 0); // doubled width
    expect(images[0].ctm[3]).toBeCloseTo(300, 0); // doubled height
  });

  test("graphics state operators are preserved when cm is replaced", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    // Add graphics state operators to the content stream
    const streams = readStreams(page);
    streams[0] = streams[0].replace(
      "200 0 0 150 100 300 cm\n/Im0 Do",
      "200 0 0 150 100 300 cm\n0.5 g\n/Im0 Do"
    );
    writeStreams(page, streams);

    // Now replace the cm
    const streams2 = readStreams(page);
    streams2[0] = streams2[0].replace("200 0 0 150 100 300 cm", "300 0 0 200 150 350 cm");
    writeStreams(page, streams2);

    // Verify the graphics state operator is still there
    const streams3 = readStreams(page);
    expect(streams3[0]).toContain("0.5 g");
    expect(streams3[0]).toContain("300 0 0 200 150 350 cm");
  });

  test("move persists through save/reload cycle", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    // Get original position, then move
    const origImages = traceImages(page);
    const origX = origImages[0].ctm[4];

    const streams = readStreams(page);
    streams[0] = streams[0].replace("200 0 0 150 100 300 cm", "200 0 0 150 300 300 cm");
    writeStreams(page, streams);

    // Save and reload
    const savedBuf = doc.saveToBuffer("compress");
    const doc2 = new mupdf.PDFDocument(savedBuf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;

    const images = traceImages(page2);
    expect(images.length).toBe(1);
    // X should have shifted by 200 (from 100 to 300 in content stream)
    expect(images[0].ctm[4]).toBeCloseTo(origX + 200, 0);
  });
});

describe("Image Delete via Content Stream", () => {
  test("removing q...Q block eliminates image from trace", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    // Verify image exists
    expect(traceImages(page).length).toBe(1);

    // Remove the entire q...Q block
    const streams = readStreams(page);
    streams[0] = streams[0].replace(/q\n.*?cm\n\/Im0 Do\nQ/s, "");
    writeStreams(page, streams);

    // Image should be gone
    expect(traceImages(page).length).toBe(0);
  });

  test("delete persists through save/reload", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    const streams = readStreams(page);
    streams[0] = streams[0].replace(/q\n.*?cm\n\/Im0 Do\nQ/s, "");
    writeStreams(page, streams);

    const savedBuf = doc.saveToBuffer("compress");
    const doc2 = new mupdf.PDFDocument(savedBuf.asUint8Array());
    const page2 = doc2.loadPage(0) as mupdf.PDFPage;
    expect(traceImages(page2).length).toBe(0);
  });
});

describe("Image Export via Device", () => {
  test("Device.fillImage captures image object for export", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    let capturedImage: any = null;
    const device = new mupdf.Device({
      fillImage(image: mupdf.Image) {
        capturedImage = image;
      },
    } as any);
    page.runPageContents(device, mupdf.Matrix.identity);
    try { (device as any).close(); } catch {}

    expect(capturedImage).not.toBeNull();
    expect(capturedImage.getWidth()).toBe(4);
    expect(capturedImage.getHeight()).toBe(4);
  });
});

describe("Edge Cases", () => {
  test("negative d value (Y-flip) is preserved during move", () => {
    const doc = loadFixture("with-image.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;

    // Rewrite with negative d (Y-flip, common in real PDFs)
    const streams = readStreams(page);
    streams[0] = streams[0].replace("200 0 0 150 100 300 cm", "200 0 0 -150 100 450 cm");
    writeStreams(page, streams);

    // Trace to confirm the flip
    let images = traceImages(page);
    const origD = images[0].ctm[3];
    expect(origD).toBeLessThan(0); // negative = Y-flip
    const origX = images[0].ctm[4];

    // Move x by +50 in content stream space, keep y the same
    const streams2 = readStreams(page);
    streams2[0] = streams2[0].replace("200 0 0 -150 100 450 cm", "200 0 0 -150 150 450 cm");
    writeStreams(page, streams2);

    images = traceImages(page);
    expect(images[0].ctm[3]).toBeCloseTo(origD, 0); // flip preserved
    expect(images[0].ctm[4]).toBeCloseTo(origX + 50, 0); // x shifted
  });

  test("content stream with no image Do ops returns empty trace", () => {
    const doc = loadFixture("with-text.pdf");
    const page = doc.loadPage(0) as mupdf.PDFPage;
    const images = traceImages(page);
    expect(images.length).toBe(0);
  });
});
