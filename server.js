const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const https = require('https');

// ============================================================
// SUPABASE CONFIG - Set these as environment variables on Render
// SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co
// SUPABASE_KEY=your-anon-key-here
// ============================================================
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_KEY environment variables!');
    console.error('   Set them in Render → Your Service → Environment tab');
    process.exit(1);
}

// Minimal Supabase REST API client (no npm packages needed)
function supabaseRequest(method, endpoint, body = null) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(`${SUPABASE_URL}/rest/v1/${endpoint}`);

        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: method,
            headers: {
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=representation'
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = data ? JSON.parse(data) : null;
                    if (res.statusCode >= 400) {
                        reject(new Error(`Supabase error ${res.statusCode}: ${data}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    resolve(data);
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

// ============================================================
// DATABASE FUNCTIONS
// ============================================================

async function getAllJobs() {
    try {
        const rows = await supabaseRequest('GET', 'jobs?order=created_at.desc');
        const jobs = {};
        if (Array.isArray(rows)) {
            rows.forEach(row => {
                jobs[row.job_id] = rowToJob(row);
            });
        }
        return jobs;
    } catch (err) {
        console.error('getAllJobs error:', err.message);
        return {};
    }
}

async function getJob(jobId) {
    try {
        const rows = await supabaseRequest('GET', `jobs?job_id=eq.${encodeURIComponent(jobId)}`);
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return rowToJob(rows[0]);
    } catch (err) {
        console.error('getJob error:', err.message);
        return null;
    }
}

function rowToJob(row) {
    return {
        id: row.job_id,
        name: row.name,
        startTime: row.start_time,
        segments: row.segments,
        delays: row.delays || [],
        nextSegmentId: row.next_segment_id,
        createdAt: row.created_at,
        lastUpdated: row.last_updated,
        expiresAt: row.expires_at
    };
}

function calculateExpiresAt(job) {
    if (!job.startTime) return null;
    const startTime = new Date(job.startTime);
    let totalMinutes = 0;
    if (Array.isArray(job.segments)) {
        job.segments.forEach(s => { totalMinutes += s.duration || 0; });
    }
    const totalDelays = Array.isArray(job.delays)
        ? job.delays.reduce((sum, d) => sum + (d.minutes || 0), 0)
        : 0;
    // Expires 24 hours after estimated end time
    const expiresAt = new Date(startTime.getTime() + (totalMinutes + totalDelays + 24 * 60) * 60000);
    return expiresAt.toISOString();
}

async function createJob(job) {
    try {
        const row = {
            job_id: job.id,
            name: job.name,
            start_time: job.startTime,
            segments: job.segments,
            delays: job.delays || [],
            next_segment_id: job.nextSegmentId || 6,
            created_at: job.createdAt || new Date().toISOString(),
            last_updated: new Date().toISOString(),
            expires_at: calculateExpiresAt(job)
        };
        await supabaseRequest('POST', 'jobs', row);
        return job;
    } catch (err) {
        console.error('createJob error:', err.message);
        return null;
    }
}

async function updateJob(jobId, job) {
    try {
        const row = {
            name: job.name,
            start_time: job.startTime,
            segments: job.segments,
            delays: job.delays || [],
            next_segment_id: job.nextSegmentId || 6,
            last_updated: new Date().toISOString(),
            expires_at: calculateExpiresAt(job)
        };
        await supabaseRequest('PATCH', `jobs?job_id=eq.${encodeURIComponent(jobId)}`, row);
        return { ...job, lastUpdated: row.last_updated };
    } catch (err) {
        console.error('updateJob error:', err.message);
        return null;
    }
}

async function deleteJob(jobId) {
    try {
        await supabaseRequest('DELETE', `jobs?job_id=eq.${encodeURIComponent(jobId)}`);
        return true;
    } catch (err) {
        console.error('deleteJob error:', err.message);
        return false;
    }
}

async function cleanupExpiredJobs() {
    try {
        const now = new Date().toISOString();
        await supabaseRequest('DELETE', `jobs?expires_at=lt.${now}&expires_at=not.is.null`);
        console.log(`🧹 Cleanup ran at ${now}`);
    } catch (err) {
        console.error('Cleanup error:', err.message);
    }
}

// Run cleanup every hour
setInterval(cleanupExpiredJobs, 60 * 60 * 1000);
cleanupExpiredJobs();

// ============================================================
// HTTP SERVER
// ============================================================

const setCORSHeaders = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

const getMimeType = (filepath) => {
    const ext = path.extname(filepath).toLowerCase();
    return { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[ext] || 'text/plain';
};

const serveStaticFile = (filepath, res) => {
    fs.readFile(filepath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': getMimeType(filepath) });
        res.end(data);
    });
};

const readBody = (req) => new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
});

const server = http.createServer(async (req, res) => {
    setCORSHeaders(res);

    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const pathname = url.parse(req.url).pathname;

    try {
        if (pathname === '/' || pathname === '/index.html') {
            serveStaticFile(path.join(__dirname, 'road-surfacing-tracker-realtime.html'), res);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/jobs') {
            const jobs = await getAllJobs();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(jobs));
            return;
        }

        if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
            const jobId = pathname.split('/')[3];
            const job = await getJob(jobId);
            if (job) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(job));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Job not found' }));
            }
            return;
        }

        if (req.method === 'POST' && pathname === '/api/jobs') {
            const job = await readBody(req);
            const created = await createJob(job);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(created));
            return;
        }

        if (req.method === 'PUT' && pathname.startsWith('/api/jobs/')) {
            const jobId = pathname.split('/')[3];
            const job = await readBody(req);
            const updated = await updateJob(jobId, job);
            if (updated) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(updated));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Job not found' }));
            }
            return;
        }

        if (req.method === 'DELETE' && pathname.startsWith('/api/jobs/')) {
            const jobId = pathname.split('/')[3];
            await deleteJob(jobId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        if (req.method === 'POST' && pathname === '/api/cleanup') {
            await cleanupExpiredJobs();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));

    } catch (err) {
        console.error('Request error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`✅ Supabase: ${SUPABASE_URL}`);
    console.log(`✅ Data persists across restarts`);
    console.log(`🧹 Auto-cleanup of expired jobs enabled`);
});
