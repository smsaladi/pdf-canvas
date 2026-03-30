// PDF Canvas type definitions

export interface AnnotationDTO {
  id: string;
  page: number;
  type: string;
  rect: [number, number, number, number];
  color: number[];
  interiorColor?: number[];
  opacity: number;
  contents: string;
  borderWidth: number;
  borderStyle?: string;
  hasRect: boolean;
  author?: string;
  modifiedDate?: string;
  createdDate?: string;
  isOpen?: boolean;
  icon?: string;
  irtRef?: string;
  replies?: AnnotationDTO[];
  vertices?: number[][];
  line?: number[][];
  inkList?: number[][][];
  quadPoints?: number[][];
  defaultAppearance?: { font: string; size: number; color: number[] };
}

export interface WidgetDTO {
  id: string;
  page: number;
  fieldType: string;
  fieldName: string;
  value: string;
  rect: [number, number, number, number];
}

export interface PageImageDTO {
  id: string;
  page: number;
  rect: [number, number, number, number];
  width: number;   // natural image width in pixels
  height: number;   // natural image height in pixels
}

export interface PageInfo {
  index: number;
  width: number;
  height: number;
}

// Text extraction types

export interface CharInfo {
  c: string;
  origin: [number, number];
  quad: [number, number, number, number, number, number, number, number];
  fontSize: number;
  fontName: string;
  fontFlags: { isMono: boolean; isSerif: boolean; isBold: boolean; isItalic: boolean };
  color: number[];
}

export interface TextLine {
  bbox: [number, number, number, number];
  wmode: number;
  chars: CharInfo[];
}

export interface TextBlock {
  bbox: [number, number, number, number];
  lines: TextLine[];
}

export interface PageTextData {
  page: number;
  blocks: TextBlock[];
}

export interface TextSearchResult {
  page: number;
  quads: number[][];
  text: string;
}

export interface TextReplacement {
  page: number;
  oldText: string;
  newText: string;
}

// Worker RPC message types

export type WorkerRequest =
  | { type: "open"; data: ArrayBuffer }
  | { type: "getPageCount" }
  | { type: "getPageInfo"; page: number }
  | { type: "renderPage"; page: number; scale: number }
  | { type: "getAnnotations"; page: number }
  | { type: "getWidgets"; page: number }
  | { type: "setAnnotRect"; annotId: string; rect: [number, number, number, number] }
  | { type: "setAnnotColor"; annotId: string; color: number[] }
  | { type: "setAnnotContents"; annotId: string; text: string }
  | { type: "setAnnotOpacity"; annotId: string; opacity: number }
  | { type: "setAnnotBorderWidth"; annotId: string; width: number }
  | { type: "setAnnotBorderStyle"; annotId: string; style: string }
  | { type: "setAnnotInteriorColor"; annotId: string; color: number[] }
  | { type: "setAnnotDefaultAppearance"; annotId: string; font: string; size: number; color: number[] }
  | { type: "setAnnotIcon"; annotId: string; icon: string }
  | { type: "setAnnotQuadPoints"; annotId: string; quadPoints: number[][] }
  | { type: "setAnnotIsOpen"; annotId: string; isOpen: boolean }
  | { type: "createAnnot"; page: number; annotType: string; rect: [number, number, number, number]; properties?: Partial<AnnotationDTO> }
  | { type: "deleteAnnot"; annotId: string }
  | { type: "setWidgetValue"; widgetId: string; value: string }
  | { type: "getPageImages"; page: number }
  | { type: "exportImage"; page: number; imageIndex: number }
  | { type: "extractText"; page: number }
  | { type: "replaceTextInStream"; page: number; oldText: string; newText: string; replaceAll?: boolean }
  | { type: "replaceTextSmart"; page: number; oldText: string; newText: string; boldOverride?: boolean; italicOverride?: boolean; fontName?: string }
  | { type: "searchText"; needle: string; page?: number }
  | { type: "addImage"; page: number; rect: [number, number, number, number]; imageData: ArrayBuffer; mimeType: string }
  | { type: "moveResizeImage"; page: number; imageIndex: number; newRect: [number, number, number, number] }
  | { type: "deleteImage"; page: number; imageIndex: number }
  | { type: "restoreImageBlock"; page: number; block: string; streamIndex: number; insertPosition: number }
  | { type: "reorderImage"; page: number; imageIndex: number; direction: "front" | "back" | "forward" | "backward" }
  | { type: "rotatePage"; page: number; angle: number }
  | { type: "deletePages"; pages: number[] }
  | { type: "rearrangePages"; order: number[] }
  | { type: "insertBlankPage"; at: number }
  | { type: "createBlankDocument"; width?: number; height?: number }
  | { type: "save"; options?: string };

export type WorkerResponse =
  | { type: "opened"; pageCount: number; pages: PageInfo[] }
  | { type: "pageCount"; count: number }
  | { type: "pageInfo"; page: number; info: PageInfo }
  | { type: "pageRendered"; page: number; bitmap: ImageBitmap; width: number; height: number }
  | { type: "annotations"; page: number; annots: AnnotationDTO[] }
  | { type: "widgets"; page: number; widgets: WidgetDTO[] }
  | { type: "annotUpdated"; annotId: string }
  | { type: "annotCreated"; annot: AnnotationDTO }
  | { type: "annotDeleted"; annotId: string }
  | { type: "saved"; buffer: ArrayBuffer }
  | { type: "textExtracted"; page: number; data: PageTextData }
  | { type: "textReplaced"; page: number; count: number }
  | { type: "textReplacedSmart"; page: number; count: number; method: "content-stream" | "font-augment" | "side-by-side" | "failed" }
  | { type: "searchResults"; results: TextSearchResult[] }
  | { type: "pageRotated"; page: number; info: PageInfo }
  | { type: "pagesUpdated"; pages: PageInfo[] }
  | { type: "imageExported"; bitmap: ImageBitmap; width: number; height: number }
  | { type: "imageUpdated"; page: number }
  | { type: "imageDeleted"; page: number }
  | { type: "error"; message: string; requestType?: string };
