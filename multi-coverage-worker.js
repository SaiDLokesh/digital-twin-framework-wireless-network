// multi-coverage-worker.js  
importScripts('path-loss-models.js');

const BS_COLORS = [
    [1,0,0],[0,1,0],[0,0,1],[1,1,0],[1,0,1],
    [0,1,1],[1,0.5,0],[0.5,0,1],[0,0.5,0],[0.5,0.5,0.5]
];

class MultiCoverageWorker {
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
            const { baseStations, gridParams, minSignal, ignoreRadius, crowdData = [] } = data;
            const { resolution, minX, maxX, minY, maxY, minZ, maxZ } = gridParams;
            // Use caller-supplied threshold (e.g. -145 dBm) or fall back to -120
            const MIN_SIGNAL = (typeof minSignal === 'number') ? minSignal : -120;
            const skipByRadius = !ignoreRadius;

            const xSteps = Math.ceil((maxX - minX) / resolution);
            const ySteps = Math.ceil((maxY - minY) / resolution);
            const zSteps = Math.ceil((maxZ - minZ) / resolution);
            const total  = xSteps * ySteps * zSteps;

            // Pre-compute per-BS constants
            const bsCache = baseStations.map(bs => ({
                ...bs,
                fcGHz:    bs.frequency / 1000,
                radiusSq: bs.radius * bs.radius,
                color:    BS_COLORS[bs.index % BS_COLORS.length]
            }));

            // Pre-baked noise tables per BS
            const bsNoise = bsCache.map(() => makeNoiseTable(8));
            const bsNoiseIdx = new Int32Array(baseStations.length);

            const posArr   = new Float32Array(total * 3);
            const sigArr   = new Float32Array(total);
            const bsIdxArr = new Int32Array(total);
            let ptCount = 0, ptsDone = 0;
            const bsCovCounts = new Int32Array(baseStations.length);

            const CHUNK = 2000;

            for (let xi = 0; xi < xSteps; xi++) {
                const x = minX + xi * resolution;
                for (let zi = 0; zi < zSteps; zi++) {
                    const z = minZ + zi * resolution;
                    for (let yi = 0; yi < ySteps; yi++) {
                        if (this.isCancelled) throw new Error('Analysis cancelled');

                        const y = minY + yi * resolution;
                        const rxPos = { x, y, z };

                        let bestSig = -Infinity, bestBS = -1;

                        for (let i = 0; i < bsCache.length; i++) {
                            const bs = bsCache[i];
                            const dx = x - bs.position.x;
                            const dy = y - bs.position.y;
                            const dz = z - bs.position.z;
                            const d3Dsq = dx*dx + dy*dy + dz*dz;
                            if (skipByRadius && d3Dsq > bs.radiusSq) continue;

                            const d2D = Math.sqrt(dx*dx + dz*dz);
                            const d3D = Math.sqrt(d3Dsq);

                            let pl = calcPathLoss(bs.environment, d2D, d3D, bs.fcGHz, bs.txHeight, y);

                            if (this.buildingData) {
                                pl += calcBuildingPenetrationLoss(bs.position, rxPos, bs.frequency, this.buildingData);
                            }

                            pl -= calcAntennaGain(bs.position, rxPos,
                                bs.antennaAzimuth, bs.antennaBeamwidth, bs.antennaGain);

                            // ── Crowd blockage loss (3GPP Model A) ──────────────
                            if (crowdData.length > 0) {
                                let crowdLoss = 0;
                                const d2D = Math.sqrt((x - bs.position.x) ** 2 + (z - bs.position.z) ** 2);
                                for (const crowd of crowdData) {
                                    const dxC = x - crowd.center.x;
                                    const dzC = z - crowd.center.z;
                                    const dist2D = Math.sqrt(dxC*dxC + dzC*dzC);
                                    if (dist2D <= crowd.radius) {
                                        const sigma = crowd.radius * 0.5;
                                        const density = crowd.density *
                                            Math.exp(-(dist2D*dist2D) / (2*sigma*sigma));
                                        const expectedB = density * d2D * 0.3;
                                        const pBlock = 1 - Math.exp(-expectedB);
                                        crowdLoss += pBlock * 15;
                                    }
                                }
                                pl += Math.min(crowdLoss, 30);
                            }
                            

                            pl += bsNoise[i][bsNoiseIdx[i]++ & (NOISE_TABLE_SIZE - 1)];

                            const rxPow = bs.txPower - pl;
                            if (rxPow > bestSig) { bestSig = rxPow; bestBS = i; }
                        }

                        if (bestSig >= MIN_SIGNAL && bestBS !== -1) {
                            const base = ptCount * 3;
                            posArr[base]     = x;
                            posArr[base + 1] = y;
                            posArr[base + 2] = z;
                            sigArr[ptCount]  = bestSig;
                            bsIdxArr[ptCount] = bestBS;
                            bsCovCounts[bestBS]++;
                            ptCount++;
                        }

                        ptsDone++;
                        if (ptsDone % CHUNK === 0 || ptsDone === total) {
                            self.postMessage({
                                type: 'progress',
                                progress: Math.min(100, Math.round((ptsDone / total) * 100)),
                                taskId,
                                data: { processed: ptsDone, total, coveragePoints: ptCount }
                            });
                            await yieldToEventLoop();
                        }
                    }
                }
            }

            const posTrim   = posArr.slice(0, ptCount * 3);
            const sigTrim   = sigArr.slice(0, ptCount);
            const bsIdxTrim = bsIdxArr.slice(0, ptCount);

            const coverageStats = baseStations.map((bs, i) => ({
                index: i,
                name: bs.name || `BS-${i + 1}`,
                coveragePoints: bsCovCounts[i],
                coveragePercentage: total > 0
                    ? ((bsCovCounts[i] / total) * 100).toFixed(2) : '0.00',
                position: bs.position,
                radius: bs.radius,
                color: BS_COLORS[i % BS_COLORS.length]
            }));

            const totalCovPct = total > 0 ? ((ptCount / total) * 100).toFixed(2) : '0.00';

            self.postMessage(
                { type: 'complete', taskId, data: {
                    positions: posTrim,
                    signals:   sigTrim,
                    bsIndices: bsIdxTrim,
                    pointCount: ptCount,
                    coverageStats,
                    totalCoveragePoints: ptCount,
                    totalCoveragePercentage: totalCovPct,
                    pointsAnalyzed: ptsDone,
                    totalPoints: total,
                    gridParams,
                    bsColors: Array.from(bsCovCounts).map((_, i) => BS_COLORS[i % BS_COLORS.length])
                }},
                [posTrim.buffer, sigTrim.buffer, bsIdxTrim.buffer]
            );

        } catch (err) {
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }
}

function yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }

new MultiCoverageWorker();
