import { describe, it, expect } from "vitest";
import { parseFontName, matchReferenceFont } from "./font-augment";

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
