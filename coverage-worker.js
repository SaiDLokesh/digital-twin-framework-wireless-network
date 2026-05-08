// coverage-worker.js  
importScripts('path-loss-models.js');

class CoverageWorker {
    constructor() {
        this.buildingData = null;         
        this.isCancelled   = false;
        self.addEventListener('message', this.handleMessage.bind(this));
    }

    handleMessage(e) {
        const { type, data, taskId } = e.data;
        if (type === 'init') {
            // One-time building data initialisation
            this.buildingData = data.buildingData;
            return;
        }
        if (type === 'cancel') { this.isCancelled = true; return; }
        if (type === 'start')  { this.isCancelled = false; this.startAnalysis(data, taskId); }
    }

    async startAnalysis(data, taskId) {
        try {
            const {
                txPosition, radius, resolution, frequency, txPower, environment,
                txHeight, rayTracingEnabled, antennaParams
            } = data;

            const MIN_SIGNAL   = -120;
            const radiusSq     = radius * radius;
            const heightRange  = radius * 0.3;
            const fcGHz        = frequency / 1000;

            // Pre-compute frequency-constant terms
            const logF = 20 * Math.log10(fcGHz);

            // Pre-baked noise table
            const noise  = makeNoiseTable(rayTracingEnabled ? 10 : 8);
            let noiseIdx = 0;

            const xSteps = Math.ceil((radius * 2) / resolution);
            const zSteps = Math.ceil((radius * 2) / resolution);
            const ySteps = Math.ceil(heightRange  / resolution);
            const total  = xSteps * zSteps * ySteps;

            // Use Float32Arrays for compact, transferable results
            const MAX_PTS = total;
            const posArr  = new Float32Array(MAX_PTS * 3);
            const sigArr  = new Float32Array(MAX_PTS);
            let   ptCount = 0;
            let   covVol  = 0;
            let   ptsDone = 0;
            let   ptsSaved= 0;

            const CHUNK = 2000;

            for (let xi = 0; xi < xSteps; xi++) {
                const ox = -radius + xi * resolution;
                for (let zi = 0; zi < zSteps; zi++) {
                    const oz = -radius + zi * resolution;
                    for (let yi = 0; yi < ySteps; yi++) {
                        if (this.isCancelled) throw new Error('Analysis cancelled');

                        const y = yi * resolution;
                        // Squared-distance early-exit (avoids sqrt for out-of-range points)
                        const dx2D = ox * ox + oz * oz;
                        const dy   = y - txPosition.y;
                        const d3Dsq = dx2D + dy * dy;
                        if (d3Dsq > radiusSq) { ptsDone++; continue; }

                        const d2D = Math.sqrt(dx2D);
                        const d3D = Math.sqrt(d3Dsq);

                        const rx = txPosition.x + ox;
                        const rz = txPosition.z + oz;
                        const rxPos = { x: rx, y, z: rz };

                        // Path loss
                        let pl = calcPathLoss(environment, d2D, d3D, fcGHz, txHeight, y);

                        // Building penetration
                        if (this.buildingData) {
                            pl += calcBuildingPenetrationLoss(txPosition, rxPos, frequency, this.buildingData);
                        }

                        // Antenna gain
                        if (antennaParams) {
                            pl -= calcAntennaGain(txPosition, rxPos,
                                antennaParams.azimuth, antennaParams.beamwidth, antennaParams.gain);
                        }

                        // Shadow fading from pre-baked table
                        pl += noise[noiseIdx++ & (NOISE_TABLE_SIZE - 1)];

                        if (isFinite(pl)) {
                            const rxPow = txPower - pl;
                            if (rxPow >= MIN_SIGNAL) {
                                const base = ptCount * 3;
                                posArr[base]     = rx;
                                posArr[base + 1] = y;
                                posArr[base + 2] = rz;
                                sigArr[ptCount]  = rxPow;
                                ptCount++;
                                covVol += resolution * resolution * resolution;
                            }
                        }

                        ptsDone++;
                        ptsSaved = ptCount;

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

            // Trim and transfer typed arrays (zero-copy)
            const posTrim = posArr.slice(0, ptCount * 3);
            const sigTrim = sigArr.slice(0, ptCount);

            self.postMessage(
                { type: 'complete', taskId, data: {
                    positions: posTrim,       // Float32Array  [x,y,z, x,y,z …]
                    signals:   sigTrim,       // Float32Array  [sig, sig …]
                    pointCount: ptCount,
                    coverageVolume: covVol,
                    pointsAnalyzed: ptsDone,
                    totalPoints: total
                }},
                [posTrim.buffer, sigTrim.buffer]  // transfer – avoids copy
            );

        } catch (err) {
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }
}

function yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }

new CoverageWorker();
