// Shared context interface for interaction sub-modules.
// The InteractionLayer class implements this; sub-modules receive it as a parameter.
import type { Viewport } from "../viewport";
import type { AnnotationDTO, WidgetDTO, PageImageDTO } from "../types";
import type { ToolMode } from "../toolbar";
import type { UndoManager } from "../undo";
import type { TextLayer } from "../text-layer";

export interface DragState {
  annotId: string;
  startScreenX: number;
  startScreenY: number;
  originalLeft: number;
  originalTop: number;
  handle: string | null;
  originalWidth: number;
  originalHeight: number;
  originalAnnotRect: [number, number, number, number];
  originalQuadPoints?: number[][];
}

export interface CreationState {
  tool: ToolMode;
  pageIndex: number;
  startScreenX: number;
  startScreenY: number;
  lastX: number;
  lastY: number;
  previewEl: HTMLDivElement;
  svgEl?: SVGSVGElement;
  pathEl?: SVGElement;
  inkPoints?: Array<[number, number]>;
}

export interface InlineEditState {
  annotId: string;
  el: HTMLDivElement;
  cleanup: () => void;
}

export interface InteractionContext {
  viewport: Viewport;
  overlayContainers: Map<number, HTMLDivElement>;
  overlayElements: Map<string, HTMLDivElement>;
  selectedId: string | null;
  selectionListeners: Array<(annotation: AnnotationDTO | null) => void>;
  mutationListeners: Array<(annotId: string, property: string, oldValue: any, newValue: any) => void>;
  dragState: DragState | null;
  creationState: CreationState | null;
  currentTool: ToolMode;
  currentColor: [number, number, number];
  currentFillColor: [number, number, number] | null;
  currentBorderWidth: number;
  undoManager: UndoManager | null;
  textLayer: TextLayer | null;
  onCreationDone: (() => void) | null;
  activeInlineEdit: InlineEditState | null;

  // Methods that sub-modules need to call back into the class
  canSelect(): boolean;
  select(annotId: string | null): void;
  startDrag(annotId: string, e: PointerEvent, handle: string | null): void;
  startCreation(pageIndex: number, e: PointerEvent): void;
  startInlineEdit(annotId: string): void;
  cancelInlineEdit(): Promise<void>;
  finishCreation(): Promise<void>;
  moveAnnot(annotId: string, newRect: [number, number, number, number]): Promise<void>;
  moveQuadPoints(annotId: string, newQuadPoints: number[][]): Promise<void>;
  getAnnotationForId(id: string): AnnotationDTO | null;
  getAnnotationForElement(el: HTMLDivElement): AnnotationDTO | null;
}
