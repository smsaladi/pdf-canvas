import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerRPC } from "./worker-rpc";
import type { WorkerResponse } from "./types";

// Minimal mock Worker for testing the RPC layer
function createMockWorker() {
  let onmessageHandler: ((e: MessageEvent) => void) | null = null;

  const worker = {
    postMessage: vi.fn(),
    terminate: vi.fn(),
    set onmessage(handler: ((e: MessageEvent) => void) | null) {
      onmessageHandler = handler;
    },
    get onmessage() {
      return onmessageHandler;
    },
    set onerror(_handler: any) {},
    get onerror() {
      return null;
    },
    // Simulate the worker sending a response back
    simulateResponse(data: any) {
      if (onmessageHandler) {
        onmessageHandler(new MessageEvent("message", { data }));
      }
    },
  };

  return worker;
}

describe("WorkerRPC", () => {
  let mock: ReturnType<typeof createMockWorker>;
  let rpc: WorkerRPC;

  beforeEach(() => {
    mock = createMockWorker();
    rpc = new WorkerRPC(mock as unknown as Worker);
  });

  it("sends messages with incrementing RPC IDs", () => {
    rpc.send({ type: "getPageCount" });
    rpc.send({ type: "getPageInfo", page: 0 });

    expect(mock.postMessage).toHaveBeenCalledTimes(2);
    expect(mock.postMessage.mock.calls[0][0]).toMatchObject({
      type: "getPageCount",
      _rpcId: 1,
    });
    expect(mock.postMessage.mock.calls[1][0]).toMatchObject({
      type: "getPageInfo",
      page: 0,
      _rpcId: 2,
    });
  });

  it("resolves promise when response arrives", async () => {
    const promise = rpc.send({ type: "getPageCount" });
    mock.simulateResponse({ type: "pageCount", count: 5, _rpcId: 1 });

    const result = await promise;
    expect(result).toEqual({ type: "pageCount", count: 5 });
  });

  it("rejects promise on error response", async () => {
    const promise = rpc.send({ type: "getPageCount" });
    mock.simulateResponse({
      type: "error",
      message: "Something went wrong",
      _rpcId: 1,
    });

    await expect(promise).rejects.toThrow("Something went wrong");
  });

  it("passes transfer list to postMessage", () => {
    const buffer = new ArrayBuffer(10);
    rpc.send({ type: "open", data: buffer }, [buffer]);

    expect(mock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "open", _rpcId: 1 }),
      [buffer]
    );
  });

  it("supports event listeners", () => {
    const listener = vi.fn();
    rpc.on("pageRendered", listener);

    mock.simulateResponse({
      type: "pageRendered",
      page: 0,
      width: 100,
      height: 200,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pageRendered", page: 0 })
    );
  });

  it("unsubscribes event listeners", () => {
    const listener = vi.fn();
    const unsub = rpc.on("pageRendered", listener);
    unsub();

    mock.simulateResponse({ type: "pageRendered", page: 0, width: 100, height: 200 });
    expect(listener).not.toHaveBeenCalled();
  });

  it("rejects all pending on terminate", async () => {
    const p1 = rpc.send({ type: "getPageCount" });
    const p2 = rpc.send({ type: "getPageInfo", page: 0 });

    rpc.terminate();

    await expect(p1).rejects.toThrow("Worker terminated");
    await expect(p2).rejects.toThrow("Worker terminated");
    expect(mock.terminate).toHaveBeenCalled();
  });
});
