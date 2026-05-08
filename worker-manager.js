// worker-manager.js  

class WorkerManager {
    constructor() {
        this.workers           = new Map();   
        this.initialised       = new Set();   
        this.taskCancelCallbacks = new Map();
        this.isWorkerSupported = typeof Worker !== 'undefined';
        this._buildingData     = null;
        console.log(`Worker support: ${this.isWorkerSupported ? 'Enabled' : 'Disabled'}`);
    }

    // ── Worker lifecycle ──────────────────────────────────────

    createWorker(taskType, workerScript) {
        if (this.workers.has(taskType)) return this.workers.get(taskType);

        if (!this.isWorkerSupported) return this._makeFallback(taskType);

        try {
            const w = new Worker(workerScript);
            this.workers.set(taskType, w);
            return w;
        } catch (err) {
            console.warn(`Worker creation failed for ${taskType}:`, err);
            this.isWorkerSupported = false;
            return this._makeFallback(taskType);
        }
    }

    setBuildingData(buildingData) {
        this._buildingData = buildingData;
        this.initialised.clear();                       
        for (const [taskType, w] of this.workers) {
            this._sendInit(taskType, w);
        }
    }

    _sendInit(taskType, worker) {
        if (this.initialised.has(taskType)) return;
        if (worker && typeof worker.postMessage === 'function') {
            worker.postMessage({ type: 'init', data: { buildingData: this._buildingData } });
            this.initialised.add(taskType);
        }
    }

    // ── Task execution ────────────────────────────────────────

    async executeTask(taskType, data, onProgress = null) {
        let worker = this.workers.get(taskType);
        if (!worker) throw new Error(`Worker not found: ${taskType}`);

        // Ensure building data has been sent
        this._sendInit(taskType, worker);

        return new Promise((resolve, reject) => {
            const taskId = Date.now() + Math.random();

            // Cancel previous task on this worker if one is running
            const prevCancel = this._activeCancelFor(taskType);
            if (prevCancel) prevCancel();

            const onMsg = (e) => {
                const { type, data: rd, progress, taskId: tid } = e.data;
                if (tid && tid !== taskId) return;

                if (type === 'progress') {
                    onProgress && onProgress(Object.assign({ progress }, rd));
                } else if (type === 'complete') {
                    worker.removeEventListener('message', onMsg);
                    worker.removeEventListener('error',   onErr);
                    this.taskCancelCallbacks.delete(taskId);
                    resolve(rd);
                } else if (type === 'error') {
                    worker.removeEventListener('message', onMsg);
                    worker.removeEventListener('error',   onErr);
                    this.taskCancelCallbacks.delete(taskId);
                    reject(new Error(rd));
                }
            };

            const onErr = (err) => {
                worker.removeEventListener('message', onMsg);
                worker.removeEventListener('error',   onErr);
                this.taskCancelCallbacks.delete(taskId);
                reject(err);
            };

            const cancelFn = () => {
                worker.postMessage({ type: 'cancel' });
                worker.removeEventListener('message', onMsg);
                worker.removeEventListener('error',   onErr);
                this.taskCancelCallbacks.delete(taskId);
                reject(new Error('Analysis cancelled'));
            };
            this.taskCancelCallbacks.set(taskId, { taskType, fn: cancelFn });

            worker.addEventListener('message', onMsg);
            worker.addEventListener('error',   onErr);

            worker.postMessage({ type: 'start', data, taskId });
        });
    }

    async executeMultiCoverageTask(baseStations, gridParams, onProgress = null) {
        return this.executeTask('multi-coverage-analysis', { baseStations, gridParams }, onProgress);
    }

    // ── Helpers ───────────────────────────────────────────────

    _activeCancelFor(taskType) {
        for (const [, entry] of this.taskCancelCallbacks) {
            if (entry.taskType === taskType) return entry.fn;
        }
        return null;
    }

    cancelAllTasks() {
        for (const [, entry] of this.taskCancelCallbacks) entry.fn();
    }

    terminateAll() {
        for (const [, w] of this.workers) w.terminate && w.terminate();
        this.workers.clear();
        this.initialised.clear();
        this.taskCancelCallbacks.clear();
    }

    getStatus() {
        return {
            isWorkerSupported: this.isWorkerSupported,
            activeWorkers: this.taskCancelCallbacks.size,
            totalWorkers: this.workers.size
        };
    }

    // ── Fallback (single-threaded) ────────────────────────────

    _makeFallback(taskType) {
        const map = {
            'coverage-analysis':       FallbackCoverageWorker,
            'delay-analysis':          FallbackDelayWorker,
            'throughput-analysis':     FallbackThroughputWorker,
            'multi-coverage-analysis': FallbackMultiCoverageWorker,
            'crowd-analysis':          FallbackCrowdWorker,
            'sinr-analysis':           FallbackSINRWorker,
            'fairness-analysis':       FallbackFairnessWorker
        };
        const Cls = map[taskType];
        if (!Cls) throw new Error(`No fallback for ${taskType}`);
        const fb = new Cls(taskType);
        this.workers.set(taskType, fb);
        return fb;
    }
}

// ── Shared fallback base ──────────────────────────────────────
class FallbackBase {
    constructor(taskType) {
        this.taskType    = taskType;
        this.onmessage   = null;
        this.isCancelled = false;
        this.buildingData= null;
    }

    postMessage(msg) {
        if (msg.type === 'init')   { this.buildingData = msg.data.buildingData; return; }
        if (msg.type === 'cancel') { this.isCancelled = true; return; }
        if (msg.type !== 'start')  return;

        this.isCancelled = false;
        setTimeout(() => {
            try {
                const result = this.execute(msg.data);
                this.onmessage?.({ data: { type: 'complete', data: result, taskId: msg.taskId } });
            } catch (err) {
                this.onmessage?.({ data: { type: 'error', data: err.message, taskId: msg.taskId } });
            }
        }, 0);
    }

    addEventListener(ev, cb) { if (ev === 'message') this.onmessage = (e) => cb(e); }
    removeEventListener()    {}
    terminate()              { this.isCancelled = true; }

    // ── Shared path-loss helpers ──────────────────────────────
    pathLoss(env, d2D, d3D, fcGHz, hBS, hUT) { return calcPathLoss(env, d2D, d3D, fcGHz, hBS, hUT); }
    antGain(tx, rx, az, bw, g)              { return calcAntennaGain(tx, rx, az, bw, g); }
    bldLoss(tx, rx, freq, bd)               { return calcBuildingPenetrationLoss(tx, rx, freq, bd); }
}

class FallbackCoverageWorker extends FallbackBase {
    execute(data) {
        const { txPosition, radius, resolution, frequency, txPower, environment, txHeight, antennaParams } = data;
        const MIN  = -120, rSq = radius * radius, hR = radius * 0.3, fcGHz = frequency / 1000;
        const coveragePoints = [], noise = makeNoiseTable(8);
        let covVol = 0, analyzed = 0, ni = 0;
        for (let ox = -radius; ox <= radius; ox += resolution) {
            for (let oz = -radius; oz <= radius; oz += resolution) {
                for (let y = 0; y <= hR; y += resolution) {
                    if (this.isCancelled) throw new Error('Analysis cancelled');
                    const d2sq = ox*ox + oz*oz;
                    const dy   = y - txPosition.y;
                    if (d2sq + dy*dy > rSq) continue;
                    const d2D = Math.sqrt(d2sq), d3D = Math.sqrt(d2sq + dy*dy);
                    const rx  = { x: txPosition.x+ox, y, z: txPosition.z+oz };
                    let pl = this.pathLoss(environment, d2D, d3D, fcGHz, txHeight, y);
                    if (this.buildingData) pl += this.bldLoss(txPosition, rx, frequency, this.buildingData);
                    if (antennaParams) pl -= this.antGain(txPosition, rx, antennaParams.azimuth, antennaParams.beamwidth, antennaParams.gain);
                    pl += noise[ni++ & (NOISE_TABLE_SIZE-1)];
                    const rxPow = txPower - pl;
                    if (rxPow >= MIN) { coveragePoints.push({ position: rx, signalStrength: rxPow }); covVol += resolution**3; }
                    analyzed++;
                }
            }
        }
        return { coveragePoints, coverageVolume: covVol, pointsAnalyzed: analyzed, totalPoints: analyzed };
    }
}

class FallbackDelayWorker extends FallbackBase {
    execute(data) {
        const { txPosition, radius, resolution, frequency, environment, txHeight, rTau, numClusters } = data;
        const rSq = radius * radius, hR = radius * 0.3;
        const fcGHz = frequency / 1000;
        const baseDS = (()=>{ const l = environment.includes('los') ? -6.955 - 0.0963*Math.log10(fcGHz) : -6.28 - 0.204*Math.log10(fcGHz); return Math.pow(10,l); })();
        const isLOS = environment.includes('los');
        const delayPoints = [];
        let total=0, maxDS=0, minDS=Infinity;
        for (let ox=-radius; ox<=radius; ox+=resolution) {
            for (let oz=-radius; oz<=radius; oz+=resolution) {
                for (let y=0; y<=hR; y+=resolution) {
                    if (this.isCancelled) throw new Error('Analysis cancelled');
                    const d2sq=ox*ox+oz*oz, dy=y-txPosition.y;
                    if (d2sq+dy*dy>rSq) continue;
                    const d2D=Math.sqrt(d2sq);
                    const delays=this._genDelays(numClusters,baseDS,rTau,isLOS);
                    let rms=this._rms(delays);
                    if (d2D>100) rms*=Math.min(3,1+(isLOS?0.1:0.2)*Math.log10(d2D/100));
                    rms*=1+(Math.random()-0.5)*0.2;
                    const dsNs=Math.max(1,rms*1e9);
                    delayPoints.push({position:{x:txPosition.x+ox,y,z:txPosition.z+oz},delaySpread:dsNs});
                    total+=dsNs; if(dsNs>maxDS)maxDS=dsNs; if(dsNs<minDS)minDS=dsNs;
                }
            }
        }
        return { delayPoints, avgDelaySpread: delayPoints.length>0?total/delayPoints.length:0, maxDelaySpread:maxDS, minDelaySpread:minDS===Infinity?0:minDS, pointsAnalyzed:delayPoints.length, totalPoints:delayPoints.length };
    }
    _genDelays(n,DS,rTau,isLOS){const r=[];for(let i=0;i<n;i++)r.push(-rTau*DS*Math.log(Math.random()||1e-10));const mn=Math.min(...r);const s=r.map(v=>v-mn).sort((a,b)=>a-b);if(isLOS){const K=9,Ct=0.7705-0.0433*K+0.0002*K*K+0.000017*K*K*K;return s.map(v=>v/Ct);}return s;}
    _rms(d){if(!d.length)return 0;const m=d.reduce((a,b)=>a+b,0)/d.length;return Math.sqrt(d.reduce((s,v)=>s+(v-m)*(v-m),0)/d.length);}
}

class FallbackThroughputWorker extends FallbackBase {
    execute(data) {
        const { txPosition, radius, resolution, frequency, txPower, environment, txHeight, bandwidth, cellLoad, useConservativeSinr, noiseFloor=-95, interferencedBm=-90 } = data;
        const rSq=radius*radius, hR=radius*0.3, fcGHz=frequency/1000;
        const prbs=BW_TO_PRBS[bandwidth]||50, prbIdx=PRB_IDX[prbs]||(prbs-1);
        const pts=[], noise=makeNoiseTable(8); let ni=0, total=0, max=0, min=Infinity;
        for(let ox=-radius;ox<=radius;ox+=resolution){for(let oz=-radius;oz<=radius;oz+=resolution){for(let y=0;y<=hR;y+=resolution){
            if(this.isCancelled)throw new Error('Analysis cancelled');
            const d2sq=ox*ox+oz*oz,dy=y-txPosition.y;
            if(d2sq+dy*dy>rSq)continue;
            const d2D=Math.sqrt(d2sq),d3D=Math.sqrt(d2sq+dy*dy);
            const rx={x:txPosition.x+ox,y,z:txPosition.z+oz};
            let pl=this.pathLoss(environment,d2D,d3D,fcGHz,txHeight,y);
            if(this.buildingData)pl+=this.bldLoss(txPosition,rx,frequency,this.buildingData);
            pl+=noise[ni++&(NOISE_TABLE_SIZE-1)];
            const rxP=txPower-pl;
            const ni2=10*Math.log10(Math.pow(10,noiseFloor/10)+Math.pow(10,interferencedBm/10));
            let sinr=rxP-ni2; if(useConservativeSinr)sinr-=5; sinr=Math.max(-10,Math.min(30,sinr));
            const tp=this._tp(sinr,prbIdx,cellLoad);
            if(isFinite(tp)){pts.push({position:rx,throughput:tp,sinr});total+=tp;if(tp>max)max=tp;if(tp<min)min=tp;}
        }}}
        return{throughputPoints:pts,avgThroughput:pts.length>0?total/pts.length:0,maxThroughput:max,minThroughput:min===Infinity?0:min,pointsAnalyzed:pts.length,totalPoints:pts.length};
    }
    _tp(sinr,prbIdx,cellLoad){
        let lo=0,hi=SINR_TO_CQI.length-1;while(lo<=hi){const m=(lo+hi)>>1,e=SINR_TO_CQI[m];if(sinr<e.sinrMin)hi=m-1;else if(sinr>=e.sinrMax)lo=m+1;else{lo=m;break;}}
        const e=SINR_TO_CQI[lo];if(!e||e.cqi===0||!e.tbsIndex)return 0;
        const row=TBS_TABLE[e.tbsIndex];if(!row)return 0;
        const tbs=row[Math.min(prbIdx,row.length-1)];return tbs?(tbs*1000/1000000)*cellLoad:0;
    }
}

class FallbackMultiCoverageWorker extends FallbackBase {
    execute(data) {
        const { baseStations, gridParams } = data;
        const { resolution, minX, maxX, minY, maxY, minZ, maxZ } = gridParams;
        const MIN=-120, pts=[];
        const bc=new Int32Array(baseStations.length);
        const noise=makeNoiseTable(8); let ni=0;
        for(let x=minX;x<=maxX;x+=resolution){for(let z=minZ;z<=maxZ;z+=resolution){for(let y=minY;y<=maxY;y+=resolution){
            if(this.isCancelled)throw new Error('Analysis cancelled');
            const rx={x,y,z};let bestSig=-Infinity,bestBS=-1;
            baseStations.forEach((bs,i)=>{
                const dx=x-bs.position.x,dy=y-bs.position.y,dz=z-bs.position.z;
                if(dx*dx+dy*dy+dz*dz>bs.radius*bs.radius)return;
                const d2D=Math.sqrt(dx*dx+dz*dz),d3D=Math.sqrt(dx*dx+dy*dy+dz*dz);
                let pl=calcPathLoss(bs.environment,d2D,d3D,bs.frequency/1000,bs.txHeight,y);
                if(this.buildingData)pl+=calcBuildingPenetrationLoss(bs.position,rx,bs.frequency,this.buildingData);
                pl-=calcAntennaGain(bs.position,rx,bs.antennaAzimuth,bs.antennaBeamwidth,bs.antennaGain);
                pl+=noise[ni++&(NOISE_TABLE_SIZE-1)];
                const rxP=bs.txPower-pl;if(rxP>bestSig){bestSig=rxP;bestBS=i;}
            });
            if(bestSig>=MIN&&bestBS!==-1){pts.push({position:rx,signalStrength:bestSig,bsIndex:bestBS,color:BS_COLORS[bestBS%BS_COLORS.length]});bc[bestBS]++;}
        }}}
        const total=pts.length;
        return{coveragePoints:pts,coverageStats:baseStations.map((bs,i)=>({index:i,name:bs.name||`BS-${i+1}`,coveragePoints:bc[i],coveragePercentage:((bc[i]/total)*100).toFixed(2)})),totalCoveragePoints:total,pointsAnalyzed:total,totalPoints:total};
    }
}

class FallbackCrowdWorker extends FallbackBase {
    execute(data) {
        const {
            txPosition, crowdCenter, crowdRadius, peakDensity,
            sigma, weatherEffect, frequency, txPower, txHeight,
            environment, resolution
        } = data;
        const fcGHz     = frequency / 1000;
        const useModelB = fcGHz >= 6;
        const lambda    = 0.3 / fcGHz;
        const sigmaEff  = sigma || (crowdRadius * 0.5);
        const MIN_SIG   = -120;
        const noise = makeNoiseTable(6);
        let ni = 0;
        const crowdPoints = [];
        let totalSig = 0, maxSig = -Infinity, minSig = Infinity;

        for (let ox = -crowdRadius; ox <= crowdRadius; ox += resolution) {
            for (let oz = -crowdRadius; oz <= crowdRadius; oz += resolution) {
                const distC = Math.sqrt(ox*ox + oz*oz);
                if (distC > crowdRadius) continue;

                let localDensity = peakDensity * Math.exp(-(distC*distC)/(2*sigmaEff*sigmaEff));
                if (weatherEffect && distC > crowdRadius*0.5) {
                    const decay = (distC - crowdRadius*0.5)/(crowdRadius*0.5);
                    localDensity *= Math.max(0.25, 1.0 - 0.75*decay);
                }

                const wx=crowdCenter.x+ox, wy=1.5, wz=crowdCenter.z+oz;
                const rxPos={x:wx,y:wy,z:wz};
                const dxT=wx-txPosition.x, dyT=wy-txPosition.y, dzT=wz-txPosition.z;
                const d3D=Math.max(1,Math.sqrt(dxT*dxT+dyT*dyT+dzT*dzT));
                const d2D=Math.max(1,Math.sqrt(dxT*dxT+dzT*dzT));

                let pl = calcPathLoss(environment, d2D, d3D, fcGHz, txHeight, wy);
                if (this.buildingData) pl += calcBuildingPenetrationLoss(txPosition, rxPos, frequency, this.buildingData);

                let blockageLoss = 0;
                if (!useModelB) {
                    // Model A
                    const expB   = localDensity * d2D * 0.3;
                    const pBlock = 1.0 - Math.exp(-expB);
                    blockageLoss = pBlock * 15;
                } else {
                    // Model B – Fresnel screen
                    const d1=d3D/2, d2=d3D/2;
                    const losH   = wy + (txPosition.y - wy)*(d1/d3D);
                    const hExcess = 1.7 - losH;
                    let sloss = 0;
                    if (hExcess > 0) {
                        const nu = hExcess * Math.sqrt(2*(d1+d2)/(lambda*d1*d2));
                        sloss = Math.max(0, 6.02 + 9.11*nu + 1.27*nu*nu);
                    }
                    blockageLoss = Math.min(40, localDensity*d2D*0.3*sloss);
                }
                pl += blockageLoss;
                pl += noise[ni++&(NOISE_TABLE_SIZE-1)];

                const rxPow = txPower - pl;
                if (rxPow >= MIN_SIG && isFinite(rxPow)) {
                    crowdPoints.push({position:{x:wx,y:wy,z:wz}, signalStrength:rxPow, density:localDensity});
                    totalSig+=rxPow;
                    if(rxPow>maxSig)maxSig=rxPow;
                    if(rxPow<minSig)minSig=rxPow;
                }
            }
        }
        return {
            crowdPoints,
            positions: null, signals: null, densities: null,  // fallback uses crowdPoints array
            pointCount: crowdPoints.length,
            avgSignal:  crowdPoints.length>0 ? totalSig/crowdPoints.length : 0,
            maxSignal:  maxSig===-Infinity ? 0 : maxSig,
            minSignal:  minSig===Infinity  ? 0 : minSig,
            pointsAnalyzed: crowdPoints.length,
            totalPoints:    crowdPoints.length,
            modelUsed: useModelB ? 'B' : 'A'
        };
    }
}

// ── FallbackSINRWorker ────────────────────────────────────────
class FallbackSINRWorker extends FallbackBase {
    execute(data) {
        const {
            txPosition, radius = 100, resolution = 5, frequency = 2400,
            txPower = 20, noiseFloor = -95, interference = -90,
            txHeight = 25, environment = 'uma-los', cellTiers = 3
        } = data;

        const fcGHz      = frequency / 1000;
        const c          = 3e8;
        const minDist    = 1;
        const heightRange = radius * 0.3;

        const sinrPoints = [];
        let totalSinr = 0, maxSinr = -Infinity, minSinr = Infinity, count = 0;

        const interferingCells = cellTiers === 1 ? 6 : cellTiers === 3 ? 18 : 42;
        const tierAtt          = { 1: 1.0, 3: 0.7, 6: 0.5 }[cellTiers] || 1.0;
        const basePow          = Math.pow(10, interference / 10);
        const N_lin            = Math.pow(10, noiseFloor / 10);

        for (let x = -radius; x <= radius; x += resolution) {
            for (let z = -radius; z <= radius; z += resolution) {
                if (this.isCancelled) throw new Error('Analysis cancelled');
                const dist2D = Math.sqrt(x * x + z * z);
                if (dist2D > radius) continue;

                for (let y = 1.5; y <= heightRange; y += resolution) {
                    const dist3D = Math.max(Math.sqrt(x*x + z*z + Math.pow(txHeight - y, 2)), minDist);
                    let PL;
                    if (environment === 'uma-los') {
                        const dBp = (4 * txHeight * y * fcGHz * 1e9) / c;
                        if (dist2D >= 10 && dist2D <= dBp) {
                            PL = 28.0 + 22 * Math.log10(dist3D) + 20 * Math.log10(fcGHz);
                        } else if (dist2D > dBp) {
                            const term = Math.pow(dBp, 2) + Math.pow(txHeight - y, 2);
                            PL = 28.0 + 40 * Math.log10(dist3D) + 20 * Math.log10(fcGHz) - 9 * Math.log10(Math.max(term, 1e-6));
                        } else {
                            PL = 32.4 + 20 * Math.log10(fcGHz) + 30 * Math.log10(dist3D);
                        }
                    } else {
                        PL = 13.54 + 39.08 * Math.log10(Math.max(dist3D, 1)) + 20 * Math.log10(fcGHz) - 0.6 * (y - 1.5);
                    }
                    PL += (Math.random() - 0.5) * 8;

                    const S_lin = Math.pow(10, (txPower - PL) / 10);
                    const I_lin = basePow * tierAtt;  
                    const sinr_dB = Math.max(-20, Math.min(30, 10 * Math.log10(S_lin / (I_lin + N_lin))));

                    sinrPoints.push({
                        position: { x: txPosition.x + x, y, z: txPosition.z + z },
                        sinr: sinr_dB
                    });
                    totalSinr += sinr_dB;
                    if (sinr_dB > maxSinr) maxSinr = sinr_dB;
                    if (sinr_dB < minSinr) minSinr = sinr_dB;
                    count++;
                }
            }
        }

        return {
            sinrPoints,
            avgSinr:        count > 0 ? totalSinr / count : 0,
            maxSinr:        maxSinr === -Infinity ? 0 : maxSinr,
            minSinr:        minSinr ===  Infinity ? 0 : minSinr,
            pointsAnalyzed: count
        };
    }
}

// ── FallbackFairnessWorker ────────────────────────────────────
class FallbackFairnessWorker extends FallbackBase {
    execute(data) {
        const { sinrPoints = [], totalBandwidth = 100 } = data;
        if (!Array.isArray(sinrPoints) || sinrPoints.length === 0) {
            throw new Error('No SINR points provided for fairness analysis');
        }

        const throughputMap = [], loadMap = [], congestionMap = [], throughputValues = [];
        let sumThroughput = 0, sumThroughputSq = 0, congestedCount = 0;
        const stats        = { underloaded: 0, balanced: 0, overloaded: 0 };
        const satisfaction = { good: 0, moderate: 0, poor: 0 };
        const distribution = { high: 0, medium: 0, low: 0 };
        let criticalCount  = 0;

        for (const { position, sinr } of sinrPoints) {
            if (this.isCancelled) throw new Error('Analysis cancelled');
            const users        = Math.floor(Math.random() * 46) + 5;
            const baseTp       = totalBandwidth / users;
            const eff          = sinr > 20 ? 1.0 : sinr >= 10 ? 0.7 : sinr >= 0 ? 0.4 : 0.1;
            const finalTp      = baseTp * eff;
            const congested    = users >= 35 && finalTp <= baseTp * 0.4;

            if (users <= 20 && finalTp >= baseTp * 0.7) stats.underloaded++;
            else if (congested) stats.overloaded++;
            else stats.balanced++;

            if (congested) congestedCount++;
            if      (finalTp > 5)  satisfaction.good++;
            else if (finalTp >= 2) satisfaction.moderate++;
            else                   satisfaction.poor++;

            if      (finalTp >= 8) distribution.high++;
            else if (finalTp >= 4) distribution.medium++;
            else                   distribution.low++;

            if (finalTp < 2 || congested) criticalCount++;

            throughputValues.push(finalTp);
            throughputMap.push({ position, users, throughput: finalTp, congested });
            loadMap.push({ position, users, loadClass: congested ? 'Overloaded' : users <= 20 ? 'Underloaded' : 'Balanced' });
            congestionMap.push({ position, congested });
            sumThroughput   += finalTp;
            sumThroughputSq += finalTp * finalTp;
        }

        const n            = sinrPoints.length;
        const avgThroughput = n > 0 ? sumThroughput / n : 0;
        const fairnessValue = sumThroughputSq > 0 ? (sumThroughput * sumThroughput) / (n * sumThroughputSq) : 0;
        const congestedPercent = n > 0 ? (congestedCount / n) * 100 : 0;
        const sorted       = throughputValues.slice().sort((a, b) => a - b);
        const minThroughput = sorted[0] ?? 0;
        const p5Throughput  = sorted[Math.max(0, Math.floor(n * 0.05) - 1)] ?? 0;
        const efficiencyScore = Math.round(
            (Math.min(1, fairnessValue) * 0.4 +
             Math.min(1, avgThroughput / 20) * 0.4 +
             Math.max(0, 1 - congestedPercent / 100) * 0.2) * 100
        );
        const insightText = fairnessValue >= 0.8 && congestedPercent < 10
            ? 'Network is highly fair and well-balanced'
            : fairnessValue < 0.6 || congestedPercent >= 25
                ? 'Low fairness, network needs optimization'
                : 'Moderate fairness with potential congestion risks';

        return {
            throughputMap, loadMap, congestionMap,
            fairnessValue, avgThroughput, pointsAnalyzed: n,
            congestedPercent, stats, satisfaction, distribution,
            minThroughput, p5Throughput, criticalCount, efficiencyScore, insightText
        };
    }
}

const workerManager = new WorkerManager();
window.workerManager = workerManager; 
