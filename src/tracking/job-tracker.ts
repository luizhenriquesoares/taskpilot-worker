export type JobStatus = 'queued' | 'running' | 'success' | 'failed';
export type JobStage = 'implement' | 'review' | 'qa';

export interface TrackedJob {
  id: string;
  cardId: string;
  cardName: string;
  project: string;
  stage: JobStage;
  status: JobStatus;
  branch?: string;
  prUrl?: string;
  error?: string;
  costUsd?: number;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
}

const MAX_JOBS = 100;

export class JobTracker {
  private jobs: TrackedJob[] = [];
  private activeJobs = new Map<string, TrackedJob>();

  /** Record a new job starting */
  start(cardId: string, cardName: string, project: string, stage: JobStage): string {
    const id = `${cardId}-${stage}-${Date.now()}`;
    const job: TrackedJob = {
      id,
      cardId,
      cardName,
      project,
      stage,
      status: 'running',
      startedAt: new Date().toISOString(),
    };

    this.activeJobs.set(id, job);
    this.jobs.unshift(job);

    // Keep only last N jobs
    if (this.jobs.length > MAX_JOBS) {
      this.jobs = this.jobs.slice(0, MAX_JOBS);
    }

    return id;
  }

  /** Mark a job as completed */
  complete(id: string, result: { branch?: string; prUrl?: string; costUsd?: number }): void {
    const job = this.activeJobs.get(id);
    if (!job) return;

    job.status = 'success';
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - new Date(job.startedAt).getTime();
    job.branch = result.branch;
    job.prUrl = result.prUrl;
    job.costUsd = result.costUsd;

    this.activeJobs.delete(id);
  }

  /** Mark a job as failed */
  fail(id: string, error: string): void {
    const job = this.activeJobs.get(id);
    if (!job) return;

    job.status = 'failed';
    job.error = error;
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - new Date(job.startedAt).getTime();

    this.activeJobs.delete(id);
  }

  /** Clear all job history */
  clear(): void {
    this.jobs = [];
    this.activeJobs.clear();
  }

  /** Get all jobs (most recent first) */
  getJobs(): TrackedJob[] {
    return this.jobs;
  }

  /** Get active (running) jobs */
  getActiveJobs(): TrackedJob[] {
    return Array.from(this.activeJobs.values());
  }

  /** Get summary stats */
  getStats() {
    const running = this.activeJobs.size;
    const success = this.jobs.filter((j) => j.status === 'success').length;
    const failed = this.jobs.filter((j) => j.status === 'failed').length;
    const totalCostUsd = this.jobs.reduce((sum, j) => sum + (j.costUsd || 0), 0);

    return {
      total: this.jobs.length,
      running,
      success,
      failed,
      totalCostUsd,
      successRate: this.jobs.length > 0 ? Math.round((success / this.jobs.length) * 100) : 0,
      avgTime: this.getAvgTimeByStage(),
      byProject: this.getStatsByProject(),
    };
  }

  /** Average duration per stage (in seconds) */
  getAvgTimeByStage(): { implement: number; review: number; qa: number } {
    const calc = (stage: JobStage): number => {
      const completed = this.jobs.filter((j) => j.stage === stage && j.status === 'success' && j.durationMs);
      if (completed.length === 0) return 0;
      const avg = completed.reduce((sum, j) => sum + (j.durationMs || 0), 0) / completed.length;
      return Math.round(avg / 1000);
    };
    return { implement: calc('implement'), review: calc('review'), qa: calc('qa') };
  }

  /** Stats grouped by project */
  getStatsByProject(): Record<string, { total: number; success: number; failed: number; avgCost: number; avgTime: number }> {
    const projects = new Map<string, TrackedJob[]>();
    for (const job of this.jobs) {
      const list = projects.get(job.project) || [];
      list.push(job);
      projects.set(job.project, list);
    }

    const result: Record<string, { total: number; success: number; failed: number; avgCost: number; avgTime: number }> = {};
    for (const [name, jobs] of projects) {
      const success = jobs.filter((j) => j.status === 'success').length;
      const failed = jobs.filter((j) => j.status === 'failed').length;
      const completed = jobs.filter((j) => j.durationMs);
      const avgCost = jobs.length > 0 ? jobs.reduce((s, j) => s + (j.costUsd || 0), 0) / jobs.length : 0;
      const avgTime = completed.length > 0 ? Math.round(completed.reduce((s, j) => s + (j.durationMs || 0), 0) / completed.length / 1000) : 0;
      result[name] = { total: jobs.length, success, failed, avgCost: Math.round(avgCost * 10000) / 10000, avgTime };
    }
    return result;
  }
}
