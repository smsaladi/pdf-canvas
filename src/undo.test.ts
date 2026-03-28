import { describe, it, expect, vi } from "vitest";
import { UndoManager, type UndoEntry } from "./undo";

describe("UndoManager", () => {
  it("starts empty", () => {
    const um = new UndoManager();
    expect(um.canUndo()).toBe(false);
    expect(um.canRedo()).toBe(false);
  });

  it("push adds to undo stack", () => {
    const um = new UndoManager();
    um.push({ annotId: "0-0", property: "rect", previousValue: [0, 0, 10, 10], newValue: [5, 5, 15, 15] });
    expect(um.canUndo()).toBe(true);
    expect(um.canRedo()).toBe(false);
  });

  it("undo pops from undo stack and pushes to redo stack", () => {
    const um = new UndoManager();
    um.push({ annotId: "0-0", property: "rect", previousValue: [0, 0], newValue: [5, 5] });
    const entry = um.undo();
    expect(entry).not.toBeNull();
    expect(entry!.previousValue).toEqual([0, 0]);
    expect(um.canUndo()).toBe(false);
    expect(um.canRedo()).toBe(true);
  });

  it("redo pops from redo stack and pushes back to undo stack", () => {
    const um = new UndoManager();
    um.push({ annotId: "0-0", property: "color", previousValue: [1, 0, 0], newValue: [0, 1, 0] });
    um.undo();
    const entry = um.redo();
    expect(entry).not.toBeNull();
    expect(entry!.newValue).toEqual([0, 1, 0]);
    expect(um.canUndo()).toBe(true);
    expect(um.canRedo()).toBe(false);
  });

  it("new action clears redo stack", () => {
    const um = new UndoManager();
    um.push({ annotId: "0-0", property: "rect", previousValue: "a", newValue: "b" });
    um.push({ annotId: "0-0", property: "rect", previousValue: "b", newValue: "c" });
    um.undo(); // redo now has "c"
    expect(um.canRedo()).toBe(true);

    um.push({ annotId: "0-0", property: "rect", previousValue: "b", newValue: "d" });
    expect(um.canRedo()).toBe(false);
  });

  it("respects maxSize", () => {
    const um = new UndoManager(3);
    for (let i = 0; i < 5; i++) {
      um.push({ annotId: "0-0", property: "rect", previousValue: i, newValue: i + 1 });
    }
    expect(um.getUndoCount()).toBe(3);
  });

  it("undo on empty stack returns null", () => {
    const um = new UndoManager();
    expect(um.undo()).toBeNull();
  });

  it("redo on empty stack returns null", () => {
    const um = new UndoManager();
    expect(um.redo()).toBeNull();
  });

  it("clear empties both stacks", () => {
    const um = new UndoManager();
    um.push({ annotId: "0-0", property: "rect", previousValue: 1, newValue: 2 });
    um.undo();
    um.clear();
    expect(um.canUndo()).toBe(false);
    expect(um.canRedo()).toBe(false);
  });

  it("calls onChange callback on push, undo, redo, clear", () => {
    const um = new UndoManager();
    const cb = vi.fn();
    um.onChange(cb);

    um.push({ annotId: "0-0", property: "rect", previousValue: 1, newValue: 2 });
    expect(cb).toHaveBeenCalledTimes(1);

    um.undo();
    expect(cb).toHaveBeenCalledTimes(2);

    um.redo();
    expect(cb).toHaveBeenCalledTimes(3);

    um.clear();
    expect(cb).toHaveBeenCalledTimes(4);
  });
});
