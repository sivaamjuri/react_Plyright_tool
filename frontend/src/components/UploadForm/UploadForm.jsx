import { useState } from 'react';
import JSZip from 'jszip';
import './UploadForm.css';

const UploadForm = ({ onAnalyze, isLoading, progress }) => {
    const [solutionFile, setSolutionFile] = useState(null);
    const [studentFiles, setStudentFiles] = useState([]);
    const [excelFile, setExcelFile] = useState(null);
    const [useExcel, setUseExcel] = useState(false);
    const [error, setError] = useState('');
    const [status, setStatus] = useState('');

    // Calculate progress percentage
    const progressPercent = progress && progress.total > 0 
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
                if (!path.includes('node_modules/') &&
                    !path.includes('.git/') &&
                    !path.includes('dist/') &&
                    !zipEntry.dir) {
                    newZip.file(path, zipEntry.async('blob'));
                    count++;
                }
            }

            if (count === 0) return file;

            const content = await newZip.generateAsync({ type: 'blob' });
            return new File([content], file.name, { type: 'application/zip' });
        } catch (e) {
            console.error(`Optimization failed for ${label}, sending original.`, e);
            return file;
        }
    };

    const handleStudentFilesChange = (e) => {
        if (e.target.files.length > 0) {
            setStudentFiles(Array.from(e.target.files));
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (!solutionFile || (studentFiles.length === 0 && !excelFile)) {
            setError('Please select the solution and either student ZIP files or an Excel sheet.');
            return;
        }
        setError('');

        const cleanSolution = await sanitizeZip(solutionFile, 'Solution');
        const cleanStudents = [];

        for (let i = 0; i < studentFiles.length; i++) {
            setStatus(`Optimizing Student ${i + 1}/${studentFiles.length}...`);
            const clean = await sanitizeZip(studentFiles[i], studentFiles[i].name);
            cleanStudents.push(clean);
        }

        setStatus('Uploading data...');
        onAnalyze(cleanSolution, cleanStudents, excelFile);
    };

    return (
        <div className="upload-container glass-panel">
            <h2>Start Batch Comparison</h2>
            <form onSubmit={handleSubmit} className="upload-form">
                <div className="file-input-group">
                    <label>Solution Project (Reference .zip)</label>
                    <input
                        type="file"
                        accept=".zip"
                        onChange={(e) => setSolutionFile(e.target.files[0])}
                        disabled={isLoading}
                    />
                </div>
                <div className="input-toggle">
                    <button
                        type="button"
                        className={!useExcel ? 'active' : ''}
                        onClick={() => setUseExcel(false)}
                    >
                        ZIP Files
                    </button>
                    <button
                        type="button"
                        className={useExcel ? 'active' : ''}
                        onClick={() => setUseExcel(true)}
                    >
                        Excel Sheet
                    </button>
                </div>

                {!useExcel ? (
                    <div className="file-input-group">
                        <label>Student Projects (Select one or more .zip)</label>
                        <input
                            type="file"
                            accept=".zip"
                            multiple
                            onChange={handleStudentFilesChange}
                            disabled={isLoading}
                        />
                        <div className="file-info">
                            {studentFiles.length > 0 && `${studentFiles.length} files selected`}
                        </div>
                    </div>
                ) : (
                    <div className="file-input-group animate-in">
                        <label>Excel Sheet (GitHub Links)</label>
                        <input
                            type="file"
                            accept=".xlsx, .xls"
                            onChange={(e) => setExcelFile(e.target.files[0])}
                            disabled={isLoading}
                        />
                        <div className="file-info">
                            {excelFile && `Selected: ${excelFile.name}`}
                        </div>
                    </div>
                )}

                {error && <div className="error-message">{error}</div>}

                <button type="submit" className={`submit-btn ${isLoading ? 'loading' : ''}`} disabled={isLoading}>
                    <span className="btn-content">
                        {isLoading ? (
                            <div className="progress-details">
                                <div className="status-header">
                                    <span className="status-icon">⚙️</span>
                                    <span className="status-text">{progress.message || status || 'Processing...'}</span>
                                </div>
                                
                                {progress.total > 0 && (
                                    <div className="progress-bar-container">
                                        <div className="progress-bar" style={{ width: `${progressPercent}%` }}></div>
                                        <span className="progress-text">
                                            {progress.current} / {progress.total} Projects Completed ({progressPercent}%)
                                        </span>
                                    </div>
                                )}

                                {progress.completedStudents && progress.completedStudents.length > 0 && (
                                    <div className="completed-list">
                                        {progress.completedStudents.slice(0, 5).map((student, idx) => (
                                            <div key={idx} className={`student-status-item ${student.status}`}>
                                                <span className="student-icon">
                                                    {student.status === 'success' ? '✅' : '❌'}
                                                </span>
                                                <div className="student-info">
                                                    <span className="student-name">{student.name}</span>
                                                    {student.status === 'error' && (
                                                        <span className="student-error">{student.error || 'Unknown error'}</span>
                                                    )}
                                                </div>
                                            </div>
                                        ))}
                                        {progress.completedStudents.length > 5 && (
                                            <div className="more-count">
                                                + {progress.completedStudents.length - 5} more projects completed
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ) : (
                            'Run Bulk Visual Check'
                        )}
                    </span>
                </button>
            </form>
        </div>
    );
};

export default UploadForm;
