// Shared constants for the interaction layer

export const HANDLE_SIZE = 8;
export const NOTE_ICON_SIZE = 24;

export const ICON_TYPES = new Set(["Text"]);
export const QUADPOINT_TYPES = new Set(["Highlight", "Underline", "StrikeOut", "Squiggly"]);

export const TOOL_TO_ANNOT_TYPE: Record<string, string> = {
  note: "Text",
  freetext: "FreeText",
  highlight: "Highlight",
  rectangle: "Square",
  circle: "Circle",
  line: "Line",
  ink: "Ink",
};
