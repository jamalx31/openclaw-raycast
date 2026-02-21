import { Action, ActionPanel, Detail, LocalStorage, Toast, environment, getPreferenceValues, showToast } from "@raycast/api";
import { ChildProcess, spawn } from "child_process";
import { hostname } from "os";
import { join } from "path";
import { createInterface } from "readline";
import { useEffect, useRef, useState } from "react";

type Preferences = {
  apiBaseUrl?: string;
  apiToken?: string;
  sessionId?: string;
  channelName?: string;
  recordSeconds?: string;
};

type ChannelResponse = {
  text?: string;
  read?: string;
  reply?: string;
  error?: string;
};

type ChatMessage = {
  role: "user" | "assistant";
  text: string;
};

const HISTORY_KEY = "openclaw-talk-history";

async function loadHistory(): Promise<ChatMessage[]> {
  const raw = await LocalStorage.getItem<string>(HISTORY_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw) as ChatMessage[]; } catch { return []; }
}

async function saveHistory(messages: ChatMessage[]) {
  await LocalStorage.setItem(HISTORY_KEY, JSON.stringify(messages.slice(-40)));
}

/** Spawn `listen <seconds>` — streams partial/final transcript lines via stdout. */
function listenLive(
  seconds: number,
  onPartial: (text: string) => void,
): Promise<string> {
  const bin = join(environment.assetsPath, "listen");
  console.log("[listen] bin path:", bin);

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, [String(seconds)]);
    let finalText = "";
    let stderrBuf = "";

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (line.startsWith("partial:")) {
        const text = line.slice(8);
        console.log("[listen] partial:", text);
        onPartial(text);
      } else if (line.startsWith("final:")) {
        finalText = line.slice(6);
        console.log("[listen] final:", finalText);
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on("close", (code) => {
      if (stderrBuf.trim()) console.log("[listen] stderr:", stderrBuf.trim());
      if (code === 0 && finalText) {
        resolve(finalText);
      } else {
        reject(new Error(stderrBuf.trim() || `listen exited with code ${code}`));
      }
    });

    proc.on("error", (err) => {
      reject(new Error(err.message));
    });
  });
}

/** Speak text using the local macOS TTS engine. Returns the child process so it can be killed. */
function speakText(text: string): ChildProcess {
  const bin = join(environment.assetsPath, "speak");
  console.log("[speak] saying:", text.slice(0, 80));
  const proc = spawn(bin, [text], { stdio: ["pipe", "ignore", "pipe"] });
  proc.stderr?.on("data", (chunk: Buffer) => {
    const msg = chunk.toString().trim();
    if (msg) console.log("[speak] stderr:", msg);
  });
  proc.on("error", (err) => console.log("[speak] error:", err.message));
  return proc;
}

function killSpeak(proc: ChildProcess | null) {
  if (!proc || proc.killed) return;
  console.log("[speak] interrupted");
  proc.stdin?.end();
  proc.kill("SIGTERM");
}

function renderMarkdown(history: ChatMessage[], liveTranscript: string) {
  let md = "# Talk to OpenClaw\n\n";

  for (const msg of history) {
    if (msg.role === "user") {
      md += `**You:** ${msg.text}\n\n`;
    } else {
      md += `**OpenClaw:** ${msg.text}\n\n`;
    }
  }

  if (liveTranscript) {
    md += `**You:** _${liveTranscript}_\n\n`;
  }

  md += "---\n> Tip: assign a global hotkey to this command in Raycast.";
  return md;
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const [isLoading, setIsLoading] = useState(false);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [liveTranscript, setLiveTranscript] = useState("");
  const startedRef = useRef(false);
  const runningRef = useRef(false);
  const speakRef = useRef<ChildProcess | null>(null);

  // Load history on mount, kill speak on unmount
  useEffect(() => {
    loadHistory().then((h) => { if (h.length) setHistory(h); });
    return () => {
      killSpeak(speakRef.current);
    };
  }, []);

  async function runVoiceFlow() {
    if (runningRef.current) return;
    runningRef.current = true;

    // Interrupt any ongoing speech
    killSpeak(speakRef.current);
    speakRef.current = null;

    setIsLoading(true);
    setLiveTranscript("");
    const toast = await showToast({ style: Toast.Style.Animated, title: "Listening…" });

    try {
      const seconds = Math.max(2, Number(prefs.recordSeconds || "30") || 30);
      console.log("[voice] listening for", seconds, "seconds");

      const text = await listenLive(seconds, (partial) => {
        setLiveTranscript(partial);
        toast.title = "Listening…";
      });

      if (!text) throw new Error("No speech detected");
      setLiveTranscript("");
      setHistory((h) => {
        const next = [...h, { role: "user" as const, text }];
        saveHistory(next);
        return next;
      });

      toast.title = "Asking OpenClaw…";

      const baseUrl = (prefs.apiBaseUrl || "").replace(/\/$/, "");
      if (!baseUrl) throw new Error("API Base URL is not configured — set it in extension preferences");

      const channel = prefs.channelName?.trim() || "openclaw-raycast";
      const url = `${baseUrl}/api/channels/${channel}/message`;
      const token = prefs.apiToken?.trim();
      console.log("[voice] sending to", url);

      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          sessionId: prefs.sessionId?.trim() || "agent:main:main",
          clientId: hostname(),
          message: text,
        }),
      });

      if (!res.ok) throw new Error(`Channel request failed: HTTP ${res.status}`);
      const data = (await res.json()) as ChannelResponse;
      console.log("[voice] response:", JSON.stringify(data));

      const replyText = data.text?.trim() || data.reply?.trim() || data.read?.trim() || "(No reply)";
      setHistory((h) => {
        const next = [...h, { role: "assistant" as const, text: replyText }];
        saveHistory(next);
        return next;
      });

      // Speak the reply — prefer the short "read" summary, fall back to full reply
      const spokenText = data.read?.trim() || replyText;
      if (spokenText && spokenText !== "(No reply)") {
        speakRef.current = speakText(spokenText);
      }

      toast.style = Toast.Style.Success;
      toast.title = "Done";
    } catch (error) {
      console.error("[voice] error:", error instanceof Error ? error.message : String(error));
      toast.style = Toast.Style.Failure;
      toast.title = "Voice flow failed";
      toast.message = error instanceof Error ? error.message : String(error);
    } finally {
      setIsLoading(false);
      runningRef.current = false;
    }
  }

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    runVoiceFlow();
  }, []);

  return (
    <Detail
      isLoading={isLoading}
      markdown={renderMarkdown(history, liveTranscript)}
      actions={
        <ActionPanel>
          <Action title="Record and Send" onAction={runVoiceFlow} />
          <Action.CopyToClipboard
            title="Copy Last Reply"
            content={history.filter((m) => m.role === "assistant").pop()?.text || ""}
          />
          <Action.CopyToClipboard
            title="Copy Full History"
            content={history.map((m) => `${m.role === "user" ? "You" : "OpenClaw"}: ${m.text}`).join("\n\n")}
          />
        </ActionPanel>
      }
    />
  );
}
