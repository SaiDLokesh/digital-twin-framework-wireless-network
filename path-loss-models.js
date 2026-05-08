// ============================================================
//  path-loss-models.js  –  shared 3GPP path-loss utilities
// ============================================================

// ── SimpleBox3 (worker-safe) ────────────
class SimpleBox3 {
    constructor(min, max) { this.min = min; this.max = max; }
    containsPoint(p) {
        return p.x >= this.min.x && p.x <= this.max.x &&
               p.y >= this.min.y && p.y <= this.max.y &&
               p.z >= this.min.z && p.z <= this.max.z;
    }
    intersectsLine(s, e) {
        const d = { x: e.x-s.x, y: e.y-s.y, z: e.z-s.z };
        const inv = {
            x: d.x !== 0 ? 1/d.x : Infinity,
            y: d.y !== 0 ? 1/d.y : Infinity,
            z: d.z !== 0 ? 1/d.z : Infinity
        };
        let tmin = -Infinity, tmax = Infinity;
        for (const ax of ['x','y','z']) {
            const t1 = (this.min[ax] - s[ax]) * inv[ax];
            const t2 = (this.max[ax] - s[ax]) * inv[ax];
            tmin = Math.max(tmin, Math.min(t1, t2));
            tmax = Math.min(tmax, Math.max(t1, t2));
        }
        return tmin <= tmax && tmax >= 0 && tmin <= 1;
    }
}

// ── 3GPP UMa / UMi path-loss formulas ────────────────────────
// All functions take fcGHz (NOT MHz) for the frequency parameter.

function calcUMaLOS(d2D, d3D, fcGHz, hBS, hUT) {
    if (d3D <= 0 || !isFinite(d3D)) return 100;
    const dBp = (4 * hBS * hUT * fcGHz * 1e9) / 3e8;
    const logF = 20 * Math.log10(fcGHz);
    let PL;
    if (d2D <= dBp && d2D >= 10) {
        PL = 28.0 + 22 * Math.log10(d3D) + logF;
    } else if (d2D <= 5000 && d2D > dBp) {
        const term = dBp * dBp + (hBS - hUT) * (hBS - hUT);
        PL = term > 0
            ? 28.0 + 40 * Math.log10(d3D) + logF - 9 * Math.log10(term)
            : 28.0 + 40 * Math.log10(d3D) + logF;
    } else {
        PL = 32.4 + logF + 30 * Math.log10(d3D);
    }
    return isFinite(PL) ? PL : 32.4 + logF + 30 * Math.log10(Math.max(d3D, 1));
}

function calcUMaNLOS(d2D, d3D, fcGHz, hBS, hUT) {
    const PL_LOS  = calcUMaLOS(d2D, d3D, fcGHz, hBS, hUT);
    const PL_NLOS = 13.54 + 39.08 * Math.log10(d3D) + 20 * Math.log10(fcGHz) - 0.6 * (hUT - 1.5);
    return Math.max(PL_LOS, PL_NLOS);
}

function calcUMiLOS(d2D, d3D, fcGHz, hBS, hUT) {
    if (d3D <= 0 || !isFinite(d3D)) return 100;
    const dBp  = (4 * hBS * hUT * fcGHz * 1e9) / 3e8;
    const logF = 20 * Math.log10(fcGHz);
    let PL;
    if (d2D <= dBp) {
        PL = 32.4 + 21 * Math.log10(d3D) + logF;
    } else {
        const term = dBp * dBp + (hBS - hUT) * (hBS - hUT);
        PL = term > 0
            ? 32.4 + 40 * Math.log10(d3D) + logF - 9.5 * Math.log10(term)
            : 32.4 + 40 * Math.log10(d3D) + logF;
    }
    return isFinite(PL) ? PL : 32.4 + 21 * Math.log10(Math.max(d3D, 1)) + logF;
}

function calcUMiNLOS(d3D, fcGHz, hBS, hUT) {
    return 35.3 * Math.log10(d3D) + 22.4 + 21.3 * Math.log10(fcGHz) - 0.3 * (hUT - 1.5);
}

// ── Dispatch by environment string ───────────────────────────
function calcPathLoss(env, d2D, d3D, fcGHz, hBS, hUT) {
    switch (env) {
        case 'uma-los':  return calcUMaLOS(d2D, d3D, fcGHz, hBS, hUT);
        case 'uma-nlos': return calcUMaNLOS(d2D, d3D, fcGHz, hBS, hUT);
        case 'umi-los':  return calcUMiLOS(d2D, d3D, fcGHz, hBS, hUT);
        case 'umi-nlos': return calcUMiNLOS(d3D, fcGHz, hBS, hUT);
        default:         return calcUMaLOS(d2D, d3D, fcGHz, hBS, hUT);
    }
}

// ── Antenna pattern ───────────────────────────────────────────
function calcAntennaGain(txPos, rxPos, azimuth, beamwidth, gain) {
    const dx = rxPos.x - txPos.x;
    const dz = rxPos.z - txPos.z;
    let angle = Math.atan2(dz, dx) * (180 / Math.PI);
    angle = (angle + 360) % 360;
    let diff = Math.abs(angle - azimuth);
    diff = Math.min(diff, 360 - diff);
    return (beamwidth === 360 || diff <= beamwidth / 2) ? gain : gain - 25;
}

// ── Building penetration loss (worker-safe) ───────────────────
function getFreqFactor(freqMHz, freqFactors) {
    const keys = Object.keys(freqFactors).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < keys.length - 1; i++) {
        if (freqMHz >= keys[i] && freqMHz < keys[i + 1]) return freqFactors[keys[i]];
    }
    return freqFactors[keys[keys.length - 1]] || 1;
}

function calcBuildingPenetrationLoss(txPos, rxPos, freqMHz, buildingData) {
    let totalLoss = 0;
    if (!buildingData) return totalLoss;
    const freqFactor = getFreqFactor(freqMHz, buildingData.parameters.frequencyFactors);
    const dx = rxPos.x - txPos.x, dy = rxPos.y - txPos.y, dz = rxPos.z - txPos.z;
    const dist3D = Math.sqrt(dx*dx + dy*dy + dz*dz);

    for (const b of buildingData.buildings) {
        const bb = new SimpleBox3(b.boundingBox.min, b.boundingBox.max);
        if (!bb.intersectsLine(txPos, rxPos)) continue;

        const txIn = bb.containsPoint(txPos);
        const rxIn = bb.containsPoint(rxPos);
        const walls = (txIn && rxIn) ? 0 : (txIn || rxIn) ? 1 : 2;

        const matLoss = buildingData.parameters.materialLosses[b.materialType] || 12;
        totalLoss += walls * b.wallThickness * matLoss * freqFactor;

        const floors = Math.floor(Math.abs(rxPos.y - txPos.y) / b.floorHeight);
        const slabLoss = buildingData.parameters.materialLosses.concrete_slab || 25;
        totalLoss += floors * 0.2 * slabLoss * freqFactor;

        const intLossPer = buildingData.parameters.materialLosses.drywall || 4;
        totalLoss += dist3D * 0.5 * intLossPer * freqFactor * 0.1;
    }
    const PRACTICAL_BUILDING_CAP = 25; 

    return Math.min(totalLoss, PRACTICAL_BUILDING_CAP);
}

const NOISE_TABLE_SIZE = 4096;
function makeNoiseTable(amplitude = 8) {
    const t = new Float32Array(NOISE_TABLE_SIZE);
    for (let i = 0; i < NOISE_TABLE_SIZE; i++) t[i] = (Math.random() - 0.5) * amplitude;
    return t;
}
