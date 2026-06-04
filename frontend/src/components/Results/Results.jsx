import { useState } from 'react';
import * as XLSX from 'xlsx';
import './Results.css';

const ComparisonCard = ({ name, simScore, diffScore, isPass, info }) => {
    const [activeTab, setActiveTab] = useState('student');

    return (
        <div className="comparison-card">
            <div className="card-header">
                <div className="name-box">
                    <span className="route-icon">🔗</span>
                    <h4>{name}</h4>
                    <span className={`status-badge ${isPass ? 'pass' : 'fail'}`}>
                        {isPass ? 'Pass' : 'Fail'}
                    </span>
                </div>
                <div className="score-details">
                    <div className="score-text">
                        <span className="sim-score">Similarity: {simScore}%</span>
                        <span className="diff-score">Difference: {diffScore}%</span>
                    </div>
                    <div className="score-bar-container">
                        <div className="score-bar" style={{ width: `${simScore}%`, backgroundColor: isPass ? '#10b981' : '#ef4444' }} />
                    </div>
                </div>
            </div>

            <div className="tab-container">
                <div className="tab-bar">
                    <button 
                        className={`tab-btn ${activeTab === 'solution' ? 'active' : ''}`}
                        onClick={() => setActiveTab('solution')}
                    >
                        Reference Solution
                    </button>
                    <button 
                        className={`tab-btn ${activeTab === 'student' ? 'active' : ''}`}
                        onClick={() => setActiveTab('student')}
                    >
                        Student Submission
                    </button>
                    <button 
                        className={`tab-btn ${activeTab === 'diff' ? 'active' : ''}`}
                        onClick={() => setActiveTab('diff')}
                    >
                        Visual Difference
                    </button>
                </div>
                
                <div className="unified-viewer">
                    {activeTab === 'solution' && (
                        <div className="viewer-image animate-fade">
                            <img src={info.solutionImage} alt="Solution" />
                        </div>
                    )}
                    {activeTab === 'student' && (
                        <div className="viewer-image animate-fade">
                            <img src={info.studentImage} alt="Student" />
                        </div>
                    )}
                    {activeTab === 'diff' && (
                        <div className="viewer-image diff animate-fade">
                            <img src={info.diffImage} alt="Difference" />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const Results = ({ data }) => {
    const [selectedIndex, setSelectedIndex] = useState(0);

    if (!data || !data.results) return null;

    const currentProject = data.results[selectedIndex];

    // Calculate pages stats
    let pagesTested = 0;
    let passedPages = 0;
    let failedPages = 0;
    let processedPages = [];

    if (currentProject && currentProject.pages) {
        processedPages = Object.entries(currentProject.pages).map(([name, info]) => {
            const simScore = parseFloat(info.score);
            const diffScore = (100 - simScore).toFixed(0);
            const isPass = simScore >= 90; // Defaulting to 90%
            if (isPass) passedPages++;
            else failedPages++;
            return { name, simScore, diffScore, isPass, info };
        });
        pagesTested = processedPages.length;
    }

    return (
        <div className="results-container">
            <div className="batch-summary glass-panel">
                <h2>React project batch results</h2>
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
                            Status: res.status === 'success' ? 'Success' : 'Failed',
                            'Similarity Score': res.status === 'success' ? `${res.overallScore}%` : '0%',
                            Remarks: res.remarks || 'No remarks available.',
                            'Failure / error (if any)': res.status === 'error' ? (res.error || '') : '',
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

                    {currentProject.status === 'success' && (
                        <div className="dashboard-summary">
                            <div className="summary-card">
                                <div className="summary-icon">📄</div>
                                <div className="summary-content">
                                    <div className="summary-title">Total Pages</div>
                                    <div className="summary-value">{pagesTested}</div>
                                </div>
                            </div>
                            <div className="summary-card">
                                <div className="summary-icon pass">✅</div>
                                <div className="summary-content">
                                    <div className="summary-title">Passed Pages</div>
                                    <div className="summary-value pass-text">{passedPages}</div>
                                </div>
                            </div>
                            <div className="summary-card">
                                <div className="summary-icon fail">❌</div>
                                <div className="summary-content">
                                    <div className="summary-title">Failed Pages</div>
                                    <div className="summary-value fail-text">{failedPages}</div>
                                </div>
                            </div>
                            <div className="summary-card">
                                <div className="summary-icon">📊</div>
                                <div className="summary-content">
                                    <div className="summary-title">Overall Score</div>
                                    <div className="summary-value">{currentProject.overallScore}%</div>
                                </div>
                            </div>
                        </div>
                    )}

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
                            {processedPages.map((pageProps, index) => (
                                <ComparisonCard key={index} {...pageProps} />
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default Results;
