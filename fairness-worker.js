// fairness-worker.js 
// Supports: init (building data), cancel, start messages
// Input:  { sinrPoints: [{position, sinr}], totalBandwidth: number }
// Output: { throughputMap, loadMap, congestionMap, fairnessValue, avgThroughput,
//           pointsAnalyzed, congestedPercent, stats, satisfaction, distribution,
//           minThroughput, p5Throughput, criticalCount, efficiencyScore, insightText }

class FairnessWorker {
    constructor() {
        this.buildingData = null;  
        this.isCancelled  = false;
        self.addEventListener('message', this.handleMessage.bind(this));
    }

    handleMessage(e) {
        const { type, data, taskId } = e.data;
        if (type === 'init')   { this.buildingData = data.buildingData; return; }
        if (type === 'cancel') { this.isCancelled = true;  return; }
        if (type === 'start')  { this.isCancelled = false; this.startAnalysis(data, taskId); }
    }

    async startAnalysis(data, taskId) {
        try {
            const { sinrPoints = [], totalBandwidth = 100 } = data;

            if (!Array.isArray(sinrPoints) || sinrPoints.length === 0) {
                self.postMessage({
                    type: 'error',
                    taskId,
                    data: 'No SINR points provided for fairness analysis'
                });
                return;
            }

            const throughputMap  = [];
            const loadMap        = [];
            const congestionMap  = [];
            const throughputValues = [];

            let sumThroughput   = 0;
            let sumThroughputSq = 0;
            let congestedCount  = 0;

            const stats        = { underloaded: 0, balanced: 0, overloaded: 0 };
            const satisfaction = { good: 0, moderate: 0, poor: 0 };
            const distribution = { high: 0, medium: 0, low: 0 };
            let   criticalCount = 0;

            const totalPoints   = sinrPoints.length;
            const CHUNK         = 200;

            for (let i = 0; i < sinrPoints.length; i++) {
                if (this.isCancelled) throw new Error('Analysis cancelled');

                const { position, sinr } = sinrPoints[i];

                // Random user count per location: 5–50
                const users        = Math.floor(Math.random() * 46) + 5;
                const baseThroughput = totalBandwidth / users;

                // Spectral efficiency based on SINR
                let efficiency = 0.1;
                if      (sinr > 20) efficiency = 1.0;
                else if (sinr >= 10) efficiency = 0.7;
                else if (sinr >= 0)  efficiency = 0.4;

                const finalThroughput = baseThroughput * efficiency;

                // Load classification
                let loadClass = 'Balanced';
                if (users <= 20 && finalThroughput >= baseThroughput * 0.7) {
                    loadClass = 'Underloaded';
                    stats.underloaded++;
                } else if (users >= 35 && finalThroughput <= baseThroughput * 0.4) {
                    loadClass = 'Overloaded';
                    stats.overloaded++;
                } else {
                    stats.balanced++;
                }

                const congested = (users >= 35 && finalThroughput <= baseThroughput * 0.4);
                if (congested) congestedCount++;

                // User satisfaction
                if      (finalThroughput > 5)  satisfaction.good++;
                else if (finalThroughput >= 2) satisfaction.moderate++;
                else                           satisfaction.poor++;

                // Throughput distribution
                if      (finalThroughput >= 8) distribution.high++;
                else if (finalThroughput >= 4) distribution.medium++;
                else                           distribution.low++;

                // Critical detection
                if (finalThroughput < 2 || congested) criticalCount++;

                throughputValues.push(finalThroughput);
                throughputMap.push({ position, users, throughput: finalThroughput, congested });
                loadMap.push({ position, users, loadClass });
                congestionMap.push({ position, congested });

                sumThroughput   += finalThroughput;
                sumThroughputSq += finalThroughput * finalThroughput;

                // Progress report
                if ((i + 1) % CHUNK === 0 || i === totalPoints - 1) {
                    const progress = Math.min(100, Math.round(((i + 1) / totalPoints) * 100));
                    self.postMessage({
                        type: 'progress',
                        progress,
                        taskId,
                        data: { processed: i + 1, total: totalPoints }
                    });
                    await yieldToEventLoop();
                }
            }

            const pointsAnalyzed  = sinrPoints.length;
            const avgThroughput   = pointsAnalyzed > 0 ? sumThroughput / pointsAnalyzed : 0;

            // Jain's fairness index
            const fairnessValue   = (sumThroughputSq > 0)
                ? (sumThroughput * sumThroughput) / (pointsAnalyzed * sumThroughputSq)
                : 0;

            const congestedPercent = pointsAnalyzed > 0
                ? (congestedCount / pointsAnalyzed) * 100 : 0;

            // Sorted for percentile calculations
            const sorted     = throughputValues.slice().sort((a, b) => a - b);
            const minThroughput = sorted[0] ?? 0;
            const p5Index    = Math.max(0, Math.floor(pointsAnalyzed * 0.05) - 1);
            const p5Throughput  = sorted[p5Index] ?? 0;

            // Composite efficiency score 0–100
            const fairnessScore   = Math.max(0, Math.min(1, fairnessValue));
            const throughputScore = Math.max(0, Math.min(1, avgThroughput / 20));
            const congestionScore = Math.max(0, 1 - congestedPercent / 100);
            const efficiencyScore = Math.round(
                (fairnessScore * 0.4 + throughputScore * 0.4 + congestionScore * 0.2) * 100
            );

            let insightText = 'Moderate fairness with potential congestion risks';
            if (fairnessValue >= 0.8 && congestedPercent < 10) {
                insightText = 'Network is highly fair and well-balanced';
            } else if (fairnessValue < 0.6 || congestedPercent >= 25) {
                insightText = 'Low fairness, network needs optimization';
            }

            self.postMessage({
                type: 'complete',
                taskId,
                data: {
                    throughputMap,
                    loadMap,
                    congestionMap,
                    fairnessValue,
                    avgThroughput,
                    pointsAnalyzed,
                    congestedPercent,
                    stats,
                    satisfaction,
                    distribution,
                    minThroughput,
                    p5Throughput,
                    criticalCount,
                    efficiencyScore,
                    insightText
                }
            });

        } catch (err) {
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }
}

function yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }

new FairnessWorker();
