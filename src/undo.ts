// Undo/Redo system

export interface UndoEntry {
  annotId: string;
  property: string;
  previousValue: any;
  newValue: any;
}

export class UndoManager {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private maxSize: number;
  private onChangeCallback: (() => void) | null = null;

  constructor(maxSize = 50) {
    this.maxSize = maxSize;
  }

  onChange(callback: () => void): void {
    this.onChangeCallback = callback;
  }

  push(entry: UndoEntry): void {
    this.undoStack.push(entry);
    if (this.undoStack.length > this.maxSize) {
      this.undoStack.shift();
    }
    // New action clears redo stack
    this.redoStack = [];
    this.onChangeCallback?.();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): UndoEntry | null {
    const entry = this.undoStack.pop();
    if (!entry) return null;
    this.redoStack.push(entry);
    this.onChangeCallback?.();
    return entry;
  }

  redo(): UndoEntry | null {
    const entry = this.redoStack.pop();
    if (!entry) return null;
    this.undoStack.push(entry);
    this.onChangeCallback?.();
    return entry;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.onChangeCallback?.();
  }

  getUndoCount(): number { return this.undoStack.length; }
  getRedoCount(): number { return this.redoStack.length; }
}
