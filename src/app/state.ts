// Shared application state — populated by init(), referenced by all app sub-modules
import type { WorkerRPC } from "../worker-rpc";
import type { Viewport } from "../viewport";
import type { InteractionLayer } from "../interaction";
import type { PropertiesPanel } from "../properties";
import type { UndoManager } from "../undo";
import type { Toolbar } from "../toolbar";
import type { TextLayer } from "../text-layer";
import type { SearchBar } from "../search";

export const app = {
  rpc: null as WorkerRPC | null,
  viewport: null as Viewport | null,
  interaction: null as InteractionLayer | null,
  properties: null as PropertiesPanel | null,
  undoManager: null as UndoManager | null,
  toolbar: null as Toolbar | null,
  textLayer: null as TextLayer | null,
  searchBar: null as SearchBar | null,
  currentFilename: "document.pdf",
  hasOpenDocument: false,
  isDirty: false,
};

// Typed accessors that throw if called before init
export function rpc(): WorkerRPC { return app.rpc!; }
export function viewport(): Viewport { return app.viewport!; }
export function interaction(): InteractionLayer { return app.interaction!; }
export function properties(): PropertiesPanel { return app.properties!; }
export function undoManager(): UndoManager { return app.undoManager!; }
export function toolbar(): Toolbar { return app.toolbar!; }
