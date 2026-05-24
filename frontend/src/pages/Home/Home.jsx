import { useState } from "react";
import UploadForm from "../../components/UploadForm/UploadForm";
import Results from "../../components/Results/Results";
import "./Home.css";

const MAX_STUDENT_PROJECTS = 10;

const Home = () => {
  const [results, setResults] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [progress, setProgress] = useState({
    current: 0,
    total: 0,
    message: "",
    type: "idle",
    completedStudents: [],
    pipelineEvents: [],
  });

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
    formData.append("solution", solutionFile);
    studentFiles.forEach((file) => formData.append("student", file));
    if (excelFile) formData.append("studentExcel", excelFile);

    try {
      const baseUrl = (
        import.meta.env.VITE_API_URL || "http://localhost:3000"
      ).replace(/\/$/, "");
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
      const message =
        error?.message === "Failed to fetch"
          ? "Cannot reach backend. Make sure API is running and VITE_API_URL points to a valid URL."
          : error.message;
      alert(`Error: ${message}`);
    } finally {
      setIsLoading(false);
      setProgress((prev) => ({ ...prev, type: "idle" }));
    }
  };

  return (
    <div
      className={`home-container${!results ? " home-container--landing" : ""}`}
    >
      <div className="home-container__glow" aria-hidden />

      {!results ? (
        <div className="landing-layout">
          <div className="landing-heading-band">
            <h1 className="hero__title hero__title--landing-band">
              <span className="hero__title-line">
                <span className="hero__title-accent">R</span>eact{" "}
                <span className="hero__title-accent">U</span>I{" "}
                <span className="hero__title-accent">V</span>alidator
              </span>
            </h1>
          </div>

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

            <div className="hero-notice" role="note">
              <span className="hero-notice__mark" aria-hidden>
                i
              </span>
              <div className="hero-notice__body">
                <span className="hero-notice__label">Operational note</span>
                <p className="hero-notice__text">
                  This workspace processes{" "}
                  <strong>up to {MAX_STUDENT_PROJECTS} student projects</strong>{" "}
                  per batch. Split larger cohorts into multiple runs to keep
                  validation fast, stable, and within platform limits.
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
          <header className="hero hero--compact">
            <h1 className="hero__title hero__title--compact">
              <span className="hero__title-accent">R</span>eact{" "}
              <span className="hero__title-accent">U</span>I{" "}
              <span className="hero__title-accent">V</span>alidator
            </h1>
          </header>

          <main className="main-content">
            <div className="results-wrapper">
              <Results data={results} />
              <button className="reset-btn" onClick={() => setResults(null)}>
                Upload New Project
              </button>
            </div>
          </main>
        </>
      )}
    </div>
  );
};

export default Home;
