import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./FileProcessingModal.css";

const timeStamp = () => {
  const d = new Date();
  const t = d.toLocaleTimeString("en-GB", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${t}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

function inferTag(message) {
  const m = (message || "").toLowerCase();
  if (/fail|error|invalid|blocked|denied/.test(m)) return "WARN";
  if (/complete|success|ready|done|finished/.test(m)) return "SUCCESS";
  if (/extract|upload|process|batch|captur|compar|start|boot|learn|optim/.test(m))
    return "RUNNING";
  return "INIT";
}

function tagClass(tag) {
  switch (tag) {
    case "SUCCESS":
      return "text-emerald-400";
    case "WARN":
      return "text-amber-300";
    case "RUNNING":
      return "text-cyan-300 fp-tag-running";
    default:
      return "text-cyan-400";
  }
}

function tagForPipelinePhase(phase) {
  if (phase === "error") return "WARN";
  if (phase === "complete") return "SUCCESS";
  if (
    phase === "screenshot_saved" ||
    phase === "server_ready" ||
    phase === "compare_page" ||
    phase === "fetch_done"
  ) {
    return "SUCCESS";
  }
  if (phase === "screenshot_failed") return "WARN";
  return "RUNNING";
}

function formatPipelineLine(e) {
  if (e.scope === "reference") {
    return `[Reference] ${e.message || "—"}`;
  }
  const raw = (e.studentName || "submission").replace(/\\/g, "/");
  const base = raw.includes("/") ? raw.split("/").pop() : raw;
  const short =
    base.length > 44 ? `${base.slice(0, 20)}…${base.slice(-20)}` : base;
  const idx =
    e.projectTotal != null &&
    e.projectTotal > 0 &&
    e.projectIndex != null
      ? `Project ${e.projectIndex}/${e.projectTotal}`
      : "Project";
  return `${idx} · ${short} — ${e.message || "—"}`;
}

/**
 * Premium full-screen loading modal: dual-ring spinner, live terminal, gradient progress.
 */
export default function FileProcessingModal({ open, progress, statusLine }) {
  const [lines, setLines] = useState([]);
  const terminalRef = useRef(null);
  const prevSigRef = useRef("");
  const completedLenRef = useRef(0);
  const pipelineIxRef = useRef(0);

  const phase = progress?.message || statusLine || "Preparing workspace…";

  const pct = useMemo(() => {
    const t = progress?.total ?? 0;
    const c = progress?.current ?? 0;
    if (t <= 0) return null;
    return Math.min(100, Math.round((c / t) * 100));
  }, [progress?.current, progress?.total]);

  const pushLine = useCallback((text, forcedTag) => {
    const tag = forcedTag || inferTag(text);
    setLines((prev) => {
      const row = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
        ts: timeStamp(),
        tag,
        text: text || "—",
      };
      return [...prev, row].slice(-120);
    });
  }, []);

  useEffect(() => {
    if (!open) {
      setLines([]);
      prevSigRef.current = "";
      completedLenRef.current = 0;
      pipelineIxRef.current = 0;
      return;
    }
    pipelineIxRef.current = 0;
    setLines([
      {
        id: "boot-1",
        ts: timeStamp(),
        tag: "INIT",
        text: "Secure session established — pipeline armed.",
      },
      {
        id: "boot-2",
        ts: timeStamp(),
        tag: "RUNNING",
        text: "Listening for orchestration events…",
      },
    ]);
    prevSigRef.current = "";
    completedLenRef.current = progress?.completedStudents?.length ?? 0;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const evs = progress?.pipelineEvents;
    if (!evs?.length) return;
    while (pipelineIxRef.current < evs.length) {
      const e = evs[pipelineIxRef.current];
      pipelineIxRef.current += 1;
      pushLine(formatPipelineLine(e), tagForPipelinePhase(e.phase));
    }
  }, [open, progress?.pipelineEvents, pushLine]);

  useEffect(() => {
    if (!open) return;

    const sig = [
      progress?.message,
      progress?.type,
      progress?.current,
      progress?.total,
      statusLine,
    ].join("|");

    if (sig && sig !== prevSigRef.current) {
      prevSigRef.current = sig;
      const msg = progress?.message || statusLine;
      if (msg) pushLine(msg);
    }

    const list = progress?.completedStudents;
    const len = list?.length ?? 0;
    if (len > completedLenRef.current && list[0]) {
      completedLenRef.current = len;
      const last = list[0];
      pushLine(
        `${last.name} → ${last.status === "success" ? "OK" : "FAILED"}${
          last.error ? `: ${last.error}` : ""
        }`,
        last.status === "success" ? "SUCCESS" : "WARN"
      );
    }
  }, [open, progress, statusLine, pushLine]);

  useEffect(() => {
    const el = terminalRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [lines, open]);

  if (!open) return null;

  const modal = (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="fp-modal-title"
    >
      <div
        className="absolute inset-0 bg-[#0f1021]/88 backdrop-blur-md transition-opacity duration-300"
        aria-hidden
      />

      <div className="relative z-[101] w-full max-w-3xl">
        <div className="rounded-2xl bg-gradient-to-br from-[#22d3ee] via-[#4338ca]/90 to-[#0891b2] p-px shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_24px_80px_-12px_rgba(0,0,0,0.65)]">
          <div className="overflow-hidden rounded-[15px] bg-[linear-gradient(165deg,#16172a_0%,#0f1021_48%,#12142c_100%)]">
            <div className="border-b border-white/[0.06] px-6 py-4 sm:px-8 sm:py-5">
              <p
                id="fp-modal-title"
                className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500"
              >
                Secure validation
              </p>
              <h2 className="mt-1 text-lg font-semibold tracking-tight text-slate-100 sm:text-xl">
                Visual validation in progress
              </h2>
            </div>

            <div className="grid grid-cols-1 gap-8 px-6 py-8 sm:px-8 lg:grid-cols-2 lg:gap-10 lg:py-10">
              <div className="flex flex-col items-center justify-center text-center">
                <div className="relative h-28 w-28 shrink-0">
                  <div className="fp-spinner-outer" />
                  <div className="fp-spinner-inner" />
                  <div className="absolute inset-[22px] rounded-full bg-gradient-to-br from-[#22d3ee]/20 to-transparent" />
                </div>
                <p className="fp-phase-text mt-8 max-w-[16rem] text-sm font-medium leading-snug text-slate-200 sm:text-base">
                  {phase}
                </p>
                <p className="mt-2 text-xs text-slate-500">
                  {progress?.total > 0
                    ? `Batch ${progress.current} of ${progress.total}`
                    : "Streaming validation events"}
                </p>
              </div>

              <div className="flex min-h-[220px] flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[#05070a]/95 shadow-inner">
                <div className="flex items-center gap-2 border-b border-white/[0.06] bg-[#080b10] px-3 py-2">
                  <span className="inline-flex gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full bg-[#ff5f57]/90" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#febc2e]/90" />
                    <span className="h-2.5 w-2.5 rounded-full bg-[#28c840]/90" />
                  </span>
                  <span className="ml-2 font-mono text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    validator — zsh
                  </span>
                </div>
                <div
                  ref={terminalRef}
                  className="fp-terminal-cursor max-h-[240px] min-h-[200px] overflow-y-auto overscroll-contain px-3 py-3 font-[JetBrains_Mono,ui-monospace,monospace] text-[11px] leading-relaxed text-slate-300/95 sm:text-xs"
                >
                  {lines.map((line) => (
                    <div key={line.id} className="mb-1.5 break-words">
                      <span className="text-slate-600">{line.ts}</span>{" "}
                      <span className={tagClass(line.tag)}>[{line.tag}]</span>{" "}
                      <span className="text-slate-400">{line.text}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="border-t border-white/[0.05] px-6 py-5 sm:px-8">
              <div className="mb-2 flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-slate-500">
                <span>Overall progress</span>
                <span className="tabular-nums text-slate-400">
                  {pct != null ? `${pct}%` : "In flight"}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className={`fp-progress-fill h-full rounded-full ${pct == null ? "fp-progress-fill--indeterminate" : ""}`}
                  style={
                    pct != null
                      ? { width: `${Math.max(4, pct)}%` }
                      : undefined
                  }
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}
