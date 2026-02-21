import { Action, ActionPanel, Detail, Icon, LocalStorage, Toast, environment, getPreferenceValues, showToast } from "@raycast/api";
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

type ListenHandle = {
  result: Promise<string>;
  stop: () => void;
};

type Phase = "recording" | "sending" | "idle";

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
): ListenHandle {
  const bin = join(environment.assetsPath, "listen");
  console.log("[listen] bin path:", bin);

  const proc = spawn(bin, [String(seconds)]);

  const result = new Promise<string>((resolve, reject) => {
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

  const stop = () => {
    if (!proc.killed) {
      console.log("[listen] sending SIGTERM");
      proc.kill("SIGTERM");
    }
  };

  return { result, stop };
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

function renderMarkdown(history: ChatMessage[], liveTranscript: string, phase: Phase) {
  let md = "";

  if (phase === "recording") {
    md += "> Press **Enter** to stop & send, or wait for silence detection.\n\n---\n\n";
  } else if (phase === "sending") {
    md += "> Sending…\n\n---\n\n";
  } else {
    md += "> Press **Enter** to record again.\n\n---\n\n";
  }

  if (liveTranscript) {
    md += `**You:** _${liveTranscript}_\n\n`;
  }

  // Newest messages first so latest content is visible at the top
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i];
    if (msg.role === "user") {
      md += `**You:** ${msg.text}\n\n`;
    } else {
      md += `**OpenClaw:** ${msg.text}\n\n`;
    }
  }

  return md;
}

export default function Command() {
  const prefs = getPreferenceValues<Preferences>();
  const [phase, setPhase] = useState<Phase>("idle");
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [liveTranscript, setLiveTranscript] = useState("");
  const startedRef = useRef(false);
  const listenRef = useRef<ListenHandle | null>(null);
  const speakRef = useRef<ChildProcess | null>(null);
  const phaseRef = useRef<Phase>("idle");

  // Keep phaseRef in sync so callbacks can read current phase
  useEffect(() => { phaseRef.current = phase; }, [phase]);

  // Load history on mount, clean up on unmount
  useEffect(() => {
    loadHistory().then((h) => { if (h.length) setHistory(h); });
    return () => {
      killSpeak(speakRef.current);
      listenRef.current?.stop();
    };
  }, []);

  async function sendAndSpeak(text: string) {
    setPhase("sending");
    const toast = await showToast({ style: Toast.Style.Animated, title: "Asking OpenClaw…" });

    try {
      setHistory((h) => {
        const next = [...h, { role: "user" as const, text }];
        saveHistory(next);
        return next;
      });

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
      setPhase("idle");
    }
  }

  async function startRecording() {
    // Interrupt any ongoing speech
    killSpeak(speakRef.current);
    speakRef.current = null;

    setLiveTranscript("");
    setPhase("recording");

    const toast = await showToast({ style: Toast.Style.Animated, title: "Listening…" });
    const seconds = Math.max(2, Number(prefs.recordSeconds || "30") || 30);
    console.log("[voice] listening for", seconds, "seconds");

    const handle = listenLive(seconds, (partial) => {
      setLiveTranscript(partial);
      toast.title = "Listening…";
    });
    listenRef.current = handle;

    // When listen finishes on its own (silence detection / timeout), auto-send
    handle.result.then(
      (text) => {
        listenRef.current = null;
        if (!text) {
          setPhase("idle");
          toast.style = Toast.Style.Failure;
          toast.title = "No speech detected";
          return;
        }
        // Only auto-send if we're still in recording phase (not already stopped manually)
        if (phaseRef.current === "recording") {
          setLiveTranscript("");
          toast.hide();
          sendAndSpeak(text);
        }
      },
      (err) => {
        listenRef.current = null;
        // Only show error if we're still in recording phase (cancel triggers a rejection)
        if (phaseRef.current === "recording") {
          console.error("[voice] listen error:", err.message);
          toast.style = Toast.Style.Failure;
          toast.title = "Listen failed";
          toast.message = err.message;
          setPhase("idle");
        }
      },
    );
  }

  async function stopAndSend() {
    const handle = listenRef.current;
    if (!handle) return;

    // Mark sending BEFORE stop so the .then() handler in startRecording skips
    setPhase("sending");

    // Signal listen to stop — it will emit final:<text> and exit
    handle.stop();

    try {
      const text = await handle.result;
      listenRef.current = null;
      setLiveTranscript("");
      if (!text) {
        await showToast({ style: Toast.Style.Failure, title: "No speech detected" });
        setPhase("idle");
        return;
      }
      await sendAndSpeak(text);
    } catch (err) {
      listenRef.current = null;
      console.error("[voice] stop error:", err instanceof Error ? err.message : String(err));
      await showToast({ style: Toast.Style.Failure, title: "No speech detected" });
      setPhase("idle");
    }
  }

  function cancelRecording() {
    const handle = listenRef.current;
    if (!handle) return;

    setPhase("idle");
    setLiveTranscript("");
    handle.stop();
    listenRef.current = null;
    console.log("[voice] recording cancelled");
    showToast({ style: Toast.Style.Success, title: "Cancelled" });
  }

  // Auto-start recording on mount
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startRecording();
  }, []);

  return (
    <Detail
      isLoading={phase === "sending"}
      markdown={renderMarkdown(history, liveTranscript, phase)}
      actions={
        <ActionPanel>
          {phase === "recording" && (
            <Action title="Stop & Send" icon={Icon.ArrowRight} onAction={stopAndSend} />
          )}
          {phase === "recording" && (
            <Action title="Cancel" icon={Icon.XMarkCircle} onAction={cancelRecording} shortcut={{ modifiers: ["cmd"], key: "." }} />
          )}
          {phase === "idle" && (
            <Action title="Record Again" icon={Icon.Microphone} onAction={startRecording} />
          )}
          {phase === "idle" && (
            <Action.CopyToClipboard
              title="Copy Last Reply"
              content={history.filter((m) => m.role === "assistant").pop()?.text || ""}
            />
          )}
          {phase === "idle" && (
            <Action.CopyToClipboard
              title="Copy Full History"
              content={history.map((m) => `${m.role === "user" ? "You" : "OpenClaw"}: ${m.text}`).join("\n\n")}
            />
          )}
        </ActionPanel>
      }
    />
  );
}
