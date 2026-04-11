import { useState } from 'react';
import UploadForm from '../../components/UploadForm/UploadForm';
import Results from '../../components/Results/Results';
import './Home.css';

const Home = () => {
    const [results, setResults] = useState(null);
    const [isLoading, setIsLoading] = useState(false);
    const [progress, setProgress] = useState({ current: 0, total: 0, message: '', type: 'idle', completedStudents: [] });

    const handleAnalyze = async (solutionFile, studentFiles, excelFile) => {
        setIsLoading(true);
        setResults(null);
        setProgress({ current: 0, total: 0, message: 'Initializing...', type: 'status', completedStudents: [] });

        const formData = new FormData();
        formData.append('solution', solutionFile);
        studentFiles.forEach(file => formData.append('student', file));
        if (excelFile) formData.append('studentExcel', excelFile);

        try {
            const baseUrl = import.meta.env.VITE_API_URL || 'https://amendment-accustom-unhidden.ngrok-free.dev';
            const response = await fetch(`${baseUrl}/compare`, {
                method: 'POST',
                body: formData,
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || 'Analysis failed');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let accumulated = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                accumulated += decoder.decode(value, { stream: true });
                const lines = accumulated.split('\n');
                accumulated = lines.pop(); // Keep the last partial line

                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const json = JSON.parse(line);
                        if (json.type === 'status' || json.type === 'start' || json.type === 'progress') {
                            setProgress(prev => ({
                                ...prev,
                                message: json.message || prev.message,
                                total: json.total !== undefined ? json.total : prev.total,
                                type: json.type
                            }));
                        } else if (json.type === 'student_complete') {
                            setProgress(prev => ({
                                ...prev,
                                current: prev.current + 1,
                                completedStudents: [
                                    {
                                        name: json.studentName,
                                        status: json.status,
                                        error: json.error,
                                        remarks: json.remarks
                                    },
                                    ...prev.completedStudents
                                ]
                            }));
                        } else if (json.type === 'result') {
                            setResults(json.data);
                        } else if (json.type === 'error') {
                            throw new Error(json.message);
                        }
                    } catch (e) {
                        console.error('Failed to parse stream line:', line, e);
                    }
                }
            }
        } catch (error) {
            console.error(error);
            alert(`Error: ${error.message}`);
        } finally {
            setIsLoading(false);
            setProgress(prev => ({ ...prev, type: 'idle' }));
        }
    };

    return (
        <div className="home-container">
            <header className="hero">
                <h1>Visual UI Checker</h1>
                <p>Compare student submissions against the solution with pixel-perfect accuracy.</p>
            </header>

            <main className="main-content">
                {!results ? (
                    <UploadForm onAnalyze={handleAnalyze} isLoading={isLoading} progress={progress} />
                ) : (
                    <div className="results-wrapper">
                        <Results data={results} />
                        <button className="reset-btn" onClick={() => setResults(null)}>
                            Upload New Project
                        </button>
                    </div>
                )}
            </main>
        </div>
    );
};

export default Home;
