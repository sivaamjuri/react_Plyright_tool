import { useState, useRef } from "react";
import JSZip from "jszip";
import FileProcessingModal from "../FileProcessingModal/FileProcessingModal";
import "./UploadForm.css";

const UploadForm = ({
  onAnalyze,
  isLoading,
  progress,
  maxStudentProjects = 10,
}) => {
  const [solutionFile, setSolutionFile] = useState(null);
  const [studentFiles, setStudentFiles] = useState([]);
  const [excelFile, setExcelFile] = useState(null);
  const [useExcel, setUseExcel] = useState(false);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState("");

  const solutionInputRef = useRef(null);
  const studentInputRef = useRef(null);
  const excelInputRef = useRef(null);

  const hasAnyFile =
    Boolean(solutionFile) || studentFiles.length > 0 || Boolean(excelFile);

  const clearAllSelections = () => {
    setSolutionFile(null);
    setStudentFiles([]);
    setExcelFile(null);
    setError(null);
    if (solutionInputRef.current) solutionInputRef.current.value = "";
    if (studentInputRef.current) studentInputRef.current.value = "";
    if (excelInputRef.current) excelInputRef.current.value = "";
  };

  const progressPercent =
    progress && progress.total > 0
      ? Math.round((progress.current / progress.total) * 100)
      : 0;

  const sanitizeZip = async (file, label) => {
    if (!file) return null;
    setStatus(`Optimizing ${label}...`);

    try {
      const zip = new JSZip();
      const loadedZip = await zip.loadAsync(file);
      const newZip = new JSZip();
      let count = 0;

      for (const [path, zipEntry] of Object.entries(loadedZip.files)) {
        if (
          !path.includes("node_modules/") &&
          !path.includes(".git/") &&
          !path.includes("dist/") &&
          !zipEntry.dir
        ) {
          newZip.file(path, zipEntry.async("blob"));
          count++;
        }
      }

      if (count === 0) return file;

      const content = await newZip.generateAsync({ type: "blob" });
      const safeName =
        (file.name && String(file.name).trim()) || "submission.zip";
      return new File([content], safeName, { type: "application/zip" });
    } catch (e) {
      console.error(`Optimization failed for ${label}, sending original.`, e);
      return file;
    }
  };

  const handleStudentFilesChange = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length > maxStudentProjects) {
      setError(
        <>
          You can upload at most {maxStudentProjects} student{" "}
          <code className="ext-tag">.zip</code> files per batch. Remove extra
          files or run multiple batches.
        </>
      );
      e.target.value = "";
      setStudentFiles([]);
      return;
    }
    setError(null);
    if (files.length > 0) {
      setStudentFiles(files);
    } else {
      setStudentFiles([]);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!solutionFile || (studentFiles.length === 0 && !excelFile)) {
      setError(
        <>
          Please select the solution and either student{" "}
          <code className="ext-tag">.zip</code> files or an Excel sheet.
        </>
      );
      return;
    }
    if (!useExcel && studentFiles.length > maxStudentProjects) {
      setError(
        <>
          You can upload at most {maxStudentProjects} student{" "}
          <code className="ext-tag">.zip</code> files per batch.
        </>
      );
      return;
    }
    setError(null);

    const cleanSolution = await sanitizeZip(solutionFile, "Solution");
    const cleanStudents = [];

    for (let i = 0; i < studentFiles.length; i++) {
      setStatus(`Optimizing Student ${i + 1}/${studentFiles.length}...`);
      const clean = await sanitizeZip(studentFiles[i], studentFiles[i].name);
      cleanStudents.push(clean);
    }

    setStatus("Uploading data...");
    onAnalyze(cleanSolution, cleanStudents, excelFile);
  };

  return (
    <>
      <FileProcessingModal
        open={isLoading}
        progress={progress}
        statusLine={status}
      />
      <div className="upload-container glass-panel">
        <header className="upload-card__header">
          <span className="upload-card__eyebrow">Validation workflow</span>
          <h2 className="upload-card__title">Upload React project builds</h2>
          <p className="upload-card__lede">
            Attach the canonical solution archive, then add student{" "}
            <code className="ext-tag">.zip</code> files or an Excel sheet of
            links. The service returns visual diffs and accuracy scores.
          </p>
        </header>

        <form onSubmit={handleSubmit} className="upload-form" noValidate>
          <div className="upload-form__body">
            <section
              className="upload-card__section"
              aria-labelledby="upload-section-ref"
            >
              <div className="upload-card__section-head">
                <span className="upload-card__step" aria-hidden>
                  1
                </span>
                <div className="upload-card__section-intro">
                  <h3 className="upload-card__section-title" id="upload-section-ref">
                    Reference solution
                  </h3>
                  <p className="upload-card__section-hint">
                    Gold-standard Vite/React{" "}
                    <code className="ext-tag">.zip</code> used as the baseline
                    for every comparison.
                  </p>
                </div>
              </div>
              <div className="upload-field">
                <label className="upload-field__label" htmlFor="upload-solution-zip">
                  Solution archive <code className="ext-tag">.zip</code>
                </label>
                <input
                  id="upload-solution-zip"
                  ref={solutionInputRef}
                  type="file"
                  accept=".zip"
                  onChange={(e) =>
                    setSolutionFile(e.target.files?.[0] ?? null)
                  }
                  disabled={isLoading}
                />
                <p className="upload-field__meta" aria-live="polite">
                  {solutionFile ? solutionFile.name : "No file selected"}
                </p>
              </div>
            </section>

            <div className="upload-form__divider" aria-hidden />

            <section
              className="upload-card__section"
              aria-labelledby="upload-section-candidates"
            >
              <div className="upload-card__section-head">
                <span className="upload-card__step" aria-hidden>
                  2
                </span>
                <div className="upload-card__section-intro">
                  <h3
                    className="upload-card__section-title"
                    id="upload-section-candidates"
                  >
                    Candidate submissions
                  </h3>
                  <p className="upload-card__section-hint">
                    Multiple student <code className="ext-tag">.zip</code> files
                    (max {maxStudentProjects} per batch) or one workbook listing
                    repository URLs.
                  </p>
                </div>
              </div>

              <div className="upload-card__mode">
                <span className="upload-field__label" id="upload-mode-label">
                  Input method
                </span>
                <div
                  className="input-toggle"
                  role="group"
                  aria-labelledby="upload-mode-label"
                >
                  <button
                    type="button"
                    className={!useExcel ? "active" : ""}
                    onClick={() => setUseExcel(false)}
                    aria-pressed={!useExcel}
                  >
                    Project <code className="ext-tag">.zip</code>s
                  </button>
                  <button
                    type="button"
                    className={useExcel ? "active" : ""}
                    onClick={() => setUseExcel(true)}
                    aria-pressed={useExcel}
                  >
                    Excel sheet
                  </button>
                </div>
              </div>

              {!useExcel ? (
                <div className="upload-field">
                  <label
                    className="upload-field__label"
                    htmlFor="upload-student-zips"
                  >
                    Student archives <code className="ext-tag">.zip</code>
                  </label>
                  <input
                    id="upload-student-zips"
                    ref={studentInputRef}
                    type="file"
                    accept=".zip"
                    multiple
                    onChange={handleStudentFilesChange}
                    disabled={isLoading}
                  />
                  <p className="upload-field__meta" aria-live="polite">
                    {studentFiles.length > 0
                      ? `${studentFiles.length} file${studentFiles.length === 1 ? "" : "s"} selected`
                      : "No files selected"}
                  </p>
                </div>
              ) : (
                <div className="upload-field animate-in">
                  <label
                    className="upload-field__label"
                    htmlFor="upload-excel"
                  >
                    Workbook (.xlsx / .xls)
                  </label>
                  <input
                    id="upload-excel"
                    ref={excelInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) =>
                      setExcelFile(e.target.files?.[0] ?? null)
                    }
                    disabled={isLoading}
                  />
                  <p className="upload-field__meta" aria-live="polite">
                    {excelFile ? excelFile.name : "No file selected"}
                  </p>
                </div>
              )}
            </section>
          </div>

          {hasAnyFile && !isLoading && (
            <div className="upload-form__toolbar">
              <button
                type="button"
                className="upload-clear-btn"
                onClick={clearAllSelections}
                aria-label="Remove selected solution ZIP, student ZIPs, and Excel file"
              >
                Clear selections
              </button>
            </div>
          )}

          {error && (
            <div className="error-message" role="alert">
              {error}
            </div>
          )}

          <div className="upload-card__actions">
            <button
              type="submit"
              className={`submit-btn ${isLoading ? "loading" : ""}`}
              disabled={isLoading}
            >
              <span className="btn-content">
                {isLoading ? (
                  <div className="progress-details">
                    <div className="status-header">
                      <span className="status-icon">⚙️</span>
                      <span className="status-text">
                        {progress.message ||
                          status ||
                          "Processing…"}
                      </span>
                    </div>

                    {progress.total > 0 && (
                      <div className="progress-bar-container">
                        <div
                          className="progress-bar"
                          style={{ width: `${progressPercent}%` }}
                        />
                        <span className="progress-text">
                          {progress.current} / {progress.total} completed (
                          {progressPercent}%)
                        </span>
                      </div>
                    )}

                    {progress.completedStudents &&
                      progress.completedStudents.length > 0 && (
                        <div className="completed-list">
                          {progress.completedStudents
                            .slice(0, 5)
                            .map((student, idx) => (
                              <div
                                key={idx}
                                className={`student-status-item ${student.status}`}
                              >
                                <span className="student-icon">
                                  {student.status === "success"
                                    ? "✅"
                                    : "❌"}
                                </span>
                                <div className="student-info">
                                  <span className="student-name">
                                    {student.name}
                                  </span>
                                  {student.status === "error" && (
                                    <span className="student-error">
                                      {student.error || "Unknown error"}
                                    </span>
                                  )}
                                </div>
                              </div>
                            ))}
                          {progress.completedStudents.length > 5 && (
                            <div className="more-count">
                              +
                              {progress.completedStudents.length - 5} more
                              completed
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                ) : (
                  "Run validation"
                )}
              </span>
            </button>
          </div>
        </form>
      </div>
    </>
  );
};

export default UploadForm;
