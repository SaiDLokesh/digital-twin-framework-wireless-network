// bs-optimiser-worker.js
// Genetic Algorithm — Minimise BS Count while achieving full-map RSSI coverage
// Changes vs original:
//   • Progress sent EVERY generation (not every 5) — includes best gene positions for live map
//   • Coverage-gap BS injection: after 80 gens, if coverage still short, add extra BSs and re-run
//       gap ≥ 15% → +2 BS   |   gap ≥ 25% → +3 BS   |   gap ≥ 40% → +4 BS   |   gap ≥ 50% → +5 BS
//   • Stop immediately when coverage ≥ 100% (99.99%) at any generation
importScripts('path-loss-models.js');

// ── GA hyper-parameters ───────────────────────────────────────
const POP_SIZE        = 50;
const MAX_GENERATIONS = 80;
const ELITISM_COUNT   = 5;
const TOURNAMENT_K    = 5;
const CROSSOVER_RATE  = 0.80;
const MUTATION_RATE   = 0.18;
const POSITION_SIGMA  = 0.25;
const BS_PENALTY      = 0.015;
const FULL_COVERAGE   = 99.99;   // treat as "100%" — stop early

class BSOptimiserWorker {
    constructor() {
        this.buildingData = null;
        this.crowdData    = [];   // populated from 'start' payload each run
        this.isCancelled  = false;
        self.addEventListener('message', this.handleMessage.bind(this));
    }

    handleMessage(e) {
        const { type, data, taskId } = e.data;
        if (type === 'init') {
            this.buildingData = data.buildingData;
            // crowdData may be updated per-run via the start payload instead,
            // but also accept it here for pre-init use cases.
            if (data.crowdData) this.crowdData = data.crowdData;
            return;
        }
        if (type === 'cancel') { this.isCancelled = true; return; }
        if (type === 'start')  { this.isCancelled = false; this.run(data, taskId); }
    }

    async run(data, taskId) {
        try {
            const {
                maxBS,
                bsTemplate,
                mapBounds,
                evalResolution,
                minRSSI,
                minSpacing,
                crowdData = []
            } = data;

            // Store crowd data on instance so fitness/coveragePct helpers can access it
            this.crowdData = crowdData;

            const fcGHz   = bsTemplate.frequency / 1000;
            const txH     = bsTemplate.txHeight;
            const radius  = bsTemplate.radius;
            const txPower = bsTemplate.txPower;
            const env     = bsTemplate.environment;

            const evalPts  = this.buildEvalGrid(mapBounds, evalResolution);
            const noise    = makeNoiseTable(4);

            // ── Phase tracking — we may run multiple phases if coverage is poor ──
            let currentMaxBS = maxBS;
            let phase        = 1;
            let totalGenSent = 0;  // global generation counter across phases

            let bestEver    = null;
            let bestFitness = -Infinity;
            let bestCovPct  = 0;
            let bestBSCount = currentMaxBS;
            const history   = [];

            // Run phases until 100% coverage or no more BS injections to do
            while (true) {
                if (this.isCancelled) throw new Error('Optimisation cancelled');

                let population = this.initPopulation(
                    POP_SIZE, currentMaxBS, mapBounds, minSpacing, radius,
                    // Warm-start from previous best if we're in a later phase
                    bestEver ? bestEver.filter(g => g.active) : null
                );

                // Reset per-phase tracking but keep global best
                let phaseBestFitness = -Infinity;
                let phaseBestEver    = null;

                let gen10RestartDone = false;  // allow at most one gen-10 restart per phase

                for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
                    if (this.isCancelled) throw new Error('Optimisation cancelled');

                    // ── Evaluate all individuals ──
                    const evaluated = population.map(ind => ({
                        individual: ind,
                        fitness: this.fitness(ind, txPower, fcGHz, txH, radius, env,
                                             evalPts, minRSSI, noise, gen * evalPts.length)
                    }));
                    evaluated.sort((a, b) => b.fitness - a.fitness);

                    // Track global best
                    if (evaluated[0].fitness > bestFitness) {
                        bestFitness = evaluated[0].fitness;
                        bestEver    = this.deepClone(evaluated[0].individual);
                        const active = bestEver.filter(g => g.active);
                        bestBSCount  = active.length;
                        bestCovPct   = this.coveragePct(
                            active, txPower, fcGHz, txH, radius, env, evalPts, minRSSI, noise, 0
                        );
                    }

                    const avgFit    = evaluated.reduce((s, e) => s + e.fitness, 0) / evaluated.length;
                    const topActive = evaluated[0].individual.filter(g => g.active);
                    const globalGen = totalGenSent + gen;  // cumulative generation number

                    history.push({
                        generation:    globalGen,
                        best:          evaluated[0].fitness,
                        avg:           avgFit,
                        covPct:        bestCovPct,
                        activeBSCount: topActive.length
                    });

                    const coverageGap = Math.max(0, 100 - bestCovPct);

                    // ── Send progress EVERY generation (with cumulative gen number) ──
                    self.postMessage({
                        type: 'progress', taskId,
                        progress: Math.round(((gen + 1) / MAX_GENERATIONS) * 100),
                        data: {
                            generation:    globalGen,
                            maxGenerations: MAX_GENERATIONS,
                            phase,
                            bestFitness:   bestFitness.toFixed(4),
                            coveragePct:   bestCovPct.toFixed(1),
                            coverageGap:   coverageGap.toFixed(1),
                            activeBSCount: bestBSCount,
                            // Send current best BS positions for the live 2D map
                            livePlacement: bestEver
                                ? bestEver.filter(g => g.active).map(g => ({ x: g.x, z: g.z }))
                                : []
                        }
                    });
                    await yieldToEventLoop();

                    // ── Stop immediately at full coverage ──
                    if (bestCovPct >= FULL_COVERAGE) break;

                    // ── Gen-10 early check: if coverage < 75%, inject BS and restart phase ──
                    if (gen === 9 && !gen10RestartDone && bestCovPct < 75) {
                        gen10RestartDone = true;
                        const injectEarly = bestCovPct < 40 ? 3 : bestCovPct < 60 ? 2 : 1;
                        currentMaxBS += injectEarly;
                        phase++;

                        self.postMessage({
                            type: 'progress', taskId,
                            progress: 0,
                            data: {
                                generation:      globalGen,
                                maxGenerations:  MAX_GENERATIONS,
                                phase,
                                phaseTransition: true,
                                gen10Restart:    true,
                                injectedBS:      injectEarly,
                                newMaxBS:        currentMaxBS,
                                bestFitness:     bestFitness.toFixed(4),
                                coveragePct:     bestCovPct.toFixed(1),
                                coverageGap:     coverageGap.toFixed(1),
                                activeBSCount:   bestBSCount,
                                livePlacement:   bestEver
                                    ? bestEver.filter(g => g.active).map(g => ({ x: g.x, z: g.z }))
                                    : []
                            }
                        });
                        await yieldToEventLoop();

                        // Reinitialise population with more BSs and break inner loop to restart phase
                        population = this.initPopulation(
                            POP_SIZE, currentMaxBS, mapBounds, minSpacing, radius,
                            bestEver ? bestEver.filter(g => g.active) : null
                        );
                        totalGenSent += (gen + 1);
                        break;
                    }

                    if (gen === MAX_GENERATIONS - 1) break;

                    // Breed next generation
                    const next = [];
                    for (let i = 0; i < ELITISM_COUNT; i++)
                        next.push(this.deepClone(evaluated[i].individual));
                    while (next.length < POP_SIZE) {
                        const p1    = this.tournament(evaluated);
                        const p2    = this.tournament(evaluated);
                        let   child = Math.random() < CROSSOVER_RATE
                            ? this.crossover(p1, p2)
                            : this.deepClone(p1);
                        child = this.mutate(child, mapBounds);
                        next.push(child);
                    }
                    population = next;
                }

                // Only add full MAX_GENERATIONS if we didn't restart mid-phase at gen 10
                // (gen-10 restart already advanced totalGenSent inside the inner loop)
                if (!gen10RestartDone) {
                    totalGenSent += MAX_GENERATIONS;
                } else {
                    gen10RestartDone = false;  // reset for next phase, totalGenSent already updated
                }

                // ── Full coverage → done ──
                if (bestCovPct >= FULL_COVERAGE) break;

                // ── Coverage-gap BS injection rule ──
                const gap = 100 - bestCovPct;
                let inject = 0;
                if      (gap >= 50) inject = 5;
                else if (gap >= 40) inject = 4;
                else if (gap >= 25) inject = 3;
                else if (gap >= 15) inject = 2;

                if (inject === 0) break;   // gap < 15% — GA is doing fine, finish

                currentMaxBS += inject;
                phase++;

                // Post a phase-transition progress message so UI can update the sweep label
                self.postMessage({
                    type: 'progress', taskId,
                    progress: 0,
                    data: {
                        generation:     totalGenSent,
                        maxGenerations: MAX_GENERATIONS,
                        phase,
                        phaseTransition: true,
                        injectedBS:      inject,
                        newMaxBS:        currentMaxBS,
                        bestFitness:     bestFitness.toFixed(4),
                        coveragePct:     bestCovPct.toFixed(1),
                        coverageGap:     gap.toFixed(1),
                        activeBSCount:   bestBSCount,
                        livePlacement:   bestEver
                            ? bestEver.filter(g => g.active).map(g => ({ x: g.x, z: g.z }))
                            : []
                    }
                });
                await yieldToEventLoop();
            }

            // ── Final detailed evaluation ──
            const activeGenes = bestEver ? bestEver.filter(g => g.active) : [];
            const finalDetail = this.detailedEval(
                activeGenes, txPower, fcGHz, txH, radius, env, evalPts, minRSSI
            );

            self.postMessage({
                type: 'complete', taskId,
                data: {
                    bestPlacement:  activeGenes.map(g => ({ x: g.x, z: g.z })),
                    activeBSCount:  activeGenes.length,
                    bestFitness,
                    history,
                    finalStats:     finalDetail,
                    bsTemplate,
                    mapBounds,
                    minRSSI,
                    totalPhases:    phase
                }
            });

        } catch (err) {
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }

    // ── Evaluation grid ───────────────────────────────────────
    buildEvalGrid({ minX, maxX, minZ, maxZ }, res) {
        const pts = [];
        for (let x = minX; x <= maxX; x += res)
            for (let z = minZ; z <= maxZ; z += res)
                pts.push({ x, y: 1.5, z });
        return pts;
    }

    // ── Population initialisation ─────────────────────────────
    // warmSeeds: array of {x,z} from previous phase's best — injected as active genes
    initPopulation(size, maxBS, bounds, minSpacing, radius, warmSeeds) {
        const pop = [];

        const hexPts = this.hexagonalGrid(bounds, radius * 0.85, maxBS);

        // Individual 0: hex grid (or warm-seeded hex if we have prior positions)
        if (warmSeeds && warmSeeds.length > 0) {
            // Fill from warm seeds first, then pad with hex positions
            const combined = [
                ...warmSeeds,
                ...hexPts.filter((_, i) => i >= warmSeeds.length)
            ];
            pop.push(this.layoutToChromosome(combined, maxBS, bounds));
        } else {
            pop.push(this.layoutToChromosome(hexPts, maxBS, bounds));
        }

        // Individuals 1–7: perturbed hex with some deactivated
        for (let i = 1; i < Math.min(8, size); i++) {
            const base = warmSeeds && warmSeeds.length > 0
                ? [...warmSeeds, ...hexPts].slice(0, maxBS)
                : hexPts;
            const perturbed = base.map(p => ({
                x: p.x + (Math.random() - 0.5) * radius * 0.4,
                z: p.z + (Math.random() - 0.5) * radius * 0.4
            }));
            const chromo = this.layoutToChromosome(perturbed, maxBS, bounds);
            const toDeactivate = Math.floor(Math.random() * maxBS * 0.4);
            for (let d = 0; d < toDeactivate; d++) {
                chromo[Math.floor(Math.random() * maxBS)].active = false;
            }
            pop.push(chromo);
        }

        while (pop.length < size) {
            pop.push(this.randomChromosome(maxBS, bounds, warmSeeds));
        }
        return pop;
    }

    hexagonalGrid({ minX, maxX, minZ, maxZ }, spacing, maxPts) {
        const pts  = [];
        const rowH = spacing * Math.sqrt(3) / 2;
        let   row  = 0;
        for (let z = minZ; z <= maxZ + spacing; z += rowH) {
            const offset = (row % 2) * spacing / 2;
            for (let x = minX + offset; x <= maxX + spacing; x += spacing) {
                if (pts.length >= maxPts) break;
                pts.push({ x, z });
            }
            if (pts.length >= maxPts) break;
            row++;
        }
        return pts;
    }

    layoutToChromosome(layout, maxBS, { minX, maxX, minZ, maxZ }) {
        return Array.from({ length: maxBS }, (_, i) => {
            if (i < layout.length) {
                return {
                    x:      Math.max(minX, Math.min(maxX, layout[i].x)),
                    z:      Math.max(minZ, Math.min(maxZ, layout[i].z)),
                    active: true
                };
            }
            return {
                x:      minX + Math.random() * (maxX - minX),
                z:      minZ + Math.random() * (maxZ - minZ),
                active: false
            };
        });
    }

    randomChromosome(maxBS, { minX, maxX, minZ, maxZ }, warmSeeds) {
        const numActive = 1 + Math.floor(Math.random() * maxBS);
        return Array.from({ length: maxBS }, (_, i) => {
            // Reuse a warm seed position randomly
            const useWarm = warmSeeds && warmSeeds.length > 0 && Math.random() < 0.3;
            const seed    = useWarm ? warmSeeds[Math.floor(Math.random() * warmSeeds.length)] : null;
            return {
                x:      seed ? seed.x + (Math.random()-0.5)*50 : minX + Math.random() * (maxX - minX),
                z:      seed ? seed.z + (Math.random()-0.5)*50 : minZ + Math.random() * (maxZ - minZ),
                active: i < numActive
            };
        });
    }

    // ── Fitness ───────────────────────────────────────────────
    fitness(individual, txPower, fcGHz, txH, radius, env, evalPts, minRSSI, noise, noiseOff) {
        const active   = individual.filter(g => g.active);
        if (!active.length) return 0;
        const radiusSq = radius * radius;
        let   covered  = 0;

        for (let pi = 0; pi < evalPts.length; pi++) {
            const pt  = evalPts[pi];
            let   best = -Infinity;
            for (let bi = 0; bi < active.length; bi++) {
                const g  = active[bi];
                const dx = pt.x - g.x, dz = pt.z - g.z, dy = pt.y - txH;
                if (dx*dx + dz*dz + dy*dy > radiusSq) continue;
                const d2D = Math.sqrt(dx*dx + dz*dz);
                const d3D = Math.sqrt(d2D*d2D + dy*dy);
                let pl = calcPathLoss(env, d2D, d3D, fcGHz, txH, pt.y);
                if (this.buildingData)
                    pl += calcBuildingPenetrationLoss(
                        { x: g.x, y: txH, z: g.z }, pt, fcGHz * 1000, this.buildingData
                    );
                // Apply crowd blockage loss
                if (this.crowdData && this.crowdData.length > 0) {
                    let crowdLoss = 0;
                    for (const crowd of this.crowdData) {
                        const dxC = pt.x - crowd.center.x;
                        const dzC = pt.z - crowd.center.z;
                        const dist2D = Math.sqrt(dxC*dxC + dzC*dzC);
                        if (dist2D <= crowd.radius) {
                            const sigma = crowd.radius * 0.5;
                            const density = crowd.density * Math.exp(-(dist2D*dist2D)/(2*sigma*sigma));
                            const expectedB = density * d2D * 0.3;
                            const pBlock = 1 - Math.exp(-expectedB);
                            crowdLoss += pBlock * 15;
                        }
                    }
                    pl += Math.min(crowdLoss, 30);
                }
                pl += noise[(noiseOff + pi * active.length + bi) & (NOISE_TABLE_SIZE - 1)];
                const rxP = txPower - pl;
                if (rxP > best) best = rxP;
            }
            if (best >= minRSSI) covered++;
        }
        return (covered / (evalPts.length || 1)) - active.length * BS_PENALTY;
    }

    coveragePct(active, txPower, fcGHz, txH, radius, env, evalPts, minRSSI, noise, noiseOff) {
        if (!active.length) return 0;
        const radiusSq = radius * radius;
        let   covered  = 0;
        for (let pi = 0; pi < evalPts.length; pi++) {
            const pt   = evalPts[pi];
            let   best = -Infinity;
            for (const g of active) {
                const dx = pt.x-g.x, dz = pt.z-g.z, dy = pt.y-txH;
                if (dx*dx+dz*dz+dy*dy > radiusSq) continue;
                const d2D = Math.sqrt(dx*dx+dz*dz);
                const d3D = Math.sqrt(d2D*d2D+dy*dy);
                let pl = calcPathLoss(env, d2D, d3D, fcGHz, txH, pt.y);
                // Apply building penetration loss (same as fitness())
                if (this.buildingData)
                    pl += calcBuildingPenetrationLoss(
                        { x: g.x, y: txH, z: g.z }, pt, fcGHz * 1000, this.buildingData
                    );
                // Apply crowd blockage loss
                if (this.crowdData && this.crowdData.length > 0) {
                    let crowdLoss = 0;
                    for (const crowd of this.crowdData) {
                        const dxC = pt.x - crowd.center.x;
                        const dzC = pt.z - crowd.center.z;
                        const dist2D = Math.sqrt(dxC*dxC + dzC*dzC);
                        if (dist2D <= crowd.radius) {
                            const sigma = crowd.radius * 0.5;
                            const density = crowd.density * Math.exp(-(dist2D*dist2D)/(2*sigma*sigma));
                            const expectedB = density * d2D * 0.3;
                            const pBlock = 1 - Math.exp(-expectedB);
                            crowdLoss += pBlock * 15;
                        }
                    }
                    pl += Math.min(crowdLoss, 30);
                }
                const rxP = txPower - pl;
                if (rxP > best) best = rxP;
            }
            if (best >= minRSSI) covered++;
        }
        return (covered / (evalPts.length || 1)) * 100;
    }

    detailedEval(active, txPower, fcGHz, txH, radius, env, evalPts, minRSSI) {
        const radiusSq = radius * radius;
        let covered = 0, sigSum = 0;
        const bsCounts  = new Array(active.length).fill(0);
        const uncovered = [];

        for (let pi = 0; pi < evalPts.length; pi++) {
            const pt = evalPts[pi];
            let best = -Infinity, bestBS = -1;
            for (let bi = 0; bi < active.length; bi++) {
                const g  = active[bi];
                const dx = pt.x-g.x, dz = pt.z-g.z, dy = pt.y-txH;
                if (dx*dx+dz*dz+dy*dy > radiusSq) continue;
                const d2D = Math.sqrt(dx*dx+dz*dz);
                const d3D = Math.sqrt(d2D*d2D+dy*dy);
                let pl = calcPathLoss(env, d2D, d3D, fcGHz, txH, pt.y);
                if (this.buildingData)
                    pl += calcBuildingPenetrationLoss(
                        { x: g.x, y: txH, z: g.z }, pt, fcGHz*1000, this.buildingData
                    );
                if (this.crowdData && this.crowdData.length > 0) {
                    let crowdLoss = 0;
                    for (const crowd of this.crowdData) {
                        const dxC = pt.x - crowd.center.x;
                        const dzC = pt.z - crowd.center.z;
                        const dist2D = Math.sqrt(dxC*dxC + dzC*dzC);
                        if (dist2D <= crowd.radius) {
                            const sigma = crowd.radius * 0.5;
                            const density = crowd.density * Math.exp(-(dist2D*dist2D)/(2*sigma*sigma));
                            const expectedB = density * d2D * 0.3;
                            const pBlock = 1 - Math.exp(-expectedB);
                            crowdLoss += pBlock * 15;
                        }
                    }
                    pl += Math.min(crowdLoss, 30);
                }
                const rxP = txPower - pl;
                if (rxP > best) { best = rxP; bestBS = bi; }
            }
            if (best >= minRSSI && bestBS !== -1) {
                covered++; sigSum += best; bsCounts[bestBS]++;
            } else if (uncovered.length < 300) {
                uncovered.push({ x: pt.x, z: pt.z });
            }
        }
        return {
            coveredPoints:   covered,
            totalPoints:     evalPts.length,
            coveragePct:     (covered / (evalPts.length || 1)) * 100,
            avgSignal:       covered > 0 ? sigSum / covered : minRSSI,
            bsCounts,
            uncoveredSample: uncovered
        };
    }

    // ── GA operators ──────────────────────────────────────────
    tournament(evaluated) {
        let best = null;
        for (let i = 0; i < TOURNAMENT_K; i++) {
            const c = evaluated[Math.floor(Math.random() * evaluated.length)];
            if (!best || c.fitness > best.fitness) best = c;
        }
        return this.deepClone(best.individual);
    }

    crossover(p1, p2) {
        return p1.map((g, i) => ({
            x:      Math.random() < 0.5 ? g.x : p2[i].x,
            z:      Math.random() < 0.5 ? g.z : p2[i].z,
            active: g.active || p2[i].active
        }));
    }

    mutate(individual, { minX, maxX, minZ, maxZ }) {
        const rX = maxX - minX, rZ = maxZ - minZ;
        return individual.map(g => {
            const gene = { ...g };
            if (Math.random() < MUTATION_RATE) {
                gene.x = gene.x + this.gauss() * rX * POSITION_SIGMA;
                gene.z = gene.z + this.gauss() * rZ * POSITION_SIGMA;
                gene.x = Math.max(minX, Math.min(maxX, gene.x));
                gene.z = Math.max(minZ, Math.min(maxZ, gene.z));
            }
            if (Math.random() < 0.05) {
                gene.x = minX + Math.random() * rX;
                gene.z = minZ + Math.random() * rZ;
            }
            if (Math.random() < MUTATION_RATE * 0.6) {
                const activeCount = individual.filter(g => g.active).length;
                if (gene.active && activeCount > 1) gene.active = false;
                else if (!gene.active) gene.active = Math.random() < 0.45;
            }
            return gene;
        });
    }

    gauss() {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    }

    deepClone(o) { return JSON.parse(JSON.stringify(o)); }
}

function yieldToEventLoop() { return new Promise(r => setTimeout(r, 0)); }
new BSOptimiserWorker();
