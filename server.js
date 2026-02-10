const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Simple in-memory database with persistence
class JobDatabase {
    constructor() {
        this.dbPath = path.join(__dirname, 'jobs.json');
        this.jobs = this.loadJobs();
        this.startCleanupScheduler();
    }

    loadJobs() {
        try {
            if (fs.existsSync(this.dbPath)) {
                const data = fs.readFileSync(this.dbPath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error('Error loading jobs:', error);
        }
        return {};
    }

    saveJobs() {
        try {
            fs.writeFileSync(this.dbPath, JSON.stringify(this.jobs, null, 2));
        } catch (error) {
            console.error('Error saving jobs:', error);
        }
    }

    calculateEndTime(job) {
        if (!job.startTime) return null;
        
        const startTime = new Date(job.startTime);
        let totalMinutes = 0;
        
        job.segments.forEach(segment => {
            totalMinutes += segment.duration;
        });
        
        // Add delays
        const totalDelayMinutes = job.delays ? 
            job.delays.reduce((sum, delay) => sum + delay.minutes, 0) : 0;
        
        const endTime = new Date(startTime.getTime() + (totalMinutes + totalDelayMinutes) * 60000);
        return endTime;
    }

    shouldDelete(job) {
        const endTime = this.calculateEndTime(job);
        if (!endTime) return false;
        
        // Delete 24 hours after estimated end time
        const deletionTime = new Date(endTime.getTime() + (24 * 60 * 60 * 1000));
        const now = new Date();
        
        return now >= deletionTime;
    }

    cleanup() {
        let deletedCount = 0;
        const jobIds = Object.keys(this.jobs);
        
        jobIds.forEach(jobId => {
            if (this.shouldDelete(this.jobs[jobId])) {
                console.log(`Deleting expired job: ${this.jobs[jobId].name} (${jobId})`);
                delete this.jobs[jobId];
                deletedCount++;
            }
        });
        
        if (deletedCount > 0) {
            this.saveJobs();
            console.log(`Cleanup complete: ${deletedCount} jobs deleted`);
        }
        
        return deletedCount;
    }

    startCleanupScheduler() {
        // Run cleanup every hour
        setInterval(() => {
            console.log('Running scheduled cleanup...');
            this.cleanup();
        }, 60 * 60 * 1000); // Every hour
        
        // Also run cleanup on startup
        console.log('Running initial cleanup...');
        this.cleanup();
    }

    getAllJobs() {
        return this.jobs;
    }

    getJob(jobId) {
        return this.jobs[jobId] || null;
    }

    createJob(job) {
        this.jobs[job.id] = job;
        this.saveJobs();
        return job;
    }

    updateJob(jobId, job) {
        if (this.jobs[jobId]) {
            job.lastUpdated = new Date().toISOString();
            this.jobs[jobId] = job;
            this.saveJobs();
            return job;
        }
        return null;
    }

    deleteJob(jobId) {
        if (this.jobs[jobId]) {
            delete this.jobs[jobId];
            this.saveJobs();
            return true;
        }
        return false;
    }
}

const db = new JobDatabase();

// CORS headers
const setCORSHeaders = (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
};

// Get MIME type for file
const getMimeType = (filepath) => {
    const ext = path.extname(filepath).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    };
    return mimeTypes[ext] || 'application/octet-stream';
};

// Serve static files
const serveStaticFile = (filepath, res) => {
    fs.readFile(filepath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }
        res.writeHead(200, { 'Content-Type': getMimeType(filepath) });
        res.end(data);
    });
};

// Simple router
const server = http.createServer((req, res) => {
    setCORSHeaders(res);

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url);
    const pathname = parsedUrl.pathname;

    // Serve HTML file at root
    if (pathname === '/' || pathname === '/index.html') {
        const htmlPath = path.join(__dirname, 'road-surfacing-tracker-realtime.html');
        serveStaticFile(htmlPath, res);
        return;
    }

    // GET /api/jobs - Get all jobs
    if (req.method === 'GET' && pathname === '/api/jobs') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(db.getAllJobs()));
        return;
    }

    // GET /api/jobs/:id - Get specific job
    if (req.method === 'GET' && pathname.startsWith('/api/jobs/')) {
        const jobId = pathname.split('/')[3];
        const job = db.getJob(jobId);
        
        if (job) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(job));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Job not found' }));
        }
        return;
    }

    // POST /api/jobs - Create new job
    if (req.method === 'POST' && pathname === '/api/jobs') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const job = JSON.parse(body);
                const created = db.createJob(job);
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(created));
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // PUT /api/jobs/:id - Update job
    if (req.method === 'PUT' && pathname.startsWith('/api/jobs/')) {
        const jobId = pathname.split('/')[3];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const job = JSON.parse(body);
                const updated = db.updateJob(jobId, job);
                
                if (updated) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(updated));
                } else {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Job not found' }));
                }
            } catch (error) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // DELETE /api/jobs/:id - Delete job
    if (req.method === 'DELETE' && pathname.startsWith('/api/jobs/')) {
        const jobId = pathname.split('/')[3];
        const deleted = db.deleteJob(jobId);
        
        if (deleted) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Job not found' }));
        }
        return;
    }

    // POST /api/cleanup - Manual cleanup trigger
    if (req.method === 'POST' && pathname === '/api/cleanup') {
        const deletedCount = db.cleanup();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: deletedCount }));
        return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('API Endpoints:');
    console.log('  GET    /api/jobs       - Get all jobs');
    console.log('  GET    /api/jobs/:id   - Get specific job');
    console.log('  POST   /api/jobs       - Create new job');
    console.log('  PUT    /api/jobs/:id   - Update job');
    console.log('  DELETE /api/jobs/:id   - Delete job');
    console.log('  POST   /api/cleanup    - Manual cleanup');
    console.log('\nAuto-cleanup runs every hour');
    console.log('Jobs are deleted 24 hours after estimated end time\n');
});
