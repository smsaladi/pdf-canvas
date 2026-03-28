// Typed message passing layer for main thread ↔ worker communication

import type { WorkerRequest, WorkerResponse } from "./types";

type PendingRequest = {
  resolve: (response: WorkerResponse) => void;
  reject: (error: Error) => void;
};

export class WorkerRPC {
  private worker: Worker;
  private pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private listeners = new Map<string, Set<(response: WorkerResponse) => void>>();

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (e: MessageEvent) => {
      const { _rpcId, ...response } = e.data;
      if (_rpcId !== undefined && this.pending.has(_rpcId)) {
        const pending = this.pending.get(_rpcId)!;
        this.pending.delete(_rpcId);
        if (response.type === "error") {
          pending.reject(new Error(response.message));
        } else {
          pending.resolve(response as WorkerResponse);
        }
      }
      // Also notify event listeners
      const typeListeners = this.listeners.get(response.type);
      if (typeListeners) {
        for (const listener of typeListeners) {
          listener(response as WorkerResponse);
        }
      }
    };

    this.worker.onerror = (e: ErrorEvent) => {
      // Reject all pending requests on worker error
      for (const [id, pending] of this.pending) {
        pending.reject(new Error(`Worker error: ${e.message}`));
      }
      this.pending.clear();
    };
  }

  send(request: WorkerRequest, transfer?: Transferable[]): Promise<WorkerResponse> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const message = { ...request, _rpcId: id };
      if (transfer) {
        this.worker.postMessage(message, transfer);
      } else {
        this.worker.postMessage(message);
      }
    });
  }

  on(type: string, listener: (response: WorkerResponse) => void): () => void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
    return () => {
      this.listeners.get(type)?.delete(listener);
    };
  }

  terminate(): void {
    this.worker.terminate();
    for (const [, pending] of this.pending) {
      pending.reject(new Error("Worker terminated"));
    }
    this.pending.clear();
  }
}

// Helper used inside the worker to respond to RPC messages
export function createWorkerResponder(ctx: typeof globalThis) {
  return function respond(rpcId: number | undefined, response: WorkerResponse, transfer?: Transferable[]) {
    const message = rpcId !== undefined ? { ...response, _rpcId: rpcId } : response;
    if (transfer) {
      (ctx as any).postMessage(message, transfer);
    } else {
      (ctx as any).postMessage(message);
    }
  };
}
