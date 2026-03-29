// Toolbar state and mode management

export type ToolMode = "select" | "hand" | "textedit" | "note" | "freetext" | "highlight" | "rectangle" | "circle" | "line" | "ink";

export type ToolChangeListener = (tool: ToolMode) => void;

export class Toolbar {
  private currentTool: ToolMode = "select";
  private listeners: ToolChangeListener[] = [];
  private buttons: Map<ToolMode, HTMLButtonElement> = new Map();

  constructor() {
    const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool-btn");
    for (const btn of toolButtons) {
      const tool = btn.dataset.tool as ToolMode;
      if (tool) {
        this.buttons.set(tool, btn);
        btn.addEventListener("click", () => this.setTool(tool));
      }
    }
  }

  getTool(): ToolMode {
    return this.currentTool;
  }

  setTool(tool: ToolMode): void {
    if (this.currentTool === tool) return;
    this.currentTool = tool;

    // Update button active states
    for (const [t, btn] of this.buttons) {
      btn.classList.toggle("active", t === tool);
    }

    for (const listener of this.listeners) {
      listener(tool);
    }
  }

  onChange(listener: ToolChangeListener): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((l) => l !== listener); };
  }
}
