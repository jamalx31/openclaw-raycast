import WebSocket, { RawData } from "ws";
import { LocalStorage } from "@raycast/api";
import { createHash, generateKeyPairSync, randomUUID, sign } from "crypto";

export type GatewayState = "disconnected" | "connecting" | "pairing" | "connected" | "error";

export type ChatEvent = {
  state: "delta" | "final" | "error" | "aborted";
  runId?: string;
  message?: unknown;
  errorMessage?: string;
};

type DeviceIdentity = {
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
};

type GatewayClientOptions = {
  url: string;
  token?: string;
  method?: string;
  sessionId?: string;
  timeoutMs?: number;
  debug?: boolean;
  onStateChange?: (state: GatewayState) => void;
};

type ReqFrame = { type: "req"; id: string; method: string; params?: unknown };

type Pending = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
};

const DEVICE_KEY = "openclaw-raycast-device-identity";

function base64Url(input: Buffer) {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const raw = await LocalStorage.getItem<string>(DEVICE_KEY);
  if (raw) {
    try {
      return JSON.parse(raw) as DeviceIdentity;
    } catch {
      // fallthrough
    }
  }

  const kp = generateKeyPairSync("ed25519");
  const publicKeyPem = kp.publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = kp.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const deviceId = `raycast-${randomUUID()}`;

  const identity: DeviceIdentity = { deviceId, publicKeyPem, privateKeyPem };
  await LocalStorage.setItem(DEVICE_KEY, JSON.stringify(identity));
  return identity;
}

function textFromUnknownMessage(msg: unknown): string {
  if (!msg) return "";
  if (typeof msg === "string") return msg;
  if (typeof msg === "object" && msg !== null) {
    const m = msg as Record<string, unknown>;
    if (typeof m.text === "string") return m.text;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((p) => {
          const part = p as Record<string, unknown>;
          return typeof part.text === "string" ? part.text : "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private state: GatewayState = "disconnected";
  private pending = new Map<string, Pending>();

  constructor(private opts: GatewayClientOptions) {}

  private log(...args: unknown[]) {
    if (this.opts.debug) console.log("[openclaw-raycast][gateway]", ...args);
  }

  private setState(next: GatewayState) {
    if (this.state === next) return;
    this.state = next;
    this.opts.onStateChange?.(next);
    this.log("state =>", next);
  }

  async connect(): Promise<void> {
    if (this.state === "connected") return;

    this.setState("connecting");
    const timeoutMs = this.opts.timeoutMs ?? 30000;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.opts.url, {
        headers: this.opts.token ? { Authorization: `Bearer ${this.opts.token}` } : undefined,
      });

      this.ws = ws;
      let connected = false;
      const t = setTimeout(() => {
        if (!connected) {
          ws.close();
          reject(new Error("Gateway connect timeout"));
        }
      }, timeoutMs);

      ws.on("open", () => {
        this.log("socket opened");
        setTimeout(() => {
          if (!connected) {
            connected = true;
            clearTimeout(t);
            this.setState("connected");
            resolve();
          }
        }, 1200);
      });

      ws.on("message", async (raw: RawData) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        if (frame.type === "event" && frame.event === "connect.challenge") {
          this.setState("pairing");
          try {
            await this.respondToChallenge(frame.payload as Record<string, unknown>);
          } catch (err) {
            clearTimeout(t);
            reject(err);
          }
          return;
        }

        if (frame.type === "res") {
          const id = String(frame.id ?? "");
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            clearTimeout(p.timer);
            if (frame.ok === false) {
              const err = (frame.error ?? {}) as Record<string, unknown>;
              p.reject(new Error(String(err.message || "Gateway request failed")));
            } else {
              p.resolve(frame.payload);
            }
          }

          if (!connected) {
            connected = true;
            clearTimeout(t);
            this.setState("connected");
            resolve();
          }
        }
      });

      ws.on("error", (err: Error) => {
        this.log("socket error", err.message);
        this.setState("error");
        clearTimeout(t);
        if (!connected) reject(err);
      });

      ws.on("close", () => {
        this.log("socket closed");
        this.setState("disconnected");
      });
    });
  }

  async sendChatStreaming(message: string, onDelta: (next: string) => void): Promise<string> {
    await this.connect();

    let full = "";
    return new Promise<string>((resolve, reject) => {
      if (!this.ws) {
        reject(new Error("Socket missing after connect"));
        return;
      }

      const method = this.opts.method || "chat.send";
      const reqId = `chat-${Date.now()}`;
      const timer = setTimeout(() => {
        this.ws?.off("message", onMessage);
        reject(new Error("Chat timeout"));
      }, this.opts.timeoutMs ?? 30000);

      const onMessage = (raw: RawData) => {
        let frame: Record<string, unknown>;
        try {
          frame = JSON.parse(raw.toString()) as Record<string, unknown>;
        } catch {
          return;
        }

        if (frame.type === "event" && frame.event === "chat") {
          const evt = frame.payload as ChatEvent;
          const chunk = textFromUnknownMessage(evt.message);

          if (evt.state === "delta") {
            if (chunk) {
              full += chunk;
              onDelta(full);
            }
          } else if (evt.state === "final") {
            clearTimeout(timer);
            this.ws?.off("message", onMessage);
            resolve(textFromUnknownMessage(evt.message) || full || "(No reply)");
          } else if (evt.state === "error") {
            clearTimeout(timer);
            this.ws?.off("message", onMessage);
            reject(new Error(evt.errorMessage || "Gateway chat error"));
          }
          return;
        }

        if (frame.type === "res" && frame.id === reqId) {
          clearTimeout(timer);
          this.ws?.off("message", onMessage);

          if (frame.ok === false) {
            const err = (frame.error ?? {}) as Record<string, unknown>;
            reject(new Error(String(err.message || "Request failed")));
            return;
          }

          const payload = (frame.payload ?? {}) as Record<string, unknown>;
          const text =
            (typeof payload.reply === "string" && payload.reply) ||
            (typeof payload.message === "string" && payload.message) ||
            (typeof payload.text === "string" && payload.text) ||
            full ||
            "(No reply)";
          resolve(text);
        }
      };

      this.ws.on("message", onMessage);
      this.ws.send(
        JSON.stringify({
          type: "req",
          id: reqId,
          method,
          params: { message, sessionId: this.opts.sessionId },
        } satisfies ReqFrame),
      );
    });
  }

  disconnect() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("Disconnected"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = null;
    this.setState("disconnected");
  }

  private async respondToChallenge(payload: Record<string, unknown>) {
    if (!this.ws) throw new Error("Socket not ready");

    const identity = await getOrCreateDeviceIdentity();
    const nonce = String(payload.nonce || "");
    const signedAt = Date.now();

    const signingPayload = {
      deviceId: identity.deviceId,
      nonce,
      signedAt,
      clientId: "openclaw-raycast",
      clientMode: "operator",
      role: "operator",
      scopes: ["chat", "tools", "memory"],
    };

    const digest = createHash("sha256").update(JSON.stringify(signingPayload)).digest();
    const signature = sign(null, digest, identity.privateKeyPem);

    this.ws.send(
      JSON.stringify({
        type: "req",
        id: `connect-${Date.now()}`,
        method: "connect",
        params: {
          protocolVersion: 1,
          client: {
            id: "openclaw-raycast",
            mode: "operator",
            version: "0.1.0",
            label: "OpenClaw Raycast",
          },
          deviceAuth: {
            ...signingPayload,
            publicKey: identity.publicKeyPem,
            alg: "ed25519",
            signature: base64Url(signature),
          },
        },
      } satisfies ReqFrame),
    );
  }
}
