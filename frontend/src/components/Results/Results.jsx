import { useState } from 'react';
import * as XLSX from 'xlsx';
import './Results.css';

const Results = ({ data }) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    if (!data || !data.results) return null;

    const currentProject = data.results[selectedIndex];

    return (
        <div className="results-container">
            <div className="batch-summary glass-panel">
                <h2>Batch Analysis Results</h2>
                <div className="overall-stats">
                    <div className="stat-card">
                        <span className="label">Total Projects</span>
                        <span className="value">{data.results.length}</span>
                    </div>
                    <div className="stat-card">
                        <span className="label">Total Run Time</span>
                        <span className="value">{data.timings.overall}</span>
                    </div>
                </div>

                <button 
                    className="download-excel-btn"
                    onClick={() => {
                        const excelData = data.results.map(res => ({
                            'Student Name': res.studentName,
                            'GitHub Repository': res.repoUrl || 'N/A',
                            'Similarity Score': res.status === 'success' ? `${res.overallScore}%` : '0%',
                            'Remarks': res.remarks || 'No remarks available.'
                        }));

                        const ws = XLSX.utils.json_to_sheet(excelData);
                        const wb = XLSX.utils.book_new();
                        XLSX.utils.book_append_sheet(wb, ws, "Evaluation Results");
                        XLSX.writeFile(wb, `Evaluation_Report_${Date.now()}.xlsx`);
                    }}
                >
                    <span className="icon">📥</span> Download Excel Report
                </button>

                <div className="projects-list">
                    {data.results.map((res, idx) => (
                        <div
                            key={idx}
                            className={`project-tab ${selectedIndex === idx ? 'active' : ''} ${res.status === 'error' ? 'error' : ''}`}
                            onClick={() => setSelectedIndex(idx)}
                        >
                            <span className="p-name">{res.studentName}</span>
                            {res.status === 'success' ? (
                                <span className="p-score">{res.overallScore}%</span>
                            ) : (
                                <span className="p-error">Failed</span>
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {currentProject && (
                <div className="detail-view glass-panel">
                    <div className="project-header">
                        <div className="header-text">
                            <span className="badge">Detailed Report</span>
                            <h3>{currentProject.studentName}</h3>
                        </div>
                        {currentProject.status === 'success' && (
                            <div className="big-score-card">
                                <div className="score-circle">
                                    <svg viewBox="0 0 36 36" className="circular-chart">
                                        <path className="circle-bg" d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                        <path className="circle" style={{ strokeDasharray: `${currentProject.overallScore}, 100` }} d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" />
                                        <text x="18" y="20.35" className="percentage">{currentProject.overallScore}%</text>
                                    </svg>
                                </div>
                                <span className="score-label">Match Accuracy</span>
                            </div>
                        )}
                    </div>

                    {currentProject.timings && (
                        <div className="timings-grid">
                            <div className="timing-item">
                                <span className="t-label">Unzip</span>
                                <span className="t-value">{currentProject.timings.unzip || '0.00s'}</span>
                            </div>
                            <div className="timing-item">
                                <span className="t-label">Setup</span>
                                <span className="t-value">{currentProject.timings.setup}</span>
                            </div>
                            <div className="timing-item">
                                <span className="t-label">Capture</span>
                                <span className="t-value">{currentProject.timings.screenshot}</span>
                            </div>
                            <div className="timing-item">
                                <span className="t-label">Compare</span>
                                <span className="t-value">{currentProject.timings.comparison}</span>
                            </div>
                            <div className="timing-item total">
                                <span className="t-label">Total</span>
                                <span className="t-value">{currentProject.timings.total}</span>
                            </div>
                        </div>
                    )}

                    {currentProject.status === 'error' ? (
                        <div className="error-box">
                            <div className="error-icon">⚠️</div>
                            <h4>Analysis Failed</h4>
                            <p>{currentProject.error}</p>
                        </div>
                    ) : (
                        <div className="comparison-stack">
                            {Object.entries(currentProject.pages).map(([name, info], index) => (
                                <div key={index} className="comparison-card">
                                    <div className="card-header">
                                        <div className="name-box">
                                            <span className="route-icon">🔗</span>
                                            <h4>{name}</h4>
                                        </div>
                                        <div className="mini-score">{info.score}% match</div>
                                    </div>

                                    <div className="visual-grid">
                                        <div className="view-container">
                                            <div className="view-label">Reference Solution</div>
                                            <div className="image-wrapper">
                                                <img src={`http://127.0.0.1:3000${info.solutionImage}`} alt="Solution" />
                                            </div>
                                        </div>

                                        <div className="view-container student">
                                            <div className="view-label">Student Submission</div>
                                            <div className="image-wrapper">
                                                <img src={`http://127.0.0.1:3000${info.studentImage}`} alt="Student" />
                                            </div>
                                        </div>

                                        <div className="view-container diff">
                                            <div className="view-label">Visual Difference</div>
                                            <div className="image-wrapper">
                                                <img src={`http://127.0.0.1:3000${info.diffImage}`} alt="Difference" />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default Results;
