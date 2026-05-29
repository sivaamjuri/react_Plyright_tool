'use strict';

const { createClient } = require('@supabase/supabase-js');

/**
 * Optional Supabase Storage offload for compare screenshots.
 * Enable with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY + SUPABASE_STORAGE_BUCKET (server .env only).
 */

function isEnabled() {
    const u = (process.env.SUPABASE_URL || '').trim();
    const k = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
    const b = (process.env.SUPABASE_STORAGE_BUCKET || '').trim();
    return Boolean(u && k && b);
}

function getExpiresSec() {
    const d = parseInt(process.env.SUPABASE_SIGNED_URL_EXPIRES_SEC || '', 10);
    return Number.isFinite(d) && d >= 120 ? d : 7 * 24 * 3600;
}

function omitBase64() {
    const v = (process.env.SUPABASE_STORAGE_OMIT_BASE64 || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function dataUrlToBuffer(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    if (!dataUrl.startsWith('data:')) return null;
    const i = dataUrl.indexOf(',');
    if (i === -1) return null;
    try {
        return Buffer.from(dataUrl.slice(i + 1), 'base64');
    } catch {
        return null;
    }
}

async function uploadPng(supabase, bucket, objectPath, buffer) {
    const { error } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
        contentType: 'image/png',
        upsert: true,
    });
    if (error) throw error;
}

async function signedUrlFor(supabase, bucket, objectPath, expiresIn) {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(objectPath, expiresIn);
    if (error) throw error;
    return data.signedUrl;
}

/**
 * Uploads per-page PNGs from pageResults (data URLs) to Storage.
 * Deduplicates solution images per run using solutionUrlCache keyed by screenshot file name.
 *
 * @param {object} params
 * @param {string} params.runId
 * @param {string} params.stuId e.g. student_0
 * @param {string[]} params.routes e.g. ['/']
 * @param {Record<string, { score: string, solutionImage?: string, studentImage?: string, diffImage?: string }>} params.pageResults
 * @param {Record<string, string>} params.solutionUrlCache fileName -> signedUrl (mutated)
 * @returns {Promise<typeof params.pageResults>}
 */
async function uploadComparePageArtifacts(params) {
    const { runId, stuId, routes, pageResults, solutionUrlCache } = params;
    if (!isEnabled()) return pageResults;

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
    });
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;
    const expiresIn = getExpiresSec();
    const stripB64 = omitBase64();

    const updated = stripB64 ? {} : pageResults;

    for (const route of routes) {
        const fileName = route === '/' ? 'index.png' : `${route.replace(/\//g, '')}.png`;
        const pageName = route === '/' ? 'Home Page' : route;
        const pr = pageResults[pageName];
        if (!pr) continue;

        let solutionUrl = solutionUrlCache[fileName];
        const solBuf = dataUrlToBuffer(pr.solutionImage);
        if (!solutionUrl && solBuf) {
            const key = `runs/${runId}/_ref/${fileName}`;
            await uploadPng(supabase, bucket, key, solBuf);
            solutionUrl = await signedUrlFor(supabase, bucket, key, expiresIn);
            solutionUrlCache[fileName] = solutionUrl;
        }

        let studentUrl = pr.studentImage;
        const stuBuf = dataUrlToBuffer(pr.studentImage);
        if (stuBuf) {
            const key = `runs/${runId}/${stuId}/student/${fileName}`;
            await uploadPng(supabase, bucket, key, stuBuf);
            studentUrl = await signedUrlFor(supabase, bucket, key, expiresIn);
        }

        let diffUrl = pr.diffImage;
        const diffBuf = dataUrlToBuffer(pr.diffImage);
        if (diffBuf) {
            const key = `runs/${runId}/${stuId}/diff/${fileName}`;
            await uploadPng(supabase, bucket, key, diffBuf);
            diffUrl = await signedUrlFor(supabase, bucket, key, expiresIn);
        }

        if (stripB64) {
            updated[pageName] = {
                score: pr.score,
                solutionImage: solutionUrl || pr.solutionImage,
                studentImage: studentUrl,
                diffImage: diffUrl,
            };
        }
    }

    return stripB64 ? updated : pageResults;
}

module.exports = {
    isEnabled,
    uploadComparePageArtifacts,
    omitBase64,
};
