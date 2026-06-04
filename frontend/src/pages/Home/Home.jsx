import { useCallback, useEffect, useState } from "react";
import UploadForm from "../../components/UploadForm/UploadForm";
import Results from "../../components/Results/Results";
import "./Home.css";

const MAX_STUDENT_PROJECTS = 10;

const getApiBaseUrl = () =>
  (import.meta.env.VITE_API_URL || "http://localhost:3000").replace(/\/$/, "");

const DISK_HINT =
  "Deletes backend/temp job folders and leftover uploads, and runs pm2 flush when available. Requires CLEANUP_DISK_SECRET on the API.";

const DISK_REACT_HOST_NOTE =
  "The React development team that owns this product is responsible for server capacity and disk hygiene on the environments they run. Set CLEANUP_DISK_SECRET in each API host’s backend .env so this cleanup can authenticate.";

const Home = () => {
  const [results, setResults] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cleanupBusy, setCleanupBusy] = useState(false);
  /** Disk cleanup modal: form → loading → done (success or error). */
  const [diskModalOpen, setDiskModalOpen] = useState(false);
  const [diskPhase, setDiskPhase] = useState("idle"); // idle | form | loading | done
  const [diskSecretInput, setDiskSecretInput] = useState("");
  const [diskOutcome, setDiskOutcome] = useState(null); // { ok, summary? } | { ok: false, message }
  const [progress, setProgress] = useState({
    current: 0,
    total: 0,
    message: "",
    type: "idle",
    completedStudents: [],
    pipelineEvents: [],
  });

  /** True for the whole /compare request (including after `result` until the stream closes). */
  const compareRunLocked = isLoading;

  const handleAnalyze = async (solutionFile, studentFiles, excelFile) => {
    setIsLoading(true);
    setResults(null);
    setProgress({
      current: 0,
      total: 0,
      message: "Initializing...",
      type: "status",
      completedStudents: [],
      pipelineEvents: [],
    });

    const formData = new FormData();
    // Third argument sets multipart filename so the API always receives originalname (avoids random hex-only names).
    formData.append(
      "solution",
      solutionFile,
      solutionFile.name || "solution.zip"
    );
    studentFiles.forEach((file, idx) => {
      formData.append(
        "student",
        file,
        file.name || `student_${idx + 1}.zip`
      );
    });
    if (excelFile) {
      formData.append(
        "studentExcel",
        excelFile,
        excelFile.name || "students.xlsx"
      );
    }

    const baseUrl = getApiBaseUrl();

    try {
      const isNgrok =
        baseUrl.includes("ngrok-free.dev") || baseUrl.includes("ngrok.io");
      console.log("API URL:", import.meta.env.VITE_API_URL);
      console.log("Final baseUrl:", baseUrl);
      const response = await fetch(`${baseUrl}/compare`, {
        method: "POST",
        headers: isNgrok ? { "ngrok-skip-browser-warning": "true" } : {},
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "Analysis failed");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let accumulated = "";

      /** Batched in one setState per chunk so every project line survives React batching */
      let pipelineBatch = [];
      const flushPipelineBatch = () => {
        if (pipelineBatch.length === 0) return;
        const batch = pipelineBatch;
        pipelineBatch = [];
        setProgress((prev) => ({
          ...prev,
          pipelineEvents: [...(prev.pipelineEvents || []), ...batch],
        }));
      };

      const handleNdjsonLine = (line) => {
        if (!line.trim()) return;
        try {
          const json = JSON.parse(line);
          if (json.type === 'heartbeat') {
            return;
          }
          if (
            json.type === "status" ||
            json.type === "start" ||
            json.type === "progress"
          ) {
            flushPipelineBatch();
            setProgress((prev) => ({
              ...prev,
              message: json.message || prev.message,
              current:
                json.current !== undefined ? json.current : prev.current,
              total: json.total !== undefined ? json.total : prev.total,
              type: json.type,
            }));
          } else if (json.type === "pipeline") {
            pipelineBatch.push({
              projectIndex: json.projectIndex,
              projectTotal: json.projectTotal,
              studentName: json.studentName,
              phase: json.phase,
              message: json.message,
              scope: json.scope,
            });
          } else if (json.type === "student_complete") {
            flushPipelineBatch();
            setProgress((prev) => ({
              ...prev,
              current: prev.current + 1,
              completedStudents: [
                {
                  name: json.studentName,
                  status: json.status,
                  error: json.error,
                  remarks: json.remarks,
                },
                ...prev.completedStudents,
              ],
            }));
          } else if (json.type === "result") {
            flushPipelineBatch();
            setResults(json.data);
          } else if (json.type === "error") {
            flushPipelineBatch();
            throw new Error(json.message);
          }
        } catch (e) {
          if (e instanceof SyntaxError) {
            console.error(
              "Failed to parse stream line (truncated):",
              line.slice(0, 240),
              e
            );
          } else {
            throw e;
          }
        }
      };

      let read;
      while (true) {
        read = await reader.read();
        if (read.value) {
          accumulated += decoder.decode(read.value, {
            stream: !read.done,
          });
        }
        if (read.done) {
          accumulated += decoder.decode();
          break;
        }
        const lines = accumulated.split("\n");
        accumulated = lines.pop() ?? "";
        for (const line of lines) {
          handleNdjsonLine(line);
        }
        flushPipelineBatch();
      }
      {
        const lines = accumulated.split("\n");
        accumulated = lines.pop() ?? "";
        for (const line of lines) {
          handleNdjsonLine(line);
        }
        flushPipelineBatch();
      }
      if (accumulated.trim()) {
        handleNdjsonLine(accumulated);
      }
      flushPipelineBatch();
    } catch (error) {
      console.error(error);
      const failedFetch =
        error?.message === "Failed to fetch" ||
        (error?.name === "TypeError" &&
          /fetch|network|load failed/i.test(String(error?.message || "")));
      const pageOrigin =
        typeof window !== "undefined" ? window.location.origin : "your-site";
      const pageIsHttps =
        typeof window !== "undefined" && window.location.protocol === "https:";
      const apiIsHttp = baseUrl.startsWith("http:");
      const mixed = pageIsHttps && apiIsHttp;
      const message = failedFetch
        ? `Cannot reach backend at ${baseUrl}/compare.${
            mixed
              ? " BROWSER BLOCKS MIXED CONTENT: this page is HTTPS but VITE_API_URL is HTTP. Put HTTPS in front of the API (Nginx + Let’s Encrypt) and set VITE_API_URL to https://…, then redeploy the frontend."
              : ""
          } Otherwise check: CORS_ORIGINS on the server includes ${pageOrigin}; EC2 security group allows TCP 3000; pm2 is online.`
        : error.message;
      alert(`Error: ${message}`);
    } finally {
      setIsLoading(false);
      setProgress((prev) => ({ ...prev, type: "idle" }));
    }
  };

  const closeDiskModal = useCallback(() => {
    setDiskModalOpen(false);
    setDiskPhase("idle");
    setDiskSecretInput("");
    setDiskOutcome(null);
  }, []);

  useEffect(() => {
    if (!diskModalOpen || diskPhase === "loading") return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") closeDiskModal();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [diskModalOpen, diskPhase, closeDiskModal]);

  const runDiskCleanupRequest = async (secret) => {
    const baseUrl = getApiBaseUrl();
    const isNgrok =
      baseUrl.includes("ngrok-free.dev") || baseUrl.includes("ngrok.io");

    const response = await fetch(`${baseUrl}/admin/cleanup-disk`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cleanup-Secret": secret,
        ...(isNgrok ? { "ngrok-skip-browser-warning": "true" } : {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || response.statusText || "Request failed");
    }
    return data.summary || {};
  };

  const submitDiskCleanup = async (secret) => {
    const trimmed = (secret || "").trim();
    if (!trimmed) return;

    setCleanupBusy(true);
    setDiskModalOpen(true);
    setDiskPhase("loading");
    setDiskOutcome(null);

    try {
      const summary = await runDiskCleanupRequest(trimmed);
      setDiskOutcome({ ok: true, summary });
      setDiskPhase("done");
    } catch (e) {
      setDiskOutcome({
        ok: false,
        message: e?.message || String(e),
      });
      setDiskPhase("done");
    } finally {
      setCleanupBusy(false);
    }
  };

  const handleDiskButtonClick = () => {
    if (cleanupBusy || compareRunLocked) return;
    const envSecret = (import.meta.env.VITE_CLEANUP_DISK_SECRET || "").trim();
    if (envSecret) {
      void submitDiskCleanup(envSecret);
    } else {
      setDiskSecretInput("");
      setDiskOutcome(null);
      setDiskPhase("form");
      setDiskModalOpen(true);
    }
  };

  const handleDiskModalSubmit = (e) => {
    e.preventDefault();
    void submitDiskCleanup(diskSecretInput);
  };

  const serverToolbar = (
    <div className="home-chrome" role="toolbar" aria-label="Server utilities">
      <span id="home-chrome-disk-desc" className="home-chrome__sr-only">
        {compareRunLocked
          ? "Free disk cleanup is unavailable while a compare is running."
          : cleanupBusy
            ? "Disk cleanup is in progress."
            : `${DISK_HINT} ${DISK_REACT_HOST_NOTE}`}
      </span>
      <div className="home-chrome__disk-bundle">
        <button
          type="button"
          className="home-chrome__disk"
          onClick={handleDiskButtonClick}
          disabled={compareRunLocked || cleanupBusy}
          aria-describedby="home-chrome-disk-desc"
        >
          <span className="home-chrome__disk-icon" aria-hidden>
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <ellipse cx="12" cy="5" rx="9" ry="3" />
              <path d="M3 5v6c0 1.7 4 3 9 3s9-1.3 9-3V5" />
              <path d="M3 11v6c0 1.7 4 3 9 3s9-1.3 9-3v-6" />
            </svg>
          </span>
          <span className="home-chrome__disk-text">
            {cleanupBusy ? "Cleaning…" : "Free disk"}
          </span>
        </button>
        <div className="home-chrome__tooltip" role="presentation">
          {compareRunLocked ? (
            <p className="home-chrome__tooltip-blocked">
              Unavailable while a compare is running.
            </p>
          ) : cleanupBusy ? (
            <p className="home-chrome__tooltip-blocked">Cleanup in progress…</p>
          ) : (
            <>
              <p className="home-chrome__tooltip-kicker">Server disk cleanup</p>
              <p className="home-chrome__tooltip-body">
                Deletes{" "}
                <code className="home-chrome__tooltip-code">backend/temp</code> job
                folders and leftover uploads, and runs{" "}
                <code className="home-chrome__tooltip-code">pm2 flush</code> when
                available. Requires{" "}
                <code className="home-chrome__tooltip-code">CLEANUP_DISK_SECRET</code>{" "}
                on the API.
              </p>
              <p className="home-chrome__tooltip-aside">{DISK_REACT_HOST_NOTE}</p>
            </>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <div
      className={`home-container${!results ? " home-container--landing" : ""}`}
    >
      <div className="home-container__glow" aria-hidden />

      {/* Global Application Header */}
      <header className="home-results-heading landing-heading-band--title-row">
        <div className="header-title-wrapper">
          <h1 className="hero__title hero__title--compact">
            React Visual Regression
          </h1>
          <span className="header-tagline">Pixel-perfect visual diffing & regression testing</span>
        </div>
        {serverToolbar}
      </header>

      {!results ? (
        <div className="landing-layout">
          <div className="landing-layout__intro">
            <header className="hero hero--landing-split">
              <p className="hero__eyebrow">Enterprise visual QA for React</p>
              <p className="hero__subtitle">
                Automated pixel-perfect validation and visual accuracy scoring for
                React applications.
              </p>
              <p className="hero__supporting">
                Compare reference and candidate builds with screenshot alignment,
                pixel-level UI diffing, and scored accuracy — built for review
                workflows and teaching at scale.
              </p>
            </header>

            <div className="hero-notice warning-alert" role="alert">
              <span className="hero-notice__mark warning-mark" aria-hidden>
                ⚠️
              </span>
              <div className="hero-notice__body">
                <span className="hero-notice__label warning-label">Warning</span>
                <p className="hero-notice__text">
                  Visual comparison results may vary due to browser rendering differences, screen resolution, and device scaling.
                </p>
              </div>
            </div>
          </div>

          <div className="landing-layout__panel">
            <main className="main-content main-content--landing">
              <UploadForm
                onAnalyze={handleAnalyze}
                isLoading={isLoading}
                progress={progress}
                maxStudentProjects={MAX_STUDENT_PROJECTS}
              />
            </main>
          </div>
        </div>
      ) : (
        <>
          <main className="main-content main-content--results">
            <div className="results-wrapper">
              <Results data={results} />
              <button className="reset-btn" onClick={() => setResults(null)}>
                Upload New Project
              </button>
            </div>
          </main>
        </>
      )}

      {diskModalOpen ? (
        <div
          className="disk-modal-overlay"
          role="presentation"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && diskPhase !== "loading") {
              closeDiskModal();
            }
          }}
        >
          <div
            className="disk-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="disk-modal-title"
          >
            {diskPhase === "form" ? (
              <form onSubmit={handleDiskModalSubmit}>
                <h2 id="disk-modal-title" className="disk-modal__title">
                  Server cleanup key
                </h2>
                <p className="disk-modal__lead">
                  Enter the same value as{" "}
                  <code className="disk-modal__code">CLEANUP_DISK_SECRET</code> in
                  the API backend <code className="disk-modal__code">.env</code>.
                </p>
                <label className="disk-modal__label" htmlFor="disk-modal-secret">
                  Secret
                </label>
                <input
                  id="disk-modal-secret"
                  className="disk-modal__input"
                  type="password"
                  autoComplete="off"
                  value={diskSecretInput}
                  onChange={(e) => setDiskSecretInput(e.target.value)}
                  placeholder="Cleanup secret"
                />
                <div className="disk-modal__actions">
                  <button
                    type="button"
                    className="disk-modal__btn disk-modal__btn--ghost"
                    onClick={closeDiskModal}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="disk-modal__btn disk-modal__btn--primary"
                    disabled={!diskSecretInput.trim()}
                  >
                    Run cleanup
                  </button>
                </div>
              </form>
            ) : null}

            {diskPhase === "loading" ? (
              <div className="disk-modal__loading">
                <h2 id="disk-modal-title" className="disk-modal__title">
                  Running cleanup…
                </h2>
                <p className="disk-modal__lead">
                  Contacting the API and clearing temp data. This may take a few
                  seconds.
                </p>
                <div className="disk-modal__spinner" aria-hidden />
              </div>
            ) : null}

            {diskPhase === "done" && diskOutcome ? (
              <div>
                <h2 id="disk-modal-title" className="disk-modal__title">
                  {diskOutcome.ok ? "Cleanup complete" : "Cleanup failed"}
                </h2>
                {diskOutcome.ok ? (
                  <ul className="disk-modal__summary">
                    <li>
                      Temp job folders removed:{" "}
                      <strong>
                        {diskOutcome.summary?.tempEntriesRemoved ?? 0}
                      </strong>
                    </li>
                    <li>
                      Stale upload files removed:{" "}
                      <strong>
                        {diskOutcome.summary?.uploadFilesRemoved ?? 0}
                      </strong>
                    </li>
                    <li>
                      PM2 log flush:{" "}
                      <strong>{String(diskOutcome.summary?.pm2Flush ?? "?")}</strong>
                    </li>
                  </ul>
                ) : (
                  <p className="disk-modal__error" role="alert">
                    {diskOutcome.message}
                  </p>
                )}
                <div className="disk-modal__actions disk-modal__actions--single">
                  <button
                    type="button"
                    className="disk-modal__btn disk-modal__btn--primary"
                    onClick={closeDiskModal}
                  >
                    OK
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Home;
