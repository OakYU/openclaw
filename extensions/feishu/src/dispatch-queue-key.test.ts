import { describe, expect, it, vi } from "vitest";
import { resolveFeishuDispatchQueueKey } from "./dispatch-queue-key.js";

/**
 * Minimal re-implementation of createChatQueue (private in monitor.account.ts)
 * for integration testing. This mirrors the exact same serial-chain logic.
 */
function createChatQueue() {
  const queues = new Map<string, Promise<void>>();
  return (key: string, task: () => Promise<void>): Promise<void> => {
    const prev = queues.get(key) ?? Promise.resolve();
    const next = prev.then(task, task);
    queues.set(key, next);
    void next.finally(() => {
      if (queues.get(key) === next) {
        queues.delete(key);
      }
    });
    return next;
  };
}

describe("resolveFeishuDispatchQueueKey", () => {
  const alwaysControl = () => true;
  const neverControl = () => false;

  // ─── Unit tests: pure queue key resolution ────────────────────────

  it("returns control queue key when message is a control command", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "/stop",
        hasControlCommand: alwaysControl,
      }),
    ).toBe("oc_abc123:control");
  });

  it("returns plain chatId when message is not a control command", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "hello world",
        hasControlCommand: neverControl,
      }),
    ).toBe("oc_abc123");
  });

  it("returns plain chatId when message text is empty", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "",
        hasControlCommand: alwaysControl,
      }),
    ).toBe("oc_abc123");
  });

  it("returns plain chatId when message text is whitespace-only", () => {
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "   ",
        hasControlCommand: alwaysControl,
      }),
    ).toBe("oc_abc123");
  });

  it("trims message text before checking", () => {
    const hasControlCommand = (text: string) => text === "/stop";
    expect(
      resolveFeishuDispatchQueueKey({
        chatId: "oc_abc123",
        messageText: "  /stop  ",
        hasControlCommand,
      }),
    ).toBe("oc_abc123:control");
  });

  it("passes cfg through to hasControlCommand", () => {
    const cfg = { test: true };
    let receivedCfg: unknown;
    const hasControlCommand = (_text: string, c?: unknown) => {
      receivedCfg = c;
      return false;
    };
    resolveFeishuDispatchQueueKey({
      chatId: "oc_abc123",
      messageText: "/status",
      hasControlCommand,
      cfg,
    });
    expect(receivedCfg).toBe(cfg);
  });

  it("uses different control queue keys for different chats", () => {
    const key1 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
      hasControlCommand: alwaysControl,
    });
    const key2 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat2",
      messageText: "/stop",
      hasControlCommand: alwaysControl,
    });
    expect(key1).toBe("oc_chat1:control");
    expect(key2).toBe("oc_chat2:control");
    expect(key1).not.toBe(key2);
  });

  // ─── Realistic control command detection ──────────────────────────

  it("detects /stop as control", () => {
    const key = resolveFeishuDispatchQueueKey({
      chatId: "oc_abc",
      messageText: "/stop",
      hasControlCommand: (t) => ["/stop", "/new", "/status"].includes(t),
    });
    expect(key).toBe("oc_abc:control");
  });

  it("detects /new as control", () => {
    const key = resolveFeishuDispatchQueueKey({
      chatId: "oc_abc",
      messageText: "/new",
      hasControlCommand: (t) => ["/stop", "/new", "/status"].includes(t),
    });
    expect(key).toBe("oc_abc:control");
  });

  it("detects /status as control", () => {
    const key = resolveFeishuDispatchQueueKey({
      chatId: "oc_abc",
      messageText: "/status",
      hasControlCommand: (t) => ["/stop", "/new", "/status"].includes(t),
    });
    expect(key).toBe("oc_abc:control");
  });

  it("routes normal conversation to the standard queue", () => {
    const key = resolveFeishuDispatchQueueKey({
      chatId: "oc_abc",
      messageText: "tell me about the weather",
      hasControlCommand: (t) => ["/stop", "/new", "/status"].includes(t),
    });
    expect(key).toBe("oc_abc");
  });

  // ─── Queue isolation: control commands bypass active runs ─────────

  it("control command executes immediately while a long task is running on the same chat", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    // Gate: long task will block until we release it
    let releaseLongTask!: () => void;
    const longTaskGate = new Promise<void>((resolve) => {
      releaseLongTask = resolve;
    });

    // 1. Enqueue a long-running agent task on "oc_chat1" (normal queue)
    const normalKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "explain quantum computing in detail",
      hasControlCommand: neverControl,
    });
    const longTaskPromise = enqueue(normalKey, async () => {
      events.push("long-task-start");
      await longTaskGate;
      events.push("long-task-end");
    });

    // Wait for long task to actually start
    await vi.waitFor(() => expect(events).toContain("long-task-start"));

    // 2. Enqueue /stop on the CONTROL queue for the same chat
    const controlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
      hasControlCommand: alwaysControl,
    });
    expect(controlKey).not.toBe(normalKey); // different queue keys

    const stopPromise = enqueue(controlKey, async () => {
      events.push("stop-executed");
    });

    // 3. /stop should complete before the long task finishes
    await stopPromise;
    expect(events).toContain("stop-executed");
    expect(events).not.toContain("long-task-end"); // long task is still running

    // 4. Now release the long task
    releaseLongTask();
    await longTaskPromise;
    expect(events).toEqual([
      "long-task-start",
      "stop-executed", // control bypassed the queue
      "long-task-end",
    ]);
  });

  it("normal messages on the same chat still serialize behind each other", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const key1 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "first message",
      hasControlCommand: neverControl,
    });
    const key2 = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "second message",
      hasControlCommand: neverControl,
    });
    expect(key1).toBe(key2); // same queue key for normal messages

    const p1 = enqueue(key1, async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
    });
    const p2 = enqueue(key2, async () => {
      events.push("second-start");
    });

    await vi.waitFor(() => expect(events).toContain("first-start"));

    // second message should NOT have started yet
    expect(events).not.toContain("second-start");

    releaseFirst();
    await p1;
    await p2;

    expect(events).toEqual([
      "first-start",
      "first-end",
      "second-start", // serialized: second only starts after first ends
    ]);
  });

  it("control commands from different chats do not interfere with each other", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseChat1Stop!: () => void;
    const chat1StopGate = new Promise<void>((resolve) => {
      releaseChat1Stop = resolve;
    });

    const chat1ControlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
      hasControlCommand: alwaysControl,
    });
    const chat2ControlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat2",
      messageText: "/stop",
      hasControlCommand: alwaysControl,
    });
    expect(chat1ControlKey).not.toBe(chat2ControlKey);

    const p1 = enqueue(chat1ControlKey, async () => {
      events.push("chat1-stop-start");
      await chat1StopGate;
      events.push("chat1-stop-end");
    });

    await vi.waitFor(() => expect(events).toContain("chat1-stop-start"));

    // chat2's /stop should execute independently
    const p2 = enqueue(chat2ControlKey, async () => {
      events.push("chat2-stop-executed");
    });

    await p2;
    expect(events).toContain("chat2-stop-executed");
    expect(events).not.toContain("chat1-stop-end");

    releaseChat1Stop();
    await p1;
  });

  it("multiple control commands on the same chat still serialize among themselves", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseFirstControl!: () => void;
    const firstControlGate = new Promise<void>((resolve) => {
      releaseFirstControl = resolve;
    });

    const controlKey = resolveFeishuDispatchQueueKey({
      chatId: "oc_chat1",
      messageText: "/stop",
      hasControlCommand: alwaysControl,
    });

    const p1 = enqueue(controlKey, async () => {
      events.push("first-control-start");
      await firstControlGate;
      events.push("first-control-end");
    });

    await vi.waitFor(() => expect(events).toContain("first-control-start"));

    // Second /status on the same control queue should wait
    const p2 = enqueue(controlKey, async () => {
      events.push("second-control-start");
    });

    expect(events).not.toContain("second-control-start");

    releaseFirstControl();
    await p1;
    await p2;

    expect(events).toEqual([
      "first-control-start",
      "first-control-end",
      "second-control-start", // serialized within the control lane
    ]);
  });

  it("a queued normal message does not block a subsequent control command", async () => {
    const enqueue = createChatQueue();
    const events: string[] = [];

    let releaseTask1!: () => void;
    const task1Gate = new Promise<void>((resolve) => {
      releaseTask1 = resolve;
    });
    let releaseTask2!: () => void;
    const task2Gate = new Promise<void>((resolve) => {
      releaseTask2 = resolve;
    });

    const normalKey = "oc_chat1"; // neverControl → chatId
    const controlKey = "oc_chat1:control"; // alwaysControl → chatId:control

    // Queue two normal messages back-to-back
    const p1 = enqueue(normalKey, async () => {
      events.push("task1-start");
      await task1Gate;
      events.push("task1-end");
    });
    const p2 = enqueue(normalKey, async () => {
      events.push("task2-start");
      await task2Gate;
      events.push("task2-end");
    });

    await vi.waitFor(() => expect(events).toContain("task1-start"));

    // Now user sends /stop — should bypass both queued normal tasks
    const pStop = enqueue(controlKey, async () => {
      events.push("stop-executed");
    });

    await pStop;
    // /stop completed while task1 is still running and task2 hasn't started
    expect(events).toContain("stop-executed");
    expect(events).not.toContain("task1-end");
    expect(events).not.toContain("task2-start");

    // Clean up
    releaseTask1();
    await p1;
    releaseTask2();
    await p2;
  });
});
