// delay-worker.js  
importScripts('path-loss-models.js');

class DelayWorker {
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
            const {
                txPosition, radius, resolution, frequency, environment,
                txHeight, rTau, numClusters, rayTracingEnabled
            } = data;

            const radiusSq   = radius * radius;
            const heightRange = radius * 0.3;
            const fcGHz      = frequency / 1000;

            // Pre-compute 3GPP DS formula once (depends only on freq + env)
            const baseDS = this.getUMADelaySpread(fcGHz, environment);
            const isLOS  = environment.includes('los');

            // Shadow fading table
            const noise  = makeNoiseTable(0.2); // ±10%
            let   noiseIdx = 0;

            const xSteps = Math.ceil((radius * 2) / resolution);
            const zSteps = Math.ceil((radius * 2) / resolution);
            const ySteps = Math.ceil(heightRange  / resolution);
            const total  = xSteps * zSteps * ySteps;

            const MAX_PTS = total;
            const posArr  = new Float32Array(MAX_PTS * 3);
            const dsArr   = new Float32Array(MAX_PTS);
            let ptCount = 0, ptsDone = 0;
            let totalDS = 0, maxDS = 0, minDS = Infinity;

            const CHUNK = 2000;

            for (let xi = 0; xi < xSteps; xi++) {
                const ox = -radius + xi * resolution;
                for (let zi = 0; zi < zSteps; zi++) {
                    const oz = -radius + zi * resolution;
                    for (let yi = 0; yi < ySteps; yi++) {
                        if (this.isCancelled) throw new Error('Analysis cancelled');

                        const y   = yi * resolution;
                        const dx2D = ox * ox + oz * oz;
                        const dy   = y - txPosition.y;
                        if (dx2D + dy * dy > radiusSq) { ptsDone++; continue; }

                        const d2D = Math.sqrt(dx2D);

                        // Cluster delays 
                        const clusterDelays = this.generateClusterDelays(numClusters, baseDS, rTau, isLOS);
                        let rmsDS = this.calcRMS(clusterDelays);

                        // Distance scaling
                        rmsDS *= this.getDistanceFactor(d2D, environment);

                        if (rayTracingEnabled) rmsDS *= environment.includes('nlos') ? 1.3 : 0.9;

                        // Shadow fading from table
                        rmsDS *= 1 + noise[noiseIdx++ & (NOISE_TABLE_SIZE - 1)];

                        const dsNs = Math.max(1, rmsDS * 1e9);
                        if (isFinite(dsNs)) {
                            const base = ptCount * 3;
                            posArr[base]     = txPosition.x + ox;
                            posArr[base + 1] = y;
                            posArr[base + 2] = txPosition.z + oz;
                            dsArr[ptCount]   = dsNs;
                            ptCount++;
                            totalDS += dsNs;
                            if (dsNs > maxDS) maxDS = dsNs;
                            if (dsNs < minDS) minDS = dsNs;
                        }

                        ptsDone++;
                        if (ptsDone % CHUNK === 0 || ptsDone === total) {
                            self.postMessage({
                                type: 'progress',
                                progress: Math.min(100, Math.round((ptsDone / total) * 100)),
                                taskId,
                                data: { processed: ptsDone, total, delayPoints: ptCount }
                            });
                            await yieldToEventLoop();
                        }
                    }
                }
            }

            const posTrim = posArr.slice(0, ptCount * 3);
            const dsTrim  = dsArr.slice(0, ptCount);

            self.postMessage(
                { type: 'complete', taskId, data: {
                    positions: posTrim,
                    delayValues: dsTrim,
                    pointCount: ptCount,
                    avgDelaySpread: ptCount > 0 ? totalDS / ptCount : 0,
                    maxDelaySpread: maxDS,
                    minDelaySpread: minDS === Infinity ? 0 : minDS,
                    pointsAnalyzed: ptsDone,
                    totalPoints: total
                }},
                [posTrim.buffer, dsTrim.buffer]
            );

        } catch (err) {
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }

    // ── 3GPP Table 7.3-5 ─────────────────────────────────────
    getUMADelaySpread(fcGHz, environment) {
        const logDS = environment.includes('los')
            ? -6.955 - 0.0963 * Math.log10(fcGHz)
            : -6.28  - 0.204  * Math.log10(fcGHz);
        return Math.pow(10, logDS);
    }

    generateClusterDelays(n, DS, rTau, isLOS) {
        const raw = new Float64Array(n);
        for (let i = 0; i < n; i++) raw[i] = -rTau * DS * Math.log(Math.random() || 1e-10);
        const mn = Math.min(...raw);
        for (let i = 0; i < n; i++) raw[i] -= mn;
        raw.sort();
        if (isLOS) {
            const K = 9;
            const Ct = 0.7705 - 0.0433 * K + 0.0002 * K * K + 0.000017 * K * K * K;
            for (let i = 0; i < n; i++) raw[i] /= Ct;
        }
        return raw;
    }

    calcRMS(delays) {
        const n = delays.length;
        if (!n) return 0;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += delays[i];
        const mean = sum / n;
        let sq = 0;
        for (let i = 0; i < n; i++) { const d = delays[i] - mean; sq += d * d; }
        return Math.sqrt(sq / n);
    }

    getDistanceFactor(d2D, environment) {
        if (d2D <= 100) return 1;
        const f = environment.includes('los')
            ? 1 + 0.1 * Math.log10(d2D / 100)
            : 1 + 0.2 * Math.log10(d2D / 100);
        return Math.min(f, 3);
    }
}

function yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }

new DelayWorker();
