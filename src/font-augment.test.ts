import { describe, it, expect } from "vitest";
import { parseFontName, matchReferenceFont, getLocalFontPath } from "./font-augment";

describe("parseFontName", () => {
  it("strips subset prefix", () => {
    const result = parseFontName("TROBIR+Arial-BoldMT");
    expect(result.family).toBe("Arial");
    expect(result.bold).toBe(true);
    expect(result.italic).toBe(false);
  });

  it("parses simple font name without prefix", () => {
    const result = parseFontName("Helvetica");
    expect(result.family).toBe("Helvetica");
    expect(result.bold).toBe(false);
    expect(result.italic).toBe(false);
  });

  it("detects bold from name", () => {
    expect(parseFontName("Arial-BoldMT").bold).toBe(true);
    expect(parseFontName("Helvetica-Bold").bold).toBe(true);
    expect(parseFontName("Calibri-Bold").bold).toBe(true);
  });

  it("detects italic from name", () => {
    expect(parseFontName("Arial-ItalicMT").italic).toBe(true);
    expect(parseFontName("Helvetica-Oblique").italic).toBe(true);
    expect(parseFontName("TimesNewRomanPS-BoldItalicMT").italic).toBe(true);
  });

  it("detects bold italic", () => {
    const result = parseFontName("ABCDEF+Arial-BoldItalicMT");
    expect(result.bold).toBe(true);
    expect(result.italic).toBe(true);
    expect(result.family).toBe("Arial");
  });

  it("handles Times New Roman concatenated name", () => {
    const result = parseFontName("TimesNewRomanPSMT");
    expect(result.family).toBe("Times New Roman");
  });

  it("handles Courier New", () => {
    const result = parseFontName("CourierNewPSMT");
    expect(result.family).toBe("Courier New");
  });

  it("handles Calibri", () => {
    const result = parseFontName("Calibri");
    expect(result.family).toBe("Calibri");
    expect(result.bold).toBe(false);
  });
});

describe("matchReferenceFont", () => {
  it("matches Arial to Arimo", () => {
    const parsed = parseFontName("ArialMT");
    const match = matchReferenceFont(parsed);
    expect(match.googleFamily).toBe("Arimo");
    expect(match.confidence).toBe("exact-metric");
  });

  it("matches Helvetica to Arimo", () => {
    const parsed = parseFontName("Helvetica-Bold");
    const match = matchReferenceFont(parsed);
    expect(match.googleFamily).toBe("Arimo");
    expect(match.bold).toBe(true);
  });

  it("matches Times New Roman to Tinos", () => {
    const parsed = parseFontName("TimesNewRomanPSMT");
    const match = matchReferenceFont(parsed);
    expect(match.googleFamily).toBe("Tinos");
    expect(match.category).toBe("serif");
  });

  it("matches Courier New to Cousine", () => {
    const parsed = parseFontName("CourierNewPSMT");
    const match = matchReferenceFont(parsed);
    expect(match.googleFamily).toBe("Cousine");
    expect(match.category).toBe("mono");
  });

  it("matches Calibri to Carlito", () => {
    const parsed = parseFontName("Calibri");
    const match = matchReferenceFont(parsed);
    expect(match.googleFamily).toBe("Carlito");
  });

  it("falls back by flags: serif", () => {
    const parsed = parseFontName("SomeUnknownSerif");
    const match = matchReferenceFont(parsed, 0x02); // Serif flag
    expect(match.googleFamily).toBe("Tinos");
    expect(match.confidence).toBe("category-fallback");
  });

  it("falls back by flags: mono", () => {
    const parsed = parseFontName("SomeMonoFont");
    const match = matchReferenceFont(parsed, 0x01); // FixedPitch flag
    expect(match.googleFamily).toBe("Cousine");
  });

  it("falls back to Arimo for unknown sans", () => {
    const parsed = parseFontName("SomeRandomFont");
    const match = matchReferenceFont(parsed);
    expect(match.googleFamily).toBe("Arimo");
    expect(match.confidence).toBe("category-fallback");
  });
});

describe("getLocalFontPath", () => {
  it("returns correct path for Arimo Regular", () => {
    const match = matchReferenceFont(parseFontName("Helvetica"));
    expect(getLocalFontPath(match)).toBe("/fonts/Arimo-Regular.ttf");
  });

  it("returns correct path for Arimo Bold", () => {
    const match = matchReferenceFont(parseFontName("Helvetica-Bold"));
    expect(getLocalFontPath(match)).toBe("/fonts/Arimo-Bold.ttf");
  });

  it("returns correct path for Arimo Italic", () => {
    const match = matchReferenceFont(parseFontName("Arial-ItalicMT"));
    expect(getLocalFontPath(match)).toBe("/fonts/Arimo-Italic.ttf");
  });

  it("returns correct path for Arimo BoldItalic", () => {
    const match = matchReferenceFont(parseFontName("ABCDEF+Arial-BoldItalicMT"));
    expect(getLocalFontPath(match)).toBe("/fonts/Arimo-BoldItalic.ttf");
  });

  it("returns correct path for Tinos Regular (serif)", () => {
    const match = matchReferenceFont(parseFontName("TimesNewRomanPSMT"));
    expect(getLocalFontPath(match)).toBe("/fonts/Tinos-Regular.ttf");
  });

  it("returns correct path for Tinos Bold", () => {
    const match = matchReferenceFont(parseFontName("TimesNewRomanPS-BoldMT"));
    expect(getLocalFontPath(match)).toBe("/fonts/Tinos-Bold.ttf");
  });

  it("returns correct path for Cousine Regular (mono)", () => {
    const match = matchReferenceFont(parseFontName("CourierNewPSMT"));
    expect(getLocalFontPath(match)).toBe("/fonts/Cousine-Regular.ttf");
  });

  it("returns correct path for Cousine Bold", () => {
    const match = matchReferenceFont(parseFontName("CourierNew-Bold"));
    expect(getLocalFontPath(match)).toBe("/fonts/Cousine-Bold.ttf");
  });

  it("falls back to Arimo for unknown font families", () => {
    const match = matchReferenceFont(parseFontName("TotallyUnknownFont"));
    expect(getLocalFontPath(match)).toBe("/fonts/Arimo-Regular.ttf");
  });

  it("falls back to Arimo Bold for unknown bold font", () => {
    const match = matchReferenceFont(parseFontName("TotallyUnknown-Bold"));
    expect(getLocalFontPath(match)).toBe("/fonts/Arimo-Bold.ttf");
  });

  it("Carlito (Calibri match) falls back to Arimo path", () => {
    // Carlito is not Arimo/Tinos/Cousine, so hits the default branch
    const match = matchReferenceFont(parseFontName("Calibri"));
    expect(getLocalFontPath(match)).toBe("/fonts/Arimo-Regular.ttf");
  });
});
