import { Action, ActionPanel, Color, Form, Icon, LocalStorage, Toast, getPreferenceValues, showToast } from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { GatewayClient, GatewayState } from "./gateway-client";

type Preferences = {
  transportMode?: "rest" | "websocket";
  apiBaseUrl?: string;
  apiToken?: string;
  sessionId?: string;
  queryPath?: string;
  gatewayWsUrl?: string;
  gatewayMethod?: string;
  debugLogs?: boolean;
};

type QueryResponse = {
  reply?: string;
  message?: string;
  text?: string;
};

const HISTORY_KEY = "openclaw-raycast-history";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  at: string;
};

async function loadHistory() {
  const raw = await LocalStorage.getItem<string>(HISTORY_KEY);
  if (!raw) return [] as ChatMessage[];
  try {
    return JSON.parse(raw) as ChatMessage[];
  } catch {
    return [] as ChatMessage[];
  }
}

async function saveHistory(next: ChatMessage[]) {
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(next.slice(-40)));
}

function statusAccessory(state: GatewayState) {
  if (state === "connected") return { text: "Connected", icon: { source: Icon.Dot, tintColor: Color.Green } };
  if (state === "connecting") return { text: "Connecting", icon: { source: Icon.Dot, tintColor: Color.Yellow } };
  if (state === "pairing") return { text: "Pairing", icon: { source: Icon.Dot, tintColor: Color.Orange } };
  if (state === "error") return { text: "Error", icon: { source: Icon.Dot, tintColor: Color.Red } };
  return { text: "Disconnected", icon: { source: Icon.Dot, tintColor: Color.SecondaryText } };
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const [input, setInput] = useState("");
  const [reply, setReply] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [gatewayState, setGatewayState] = useState<GatewayState>("disconnected");
  const clientRef = useRef<GatewayClient | null>(null);

  useEffect(() => {
    return () => {
      clientRef.current?.disconnect();
      clientRef.current = null;
    };
  }, []);

  function ensureGatewayClient() {
    if (clientRef.current) return clientRef.current;
    const url = prefs.gatewayWsUrl?.trim();
    if (!url) throw new Error("Missing Gateway WebSocket URL");

    const client = new GatewayClient({
      url,
      token: prefs.apiToken,
      method: prefs.gatewayMethod || "chat.send",
      sessionId: prefs.sessionId?.trim() || undefined,
      debug: !!prefs.debugLogs,
      onStateChange: setGatewayState,
    });
    clientRef.current = client;
    return client;
  }

  async function sendMessage() {
    if (!input.trim()) return;

    setIsLoading(true);
    const loading = await showToast({ style: Toast.Style.Animated, title: "Asking OpenClaw…" });

    try {
      const mode = prefs.transportMode || "rest";
      let assistant = "";

      if (mode === "websocket") {
        const client = ensureGatewayClient();
        assistant = await client.sendChatStreaming(input.trim(), (next) => setReply(next));
      } else {
        const base = prefs.apiBaseUrl?.trim();
        if (!base) throw new Error("Missing API base URL for REST mode");

        const body: Record<string, string> = { message: input.trim() };
        if (prefs.sessionId?.trim()) body.sessionId = prefs.sessionId.trim();

        const queryPath = prefs.queryPath?.trim() || "/query";
        const res = await fetch(`${base.replace(/\/$/, "")}${queryPath.startsWith("/") ? queryPath : `/${queryPath}`}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(prefs.apiToken ? { Authorization: `Bearer ${prefs.apiToken}` } : {}),
          },
          body: JSON.stringify(body),
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = (await res.json()) as QueryResponse;
        assistant = data.reply || data.message || data.text || "(No reply field returned)";
      }

      setReply(assistant);
      const history = await loadHistory();
      history.push({ role: "user", content: input.trim(), at: new Date().toISOString() });
      history.push({ role: "assistant", content: assistant, at: new Date().toISOString() });
      await saveHistory(history);

      setInput("");
      loading.style = Toast.Style.Success;
      loading.title = "Reply received";
    } catch (error) {
      loading.style = Toast.Style.Failure;
      loading.title = "Request failed";
      loading.message = error instanceof Error ? error.message : String(error);
    } finally {
      setIsLoading(false);
    }
  }

  const stateAcc = statusAccessory(gatewayState);

  return (
    <Form
      isLoading={isLoading}
      actions={
        <ActionPanel>
          <Action title="Send" icon={Icon.Message} onAction={sendMessage} />
          <Action title="Disconnect Gateway" onAction={() => clientRef.current?.disconnect()} />
          <Action.CopyToClipboard title="Copy Reply" content={reply} shortcut={{ modifiers: ["cmd"], key: "c" }} />
        </ActionPanel>
      }
    >
      <Form.Description title="Transport" text={(prefs.transportMode || "rest").toUpperCase()} />
      {(prefs.transportMode || "rest") === "websocket" && (
        <Form.Description title="Gateway" text={`${stateAcc.text}`} />
      )}
      <Form.TextArea id="prompt" title="Message" placeholder="Ask anything…" value={input} onChange={setInput} info={stateAcc.text} />
      <Form.Description title="Reply" text={reply || "No reply yet"} />
    </Form>
  );
}
