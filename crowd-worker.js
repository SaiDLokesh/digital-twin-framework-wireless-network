// crowd-worker.js
// 3GPP TR 38.901 Human Blockage
//   Model A (statistical)  – freq < 6 GHz
//   Model B (geometric/Fresnel) – freq >= 6 GHz
importScripts('path-loss-models.js');

// ── Model A constants (3GPP TR 38.901 Table 7.6.4.2-1) ───────
const MODEL_A_LOSS_DB   = 15;   // fixed dB penalty per blocker in path
const BLOCKER_WIDTH_M   = 0.3;  // shoulder width (m)
const BLOCKER_HEIGHT_M  = 1.7;  // average human height (m)

// ── Model B constants ─────────────────────────────────────────
// Person treated as rectangular screen: w=0.3m h=1.7m
// Diffraction loss via Fresnel integral approximation
const SCREEN_W = 0.3;
const SCREEN_H = 1.7;

class CrowdWorker {
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
                txPosition, crowdCenter, crowdRadius, peakDensity,
                sigma, weatherEffect, frequency, txPower, txHeight,
                environment, resolution
            } = data;

            const fcGHz      = frequency / 1000;
            const useModelB  = fcGHz >= 6;          // switch at 6 GHz
            const r          = crowdRadius;
            const MIN_SIG    = -130;  // extended to show full crowd circle shape
            const sigmaEff   = sigma || (r * 0.5);
            const lambda     = 0.3 / fcGHz;         // wavelength (m)

            const xSteps = Math.ceil((r * 2) / resolution);
            const zSteps = Math.ceil((r * 2) / resolution);
            const total  = xSteps * zSteps;

            const posArr  = new Float32Array(total * 3);
            const sigArr  = new Float32Array(total);
            const densArr = new Float32Array(total);
            let ptCount = 0, ptsDone = 0;

            const noise = makeNoiseTable(6);
            let   ni    = 0;
            const CHUNK = 1000;

            for (let xi = 0; xi < xSteps; xi++) {
                const ox = -r + xi * resolution;
                for (let zi = 0; zi < zSteps; zi++) {
                    if (this.isCancelled) throw new Error('Analysis cancelled');

                    const oz = -r + zi * resolution;
                    const distC = Math.sqrt(ox * ox + oz * oz);
                    if (distC > r) { ptsDone++; continue; }

                    // RX world position (human chest height)
                    const wx = crowdCenter.x + ox;
                    const wy = 1.5;
                    const wz = crowdCenter.z + oz;

                    // ── Gaussian density ──────────────────────────────────
                    let localDensity = peakDensity *
                        Math.exp(-(distC * distC) / (2 * sigmaEff * sigmaEff));

                    // Weather: disperse outer crowd beyond 50% radius
                    if (weatherEffect && distC > r * 0.5) {
                        const decay = (distC - r * 0.5) / (r * 0.5);
                        localDensity *= Math.max(0.25, 1.0 - 0.75 * decay);
                    }

                    // ── Path distances ────────────────────────────────────
                    const dxT = wx - txPosition.x;
                    const dyT = wy - txPosition.y;
                    const dzT = wz - txPosition.z;
                    const d3D = Math.max(1, Math.sqrt(dxT*dxT + dyT*dyT + dzT*dzT));
                    const d2D = Math.max(1, Math.sqrt(dxT*dxT + dzT*dzT));

                    // ── Base path loss ────────────────────────────────────
                    let pl = calcPathLoss(environment, d2D, d3D, fcGHz, txHeight, wy);

                    // ── Building penetration ──────────────────────────────
                    if (this.buildingData) {
                        pl += calcBuildingPenetrationLoss(
                            txPosition, { x: wx, y: wy, z: wz }, frequency, this.buildingData
                        );
                    }

                    // ── Human blockage loss ───────────────────────────────
                    let blockageLoss = 0;

                    if (!useModelB) {
                        // ── MODEL A: statistical (< 6 GHz) ───────────────
                        // Expected blockers in path corridor = density × d2D × width
                        const expectedB = localDensity * d2D * BLOCKER_WIDTH_M;
                        // Poisson: P(≥1 blocker) = 1 − e^(−λ)
                        const pBlock    = 1.0 - Math.exp(-expectedB);
                        blockageLoss    = pBlock * MODEL_A_LOSS_DB;

                    } else {
                        // ── MODEL B: geometric Fresnel screen (≥ 6 GHz) ──
                        // Each person is a rect screen w×h centred at height h/2
                        // Fresnel diffraction parameter ν = h_excess × sqrt(2(d1+d2)/(λ·d1·d2))
                        // where h_excess = clearance needed minus actual clearance
                        // Simplified: average blocker is at midpoint d1=d2=d3D/2
                        const d1 = d3D / 2, d2 = d3D / 2;
                        const screenTopH = SCREEN_H;           // top of screen above ground
                        const losH       = wy + (txPosition.y - wy) * (d1 / d3D); // LOS height at midpoint
                        const hExcess    = screenTopH - losH;  // positive = screen blocks LOS

                        let singleScreenLoss = 0;
                        if (hExcess > 0) {
                            // Fresnel–Kirchhoff diffraction parameter ν
                            const nu = hExcess * Math.sqrt(2 * (d1 + d2) / (lambda * d1 * d2));
                            // Approximation: L(ν) ≈ 6.02 + 9.11ν + 1.27ν² dB  (ITU-R P.526)
                            singleScreenLoss = Math.max(0, 6.02 + 9.11 * nu + 1.27 * nu * nu);
                        }

                        // Expected number of screens in path (area density × corridor)
                        const expectedScreens = localDensity * d2D * SCREEN_W;
                        // Combined loss: probabilistic sum of independent screens
                        // Use: L_total = expectedScreens × singleScreenLoss (linear regime)
                        blockageLoss = Math.min(40, expectedScreens * singleScreenLoss);
                    }

                    pl += blockageLoss;

                    // ── Shadow fading ─────────────────────────────────────
                    pl += noise[ni++ & (NOISE_TABLE_SIZE - 1)];

                    const rxPow = txPower - pl;
                    if (rxPow >= MIN_SIG && isFinite(rxPow)) {
                        const base = ptCount * 3;
                        posArr[base]     = wx;
                        posArr[base + 1] = wy;
                        posArr[base + 2] = wz;
                        sigArr[ptCount]  = rxPow;
                        densArr[ptCount] = localDensity;
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

            const posTrim  = posArr.slice(0, ptCount * 3);
            const sigTrim  = sigArr.slice(0, ptCount);
            const densTrim = densArr.slice(0, ptCount);

            self.postMessage(
                { type: 'complete', taskId, data: {
                    positions:      posTrim,
                    signals:        sigTrim,
                    densities:      densTrim,
                    pointCount:     ptCount,
                    pointsAnalyzed: ptsDone,
                    totalPoints:    total,
                    modelUsed:      useModelB ? 'B' : 'A'
                }},
                [posTrim.buffer, sigTrim.buffer, densTrim.buffer]
            );

        } catch (err) {
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }
}

function yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }
new CrowdWorker();
