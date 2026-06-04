import { useState } from 'react';
import * as XLSX from 'xlsx';
import './Results.css';

/* ─── Per-screen comparison card ─────────────────────────────────────── */
const ComparisonCard = ({ name, simScore, diffScore, isPass, info }) => {
    const [activeTab, setActiveTab] = useState('student');

    const scoreColor = isPass ? '#10b981' : simScore >= 70 ? '#f59e0b' : '#ef4444';

    return (
        <div className="comparison-card">
            {/* Card Header */}
            <div className="card-header">
                <div className="card-title-row">
                    <div className="route-pill">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                        </svg>
                        <span>{name}</span>
                    </div>
                    <span className={`accuracy-chip ${isPass ? 'chip-pass' : simScore >= 70 ? 'chip-warn' : 'chip-fail'}`}>
                        {simScore}% match
                    </span>
                </div>

                {/* Progress bar */}
                <div className="card-progress-track">
                    <div
                        className="card-progress-fill"
                        style={{ width: `${simScore}%`, background: scoreColor }}
                    />
                </div>
                <div className="card-score-row">
                    <span className="score-detail-text" style={{ color: '#34d399' }}>Similarity {simScore}%</span>
                    <span className="score-detail-text" style={{ color: '#f87171' }}>Difference {diffScore}%</span>
                    <span className={`status-pill ${isPass ? 'status-pass' : 'status-fail'}`}>
                        {isPass ? 'Pass' : 'Fail'}
                    </span>
                </div>
            </div>

            {/* Tab Navigator */}
            <div className="img-tab-bar">
                {[
                    { key: 'solution', label: 'Reference' },
                    { key: 'student',  label: 'Submission' },
                    { key: 'diff',     label: 'Diff View' },
                ].map(({ key, label }) => (
                    <button
                        key={key}
                        className={`img-tab-btn ${activeTab === key ? 'active' : ''}`}
                        onClick={() => setActiveTab(key)}
                    >
                        {label}
                    </button>
                ))}
            </div>

            {/* Image Viewer */}
            <div className={`img-viewer-frame ${activeTab === 'diff' ? 'diff-mode' : ''}`}>
                {activeTab === 'solution' && (
                    <img className="viewer-img animate-fade" src={info.solutionImage} alt="Reference solution" />
                )}
                {activeTab === 'student' && (
                    <img className="viewer-img animate-fade" src={info.studentImage} alt="Student submission" />
                )}
                {activeTab === 'diff' && (
                    <img className="viewer-img animate-fade" src={info.diffImage} alt="Visual diff" />
                )}
            </div>
        </div>
    );
};

/* ─── Root Results Component ──────────────────────────────────────────── */
const Results = ({ data }) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    if (!data || !data.results) return null;

    const currentProject = data.results[selectedIndex];

    /* Compute per-project page stats */
    let pagesTested = 0, passedPages = 0, failedPages = 0;
    let processedPages = [];

    if (currentProject?.pages) {
        processedPages = Object.entries(currentProject.pages).map(([name, info]) => {
            const simScore  = parseFloat(info.score);
            const diffScore = (100 - simScore).toFixed(0);
            const isPass    = simScore >= 90;
            if (isPass) passedPages++; else failedPages++;
            return { name, simScore, diffScore, isPass, info };
        });
        pagesTested = processedPages.length;
    }

    const overallScore = currentProject?.overallScore ?? 0;

    /* Excel export */
    const handleDownload = () => {
        const excelData = data.results.map(res => ({
            'Student Name'           : res.studentName,
            'GitHub Repository'      : res.repoUrl || 'N/A',
            'Status'                 : res.status === 'success' ? 'Success' : 'Failed',
            'Similarity Score'       : res.status === 'success' ? `${res.overallScore}%` : '0%',
            'Remarks'                : res.remarks || 'No remarks available.',
            'Failure / error (if any)': res.status === 'error' ? (res.error || '') : '',
        }));
        const ws = XLSX.utils.json_to_sheet(excelData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Evaluation Results');
        XLSX.writeFile(wb, `Evaluation_Report_${Date.now()}.xlsx`);
    };

    return (
        <div className="results-container">

            {/* ── LEFT SIDEBAR ─────────────────────────────── */}
            <aside className="batch-sidebar glass-panel">
                <div className="sidebar-header">
                    <h2 className="sidebar-title">Batch Results</h2>
                    <span className="sidebar-count">{data.results.length} project{data.results.length !== 1 ? 's' : ''}</span>
                </div>

                <div className="sidebar-meta">
                    <span className="meta-label">Total Run Time</span>
                    <span className="meta-value">{data.timings?.overall ?? '—'}</span>
                </div>

                <button className="download-excel-btn" onClick={handleDownload}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Export Excel Report
                </button>

                <div className="projects-list">
                    {data.results.map((res, idx) => (
                        <div
                            key={idx}
                            className={`project-tab ${selectedIndex === idx ? 'active' : ''} ${res.status === 'error' ? 'tab-error' : ''}`}
                            onClick={() => setSelectedIndex(idx)}
                        >
                            <span className="p-name">{res.studentName}</span>
                            {res.status === 'success' ? (
                                <span className="p-score">{res.overallScore}%</span>
                            ) : (
                                <span className="p-error-tag">Error</span>
                            )}
                        </div>
                    ))}
                </div>
            </aside>

            {/* ── RIGHT DETAIL PANEL ───────────────────────── */}
            {currentProject && (
                <main className="detail-panel glass-panel">

                    {/* Panel Header */}
                    <div className="panel-header">
                        <div className="panel-title-block">
                            <span className="panel-eyebrow">Detailed Report</span>
                            <h3 className="panel-student-name">{currentProject.studentName}</h3>
                        </div>

                        {currentProject.status === 'success' && (
                            <div className="accuracy-ring-wrap">
                                <svg viewBox="0 0 36 36" className="ring-svg">
                                    <path className="ring-bg"   d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                    <path
                                        className="ring-fill"
                                        style={{
                                            strokeDasharray : `${overallScore}, 100`,
                                            stroke          : overallScore >= 90 ? '#10b981' : overallScore >= 70 ? '#f59e0b' : '#ef4444'
                                        }}
                                        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                                    />
                                    <text x="18" y="20.35" className="ring-pct">{overallScore}%</text>
                                </svg>
                                <span className="ring-label">Match Accuracy</span>
                            </div>
                        )}
                    </div>

                    {/* ── SUMMARY METRIC STRIP ─────────────── */}
                    {currentProject.status === 'success' && (
                        <div className="metrics-strip">
                            <div className="metric-tile metric-analyzed">
                                <span className="metric-label">Screens Analyzed</span>
                                <span className="metric-badge badge-analyzed">{pagesTested}</span>
                            </div>
                            <div className="metric-separator" />
                            <div className="metric-tile metric-passed">
                                <span className="metric-label">Screens Passed</span>
                                <span className="metric-badge badge-passed">{passedPages}</span>
                            </div>
                            <div className="metric-separator" />
                            <div className="metric-tile metric-failed">
                                <span className="metric-label">Screens Failed</span>
                                <span className="metric-badge badge-failed">{failedPages}</span>
                            </div>
                            <div className="metric-separator" />
                            <div className="metric-tile metric-accuracy">
                                <span className="metric-label">Visual Accuracy Score</span>
                                <span className={`metric-badge ${overallScore >= 90 ? 'badge-acc-high' : overallScore >= 70 ? 'badge-acc-mid' : 'badge-acc-low'}`}>
                                    {overallScore}%
                                </span>
                            </div>
                        </div>
                    )}

                    {/* ── SCREEN CARDS ─────────────────────── */}
                    {currentProject.status === 'error' ? (
                        <div className="error-box">
                            <div className="error-icon-wrap">
                                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" />
                                    <line x1="12" y1="8" x2="12" y2="12" />
                                    <line x1="12" y1="16" x2="12.01" y2="16" />
                                </svg>
                            </div>
                            <h4>Analysis Failed</h4>
                            <p>{currentProject.error}</p>
                        </div>
                    ) : (
                        <div className="screens-grid">
                            {processedPages.map((pageProps, index) => (
                                <ComparisonCard key={index} {...pageProps} />
                            ))}
                        </div>
                    )}
                </main>
            )}
        </div>
    );
};

export default Results;
