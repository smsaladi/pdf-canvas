import { describe, it, expect } from "vitest";
import {
  decodeLiteralString,
  encodeLiteralString,
  decodeHexString,
  encodeHexString,
  extractTextOccurrences,
  replaceTextInStream,
  getAllText,
} from "./content-stream";

describe("decodeLiteralString", () => {
  it("decodes simple string", () => {
    expect(decodeLiteralString("(Hello)")).toBe("Hello");
  });

  it("decodes escaped parentheses", () => {
    expect(decodeLiteralString("(Hello \\(World\\))")).toBe("Hello (World)");
  });

  it("decodes escaped backslash", () => {
    expect(decodeLiteralString("(path\\\\to\\\\file)")).toBe("path\\to\\file");
  });

  it("decodes escape sequences", () => {
    expect(decodeLiteralString("(line1\\nline2)")).toBe("line1\nline2");
    expect(decodeLiteralString("(tab\\there)")).toBe("tab\there");
  });

  it("decodes octal escapes", () => {
    expect(decodeLiteralString("(\\110ello)")).toBe("Hello"); // \110 = H
  });

  it("handles empty string", () => {
    expect(decodeLiteralString("()")).toBe("");
  });
});

describe("encodeLiteralString", () => {
  it("encodes simple string", () => {
    expect(encodeLiteralString("Hello")).toBe("(Hello)");
  });

  it("escapes parentheses", () => {
    expect(encodeLiteralString("Hello (World)")).toBe("(Hello \\(World\\))");
  });

  it("escapes backslashes", () => {
    expect(encodeLiteralString("a\\b")).toBe("(a\\\\b)");
  });

  it("round-trips with decode", () => {
    const original = "Hello (World) \\ end";
    expect(decodeLiteralString(encodeLiteralString(original))).toBe(original);
  });
});

describe("decodeHexString", () => {
  it("decodes hex bytes", () => {
    expect(decodeHexString("<48656C6C6F>")).toBe("Hello");
  });

  it("handles whitespace in hex", () => {
    expect(decodeHexString("<48 65 6C 6C 6F>")).toBe("Hello");
  });

  it("handles empty hex string", () => {
    expect(decodeHexString("<>")).toBe("");
  });
});

describe("encodeHexString", () => {
  it("encodes to hex", () => {
    expect(encodeHexString("Hello")).toBe("<48656c6c6f>");
  });

  it("round-trips with decode", () => {
    expect(decodeHexString(encodeHexString("Test 123"))).toBe("Test 123");
  });
});

describe("extractTextOccurrences", () => {
  it("finds Tj operator with literal string", () => {
    const stream = "BT /F1 12 Tf 100 700 Td (Hello World) Tj ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0].text).toBe("Hello World");
    expect(occurrences[0].operator).toBe("Tj");
    expect(occurrences[0].isHex).toBe(false);
  });

  it("finds multiple Tj strings", () => {
    const stream = "BT (First) Tj (Second) Tj ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(2);
    expect(occurrences[0].text).toBe("First");
    expect(occurrences[1].text).toBe("Second");
  });

  it("finds TJ array strings", () => {
    const stream = "BT [(H) 20 (ello) -10 ( World)] TJ ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(3);
    expect(occurrences[0].text).toBe("H");
    expect(occurrences[1].text).toBe("ello");
    expect(occurrences[2].text).toBe(" World");
    expect(occurrences[0].operator).toBe("TJ");
  });

  it("finds ' operator", () => {
    const stream = "BT (Next line text) ' ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0].text).toBe("Next line text");
    expect(occurrences[0].operator).toBe("'");
  });

  it("handles hex strings with Tj", () => {
    const stream = "BT <48656C6C6F> Tj ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0].text).toBe("Hello");
  });

  it("skips non-text operators", () => {
    const stream = "BT /F1 12 Tf 100 700 Td ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(0);
  });

  it("handles escaped parens in strings", () => {
    const stream = "BT (Hello \\(World\\)) Tj ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0].text).toBe("Hello (World)");
  });

  it("handles comments", () => {
    const stream = "BT\n% this is a comment\n(Hello) Tj ET";
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(1);
    expect(occurrences[0].text).toBe("Hello");
  });

  it("handles complex multi-operator stream", () => {
    const stream = `BT
/F1 12 Tf
72 720 Td
(Invoice #12345) Tj
0 -20 Td
(Date: 2024-01-15) Tj
0 -20 Td
[(Total: ) -50 ($1,234.56)] TJ
ET`;
    const occurrences = extractTextOccurrences(stream);
    expect(occurrences.length).toBe(4);
    expect(occurrences[0].text).toBe("Invoice #12345");
    expect(occurrences[1].text).toBe("Date: 2024-01-15");
    expect(occurrences[2].text).toBe("Total: ");
    expect(occurrences[3].text).toBe("$1,234.56");
  });
});

describe("replaceTextInStream", () => {
  it("replaces simple text", () => {
    const stream = "BT (Hello World) Tj ET";
    const { result, count } = replaceTextInStream(stream, "Hello", "Howdy");
    expect(count).toBe(1);
    expect(result).toContain("(Howdy World)");
    expect(result).toContain("Tj");
  });

  it("replaces in TJ array", () => {
    const stream = "BT [(H) 20 (ello)] TJ ET";
    const { result, count } = replaceTextInStream(stream, "ello", "ELLO");
    expect(count).toBe(1);
    expect(result).toContain("(ELLO)");
  });

  it("replaces all occurrences when replaceAll=true", () => {
    const stream = "BT (Hello) Tj (Hello) Tj ET";
    const { result, count } = replaceTextInStream(stream, "Hello", "World", true);
    expect(count).toBe(2);
    expect(result).not.toContain("(Hello)");
  });

  it("replaces only first occurrence when replaceAll=false", () => {
    const stream = "BT (Hello) Tj (Hello) Tj ET";
    const { result, count } = replaceTextInStream(stream, "Hello", "World", false);
    expect(count).toBe(1);
    // First replaced, second still Hello
    const occurrences = extractTextOccurrences(result);
    expect(occurrences[0].text).toBe("World");
    expect(occurrences[1].text).toBe("Hello");
  });

  it("returns count=0 when text not found", () => {
    const stream = "BT (Hello) Tj ET";
    const { result, count } = replaceTextInStream(stream, "Goodbye", "Hi");
    expect(count).toBe(0);
    expect(result).toBe(stream);
  });

  it("handles special characters in replacement", () => {
    const stream = "BT (price) Tj ET";
    const { result, count } = replaceTextInStream(stream, "price", "$100 (USD)");
    expect(count).toBe(1);
    // The replacement should be properly escaped
    const occurrences = extractTextOccurrences(result);
    expect(occurrences[0].text).toBe("$100 (USD)");
  });
});

describe("getAllText", () => {
  it("concatenates all text from stream", () => {
    const stream = "BT (Hello ) Tj (World) Tj ET";
    expect(getAllText(stream)).toBe("Hello World");
  });

  it("includes TJ array text", () => {
    const stream = "BT [(Hel) 20 (lo)] TJ ET";
    expect(getAllText(stream)).toBe("Hello");
  });
});
