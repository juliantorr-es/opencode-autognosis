import { getDb } from "../database.js";
import { Logger } from "./logger.js";
import { indexFile, getAllSourceFiles } from "../performance-optimization.js";

const RUN_ID = `worker-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const PID = process.pid;

async function start() {
    Logger.log("Worker", `Starting background supervisor [${RUN_ID}] PID: ${PID}`);
    getDb().registerWorker(PID, RUN_ID, "autognosis-worker");

    // Heartbeat loop
    setInterval(() => {
        getDb().pragma(`UPDATE worker_registry SET last_heartbeat = CURRENT_TIMESTAMP WHERE pid = ${PID}`);
    }, 30000);

    // Process Job Queue
    while (true) {
        try {
            const job = getDb().pragma("SELECT * FROM background_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1") as any;
            if (job) {
                getDb().updateJob(job.id, { status: "running" });
                
                if (job.type === "indexing") {
                    Logger.log("Worker", `Processing indexing job: ${job.id}`);
                    const files = await getAllSourceFiles();
                    let count = 0;
                    for (const f of files) {
                        await indexFile(f);
                        count++;
                        if (count % 10 === 0) {
                            getDb().updateJob(job.id, { progress: Math.round((count / files.length) * 100) });
                        }
                    }
                }
                
                getDb().updateJob(job.id, { status: "completed", progress: 100 });
            }
        } catch (e) {
            Logger.log("Worker", "Job loop error", e);
        }
        await new Promise(r => setTimeout(r, 5000));
    }
}

start().catch(e => Logger.log("Worker", "Fatal error", e));
