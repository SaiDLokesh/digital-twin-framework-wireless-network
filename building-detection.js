class BuildingDetectionSystem {
    constructor(scene) {
        this.scene = scene;
        this.buildingMeshes = [];
        this.hollowBuildings = [];
        
        // Realistic building parameters (meters)
        this.wallThickness = 0.15;     // 15cm realistic wall thickness
        this.floorHeight = 3.0;        // Standard floor height: 3m
        
        // Material penetration losses (dB/m) - Based on ITU/3GPP standards
        this.materialLosses = {
            'glass': 2.5,
            'wood': 6.0,
            'drywall': 4.0,
            'brick': 12.0,
            'concrete': 15.0,
            'concrete_slab': 25.0,
            'metal': 40.0,
            'plaster': 8.0,
            'composite': 15.0,
            'unknown': 12.0
        };
        
        // Frequency adjustment factors
        this.frequencyFactors = {
            900: 0.9,
            1800: 1.0,
            2400: 1.2,
            3500: 1.4,
            5800: 1.8,
            28000: 3.0
        };
        
        this.initializeBuildingDetection();
    }

    initializeBuildingDetection() {
        this.extractBuildingMeshes();
        this.convertToHollowBuildings();
        console.log(`Building detection initialized: ${this.hollowBuildings.length} buildings`);
    }

    extractBuildingMeshes() {
        this.buildingMeshes = [];
        this.scene.traverse((child) => {
            if (child.isMesh && child.visible) {
                if (this.isPotentialBuilding(child)) {
                    this.buildingMeshes.push(child);
                }
            }
        });
    }

    isPotentialBuilding(mesh) {
        const excludedNames = ['ground', 'plane', 'marker', 'coverage', 
                              'delay', 'throughput', 'antenna', 'label'];
        
        if (mesh.name) {
            for (const name of excludedNames) {
                if (mesh.name.toLowerCase().includes(name)) return false;
            }
        }

        if (mesh.geometry && mesh.geometry.boundingBox) {
            const box = mesh.geometry.boundingBox;
            const size = new THREE.Vector3();
            box.getSize(size);
            return size.x > 3 || size.y > 3 || size.z > 3;
        }
        return false;
    }

    convertToHollowBuildings() {
        this.hollowBuildings = [];
        this.buildingMeshes.forEach((mesh, index) => {
            const boundingBox = new THREE.Box3().setFromObject(mesh);
            const center = new THREE.Vector3();
            boundingBox.getCenter(center);
            const size = new THREE.Vector3();
            boundingBox.getSize(size);
            
            const innerSize = new THREE.Vector3(
                Math.max(0.1, size.x - (2 * this.wallThickness)),
                size.y,
                Math.max(0.1, size.z - (2 * this.wallThickness))
            );

            const floors = Math.max(1, Math.floor(size.y / this.floorHeight));
            
            this.hollowBuildings.push({
                name: mesh.name || `Building_${index}`,
                center: center,
                outerSize: size.clone(),
                innerSize: innerSize,
                wallThickness: this.wallThickness,
                floors: floors,
                floorHeight: this.floorHeight,
                boundingBox: boundingBox,
                innerBoundingBox: this.createInnerBoundingBox(center, innerSize),
                materialType: this.estimateMaterialType(mesh.material)
            });
        });
    }

    createInnerBoundingBox(center, innerSize) {
        const halfSize = innerSize.clone().multiplyScalar(0.5);
        const min = new THREE.Vector3(
            center.x - halfSize.x,
            center.y - halfSize.y,
            center.z - halfSize.z
        );
        const max = new THREE.Vector3(
            center.x + halfSize.x,
            center.y + halfSize.y,
            center.z + halfSize.z
        );
        return new THREE.Box3(min, max);
    }

    estimateMaterialType(material) {
        if (!material || !material.color) return 'concrete';
        const color = material.color;
        const hsl = { h: 0, s: 0, l: 0 };
        color.getHSL(hsl);
        if (hsl.l < 0.3) return 'concrete';
        if (hsl.s < 0.2 && hsl.l > 0.7) return 'glass';
        if (color.r > 0.5 && color.g < 0.4 && color.b < 0.4) return 'brick';
        return 'concrete';
    }

    calculateBuildingPenetrationLoss(txPos, rxPos, frequencyMHz = 2400) {
        const results = {
            totalLoss: 0,
            wallLoss: 0,
            floorLoss: 0,
            interiorLoss: 0,
            totalWalls: 0,
            totalFloors: 0,
            buildingsPenetrated: [],
            isLOS: true,
            distance: txPos.distanceTo(rxPos)
        };
        
        const freqGHz = frequencyMHz / 1000;
        const freqFactor = this.getFrequencyFactor(frequencyMHz);

        this.hollowBuildings.forEach(building => {
            if (!building.boundingBox.intersectsLine(txPos, rxPos)) return;

            results.isLOS = false;
            results.buildingsPenetrated.push(building.name);

            // Wall count approximation
            let wallCount = 0;
            const txInside = building.boundingBox.containsPoint(txPos);
            const rxInside = building.boundingBox.containsPoint(rxPos);
            if (txInside && rxInside) {
                wallCount = 0;
            } else if (txInside || rxInside) {
                wallCount = 1;
            } else {
                wallCount = 2;
            }
            results.totalWalls += wallCount;
            const materialLoss = this.materialLosses[building.materialType] || 12.0;
            results.wallLoss += wallCount * building.wallThickness * materialLoss * freqFactor;

            // Floor penetration
            const yDiff = Math.abs(rxPos.y - txPos.y);
            const floorCount = Math.floor(yDiff / building.floorHeight);
            results.totalFloors += floorCount;
            const floorLossPer = this.materialLosses.concrete_slab || 25.0;
            results.floorLoss += floorCount * 0.2 * floorLossPer * freqFactor;

            // Interior loss approximation
            const interiorDistance = results.distance * 0.5;
            const interiorLossPer = this.materialLosses.drywall || 4.0;
            results.interiorLoss += interiorDistance * interiorLossPer * freqFactor * 0.1;
        });

        results.totalLoss = results.wallLoss + results.floorLoss + results.interiorLoss;
        return results;
    }

    getFrequencyFactor(frequencyMHz) {
        const keys = Object.keys(this.frequencyFactors).map(Number).sort((a,b)=>a-b);
        for (let i = 0; i < keys.length - 1; i++) {
            if (frequencyMHz >= keys[i] && frequencyMHz < keys[i+1]) {
                return this.frequencyFactors[keys[i]];
            }
        }
        return this.frequencyFactors[keys[keys.length-1]] || 1.0;
    }

    getBuildingDataForWorker() {
        return {
            buildings: this.hollowBuildings.map(b => ({
                name: b.name,
                center: { x: b.center.x, y: b.center.y, z: b.center.z },
                outerSize: { x: b.outerSize.x, y: b.outerSize.y, z: b.outerSize.z },
                innerSize: { x: b.innerSize.x, y: b.innerSize.y, z: b.innerSize.z },
                wallThickness: b.wallThickness,
                floors: b.floors,
                floorHeight: b.floorHeight,
                materialType: b.materialType,
                boundingBox: {
                    min: { x: b.boundingBox.min.x, y: b.boundingBox.min.y, z: b.boundingBox.min.z },
                    max: { x: b.boundingBox.max.x, y: b.boundingBox.max.y, z: b.boundingBox.max.z }
                },
                innerBoundingBox: {
                    min: { x: b.innerBoundingBox.min.x, y: b.innerBoundingBox.min.y, z: b.innerBoundingBox.min.z },
                    max: { x: b.innerBoundingBox.max.x, y: b.innerBoundingBox.max.y, z: b.innerBoundingBox.max.z }
                }
            })),
            parameters: {
                wallThickness: this.wallThickness,
                floorHeight: this.floorHeight,
                materialLosses: this.materialLosses,
                frequencyFactors: this.frequencyFactors
            }
        };
    }
}

// Global instance
let buildingDetectionSystem = null;

function initializeBuildingDetection(scene) {
    buildingDetectionSystem = new BuildingDetectionSystem(scene);
    return buildingDetectionSystem;
}