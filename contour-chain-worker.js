// contour-chain-worker.js – Pure Matrix-Based Coverage Algorithm 
// ═══════════════════════════════════════════════════════════════════
// Now with crowd blockage loss (3GPP TR 38.901 Model A)
// Receives optional `crowdData` array: [{ center: {x,z}, radius, density }]

importScripts('path-loss-models.js');

const ENV_SCALE = {
    'uma-los': 1.00, 'uma-nlos': 0.65, 'umi-los': 0.80, 'umi-nlos': 0.50
};

// Fixed grid resolution
const GRID_RESOLUTION = 10; // 10 meters per cell

// Block sizes
const BLOCK_SIZE_METERS = 100; // 100 meters for auto-fill
const BS_QUALITY_RADIUS = 200; // 200 meters radius for BS quality check
const CELLS_PER_BLOCK = BLOCK_SIZE_METERS / GRID_RESOLUTION; // 10 cells
const CELLS_PER_QUALITY_RADIUS = BS_QUALITY_RADIUS / GRID_RESOLUTION; // 20 cells radius

// Auto-fill threshold: 30% of block filled = mark as -1
const AUTO_FILL_THRESHOLD = 0.30;

// BS quality threshold: BS must cover at least 50% NEW cells in its 200m radius circle
const BS_QUALITY_THRESHOLD = 0.50;

class MatrixCoverageWorker {
    constructor() {
        this.buildingData = null;
        this.isCancelled = false;
        this.matrix = null;
        this.rows = 0;
        this.cols = 0;
        
        // COUNTERS - Track every scan
        this.scanCounters = {
            totalPositionsScanned: 0,      // Total BS positions evaluated
            acceptedPositions: 0,           // BS positions accepted
            rejectedPositions: 0,           // BS positions rejected (quality fail)
            unusablePositions: 0,           // Positions marked -2
            autoFilledPositions: 0,         // Cells auto-filled
            qualityChecks: 0,               // Quality metric calculations
            anchorAttempts: 0,              // Anchor placement attempts
            totalBSPlaced: 0                // Total BS successfully placed
        };
        
        self.addEventListener('message', this.handleMessage.bind(this));
    }

    handleMessage(e) {
        const { type, data, taskId } = e.data;
        if (type === 'init') { 
            this.buildingData = data.buildingData; 
            console.log('Building data:', this.buildingData ? `${this.buildingData.buildings.length} buildings` : 'No buildings');
            return; 
        }
        if (type === 'cancel') { this.isCancelled = true; return; }
        if (type === 'start') { 
            this.isCancelled = false;
            this.resetCounters();
            this.run(data, taskId); 
        }
    }
    
    resetCounters() {
        this.scanCounters = {
            totalPositionsScanned: 0,
            acceptedPositions: 0,
            rejectedPositions: 0,
            unusablePositions: 0,
            autoFilledPositions: 0,
            qualityChecks: 0,
            anchorAttempts: 0,
            totalBSPlaced: 0
        };
    }

    async run(data, taskId) {
        try {
            const { bsTemplate, mapBounds, minRSSI, targetCoverage = 99, crowdData = [] } = data;
            const { txPower, frequency, txHeight, radius, environment } = bsTemplate;
            const fcGHz = frequency / 1000;
            const effR = radius;
            
            const { minX, minZ, maxX, maxZ } = mapBounds;
            
            const mapWidthMeters = maxX - minX;
            const mapDepthMeters = maxZ - minZ;
            
            // Create matrix
            this.cols = Math.ceil(mapWidthMeters / GRID_RESOLUTION) + 1;
            this.rows = Math.ceil(mapDepthMeters / GRID_RESOLUTION) + 1;
            this.matrix = Array(this.rows).fill().map(() => Array(this.cols).fill(0));
            
            const totalCells = this.rows * this.cols;
            console.log(`\n╔════════════════════════════════════════════════════════════╗`);
            console.log(`║  MATRIX COVERAGE ALGORITHM - COMPLETE VERSION           ║`);
            console.log(`╠════════════════════════════════════════════════════════════╣`);
            console.log(`║ Matrix: ${this.rows}x${this.cols} = ${totalCells} cells, ${GRID_RESOLUTION}m each`);
            console.log(`║ Quality radius: ${BS_QUALITY_RADIUS}m (${CELLS_PER_QUALITY_RADIUS} cells)`);
            console.log(`║ Auto-fill: ${AUTO_FILL_THRESHOLD*100}% of 100m block`);
            console.log(`║ BS quality: ${BS_QUALITY_THRESHOLD*100}% NEW coverage required`);
            console.log(`║ Map bounds: X[${minX.toFixed(0)},${maxX.toFixed(0)}] Z[${minZ.toFixed(0)},${maxZ.toFixed(0)}]`);
            console.log(`║ Crowd zones: ${crowdData.length}`);
            console.log(`╚════════════════════════════════════════════════════════════╝\n`);
            
            const placedBS = [];
            const rejectedBS = [];
            let stepNum = 0;
            let totalCellsCovered = 0;
            
            // Helper: Get cell coordinates
            const getCellPos = (row, col) => ({
                x: minX + col * GRID_RESOLUTION,
                z: minZ + row * GRID_RESOLUTION,
                y: 1.5
            });
            
            // Helper: Calculate RSSI including building and crowd loss
            const calculateRSSI = (bsPos, cellX, cellZ) => {
                const dx = cellX - bsPos.x;
                const dz = cellZ - bsPos.z;
                const dy = 1.5 - txHeight;
                const d2d = Math.sqrt(dx*dx + dz*dz);
                const d3d = Math.sqrt(d2d*d2d + dy*dy);
                
                let pl = calcPathLoss(environment, d2d, d3d, fcGHz, txHeight, 1.5);
                
                // Building penetration loss
                if (this.buildingData && this.buildingData.buildings && this.buildingData.buildings.length > 0) {
                    const buildingLoss = calcBuildingPenetrationLoss(
                        { x: bsPos.x, y: txHeight, z: bsPos.z }, 
                        { x: cellX, y: 1.5, z: cellZ }, 
                        frequency, 
                        this.buildingData
                    );
                    pl += buildingLoss;
                }
                
                // ── Crowd blockage loss (3GPP Model A) ─────────────────
                let crowdLoss = 0;
                for (const crowd of crowdData) {
                    const dxC = cellX - crowd.center.x;
                    const dzC = cellZ - crowd.center.z;
                    const dist2D = Math.sqrt(dxC*dxC + dzC*dzC);
                    if (dist2D <= crowd.radius) {
                        const sigma = crowd.radius * 0.5;
                        const density = crowd.density * Math.exp(-(dist2D*dist2D) / (2*sigma*sigma));
                        const expectedB = density * d2d * 0.3;   // shoulder width 0.3m
                        const pBlock = 1 - Math.exp(-expectedB);
                        crowdLoss += pBlock * 15;   // 15 dB per blocker
                    }
                }
                crowdLoss = Math.min(crowdLoss, 30);  // cap at 30 dB
                pl += crowdLoss;
                // ───────────────────────────────────────────────────────
                
                return txPower - pl;
            };
            
            // Helper: Check if cell is covered by a BS
            const isCellCoveredByBS = (cellX, cellZ, bsPos) => {
                const rssi = calculateRSSI(bsPos, cellX, cellZ);
                return rssi >= minRSSI;
            };
            
            // Calculate NEW coverage in 200m radius around BS
            const getBSQualityMetrics = (bsPos) => {
                this.scanCounters.qualityChecks++;
                
                const centerRow = Math.floor((bsPos.z - minZ) / GRID_RESOLUTION);
                const centerCol = Math.floor((bsPos.x - minX) / GRID_RESOLUTION);
                const radiusCells = Math.floor(BS_QUALITY_RADIUS / GRID_RESOLUTION);
                
                let totalInRadius = 0;
                let newCoverageCount = 0;
                let overlapCount = 0;
                let uncoveredCount = 0;
                
                for (let dr = -radiusCells; dr <= radiusCells; dr++) {
                    for (let dc = -radiusCells; dc <= radiusCells; dc++) {
                        const distanceMeters = Math.sqrt(dr*dr + dc*dc) * GRID_RESOLUTION;
                        if (distanceMeters > BS_QUALITY_RADIUS) continue;
                        
                        const row = centerRow + dr;
                        const col = centerCol + dc;
                        
                        if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
                            totalInRadius++;
                            const cellPos = getCellPos(row, col);
                            const isCoveredByThisBS = isCellCoveredByBS(cellPos.x, cellPos.z, bsPos);
                            
                            if (isCoveredByThisBS) {
                                if (this.matrix[row][col] === 0) {
                                    newCoverageCount++;
                                } else if (this.matrix[row][col] === 1 || this.matrix[row][col] === -1) {
                                    overlapCount++;
                                }
                            } else {
                                if (this.matrix[row][col] === 0) {
                                    uncoveredCount++;
                                }
                            }
                        }
                    }
                }
                
                const newCoveragePercentage = totalInRadius > 0 ? newCoverageCount / totalInRadius : 0;
                const overlapPercentage = totalInRadius > 0 ? overlapCount / totalInRadius : 0;
                const isAcceptable = newCoveragePercentage >= BS_QUALITY_THRESHOLD;
                
                return {
                    isAcceptable,
                    newCoveragePercentage,
                    overlapPercentage,
                    newCoverageCount,
                    overlapCount,
                    totalInRadius,
                    uncoveredCount
                };
            };
            
            // Update matrix with new BS
            const updateMatrixWithBS = (pos) => {
                let newlyCovered = 0;
                
                for (let row = 0; row < this.rows; row++) {
                    for (let col = 0; col < this.cols; col++) {
                        if (this.matrix[row][col] === 0 || this.matrix[row][col] === -1) {
                            const cellPos = getCellPos(row, col);
                            if (isCellCoveredByBS(cellPos.x, cellPos.z, pos)) {
                                this.matrix[row][col] = 1;
                                newlyCovered++;
                            }
                        }
                    }
                }
                
                totalCellsCovered += newlyCovered;
                return newlyCovered;
            };
            
            // Auto-fill 100m blocks at 30% coverage
            const autoFillBlocks = () => {
                let filled = 0;
                
                const blocksX = Math.ceil(mapWidthMeters / BLOCK_SIZE_METERS);
                const blocksZ = Math.ceil(mapDepthMeters / BLOCK_SIZE_METERS);
                
                for (let blockZ = 0; blockZ < blocksZ; blockZ++) {
                    for (let blockX = 0; blockX < blocksX; blockX++) {
                        const blockMinX = minX + (blockX * BLOCK_SIZE_METERS);
                        const blockMaxX = Math.min(maxX, blockMinX + BLOCK_SIZE_METERS);
                        const blockMinZ = minZ + (blockZ * BLOCK_SIZE_METERS);
                        const blockMaxZ = Math.min(maxZ, blockMinZ + BLOCK_SIZE_METERS);
                        
                        const startCol = Math.max(0, Math.floor((blockMinX - minX) / GRID_RESOLUTION));
                        const endCol = Math.min(this.cols - 1, Math.ceil((blockMaxX - minX) / GRID_RESOLUTION));
                        const startRow = Math.max(0, Math.floor((blockMinZ - minZ) / GRID_RESOLUTION));
                        const endRow = Math.min(this.rows - 1, Math.ceil((blockMaxZ - minZ) / GRID_RESOLUTION));
                        
                        let coveredCount = 0;
                        let totalInBlock = 0;
                        
                        for (let row = startRow; row <= endRow; row++) {
                            for (let col = startCol; col <= endCol; col++) {
                                totalInBlock++;
                                if (this.matrix[row][col] === 1) {
                                    coveredCount++;
                                }
                            }
                        }
                        
                        const coveragePercentage = coveredCount / totalInBlock;
                        
                        if (coveragePercentage >= AUTO_FILL_THRESHOLD && totalInBlock > 0) {
                            for (let row = startRow; row <= endRow; row++) {
                                for (let col = startCol; col <= endCol; col++) {
                                    if (this.matrix[row][col] === 0) {
                                        this.matrix[row][col] = -1;
                                        filled++;
                                        this.scanCounters.autoFilledPositions++;
                                    }
                                }
                            }
                        }
                    }
                }
                
                return filled;
            };
            
            // Mark area as unusable (-2)
            const markUnusableArea = (bsPos) => {
                let marked = 0;
                const radiusCells = Math.floor(BS_QUALITY_RADIUS / GRID_RESOLUTION);
                const centerRow = Math.floor((bsPos.z - minZ) / GRID_RESOLUTION);
                const centerCol = Math.floor((bsPos.x - minX) / GRID_RESOLUTION);
                
                for (let dr = -radiusCells; dr <= radiusCells; dr++) {
                    for (let dc = -radiusCells; dc <= radiusCells; dc++) {
                        const distanceMeters = Math.sqrt(dr*dr + dc*dc) * GRID_RESOLUTION;
                        if (distanceMeters > BS_QUALITY_RADIUS) continue;
                        
                        const row = centerRow + dr;
                        const col = centerCol + dc;
                        
                        if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
                            if (this.matrix[row][col] === 0 || this.matrix[row][col] === -1) {
                                this.matrix[row][col] = -2;
                                marked++;
                                this.scanCounters.unusablePositions++;
                            }
                        }
                    }
                }
                
                return marked;
            };
            
            // Count covered cells (both explicitly covered =1 and auto-filled =-1)
            const countCovered = () => {
                let covered = 0;
                for (let row = 0; row < this.rows; row++) {
                    for (let col = 0; col < this.cols; col++) {
                        if (this.matrix[row][col] === 1 || this.matrix[row][col] === -1) covered++;
                    }
                }
                return covered;
            };
            
            // Find min(x+z) uncovered cell
            const findMinXZUncovered = () => {
                let minXZ = Infinity;
                let targetRow = -1, targetCol = -1;
                
                for (let row = 0; row < this.rows; row++) {
                    for (let col = 0; col < this.cols; col++) {
                        if (this.matrix[row][col] === 0) {
                            const cell = getCellPos(row, col);
                            const xz = cell.x + cell.z;
                            if (xz < minXZ) {
                                minXZ = xz;
                                targetRow = row;
                                targetCol = col;
                            }
                        }
                    }
                }
                
                return { row: targetRow, col: targetCol, pos: getCellPos(targetRow, targetCol) };
            };
            
            // Find radial expansion point (perimeter-only shell walk — O(r) per shell)
            const findRadialExpansionPoint = (centerRow, centerCol) => {
                const maxRadius = Math.max(this.rows, this.cols);
                
                for (let r = 1; r <= maxRadius; r++) {
                    // Walk only the 4 sides of the square shell at distance r
                    const checkCell = (row, col) => {
                        if (row >= 0 && row < this.rows && col >= 0 && col < this.cols) {
                            if (this.matrix[row][col] === 0) {
                                return { row, col, pos: getCellPos(row, col) };
                            }
                        }
                        return null;
                    };
                    // Top and bottom rows of shell
                    for (let dc = -r; dc <= r; dc++) {
                        let hit = checkCell(centerRow - r, centerCol + dc);
                        if (hit) return hit;
                        hit = checkCell(centerRow + r, centerCol + dc);
                        if (hit) return hit;
                    }
                    // Left and right columns (excluding corners already visited)
                    for (let dr = -r + 1; dr <= r - 1; dr++) {
                        let hit = checkCell(centerRow + dr, centerCol - r);
                        if (hit) return hit;
                        hit = checkCell(centerRow + dr, centerCol + r);
                        if (hit) return hit;
                    }
                }
                
                return null;
            };
            
            // Find best position for BS with optimized scanning
            const findBestPositionForTarget = (targetCell, searchRadius = Math.min(effR, 150)) => {
                let bestPos = { x: targetCell.x, z: targetCell.z };
                let bestNewCoverage = 0;
                let bestQuality = null;
                let positionsEvaluated = 0;
                
                const stepSize = GRID_RESOLUTION * 2;
                const radiusSteps = Math.floor(searchRadius / stepSize);
                
                for (let dx = -radiusSteps; dx <= radiusSteps; dx++) {
                    for (let dz = -radiusSteps; dz <= radiusSteps; dz++) {
                        const testPos = {
                            x: Math.max(minX, Math.min(maxX, targetCell.x + dx * stepSize)),
                            z: Math.max(minZ, Math.min(maxZ, targetCell.z + dz * stepSize))
                        };
                        
                        positionsEvaluated++;
                        this.scanCounters.totalPositionsScanned++;
                        
                        let newCoverage = 0;
                        for (let row = 0; row < this.rows; row++) {
                            for (let col = 0; col < this.cols; col++) {
                                if (this.matrix[row][col] === 0) {
                                    const cell = getCellPos(row, col);
                                    if (isCellCoveredByBS(cell.x, cell.z, testPos)) {
                                        newCoverage++;
                                    }
                                }
                            }
                        }
                        
                        const quality = getBSQualityMetrics(testPos);
                        const score = newCoverage + (quality.isAcceptable ? quality.newCoveragePercentage * 500 : 0);
                        
                        if (score > bestNewCoverage) {
                            bestNewCoverage = score;
                            bestPos = testPos;
                            bestQuality = quality;
                        }
                    }
                }
                
                return { 
                    pos: bestPos, 
                    newCoverage: bestNewCoverage, 
                    quality: bestQuality,
                    positionsEvaluated: positionsEvaluated
                };
            };
            
            // ============================================================
            // PLACE ANCHOR
            // ============================================================
            const anchorPos = { x: minX + 20, z: minZ + 20 };
            console.log(`\n🔍 SCANNING ANCHOR POSITION...`);
            this.scanCounters.anchorAttempts++;
            
            const anchorQuality = getBSQualityMetrics(anchorPos);
            this.scanCounters.totalPositionsScanned++;
            
            console.log(`   Anchor at (${anchorPos.x.toFixed(0)}, ${anchorPos.z.toFixed(0)})`);
            console.log(`   New coverage: ${(anchorQuality.newCoveragePercentage*100).toFixed(1)}% (${anchorQuality.newCoverageCount}/${anchorQuality.totalInRadius} cells)`);
            console.log(`   Overlap: ${(anchorQuality.overlapPercentage*100).toFixed(1)}%`);
            
            let anchorCoverage = 0;
            let autoFilled = 0;
            
            if (anchorQuality.isAcceptable) {
                anchorCoverage = updateMatrixWithBS(anchorPos);
                autoFilled = autoFillBlocks();
                
                placedBS.push({
                    x: anchorPos.x, z: anchorPos.z,
                    newPoints: anchorCoverage,
                    autoFilled: autoFilled,
                    newCoveragePct: (anchorQuality.newCoveragePercentage * 100).toFixed(1),
                    overlapPct: (anchorQuality.overlapPercentage * 100).toFixed(1),
                    isAnchor: true,
                    step: stepNum
                });
                this.scanCounters.acceptedPositions++;
                this.scanCounters.totalBSPlaced++;
                console.log(`   ✅ ACCEPTED - Added ${anchorCoverage} new cells, auto-filled ${autoFilled}`);
            } else {
                console.log(`   ❌ REJECTED - Only ${(anchorQuality.newCoveragePercentage*100).toFixed(1)}% new coverage`);
                const marked = markUnusableArea(anchorPos);
                rejectedBS.push({
                    x: anchorPos.x, z: anchorPos.z,
                    newCoveragePct: (anchorQuality.newCoveragePercentage * 100).toFixed(1),
                    markedCells: marked,
                    reason: `Only ${(anchorQuality.newCoveragePercentage*100).toFixed(1)}% new coverage`,
                    step: stepNum
                });
                this.scanCounters.rejectedPositions++;
            }
            stepNum++;
            
            let coveredCount = countCovered();
            let covPct = (coveredCount / totalCells) * 100;
            
            this.printCounterStatus(stepNum, placedBS.length, rejectedBS.length, covPct, totalCells);
            await this.sendProgress(taskId, placedBS, rejectedBS, this.matrix, mapBounds, covPct, totalCells, stepNum, this.scanCounters);
            
            // ============================================================
            // MAIN LOOP
            // ============================================================
            let stuckCounter = 0;
            let lastCovPct = 0;
            let consecutiveRejections = 0;
            let totalPositionsEvaluated = 0;
            
            while (placedBS.length < 200 && covPct < targetCoverage && !this.isCancelled) {
                
                const target = findMinXZUncovered();
                if (target.row === -1) {
                    console.log(`\n⚠️ No uncovered cells remaining!`);
                    break;
                }
                
                const expansionPoint = findRadialExpansionPoint(target.row, target.col);
                
                console.log(`\n🔍 SCANNING FOR BS #${placedBS.length + 1} (Step ${stepNum})...`);
                console.log(`   Target uncovered cell at (${target.pos.x.toFixed(0)}, ${target.pos.z.toFixed(0)})`);
                
                let best;
                if (expansionPoint) {
                    console.log(`   Expansion point at (${expansionPoint.pos.x.toFixed(0)}, ${expansionPoint.pos.z.toFixed(0)})`);
                    best = findBestPositionForTarget(expansionPoint.pos);
                } else {
                    best = findBestPositionForTarget(target.pos);
                }
                
                totalPositionsEvaluated += best.positionsEvaluated;
                console.log(`   Evaluated ${best.positionsEvaluated} positions around target (Total scanned: ${this.scanCounters.totalPositionsScanned})`);
                console.log(`   Best candidate at (${best.pos.x.toFixed(0)}, ${best.pos.z.toFixed(0)})`);
                console.log(`   Would cover ${best.newCoverage} new cells globally`);
                
                if (best.newCoverage > 0 && best.quality) {
                    const quality = best.quality;
                    
                    console.log(`   New coverage in 200m radius: ${(quality.newCoveragePercentage*100).toFixed(1)}% (${quality.newCoverageCount}/${quality.totalInRadius} cells)`);
                    console.log(`   Overlap: ${(quality.overlapPercentage*100).toFixed(1)}%`);
                    console.log(`   Requirement: ${BS_QUALITY_THRESHOLD*100}% NEW coverage → ${quality.isAcceptable ? '✅ MET' : '❌ NOT MET'}`);
                    
                    if (quality.isAcceptable) {
                        const newCoverage = updateMatrixWithBS(best.pos);
                        const newAutoFilled = autoFillBlocks();
                        
                        placedBS.push({
                            x: best.pos.x, z: best.pos.z,
                            newPoints: newCoverage,
                            autoFilled: newAutoFilled,
                            newCoveragePct: (quality.newCoveragePercentage * 100).toFixed(1),
                            overlapPct: (quality.overlapPercentage * 100).toFixed(1),
                            isAnchor: false,
                            step: stepNum
                        });
                        
                        this.scanCounters.acceptedPositions++;
                        this.scanCounters.totalBSPlaced++;
                        coveredCount = countCovered();
                        covPct = (coveredCount / totalCells) * 100;
                        
                        console.log(`   ✅ ACCEPTED - Added ${newCoverage} new cells, auto-filled ${newAutoFilled}, total coverage: ${covPct.toFixed(1)}%`);
                        
                        stuckCounter = 0;
                        consecutiveRejections = 0;
                    } else {
                        const marked = markUnusableArea(best.pos);
                        rejectedBS.push({
                            x: best.pos.x, z: best.pos.z,
                            newCoveragePct: (quality.newCoveragePercentage * 100).toFixed(1),
                            markedCells: marked,
                            reason: `Only ${(quality.newCoveragePercentage*100).toFixed(1)}% new coverage`,
                            step: stepNum
                        });
                        
                        this.scanCounters.rejectedPositions++;
                        console.log(`   ❌ REJECTED - Marked ${marked} cells as unusable`);
                        
                        consecutiveRejections++;
                        stuckCounter++;
                        this.matrix[target.row][target.col] = -2;
                    }
                } else {
                    console.log(`   ⚠️ No coverage possible at this location`);
                    this.matrix[target.row][target.col] = -2;
                    stuckCounter++;
                }
                stepNum++;
                
                if (stepNum % 5 === 0 || Math.abs(covPct - lastCovPct) > 5) {
                    this.printCounterStatus(stepNum, placedBS.length, rejectedBS.length, covPct, totalCells);
                }
                
                await this.sendProgress(taskId, placedBS, rejectedBS, this.matrix, mapBounds, covPct, totalCells, stepNum, this.scanCounters);
                
                if (consecutiveRejections > 5) {
                    console.log(`\n⚠️ Too many rejections (${consecutiveRejections}), forcing auto-fill of area...`);
                    const lastRejected = rejectedBS[rejectedBS.length - 1];
                    if (lastRejected) {
                        const marked = markUnusableArea({ x: lastRejected.x, z: lastRejected.z });
                        console.log(`   Force-marked ${marked} cells as unusable`);
                        consecutiveRejections = 0;
                    }
                }
                
                if (Math.abs(covPct - lastCovPct) < 0.1 && stuckCounter > 8 && stepNum > 3) {
                    console.log(`\n⚠️ Stuck at ${covPct.toFixed(1)}% for ${stuckCounter} steps, forcing auto-fill of neighbors...`);
                    let forceFilled = 0;
                    for (let row = 0; row < this.rows; row++) {
                        for (let col = 0; col < this.cols; col++) {
                            if (this.matrix[row][col] !== 0) continue;
                            
                            let coveredNeighbors = 0;
                            for (let dr = -1; dr <= 1; dr++) {
                                for (let dc = -1; dc <= 1; dc++) {
                                    if (dr === 0 && dc === 0) continue;
                                    const nr = row + dr, nc = col + dc;
                                    if (nr >= 0 && nr < this.rows && nc >= 0 && nc < this.cols) {
                                        if (this.matrix[nr][nc] === 1) {
                                            coveredNeighbors++;
                                        }
                                    }
                                }
                            }
                            
                            if (coveredNeighbors >= 2) {
                                this.matrix[row][col] = -1;
                                forceFilled++;
                                this.scanCounters.autoFilledPositions++;
                            }
                        }
                    }
                    console.log(`   Force-filled ${forceFilled} cells`);
                    
                    coveredCount = countCovered();
                    covPct = (coveredCount / totalCells) * 100;
                    stuckCounter = 0;
                }
                
                lastCovPct = covPct;
                if (covPct >= targetCoverage) break;
            }
            
            const finalCoverage = (countCovered() / totalCells) * 100;
            
            console.log(`\n╔════════════════════════════════════════════════════════════╗`);
            console.log(`║  FINAL RESULTS                                            ║`);
            console.log(`╠════════════════════════════════════════════════════════════╣`);
            console.log(`║ Steps executed: ${stepNum}`);
            console.log(`║ BS placed: ${placedBS.length}`);
            console.log(`║ BS rejected: ${rejectedBS.length}`);
            console.log(`║ Final coverage: ${finalCoverage.toFixed(1)}% (${countCovered()}/${totalCells} cells)`);
            console.log(`╠════════════════════════════════════════════════════════════╣`);
            console.log(`║ SCAN COUNTERS:                                            ║`);
            console.log(`║ Total positions scanned: ${this.scanCounters.totalPositionsScanned}`);
            console.log(`║ Accepted positions: ${this.scanCounters.acceptedPositions}`);
            console.log(`║ Rejected positions: ${this.scanCounters.rejectedPositions}`);
            console.log(`║ Unusable cells marked: ${this.scanCounters.unusablePositions}`);
            console.log(`║ Auto-filled cells: ${this.scanCounters.autoFilledPositions}`);
            console.log(`║ Quality checks performed: ${this.scanCounters.qualityChecks}`);
            console.log(`║ Anchor attempts: ${this.scanCounters.anchorAttempts}`);
            console.log(`║ Total BS placed: ${this.scanCounters.totalBSPlaced}`);
            console.log(`╚════════════════════════════════════════════════════════════╝\n`);
            
            self.postMessage({ 
                type: 'complete', 
                taskId, 
                data: { 
                    bsCount: placedBS.length,
                    rejectedCount: rejectedBS.length,
                    coveragePct: finalCoverage,
                    totalSteps: stepNum,
                    counters: this.scanCounters,
                    bsPositions: placedBS.map((bs, i) => ({ 
                        x: bs.x, z: bs.z, 
                        isAnchor: bs.isAnchor,
                        newCoveragePct: bs.newCoveragePct,
                        overlapPct: bs.overlapPct,
                        step: bs.step,
                        isHeal: bs.autoFilled > 0   // mark if it triggered auto-fill (gap healing)
                    })),
                    rejectedPositions: rejectedBS.map((bs, i) => ({
                        x: bs.x, z: bs.z,
                        newCoveragePct: bs.newCoveragePct,
                        markedCells: bs.markedCells,
                        reason: bs.reason,
                        step: bs.step
                    })),
                    mapBounds,
                    bsTemplate,
                    matrixSize: { rows: this.rows, cols: this.cols, totalCells: totalCells }
                } 
            });
            
        } catch (err) {
            console.error('Error:', err);
            console.error('Stack trace:', err.stack);
            self.postMessage({ type: 'error', taskId, data: err.message });
        }
    }
    
    printCounterStatus(step, accepted, rejected, coverage, totalCells) {
        const coveredCount = Math.floor((coverage / 100) * totalCells);
        console.log(`\n📊 STATUS @ Step ${step}:`);
        console.log(`   Coverage: ${coverage.toFixed(1)}% (${coveredCount}/${totalCells} cells)`);
        console.log(`   Accepted BS: ${accepted} | Rejected: ${rejected} | Total scans: ${this.scanCounters.totalPositionsScanned}`);
        console.log(`   Quality checks: ${this.scanCounters.qualityChecks}`);
        console.log(`   Auto-filled: ${this.scanCounters.autoFilledPositions} cells`);
        console.log(`   Unusable: ${this.scanCounters.unusablePositions} cells`);
    }
    
    async sendProgress(taskId, placedBS, rejectedBS, matrix, mapBounds, covPct, totalCells, stepNum, counters) {
        const coveredPoints = [];
        const autoFilledPoints = [];
        const unusablePoints = [];
        const { minX, minZ } = mapBounds;
        
        for (let row = 0; row < matrix.length; row++) {
            for (let col = 0; col < matrix[0].length; col++) {
                const x = minX + col * GRID_RESOLUTION;
                const z = minZ + row * GRID_RESOLUTION;
                if (matrix[row][col] === 1) {
                    coveredPoints.push({ x, z });
                } else if (matrix[row][col] === -1) {
                    autoFilledPoints.push({ x, z });
                } else if (matrix[row][col] === -2) {
                    unusablePoints.push({ x, z });
                }
            }
        }
        
        self.postMessage({
            type: 'progress', taskId,
            progress: Math.round(covPct),
            data: {
                step: stepNum,
                coveragePct: covPct.toFixed(1),
                coverageGap: (100 - covPct).toFixed(1),
                bsCount: placedBS.length,
                rejectedCount: rejectedBS.length,
                totalCells: totalCells,
                coveredCells: coveredPoints.length,
                autoFilledCells: autoFilledPoints.length,
                unusableCells: unusablePoints.length,
                counters: counters,
                placements: placedBS.map(b => ({ 
                    x: b.x, z: b.z, 
                    isAnchor: b.isAnchor,
                    newPoints: b.newPoints,
                    autoFilled: b.autoFilled,
                    newCoveragePct: b.newCoveragePct,
                    overlapPct: b.overlapPct,
                    step: b.step
                })),
                rejected: rejectedBS.map(b => ({
                    x: b.x, z: b.z,
                    newCoveragePct: b.newCoveragePct,
                    markedCells: b.markedCells,
                    reason: b.reason,
                    step: b.step
                })),
                coveredPoints: coveredPoints,
                autoFilledPoints: autoFilledPoints,
                unusablePoints: unusablePoints,
                mapBounds
            }
        });
        await new Promise(r => setTimeout(r, 0));
    }
}

new MatrixCoverageWorker();
