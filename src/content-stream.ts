// PDF content stream tokenizer and text replacement engine
// Re-exports from sub-modules for backward compatibility

export { decodeLiteralString, encodeLiteralString, decodeHexString, encodeHexString } from "./content-stream/encoding";
export { extractTextOccurrences, getAllText } from "./content-stream/parser";
export type { TextOccurrence } from "./content-stream/parser";
export { replaceTextInStream, replaceTextWithFontSwitch } from "./content-stream/replace";
export { parseToUnicodeCMap, replaceHexTextInStream } from "./content-stream/type0";
