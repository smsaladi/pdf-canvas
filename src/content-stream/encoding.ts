// PDF string encoding/decoding: literal strings and hex strings

/** Decode a PDF literal string (remove parens, handle escapes) */
export function decodeLiteralString(raw: string): string {
  const inner = raw.slice(1, -1);
  let result = "";
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "\\") {
      i++;
      if (i >= inner.length) break;
      switch (inner[i]) {
        case "n": result += "\n"; break;
        case "r": result += "\r"; break;
        case "t": result += "\t"; break;
        case "b": result += "\b"; break;
        case "f": result += "\f"; break;
        case "(": result += "("; break;
        case ")": result += ")"; break;
        case "\\": result += "\\"; break;
        default:
          if (inner[i] >= "0" && inner[i] <= "7") {
            let octal = inner[i];
            if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
              octal += inner[++i];
              if (i + 1 < inner.length && inner[i + 1] >= "0" && inner[i + 1] <= "7") {
                octal += inner[++i];
              }
            }
            result += String.fromCharCode(parseInt(octal, 8));
          } else {
            result += inner[i];
          }
      }
    } else {
      result += inner[i];
    }
    i++;
  }
  return result;
}

/** Encode a string as a PDF literal string with escapes */
export function encodeLiteralString(text: string): string {
  let escaped = "";
  for (const ch of text) {
    switch (ch) {
      case "(": escaped += "\\("; break;
      case ")": escaped += "\\)"; break;
      case "\\": escaped += "\\\\"; break;
      default: escaped += ch;
    }
  }
  return `(${escaped})`;
}

/** Decode a PDF hex string: <48656C6C6F> → "Hello" */
export function decodeHexString(raw: string): string {
  const hex = raw.slice(1, -1).replace(/\s/g, "");
  let result = "";
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    result += String.fromCharCode(byte);
  }
  return result;
}

/** Encode a string as a PDF hex string */
export function encodeHexString(text: string): string {
  let hex = "";
  for (let i = 0; i < text.length; i++) {
    hex += text.charCodeAt(i).toString(16).padStart(2, "0");
  }
  return `<${hex}>`;
}
