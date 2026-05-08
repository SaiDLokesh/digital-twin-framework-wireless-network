// sinr-worker.js  
class SINRWorker {
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
                txPosition,
                radius       = 100,
                resolution   = 5,
                frequency    = 2400,
                txPower      = 20,
                noiseFloor   = -95,
                interference = -90,
                txHeight     = 25,
                environment  = 'uma-los',
                cellTiers    = 3
            } = data;

            const fcGHz      = frequency / 1000;
            const c          = 3e8;
            const minDist    = 1;
            const heightRange = radius * 0.3;

            const sinrPoints = [];
            let totalSinr    = 0;
            let maxSinr      = -Infinity;
            let minSinr      =  Infinity;
            let count        = 0;

            // Grid dimensions for progress tracking
            const gridSteps    = Math.ceil((2 * radius) / resolution);
            const totalSteps   = gridSteps * gridSteps;
            let   processedSteps = 0;

            const CHUNK = 500; // yield cadence (outer-loop steps)

            for (let x = -radius; x <= radius; x += resolution) {
                for (let z = -radius; z <= radius; z += resolution) {
                    if (this.isCancelled) throw new Error('Analysis cancelled');

                    const dist2D = Math.sqrt(x * x + z * z);
                    if (dist2D > radius) { processedSteps++; continue; }

                    for (let y = 1.5; y <= heightRange; y += resolution) {

                        const dist3D = Math.max(
                            Math.sqrt(x * x + z * z + Math.pow(txHeight - y, 2)),
                            minDist
                        );

                        // ── Path loss (mirrors sinr-worker original logic) ──────────
                        let PL;
                        if (environment === 'uma-los') {
                            const dBp = (4 * txHeight * y * fcGHz * 1e9) / c;
                            if (dist2D >= 10 && dist2D <= dBp) {
                                PL = 28.0 + 22 * Math.log10(dist3D) + 20 * Math.log10(fcGHz);
                            } else if (dist2D > dBp) {
                                const term = Math.pow(dBp, 2) + Math.pow(txHeight - y, 2);
                                PL = 28.0 + 40 * Math.log10(dist3D)
                                   + 20 * Math.log10(fcGHz)
                                   - 9  * Math.log10(Math.max(term, 1e-6));
                            } else {
                                PL = 32.4 + 20 * Math.log10(fcGHz) + 30 * Math.log10(dist3D);
                            }
                        } else if (environment === 'uma-nlos') {
                            PL = 13.54 + 39.08 * Math.log10(Math.max(dist3D, 1))
                               + 20 * Math.log10(fcGHz)
                               - 0.6 * (y - 1.5);
                        } else if (environment === 'umi-los') {
                            const dBp  = (4 * txHeight * y * fcGHz * 1e9) / c;
                            const logF = 20 * Math.log10(fcGHz);
                            if (dist2D <= dBp) {
                                PL = 32.4 + 21 * Math.log10(dist3D) + logF;
                            } else {
                                const term = Math.pow(dBp, 2) + Math.pow(txHeight - y, 2);
                                PL = 32.4 + 40 * Math.log10(dist3D) + logF
                                   - 9.5 * Math.log10(Math.max(term, 1e-6));
                            }
                        } else {
                            // umi-nlos
                            PL = 35.3 * Math.log10(Math.max(dist3D, 1))
                               + 22.4
                               + 21.3 * Math.log10(fcGHz)
                               - 0.3  * (y - 1.5);
                        }

                        // Shadow fading ±4 dB
                        PL += (Math.random() - 0.5) * 8;

                        const S_dBm = txPower - PL;
                        const S_lin = Math.pow(10, S_dBm / 10);

                        // ── Interference model (same as original) ─────────────────
                        const interferingCellCount = cellTiers === 1 ? 6 : cellTiers === 3 ? 18 : 42;
                        const tierAttenuations     = { 1: 1.0, 3: 0.7, 6: 0.5 };
                        const tierAtt              = tierAttenuations[cellTiers] || 1.0;
                        const basePow              = Math.pow(10, interference / 10);

                        let I_lin = 0;
                        for (let i = 0; i < interferingCellCount; i++) {
                            I_lin += (basePow * tierAtt) / interferingCellCount;
                        }

                        const N_lin    = Math.pow(10, noiseFloor / 10);
                        const sinr_lin = S_lin / (I_lin + N_lin);
                        const sinr_dB  = Math.max(-20, Math.min(30, 10 * Math.log10(sinr_lin)));

                        sinrPoints.push({
                            position: {
                                x: txPosition.x + x,
                                y,
                                z: txPosition.z + z
                            },
                            sinr: sinr_dB
                        });

                        totalSinr += sinr_dB;
                        if (sinr_dB > maxSinr) maxSinr = sinr_dB;
                        if (sinr_dB < minSinr) minSinr = sinr_dB;
                        count++;
                    }

                    processedSteps++;
                }

                // Yield and report progress once per outer-loop row
                const progress = Math.min(100, Math.round((processedSteps / totalSteps) * 100));
                self.postMessage({
                    type: 'progress',
                    progress,
                    taskId,
                    data: { processed: processedSteps, total: totalSteps }
                });
                await yieldToEventLoop();
            }

            self.postMessage({
                type: 'complete',
                taskId,
                data: {
                    sinrPoints,
                    avgSinr:        count > 0 ? totalSinr / count : 0,
                    maxSinr:        maxSinr === -Infinity ? 0 : maxSinr,
                    minSinr:        minSinr ===  Infinity ? 0 : minSinr,
                    pointsAnalyzed: count
                }
            });

        } catch (err) {
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }
}

function yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }

new SINRWorker();
