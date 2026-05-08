
let scene, camera, renderer, controls, model;
let _defaultCameraPos = null;
let _defaultCameraTarget = null;
let raycaster, mouse;
let point1 = null, point2 = null;
let point1Marker = null, point2Marker = null;
let isSelecting = false;
let coverageMarkers = [];
let coverageAnalysis = null;
let coverageMap = null;
let coverageVolume = null;
let coveragePoints = [];
let delayPoints = [];
let delayAnalysis = null;
let delayMap = null;
let throughputPoints = [];
let throughputAnalysis = null;
let throughputMap = null;
let groundLevel = 0;
let currentAnalysisTask = null;
let currentTool = 'view';
let currentTaskId = null;
let buildingDetection = null;  

// Multi-Coverage Analysis Variables
let baseStations = [];
let bsMarkers = [];
let bsLabels = [];
let currentBSIndex = 0;
let isSelectingBSPosition = false;
let editingBSIndex = null;
let multiCoverageAnalysis = null;

// Crowd Analysis Variables
let crowdBSPosition = null;
let crowdCenterPosition = null;
let crowdBSMarker = null;
let crowdCenterMarker = null;
let crowdHeatmapGroup = null;
let crowdFiguresGroup = null;
let crowdBSTowerGroup = null;
let isSelectingCrowdBS = false;
let isSelectingCrowdCenter = false;
let crowdAnalysis = null;

// SINR Analysis Variables
let sinrPoints = [];
let sinrAnalysis = null;
let sinrMap = null;
let sinrTxPosition = null;
let sinrTxMarker = null;
let isSelectingSinrTx = false;

// Fairness Analysis Variables
let fairnessAnalysis = null;
let fairnessMap = null;

// Initialize workers once; building data is sent via 'init' message (not per-task)
function initWorkersWithBuildingData() {
    workerManager.createWorker('coverage-analysis',       'coverage-worker.js');
    workerManager.createWorker('delay-analysis',          'delay-worker.js');
    workerManager.createWorker('throughput-analysis',     'throughput-worker.js');
    workerManager.createWorker('multi-coverage-analysis', 'multi-coverage-worker.js');
    workerManager.createWorker('crowd-analysis',          'crowd-worker.js');
    workerManager.createWorker('bs-optimiser',            'bs-optimiser-worker.js');
    workerManager.createWorker('contour-chain',           'contour-chain-worker.js');
    workerManager.createWorker('sinr-analysis',           'sinr-worker.js');
    workerManager.createWorker('fairness-analysis',       'fairness-worker.js');
    workerManager.setBuildingData(
        buildingDetection ? buildingDetection.getBuildingDataForWorker() : null
    );
    const status = workerManager.getStatus();
    document.getElementById('performance-info').textContent =
        `Worker mode: ${status.isWorkerSupported ? 'Multi-threaded' : 'Single-threaded (fallback)'}`;
}

function init() {
    // Create scene
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x87ceeb);
    // Auto-flag render whenever scene graph changes
    (function patchSceneForRenderFlag(sc) {
        const origAdd = sc.add.bind(sc);
        const origRemove = sc.remove.bind(sc);
        sc.add    = (...a) => { origAdd(...a);    markNeedsRender(); };
        sc.remove = (...a) => { origRemove(...a); markNeedsRender(); };
    })(scene);
    
    // Create camera
    const container = document.getElementById('model-container');
    if (!container) {
        console.error('Model container not found!');
        return;
    }
    
    camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 10000);
    
    // Create renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.appendChild(renderer.domElement);
    
    // Add orbit controls
    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    
    // Setup raycaster for object selection
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();
    
    // Add lights
    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    scene.add(ambientLight);
    
    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(0, 1000, 0);
    scene.add(directionalLight);
    
    // Load GLB model with better error handling
    loadModel();
    
    // Add click event listener
    renderer.domElement.addEventListener('click', onModelClick, false);
    
    // Setup UI event listeners
    setupEventListeners();

    const panel = document.getElementById('controls-panel');
    makeDraggable(panel);
    makeResizable(panel);
    
    // Workers are initialised after building detection (in loadModel callback)
    
    // Start animation loop
    animate();
    
    // Handle window resize
    window.addEventListener('resize', onWindowResize);
}

function loadModel() {
    const loader = new THREE.GLTFLoader();
    
    console.log('Loading 3D model...');
    
    loader.load(
        'model.glb',
        function(gltf) {
            console.log('Model loaded successfully');
            model = gltf.scene;
            
            model.traverse((child) => {
                if (child.isMesh) {
                    child.castShadow = true;
                    child.receiveShadow = true;
                    
                    if (child.material) {
                        if (child.material.emissive) {
                            child.material.emissive.set(0x000000);
                        }
                        
                        if (child.material.color) {
                            const color = child.material.color.clone();
                            color.multiplyScalar(1.2);
                            child.material.color.copy(color);
                        }
                        
                        child.material.needsUpdate = true;
                    }
                }
            });
            
            scene.add(model);
            
            const box = new THREE.Box3().setFromObject(model);
            const center = box.getCenter(new THREE.Vector3());
            const size = box.getSize(new THREE.Vector3());
            
            const groundOffset = -box.min.y;
            
            // Position model so ground is at y=0
            model.position.x = -center.x;
            model.position.y = groundOffset;
            model.position.z = -center.z;
            
            console.log('Model loaded successfully:', {
                minY: box.min.y,
                maxY: box.max.y,
                centerY: center.y,
                groundOffset: groundOffset,
                modelY: model.position.y,
                size: size
            });
            
            // Store default top-view position so Ctrl+Enter can restore it
            _defaultCameraPos = { x: 0, y: size.y * 12, z: size.y * 4 };
            _defaultCameraTarget = { x: 0, y: 0, z: 0 };

            camera.position.set(0, size.y * 12, size.y * 4);
            camera.lookAt(0, 0, 0);
            
            controls.target.set(0, 0, 0);
            controls.update();
            
            const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
            const groundMaterial = new THREE.MeshLambertMaterial({ 
                color: 0x90EE90, 
                side: THREE.DoubleSide,
                transparent: true,
                opacity: 0.3
            });
            const ground = new THREE.Mesh(groundGeometry, groundMaterial);
            ground.rotation.x = Math.PI / 2;
            ground.position.y = 0;
            ground.name = 'ground-plane';
            scene.add(ground);

            buildingDetection = initializeBuildingDetection(scene);
            window.buildingDetection = buildingDetection;  // expose for interactive-mode.js
            initWorkersWithBuildingData();

            console.log(
                `Building detection initialized: ${buildingDetection.hollowBuildings.length} buildings detected`
            );

            if (buildingDetection.hollowBuildings.length === 0) {
                console.warn("No buildings were detected in the loaded model.");
    // alert("No buildings detected → penetration loss calculations will be skipped.");
            }
            
        },
        function(progress) {
            // Progress callback
            const percent = (progress.loaded / progress.total * 100).toFixed(2);
            console.log(`Loading model: ${percent}%`);
        },
        function(error) {
            console.error('Error loading model:', error);
            createFallbackModel();
        }
    );
}

function createFallbackModel() {
    console.log('Creating fallback model...');
    
    const buildingGroup = new THREE.Group();
    
    const buildingMaterial = new THREE.MeshLambertMaterial({ 
        color: 0xaaaaaa,
        transparent: false
    });
    
    const buildingGeometry = new THREE.BoxGeometry(200, 100, 200);
    const building = new THREE.Mesh(buildingGeometry, buildingMaterial);
    building.position.y = 50;
    building.castShadow = true;
    building.receiveShadow = true;
    buildingGroup.add(building);
    
    // Smaller structures with brighter materials 
    const smallBuilding1 = new THREE.Mesh(
        new THREE.BoxGeometry(80, 60, 80),
        new THREE.MeshLambertMaterial({ color: 0x888888 })
    );
    smallBuilding1.position.set(150, 30, 150);
    smallBuilding1.castShadow = true;
    smallBuilding1.receiveShadow = true;
    buildingGroup.add(smallBuilding1);
    
    const smallBuilding2 = new THREE.Mesh(
        new THREE.BoxGeometry(60, 80, 60),
        new THREE.MeshLambertMaterial({ color: 0x999999 })
    );
    smallBuilding2.position.set(-120, 40, -120);
    smallBuilding2.castShadow = true;
    smallBuilding2.receiveShadow = true;
    buildingGroup.add(smallBuilding2);
    
    scene.add(buildingGroup);
    model = buildingGroup;
    
    camera.position.set(0, 300, 400);
    camera.lookAt(0, 0, 0);
    controls.target.set(0, 0, 0);
    controls.update();
    
    console.log('Fallback model created');
}

function setupEventListeners() {
    // Tool selector
    document.getElementById('tool-select').addEventListener('change', function() {
        currentTool = this.value;
        
        // Hide all tool sections
        document.querySelectorAll('.tool-section').forEach(section => {
            section.style.display = 'none';
        });
        
        // Show selected tool
        if (currentTool === 'pathloss') {
            document.getElementById('pathloss-tool').style.display = 'block';
            resetSelection();
        } else if (currentTool === 'coverage') {
            document.getElementById('coverage-tool').style.display = 'block';
            resetCoverage();
        } else if (currentTool === 'multi-coverage') {
            document.getElementById('multi-coverage-tool').style.display = 'block';
            hideBSConfigPanel();
            updateBSList();
            updateGridRange();
        } else if (currentTool === 'delay') {
            document.getElementById('delay-tool').style.display = 'block';
            resetDelayAnalysis();
        } else if (currentTool === 'throughput') {
            document.getElementById('throughput-tool').style.display = 'block';
            resetThroughputAnalysis();
        } else if (currentTool === 'crowd') {
            document.getElementById('crowd-tool').style.display = 'block';
            resetCrowdAnalysis();
        } else if (currentTool === 'bs-optimiser') {
            document.getElementById('bs-optimiser-tool').style.display = '';
        } else if (currentTool === 'contour-chain') {
            document.getElementById('contour-chain-tool').style.display = '';
        } else if (currentTool === 'sinr') {
            document.getElementById('sinr-tool').style.display = 'block';
            resetSINRAnalysis();
        } else if (currentTool === 'fairness') {
            document.getElementById('fairness-tool').style.display = 'block';
        } else if (currentTool === 'interactive') {
            document.getElementById('interactive-tool').style.display = '';
            initInteractiveMode();   // we'll define this function
        }
        


    });
    
    // Panel toggle
    document.getElementById('toggle-panel').addEventListener('click', function() {
        const panel   = document.getElementById('controls-panel');
        const content = document.getElementById('panel-content');
        const resizer = document.getElementById('panel-resizer');
        const isCollapsed = content.style.display === 'none';

        if (isCollapsed) {
            content.style.display = 'block';
            if (resizer) resizer.style.display = 'block';
            panel.style.maxHeight  = '90vh';
            panel.style.height     = '';
            this.textContent = '▼';
        } else {
            content.style.display = 'none';
            if (resizer) resizer.style.display = 'none';
            panel.style.maxHeight  = 'none';
            panel.style.height     = 'auto';
            this.textContent = '►';
        }
    });
    
    // Path loss calculator events
    document.getElementById('select-btn').addEventListener('click', function() {
        isSelecting = true;
        this.textContent = 'Selecting...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });
    
    document.getElementById('reset-btn').addEventListener('click', resetSelection);
    document.getElementById('calculate-btn').addEventListener('click', calculatePathLoss);
    
    // Frequency slider
    document.getElementById('frequency').addEventListener('input', function() {
        document.getElementById('frequency-value').textContent = this.value + ' MHz';
    });
    
    // Manual frequency input
    document.getElementById('frequency-value').addEventListener('click', function() {
        const newFreq = prompt('Enter frequency in MHz:', document.getElementById('frequency').value);
        if (newFreq !== null && !isNaN(newFreq) && newFreq >= 100 && newFreq <= 6000) {
            document.getElementById('frequency').value = newFreq;
            document.getElementById('frequency-value').textContent = newFreq + ' MHz';
        } else if (newFreq !== null) {
            alert('Please enter a valid frequency between 100 and 6000 MHz');
        }
    });
    
    // Height inputs
    document.getElementById('tx-height').addEventListener('input', function() {
        document.getElementById('tx-height-value').textContent = this.value + ' m';
    });
    
    document.getElementById('rx-height').addEventListener('input', function() {
        document.getElementById('rx-height-value').textContent = this.value + ' m';
    });
    
    // Manual height input for transmitter
    document.getElementById('tx-height-value').addEventListener('click', function() {
        const newHeight = prompt('Enter transmitter height in meters:', document.getElementById('tx-height').value);
        if (newHeight !== null && !isNaN(newHeight) && newHeight >= 1.5 && newHeight <= 100) {
            document.getElementById('tx-height').value = newHeight;
            this.textContent = newHeight + ' m';
        } else if (newHeight !== null) {
            alert('Please enter a valid height between 1.5 and 100 meters');
        }
    });
    
    // Manual height input for receiver
    document.getElementById('rx-height-value').addEventListener('click', function() {
        const newHeight = prompt('Enter receiver height in meters:', document.getElementById('rx-height').value);
        if (newHeight !== null && !isNaN(newHeight) && newHeight >= 1.5 && newHeight <= 22.5) {
            document.getElementById('rx-height').value = newHeight;
            this.textContent = newHeight + ' m';
        } else if (newHeight !== null) {
            alert('Please enter a valid height between 1.5 and 22.5 meters');
        }
    });
    
    // Coverage analysis events
    document.getElementById('select-tx-btn').addEventListener('click', function() {
        isSelecting = true;
        this.textContent = 'Selecting TX...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });
    
    document.getElementById('analyze-coverage-btn').addEventListener('click', analyzeCoverage3D);
    document.getElementById('show-map-btn').addEventListener('click', show3DCoverageMap);
    document.getElementById('reset-coverage-btn').addEventListener('click', resetCoverage);
    
    // Antenna directional properties event listeners
    document.getElementById('antenna-azimuth').addEventListener('input', function() {
        document.getElementById('antenna-azimuth-value').textContent = this.value + '°';
        if (point1) {
            visualizeAntennaPattern(point1, parseFloat(this.value), 
                parseFloat(document.getElementById('antenna-beamwidth').value));
        }
    });

    document.getElementById('antenna-gain').addEventListener('input', function() {
        document.getElementById('antenna-gain-value').textContent = this.value + ' dBi';
    });

    document.getElementById('antenna-beamwidth').addEventListener('change', function() {
        if (point1) {
            visualizeAntennaPattern(point1, 
                parseFloat(document.getElementById('antenna-azimuth').value),
                parseFloat(this.value));
        }
    });
    
    // Coverage sliders and inputs
    document.getElementById('tx-power').addEventListener('input', function() {
        document.getElementById('tx-power-value').textContent = this.value + ' dBm';
    });
    
    // Manual TX power input
    document.getElementById('tx-power-value').addEventListener('click', function() {
        const newPower = prompt('Enter transmit power in dBm:', document.getElementById('tx-power').value);
        if (newPower !== null && !isNaN(newPower) && newPower >= 0 && newPower <= 50) {
            document.getElementById('tx-power').value = newPower;
            this.textContent = newPower + ' dBm';
        } else if (newPower !== null) {
            alert('Please enter a valid power between 0 and 50 dBm');
        }
    });
    
    document.getElementById('coverage-tx-height').addEventListener('input', function() {
        document.getElementById('coverage-tx-height-value').textContent = this.value + ' m';
    });
    
    // Manual coverage TX height input
    document.getElementById('coverage-tx-height-value').addEventListener('click', function() {
        const newHeight = prompt('Enter transmitter height in meters:', document.getElementById('coverage-tx-height').value);
        if (newHeight !== null && !isNaN(newHeight) && newHeight >= 1.5 && newHeight <= 100) {
            document.getElementById('coverage-tx-height').value = newHeight;
            this.textContent = newHeight + ' m';
        } else if (newHeight !== null) {
            alert('Please enter a valid height between 1.5 and 100 meters');
        }
    });
    
    document.getElementById('coverage-frequency').addEventListener('input', function() {
        document.getElementById('coverage-frequency-value').textContent = this.value + ' MHz';
    });
    
    // Manual coverage frequency input
    document.getElementById('coverage-frequency-value').addEventListener('click', function() {
        const newFreq = prompt('Enter frequency in MHz:', document.getElementById('coverage-frequency').value);
        if (newFreq !== null && !isNaN(newFreq) && newFreq >= 100 && newFreq <= 6000) {
            document.getElementById('coverage-frequency').value = newFreq;
            document.getElementById('coverage-frequency-value').textContent = newFreq + ' MHz';
        } else if (newFreq !== null) {
            alert('Please enter a valid frequency between 100 and 6000 MHz');
        }
    });
    
    document.getElementById('coverage-radius').addEventListener('input', function() {
        document.getElementById('coverage-radius-value').textContent = this.value + ' m';
    });
    
    // Manual coverage radius input
    document.getElementById('coverage-radius-value').addEventListener('click', function() {
        const newRadius = prompt('Enter coverage radius in meters:', document.getElementById('coverage-radius').value);
        if (newRadius !== null && !isNaN(newRadius) && newRadius >= 10 && newRadius <= 500) {
            document.getElementById('coverage-radius').value = newRadius;
            document.getElementById('coverage-radius-value').textContent = newRadius + ' m';
        } else if (newRadius !== null) {
            alert('Please enter a valid radius between 10 and 500 meters');
        }
    });
    
    document.getElementById('resolution').addEventListener('input', function() {
        document.getElementById('resolution-value').textContent = this.value + ' m';
    });
    
    // Manual resolution input
    document.getElementById('resolution-value').addEventListener('click', function() {
        const newResolution = prompt('Enter grid resolution in meters:', document.getElementById('resolution').value);
        if (newResolution !== null && !isNaN(newResolution) && newResolution >= 1 && newResolution <= 20) {
            document.getElementById('resolution').value = newResolution;
            document.getElementById('resolution-value').textContent = newResolution + ' m';
        } else if (newResolution !== null) {
            alert('Please enter a valid resolution between 1 and 20 meters');
        }
    });

    // Delay analysis events
    document.getElementById('select-delay-tx-btn').addEventListener('click', function() {
        isSelecting = true;
        this.textContent = 'Selecting TX...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });
    
    document.getElementById('analyze-delay-btn').addEventListener('click', analyzeDelaySpread);
    document.getElementById('show-delay-map-btn').addEventListener('click', show3DDelayMap);
    document.getElementById('reset-delay-btn').addEventListener('click', resetDelayAnalysis);

    // Delay analysis sliders and inputs
    document.getElementById('delay-frequency').addEventListener('input', function() {
        document.getElementById('delay-frequency-value').textContent = this.value + ' MHz';
    });
    
    document.getElementById('delay-tx-height').addEventListener('input', function() {
        document.getElementById('delay-tx-height-value').textContent = this.value + ' m';
    });
    
    document.getElementById('delay-radius').addEventListener('input', function() {
        document.getElementById('delay-radius-value').textContent = this.value + ' m';
    });
    
    document.getElementById('delay-resolution').addEventListener('input', function() {
        document.getElementById('delay-resolution-value').textContent = this.value + ' m';
    });

    document.getElementById('delay-scaling').addEventListener('input', function() {
        document.getElementById('delay-scaling-value').textContent = this.value;
    });

    document.getElementById('cluster-count').addEventListener('input', function() {
        document.getElementById('cluster-count-value').textContent = this.value + ' clusters';
    });

    // Manual delay scaling input
    document.getElementById('delay-scaling-value').addEventListener('click', function() {
        const newScaling = prompt('Enter delay scaling factor (rτ):', document.getElementById('delay-scaling').value);
        if (newScaling !== null && !isNaN(newScaling) && newScaling >= 1 && newScaling <= 5) {
            document.getElementById('delay-scaling').value = newScaling;
            this.textContent = newScaling;
        } else if (newScaling !== null) {
            alert('Please enter a valid scaling factor between 1 and 5');
        }
    });

    // Manual cluster count input
    document.getElementById('cluster-count-value').addEventListener('click', function() {
        const newCount = prompt('Enter number of clusters:', document.getElementById('cluster-count').value);
        if (newCount !== null && !isNaN(newCount) && newCount >= 1 && newCount <= 20) {
            document.getElementById('cluster-count').value = newCount;
            this.textContent = newCount + ' clusters';
        } else if (newCount !== null) {
            alert('Please enter a valid cluster count between 1 and 20');
        }
    });

    // Throughput analysis events
    document.getElementById('select-throughput-tx-btn').addEventListener('click', function() {
        isSelecting = true;
        this.textContent = 'Selecting TX...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });
    
    document.getElementById('analyze-throughput-btn').addEventListener('click', analyzeThroughput);
    document.getElementById('show-throughput-map-btn').addEventListener('click', show3DThroughputMap);
    document.getElementById('reset-throughput-btn').addEventListener('click', resetThroughputAnalysis);

    // Throughput analysis sliders and inputs
    document.getElementById('throughput-frequency').addEventListener('input', function() {
        document.getElementById('throughput-frequency-value').textContent = this.value + ' MHz';
    });
    
    document.getElementById('throughput-tx-height').addEventListener('input', function() {
        document.getElementById('throughput-tx-height-value').textContent = this.value + ' m';
    });
    
    document.getElementById('throughput-radius').addEventListener('input', function() {
        document.getElementById('throughput-radius-value').textContent = this.value + ' m';
    });
    
    document.getElementById('throughput-resolution').addEventListener('input', function() {
        document.getElementById('throughput-resolution-value').textContent = this.value + ' m';
    });

    document.getElementById('cell-load').addEventListener('input', function() {
        const value = parseFloat(this.value);
        document.getElementById('cell-load-value').textContent = value.toFixed(1) + ' (' + (value * 100) + '%)';
    });

    // Noise floor and interference event listeners
    document.getElementById('noise-floor').addEventListener('input', function() {
        document.getElementById('noise-floor-value').textContent = this.value + ' dBm';
    });

    document.getElementById('interference').addEventListener('input', function() {
        document.getElementById('interference-value').textContent = this.value + ' dBm';
    });

    // Manual input for noise floor
    document.getElementById('noise-floor-value').addEventListener('click', function() {
        const newValue = prompt('Enter noise floor in dBm:', document.getElementById('noise-floor').value);
        if (newValue !== null && !isNaN(newValue) && newValue >= -120 && newValue <= -80) {
            document.getElementById('noise-floor').value = newValue;
            this.textContent = newValue + ' dBm';
        } else if (newValue !== null) {
            alert('Please enter a valid noise floor between -120 and -80 dBm');
        }
    });

    // Manual input for interference
    document.getElementById('interference-value').addEventListener('click', function() {
        const newValue = prompt('Enter interference level in dBm:', document.getElementById('interference').value);
        if (newValue !== null && !isNaN(newValue) && newValue >= -110 && newValue <= -70) {
            document.getElementById('interference').value = newValue;
            this.textContent = newValue + ' dBm';
        } else if (newValue !== null) {
            alert('Please enter a valid interference level between -110 and -70 dBm');
        }
    });

    // Multi-Coverage Analysis events
    document.getElementById('add-bs-btn').addEventListener('click', () => showBSConfigPanel());
    document.getElementById('close-bs-config-btn').addEventListener('click', hideBSConfigPanel);
    document.getElementById('save-bs-btn').addEventListener('click', saveBaseStation);
    document.getElementById('position-bs-btn').addEventListener('click', function() {
        isSelectingBSPosition = true;
        this.textContent = 'Click on 3D Model...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });
    document.getElementById('cancel-bs-btn').addEventListener('click', hideBSConfigPanel);
    
    // Multi-coverage sliders and inputs
    document.getElementById('bs-tx-power').addEventListener('input', function() {
        document.getElementById('bs-tx-power-value').textContent = this.value + ' dBm';
    });
    document.getElementById('bs-frequency').addEventListener('input', function() {
        document.getElementById('bs-frequency-value').textContent = this.value + ' MHz';
    });
    document.getElementById('bs-tx-height').addEventListener('input', function() {
        document.getElementById('bs-tx-height-value').textContent = this.value + ' m';
    });
    document.getElementById('bs-radius').addEventListener('input', function() {
        document.getElementById('bs-radius-value').textContent = this.value + ' m';
    });
    document.getElementById('bs-antenna-azimuth').addEventListener('input', function() {
        document.getElementById('bs-antenna-azimuth-value').textContent = this.value + '°';
    });
    document.getElementById('bs-antenna-gain').addEventListener('input', function() {
        document.getElementById('bs-antenna-gain-value').textContent = this.value + ' dBi';
    });
    
    document.getElementById('multi-coverage-resolution').addEventListener('input', function() {
        document.getElementById('multi-coverage-resolution-value').textContent = this.value + ' m';
        updateGridRange();
    });
    
    document.getElementById('grid-padding').addEventListener('input', function() {
        document.getElementById('grid-padding-value').textContent = this.value + ' m';
        updateGridRange();
    });
    
    document.getElementById('auto-grid').addEventListener('change', updateGridRange);
    
    document.getElementById('remove-all-bs-btn').addEventListener('click', removeAllBaseStations);
    document.getElementById('export-bs-btn').addEventListener('click', exportBSConfig);
    document.getElementById('import-bs-btn').addEventListener('click', importBSConfig);
    
    document.getElementById('analyze-multi-coverage-btn').addEventListener('click', analyzeMultiCoverage);
    document.getElementById('show-multi-coverage-map-btn').addEventListener('click', showMultiCoverageMap);
    document.getElementById('show-bs-comparison-btn').addEventListener('click', showBSComparison);
    document.getElementById('reset-multi-coverage-btn').addEventListener('click', resetMultiCoverage);
    
    document.getElementById('toggle-bs-stats-btn').addEventListener('click', function() {
        const container = document.getElementById('bs-stats-container');
        if (container.style.display === 'none') {
            container.style.display = 'block';
            this.textContent = 'Hide Details';
        } else {
            container.style.display = 'none';
            this.textContent = 'Show Details';
        }
    });
    
    // Cancel button event listener
    document.getElementById('cancel-btn').addEventListener('click', cancelAnalysis);

    // ── Crowd Analysis event listeners ────────────────────────
    document.getElementById('select-crowd-bs-btn').addEventListener('click', function() {
        isSelectingCrowdBS = true;
        isSelectingCrowdCenter = false;
        this.textContent = 'Click on 3D model...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });
    document.getElementById('select-crowd-center-btn').addEventListener('click', function() {
        isSelectingCrowdCenter = true;
        isSelectingCrowdBS = false;
        this.textContent = 'Click on 3D model...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });
    document.getElementById('analyze-crowd-btn').addEventListener('click', analyzeCrowd);
    document.getElementById('clear-crowd-btn').addEventListener('click', clearCrowdVisualization);
    document.getElementById('reset-crowd-btn').addEventListener('click', resetCrowdAnalysis);

    document.getElementById('crowd-density').addEventListener('input', function() {
        document.getElementById('crowd-density-value').textContent = this.value + ' p/m²';
    });
    // crowd-radius is now a number input — no listener needed
    document.getElementById('crowd-resolution').addEventListener('input', function() {
        document.getElementById('crowd-resolution-value').textContent = this.value + ' m';
    });
    document.getElementById('crowd-tx-power').addEventListener('input', function() {
        document.getElementById('crowd-tx-power-value').textContent = this.value + ' dBm';
    });
    document.getElementById('crowd-tx-height').addEventListener('input', function() {
        document.getElementById('crowd-tx-height-value').textContent = this.value + ' m';
    });
    document.getElementById('crowd-frequency').addEventListener('input', function() {
        const freq = parseFloat(this.value);
        document.getElementById('crowd-frequency-value').textContent = freq + ' MHz';
        // Update model indicator
        const modelEl = document.getElementById('crowd-model-indicator');
        if (freq < 6000) {
            modelEl.textContent = '📡 Model A active — statistical blocker (3GPP TR 38.901) < 6 GHz';
            modelEl.style.color = '#276749';
        } else {
            modelEl.textContent = '📡 Model B active — Fresnel screen geometry ≥ 6 GHz';
            modelEl.style.color = '#2b6cb0';
        }
    });

    // Setup SINR and Fairness event listeners
    setupSINREventListeners();
}

// Model Click Handler
function onModelClick(event) {
    if (!isSelecting && !isSelectingBSPosition && !isSelectingCrowdBS && !isSelectingCrowdCenter && !isSelectingSinrTx && currentTool !== 'multi-coverage') return;
    
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    
    raycaster.setFromCamera(mouse, camera);
    
    let intersects = raycaster.intersectObject(model, true);
    if (intersects.length === 0) {
        intersects = raycaster.intersectObjects(scene.children, true);
    }
    
    if (intersects.length > 0) {
        const point = intersects[0].point;
        
        if (isSelectingBSPosition) {
            handleBSSelection(point);
        } else if (isSelectingSinrTx) {
            handleSINRClick(intersects);
        } else if (currentTool === 'pathloss') {
            handlePathLossSelection(point);
        } else if (currentTool === 'coverage') {
            handleCoverageSelection(point);
        } else if (currentTool === 'delay') {
            handleDelaySelection(point);
        } else if (currentTool === 'throughput') {
            handleThroughputSelection(point);
        } else if (currentTool === 'crowd') {
            handleCrowdClick(point);
        }
    }
}

// Selection Handlers
function handlePathLossSelection(point) {
    if (!point1) {
        point1 = point;
        point1Marker = createPointMarker(point1, 0xff0000, 'point1-marker');
        updatePointDisplay('point1-coords', point1);
    } else if (!point2) {
        point2 = point;
        point2Marker = createPointMarker(point2, 0x0000ff, 'point2-marker');
        updatePointDisplay('point2-coords', point2);
        exitSelectionMode();
        document.getElementById('select-btn').textContent = 'Select Points';
        document.getElementById('select-btn').style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    }
}

function handleCoverageSelection(point) {
    point1 = point;
    if (point1Marker) scene.remove(point1Marker);
    point1Marker = createPointMarker(point1, 0xffa500, 'coverage-tx-marker');
    updatePointDisplay('tx-coords', point1);
    
    // Visualize antenna pattern when transmitter is selected
    const azimuth = parseFloat(document.getElementById('antenna-azimuth').value);
    const beamwidth = parseFloat(document.getElementById('antenna-beamwidth').value);
    visualizeAntennaPattern(point1, azimuth, beamwidth);
    
    exitSelectionMode();
    document.getElementById('select-tx-btn').textContent = 'Select Transmitter';
    document.getElementById('select-tx-btn').style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
}

function handleDelaySelection(point) {
    point1 = point;
    point1Marker = createPointMarker(point1, 0x800080, 'delay-tx-marker'); // Purple for delay analysis
    updatePointDisplay('delay-tx-coords', point1);
    
    // Set default transmitter height for delay analysis
    document.getElementById('delay-tx-height').value = 25;
    document.getElementById('delay-tx-height-value').textContent = '25 m';
    
    exitSelectionMode();
    document.getElementById('select-delay-tx-btn').textContent = 'Select Transmitter';
    document.getElementById('select-delay-tx-btn').style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
}

function handleThroughputSelection(point) {
    point1 = point;
    if (point1Marker) scene.remove(point1Marker);
    point1Marker = createPointMarker(point1, 0x008000, 'throughput-tx-marker'); // Green for throughput analysis
    updatePointDisplay('throughput-tx-coords', point1);
    
    // Set default transmitter height for throughput analysis
    document.getElementById('throughput-tx-height').value = 25;
    document.getElementById('throughput-tx-height-value').textContent = '25 m';
    
    exitSelectionMode();
    document.getElementById('select-throughput-tx-btn').textContent = 'Select Transmitter';
    document.getElementById('select-throughput-tx-btn').style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
}

function handleBSSelection(point) {
    const bsData = {
        name: document.getElementById('bs-name').value.trim() || `BS-${baseStations.length + 1}`,
        color: document.getElementById('bs-color').value,
        txPower: parseFloat(document.getElementById('bs-tx-power').value),
        frequency: parseFloat(document.getElementById('bs-frequency').value),
        txHeight: parseFloat(document.getElementById('bs-tx-height').value),
        radius: parseFloat(document.getElementById('bs-radius').value),
        environment: document.getElementById('bs-environment').value,
        antennaAzimuth: parseFloat(document.getElementById('bs-antenna-azimuth').value),
        antennaBeamwidth: parseFloat(document.getElementById('bs-antenna-beamwidth').value),
        antennaGain: parseFloat(document.getElementById('bs-antenna-gain').value),
        rayTracingEnabled: document.getElementById('bs-ray-tracing').checked,
        position: { x: point.x, y: point.y, z: point.z },
        index: editingBSIndex !== null ? editingBSIndex : baseStations.length
    };
    
    if (editingBSIndex !== null && baseStations[editingBSIndex]) {
        // Update existing BS
        baseStations[editingBSIndex] = bsData;
        updateBSMarker(editingBSIndex, bsData);
    } else {
        // Add new BS
        baseStations.push(bsData);
        const index = baseStations.length - 1;
        bsData.index = index;
        const marker = createBSMarker(bsData, index);
        bsMarkers[index] = marker.marker;
        bsLabels[index] = marker.label;
    }
    
    updateBSList();
    hideBSConfigPanel();
    updateGridRange();
}

// Path Loss Calculation
function calculatePathLoss() {
    if (!point1 || !point2) {
        alert('Please select both points first!');
        return;
    }
    
    const distance3D = point1.distanceTo(point2);
    const distance2D = Math.sqrt(
        Math.pow(point2.x - point1.x, 2) + 
        Math.pow(point2.z - point1.z, 2)
    );
    const frequency = parseFloat(document.getElementById('frequency').value);
    const txHeight = parseFloat(document.getElementById('tx-height').value);
    const rxHeight = parseFloat(document.getElementById('rx-height').value);
    const environment = document.getElementById('environment').value;
    
    console.log('Input parameters:', {
        distance2D, distance3D, frequency, txHeight, rxHeight, environment
    });
    
    // Check if points are within valid range
    if (distance2D < 10 || distance2D > 5000) {
        alert('Distance must be between 10m and 5km for accurate 3GPP model calculation');
        return;
    }
    
    let pathLoss;
    let modelName;
    
    switch(environment) {
        case 'uma-los':
            pathLoss = calculateUMaLOS(distance2D, distance3D, frequency, txHeight, rxHeight);
            modelName = 'UMa LOS';
            break;
        case 'uma-nlos':
            pathLoss = calculateUMaNLOS(distance2D, distance3D, frequency, txHeight, rxHeight);
            modelName = 'UMa NLOS';
            break;
        case 'umi-los':
            pathLoss = calculateUMiLOS(distance2D, distance3D, frequency, txHeight, rxHeight);
            modelName = 'UMi LOS';
            break;
        case 'umi-nlos':
            pathLoss = calculateUMiNLOS(distance3D, frequency, txHeight, rxHeight);
            modelName = 'UMi NLOS';
            break;
        default:
            pathLoss = calculateUMaLOS(distance2D, distance3D, frequency, txHeight, rxHeight);
            modelName = 'UMa LOS';
    }
    
    console.log('Calculated path loss:', pathLoss);
    
    // Check if pathLoss is valid
    if (isNaN(pathLoss) || !isFinite(pathLoss)) {
        alert('Error in path loss calculation. Please check the input parameters.');
        return;
    }
    
    // Add shadow fading
    const shadowFading = (Math.random()) * 4;   //4 db shadow fading 
    pathLoss += shadowFading;
    
    document.getElementById('path-loss-value').textContent = pathLoss.toFixed(2) + ' dB';
    document.getElementById('distance-info').textContent = `Distance: ${distance3D.toFixed(2)} m (2D: ${distance2D.toFixed(2)} m)`;
    document.getElementById('model-info').textContent = `Model: ${modelName} | Shadow Fading: ${shadowFading.toFixed(1)} dB`;
    document.getElementById('result').style.display = 'block';
}

// 3GPP Path Loss Models
function calculateUMaLOS(d2D, d3D, frequency, hBS, hUT) {
    const fcGHz = frequency / 1000;
    const c = 3e8;
    const dBp = (4 * hBS * hUT * fcGHz * 1e9) / c;
    
    if (d3D <= 0 || !isFinite(d3D)) return 100;
    
    let PL_LOS;
    if (d2D <= dBp && d2D >= 10) {
        PL_LOS = 28.0 + 22 * Math.log10(d3D) + 20 * Math.log10(fcGHz);
    } else if (d2D <= 5000 && d2D > dBp) {
        const term = Math.pow(dBp, 2) + Math.pow(hBS - hUT, 2);
        PL_LOS = term > 0 ? 
            28.0 + 40 * Math.log10(d3D) + 20 * Math.log10(fcGHz) - 9 * Math.log10(term) :
            28.0 + 40 * Math.log10(d3D) + 20 * Math.log10(fcGHz);
    } else {
        PL_LOS = 32.4 + 20 * Math.log10(fcGHz) + 30 * Math.log10(d3D);
    }
    
    return isFinite(PL_LOS) ? PL_LOS : 32.4 + 20 * Math.log10(fcGHz) + 30 * Math.log10(Math.max(d3D, 1));
}

function calculateUMaNLOS(d2D, d3D, frequency, hBS, hUT) {
    const PL_LOS = calculateUMaLOS(d2D, d3D, frequency, hBS, hUT);
    const PL_NLOS = 13.54 + 39.08 * Math.log10(d3D) + 20 * Math.log10(frequency/1000) - 0.6 * (hUT - 1.5);
    return Math.max(PL_LOS, PL_NLOS);
}

function calculateUMiLOS(d2D, d3D, frequency, hBS, hUT) {
    const fcGHz = frequency / 1000;
    const c = 3e8;
    const dBp = (4 * hBS * hUT * fcGHz * 1e9) / c;
    
    if (d3D <= 0 || !isFinite(d3D)) return 100;
    
    let PL_UMi;
    if (d2D <= dBp) {
        PL_UMi = 32.4 + 21 * Math.log10(d3D) + 20 * Math.log10(fcGHz);
    } else {
        const term = Math.pow(dBp, 2) + Math.pow(hBS - hUT, 2);
        PL_UMi = term > 0 ?
            32.4 + 40 * Math.log10(d3D) + 20 * Math.log10(fcGHz) - 9.5 * Math.log10(term) :
            32.4 + 40 * Math.log10(d3D) + 20 * Math.log10(fcGHz);
    }
    
    return isFinite(PL_UMi) ? PL_UMi : 32.4 + 21 * Math.log10(Math.max(d3D, 1)) + 20 * Math.log10(fcGHz);
}

function calculateUMiNLOS(d3D, frequency, hBS, hUT) {
    const fcGHz = frequency / 1000;
    return 35.3 * Math.log10(d3D) + 22.4 + 21.3 * Math.log10(fcGHz) - 0.3 * (hUT - 1.5);
}

// Coverage Analysis
async function analyzeCoverage3D() {
    if (!point1) {
        alert('Please select transmitter location first!');
        return;
    }
    
    const startTime = performance.now();
    
    const txPower = parseFloat(document.getElementById('tx-power').value);
    const radius = parseFloat(document.getElementById('coverage-radius').value);
    const resolution = parseFloat(document.getElementById('resolution').value);
    const frequency = parseFloat(document.getElementById('coverage-frequency').value);
    const txHeight = parseFloat(document.getElementById('coverage-tx-height').value);
    const environment = document.getElementById('coverage-environment').value;
    const rayTracingEnabled = document.getElementById('ray-tracing').checked;
    
    // Get antenna parameters
    const antennaAzimuth = parseFloat(document.getElementById('antenna-azimuth').value);
    const antennaBeamwidth = parseFloat(document.getElementById('antenna-beamwidth').value);
    const antennaGain = parseFloat(document.getElementById('antenna-gain').value);
    
    // Clear previous visualization
    clearCoverageVisualization();
    
    // Show progress overlay
    showProgressOverlay('3D Coverage Analysis', 'Calculating coverage area...');
    
    try {
        const txPosition = {
            x: point1.x,
            y: point1.y,
            z: point1.z
        };
        
        const analysisData = {
            txPosition,
            radius,
            resolution,
            frequency,
            txPower,
            environment,
            txHeight,
            antennaParams: {
                azimuth: antennaAzimuth,
                beamwidth: antennaBeamwidth,
                gain: antennaGain
            },
            rayTracingEnabled,
            groundLevel,
            // buildingData is sent once via workerManager.setBuildingData(), not per task
        };
        
        // Store the current task
        currentAnalysisTask = {
            type: 'coverage-analysis',
            data: analysisData
        };
        
        // Execute analysis in worker
        const result = await workerManager.executeTask(
            'coverage-analysis',
            analysisData,
            // Progress callback
            (progress) => {
                updateProgress(progress.progress || 0, 
                    `Processed ${(progress.processed||0).toLocaleString()} of ${(progress.total||0).toLocaleString()} points...`);
            }
        );
        
        const endTime = performance.now();
        const computeTime = ((endTime - startTime) / 1000).toFixed(2);
        
        // Unpack typed-array result from optimised worker
        const _covPos = result.positions, _covSig = result.signals, _covCount = result.pointCount;
        coveragePoints = [];
        for (let _i = 0; _i < _covCount; _i++) {
            const _b = _i * 3;
            coveragePoints.push({
                position: new THREE.Vector3(_covPos[_b], _covPos[_b+1], _covPos[_b+2]),
                signalStrength: _covSig[_i],
                color: getSignalColor(_covSig[_i])
            });
        }
        
        // Create visualization
        create3DCoverageVisualization();
        
        // Update UI with results
        document.getElementById('coverage-area').textContent = result.coverageVolume.toFixed(2) + ' m³';
        document.getElementById('points-analyzed').textContent = result.pointsAnalyzed.toLocaleString();
        document.getElementById('compute-time').textContent = computeTime + ' seconds';
        document.getElementById('coverage-model').textContent = `Model: ${environment.toUpperCase()} | Ray Tracing: ${rayTracingEnabled ? 'On' : 'Off'}`;
        
        const status = workerManager.getStatus();
        document.getElementById('performance-info').textContent = 
            `Worker mode: ${status.isWorkerSupported ? 'Multi-threaded' : 'Single-threaded'} | ` +
            `Points: ${result.pointCount.toLocaleString()}`;
        
        document.getElementById('coverage-result').style.display = 'block';
        
        coverageAnalysis = {
            txPosition: point1.clone(),
            txHeight: txHeight,
            radius: radius,
            resolution: resolution,
            coverageVolume: result.coverageVolume,
            pointsAnalyzed: result.pointsAnalyzed,
            computeTime: computeTime,
            coveragePoints: result.coveragePoints.length,
            environment: environment,
            rayTracing: rayTracingEnabled,
            antennaParams: {
                azimuth: antennaAzimuth,
                beamwidth: antennaBeamwidth,
                gain: antennaGain
            }
        };
        
    } catch (error) {
        console.error('Coverage analysis failed:', error);
        if (error.message !== 'Analysis cancelled') {
            alert('Coverage analysis failed: ' + error.message);
        }
    } finally {
        // Hide progress overlay
        hideProgressOverlay();
        currentAnalysisTask = null;
        currentTaskId = null;
    }
}

function getSignalColor(signalStrength) {
    // Color scale from red (weak) to green (strong)
    if (signalStrength >= -70) return new THREE.Color(0x00ff00); // Green
    if (signalStrength >= -85) return new THREE.Color(0x80ff00); // Light Green
    if (signalStrength >= -95) return new THREE.Color(0xffff00); // Yellow
    if (signalStrength >= -105) return new THREE.Color(0xff8000); // Orange
    return new THREE.Color(0xff0000); // Red
}

function create3DCoverageVisualization() {
    if (coveragePoints.length === 0) return;
    createCoveragePointCloud();
    createCoverageVolumeSpheres();
}

function createCoveragePointCloud() {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];
    
    coveragePoints.forEach(point => {
        positions.push(point.position.x, point.position.y, point.position.z);
        colors.push(point.color.r, point.color.g, point.color.b);
    });
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    
    const material = new THREE.PointsMaterial({
        size: 2,
        vertexColors: true,
        transparent: true,
        opacity: 0.6
    });
    
    const pointCloud = new THREE.Points(geometry, material);
    pointCloud.name = 'coverage-point-cloud';
    scene.add(pointCloud);
    coverageMarkers.push(pointCloud);
}

function createCoverageVolumeSpheres() {
    const signalRanges = [
        { min: -70, max: 0, color: new THREE.Color(0x00ff00), size: 3 }, // Green
        { min: -80, max: -70, color: new THREE.Color(0x80ff00), size: 4 }, // Light Green
        { min: -90, max: -80, color: new THREE.Color(0xffff00), size: 5 }, // Yellow
        { min: -100, max: -90, color: new THREE.Color(0xff8000), size: 6 }, // Orange
        { min: -120, max: -100, color: new THREE.Color(0xff0000), size: 7 } // Red
    ];
    
    signalRanges.forEach(range => {
        const pointsInRange = coveragePoints.filter(p => p.signalStrength >= range.min && p.signalStrength < range.max);
        const samplePoints = pointsInRange.filter((_, index) => index % 20 === 0);
        
        samplePoints.forEach(point => {
            const geometry = new THREE.SphereGeometry(range.size, 8, 8);
            const material = new THREE.MeshBasicMaterial({
                color: range.color,
                transparent: true,
                opacity: 0.2
            });
            
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.copy(point.position);
            sphere.name = 'coverage-volume-sphere';
            scene.add(sphere);
            coverageMarkers.push(sphere);
        });
    });
}

function disposeObject(obj) {
    if (!obj) return;
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
        if (Array.isArray(obj.material)) {
            obj.material.forEach(m => { if (m.map) m.map.dispose(); m.dispose(); });
        } else {
            if (obj.material.map) obj.material.map.dispose();
            obj.material.dispose();
        }
    }
}

function clearCoverageVisualization() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.name && obj.name.includes('coverage')) {
            disposeObject(obj);
            scene.remove(obj);
        }
    }
    coverageMarkers = [];
    coveragePoints  = [];
}

function resetCoverage() {
    if (point1Marker) scene.remove(point1Marker);
    
    point1 = null;
    point1Marker = null;
    
    clearCoverageVisualization();
    
    document.getElementById('tx-coords').textContent = 'Not selected';
    
    // Reset to default values
    document.getElementById('tx-power').value = 20;
    document.getElementById('tx-power-value').textContent = '20 dBm';
    document.getElementById('coverage-tx-height').value = 25;
    document.getElementById('coverage-tx-height-value').textContent = '25 m';
    document.getElementById('coverage-frequency').value = 2400;
    document.getElementById('coverage-frequency-value').textContent = '2400 MHz';
    document.getElementById('coverage-radius').value = 100;
    document.getElementById('coverage-radius-value').textContent = '100 m';
    document.getElementById('resolution').value = 5;
    document.getElementById('resolution-value').textContent = '5 m';
    document.getElementById('antenna-azimuth').value = 0;
    document.getElementById('antenna-azimuth-value').textContent = '0°';
    document.getElementById('antenna-gain').value = 8;
    document.getElementById('antenna-gain-value').textContent = '8 dBi';
    document.getElementById('antenna-beamwidth').value = 120;
    document.getElementById('ray-tracing').checked = false;
    document.getElementById('coverage-environment').value = 'uma-nlos';
    
    document.getElementById('coverage-result').style.display = 'none';
    
    if (coverageMap) {
        coverageMap.style.display = 'none';
    }
    
    exitSelectionMode();
}

// Multi-Coverage Analysis Functions
function showBSConfigPanel(editIndex = null) {
    const panel = document.getElementById('bs-config-panel');
    const title = document.getElementById('bs-config-title');
    
    if (editIndex !== null && baseStations[editIndex]) {
        editingBSIndex = editIndex;
        const bs = baseStations[editIndex];
        title.textContent = `Edit Base Station: ${bs.name}`;
        
        // Load existing values
        document.getElementById('bs-name').value = bs.name;
        document.getElementById('bs-color').value = bs.color;
        document.getElementById('bs-tx-power').value = bs.txPower;
        document.getElementById('bs-tx-power-value').textContent = bs.txPower + ' dBm';
        document.getElementById('bs-frequency').value = bs.frequency;
        document.getElementById('bs-frequency-value').textContent = bs.frequency + ' MHz';
        document.getElementById('bs-tx-height').value = bs.txHeight;
        document.getElementById('bs-tx-height-value').textContent = bs.txHeight + ' m';
        document.getElementById('bs-radius').value = bs.radius;
        document.getElementById('bs-radius-value').textContent = bs.radius + ' m';
        document.getElementById('bs-environment').value = bs.environment;
        document.getElementById('bs-antenna-azimuth').value = bs.antennaAzimuth;
        document.getElementById('bs-antenna-azimuth-value').textContent = bs.antennaAzimuth + '°';
        document.getElementById('bs-antenna-beamwidth').value = bs.antennaBeamwidth;
        document.getElementById('bs-antenna-gain').value = bs.antennaGain;
        document.getElementById('bs-antenna-gain-value').textContent = bs.antennaGain + ' dBi';
        document.getElementById('bs-ray-tracing').checked = bs.rayTracingEnabled;
    } else {
        editingBSIndex = null;
        title.textContent = 'Add New Base Station';
        
        // Set default values
        document.getElementById('bs-name').value = `BS-${baseStations.length + 1}`;
        document.getElementById('bs-color').value = '#ff0000';
        document.getElementById('bs-tx-power').value = 20;
        document.getElementById('bs-tx-power-value').textContent = '20 dBm';
        document.getElementById('bs-frequency').value = 2400;
        document.getElementById('bs-frequency-value').textContent = '2400 MHz';
        document.getElementById('bs-tx-height').value = 25;
        document.getElementById('bs-tx-height-value').textContent = '25 m';
        document.getElementById('bs-radius').value = 100;
        document.getElementById('bs-radius-value').textContent = '100 m';
        document.getElementById('bs-environment').value = 'uma-nlos';
        document.getElementById('bs-antenna-azimuth').value = 0;
        document.getElementById('bs-antenna-azimuth-value').textContent = '0°';
        document.getElementById('bs-antenna-beamwidth').value = 120;
        document.getElementById('bs-antenna-gain').value = 8;
        document.getElementById('bs-antenna-gain-value').textContent = '8 dBi';
        document.getElementById('bs-ray-tracing').checked = false;
    }
    
    panel.style.display = 'block';
    
    // Scroll to panel
    setTimeout(() => {
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 100);
}

function hideBSConfigPanel() {
    document.getElementById('bs-config-panel').style.display = 'none';
    editingBSIndex = null;
    isSelectingBSPosition = false;
    document.getElementById('position-bs-btn').textContent = '📍 Set Position';
    document.getElementById('position-bs-btn').style.background = 'linear-gradient(135deg, #3182ce 0%, #2b6cb0 100%)';
    showSelectionMode(false);
}

function saveBaseStation() {
    const name = document.getElementById('bs-name').value.trim() || `BS-${baseStations.length + 1}`;
    const color = document.getElementById('bs-color').value;
    
    const bsData = {
        name: name,
        color: color,
        txPower: parseFloat(document.getElementById('bs-tx-power').value),
        frequency: parseFloat(document.getElementById('bs-frequency').value),
        txHeight: parseFloat(document.getElementById('bs-tx-height').value),
        radius: parseFloat(document.getElementById('bs-radius').value),
        environment: document.getElementById('bs-environment').value,
        antennaAzimuth: parseFloat(document.getElementById('bs-antenna-azimuth').value),
        antennaBeamwidth: parseFloat(document.getElementById('bs-antenna-beamwidth').value),
        antennaGain: parseFloat(document.getElementById('bs-antenna-gain').value),
        rayTracingEnabled: document.getElementById('bs-ray-tracing').checked,
        position: null // Will be set when position is selected
    };
    
    if (editingBSIndex !== null && baseStations[editingBSIndex]) {
        // Update existing BS
        bsData.position = baseStations[editingBSIndex].position;
        baseStations[editingBSIndex] = {
            ...baseStations[editingBSIndex],
            ...bsData,
            index: editingBSIndex
        };
        
        // Update marker and label
        updateBSMarker(editingBSIndex, bsData);
    } else {
        // New BS - requires position
        if (!isSelectingBSPosition) {
            alert('Please set a position for the base station first!');
            isSelectingBSPosition = true;
            document.getElementById('position-bs-btn').textContent = 'Click on 3D Model...';
            document.getElementById('position-bs-btn').style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
            showSelectionMode(true);
            return;
        }
        
        // Position will be set when user clicks on model
        return;
    }
    
    updateBSList();
    hideBSConfigPanel();
    updateGridRange();
}

function updateBSMarker(index, bsData) {
    // Remove existing marker and label
    if (bsMarkers[index]) {
        scene.remove(bsMarkers[index]);
        if (bsLabels[index]) {
            scene.remove(bsLabels[index]);
        }
    }
    
    // Create new marker
    const marker = createBSMarker(bsData, index);
    bsMarkers[index] = marker.marker;
    bsLabels[index] = marker.label;
}

function createBSMarker(bsData, index) {
    // Create marker sphere
    const geometry = new THREE.SphereGeometry(3, 16, 16);
    const color = new THREE.Color(bsData.color);
    const material = new THREE.MeshBasicMaterial({ 
        color: color,
        transparent: true,
        opacity: 0.9
    });
    
    const marker = new THREE.Mesh(geometry, material);
    marker.position.set(bsData.position.x, bsData.position.y, bsData.position.z);
    marker.name = `bs-marker-${index}`;
    scene.add(marker);
    
    // Create label
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = 256;
    canvas.height = 128;
    
    // Background
    context.fillStyle = 'rgba(255, 255, 255, 0.85)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    
    // Border
    context.strokeStyle = bsData.color;
    context.lineWidth = 3;
    context.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    
    // BS Name
    context.fillStyle = bsData.color;
    context.font = 'bold 20px Arial';
    context.textAlign = 'center';
    context.fillText(bsData.name, canvas.width / 2, 35);
    
    // Details
    context.fillStyle = '#333333';
    context.font = '14px Arial';
    context.fillText(`${bsData.txPower} dBm @ ${bsData.frequency} MHz`, canvas.width / 2, 65);
    context.fillText(`R: ${bsData.radius}m | H: ${bsData.txHeight}m`, canvas.width / 2, 90);
    context.fillText(`Az: ${bsData.antennaAzimuth}° | BW: ${bsData.antennaBeamwidth}°`, canvas.width / 2, 115);
    
    const texture = new THREE.CanvasTexture(canvas);
    const spriteMaterial = new THREE.SpriteMaterial({ 
        map: texture,
        transparent: true,
        opacity: 0.9
    });
    
    const label = new THREE.Sprite(spriteMaterial);
    label.position.set(bsData.position.x, bsData.position.y + 15, bsData.position.z);
    label.scale.set(25, 12.5, 1);
    label.name = `bs-label-${index}`;
    scene.add(label);
    
    return { marker, label };
}

function updateBSList() {
    const bsList = document.getElementById('bs-list');
    const bsCount = document.getElementById('bs-count');
    
    bsList.innerHTML = '';
    bsCount.textContent = baseStations.length;
    
    if (baseStations.length === 0) {
        bsList.innerHTML = `
            <div style="text-align: center; padding: 40px 20px; color: #718096;">
                <div style="font-size: 48px; margin-bottom: 10px;">📡</div>
                <div style="font-weight: bold; margin-bottom: 5px;">No Base Stations</div>
                <div style="font-size: 14px;">Click "Add BS" to create your first base station</div>
            </div>
        `;
        return;
    }
    
    baseStations.forEach((bs, index) => {
        const bsItem = document.createElement('div');
        bsItem.className = 'bs-list-item';
        bsItem.style.cssText = `
            padding: 12px;
            margin-bottom: 8px;
            background: white;
            border-radius: 8px;
            border-left: 4px solid ${bs.color};
            border: 1px solid #e2e8f0;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 12px;
        `;
        
        bsItem.innerHTML = `
            <div style="display: flex; align-items: center; gap: 12px; flex: 1;">
                <div style="width: 12px; height: 12px; border-radius: 50%; background: ${bs.color}; border: 2px solid ${bs.color};"></div>
                <div style="flex: 1;">
                    <div style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="font-weight: bold; color: ${bs.color};">${bs.name}</div>
                        <div style="font-size: 12px; color: #718096;">#${index + 1}</div>
                    </div>
                    <div style="font-size: 12px; color: #4a5568; margin-top: 4px;">
                        ${bs.position ? `Pos: (${bs.position.x.toFixed(1)}, ${bs.position.y.toFixed(1)}, ${bs.position.z.toFixed(1)})` : 'No position set'}
                    </div>
                    <div style="font-size: 11px; color: #718096; margin-top: 2px;">
                        ${bs.txPower} dBm @ ${bs.frequency} MHz • R: ${bs.radius}m • H: ${bs.txHeight}m
                    </div>
                </div>
            </div>
            <div style="display: flex; gap: 5px;">
                <button class="bs-action-btn" onclick="editBaseStation(${index}); event.stopPropagation();" 
                        style="background: ${bs.color}; color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer;">
                    ✏️ Edit
                </button>
                <button class="bs-action-btn" onclick="removeBaseStation(${index}); event.stopPropagation();" 
                        style="background: #e53e3e; color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 12px; cursor: pointer;">
                    🗑️
                </button>
            </div>
        `;
        
        bsItem.addEventListener('mouseenter', () => {
            bsItem.style.transform = 'translateY(-2px)';
            bsItem.style.boxShadow = '0 4px 12px rgba(0,0,0,0.1)';
            highlightBS(index, true);
        });
        
        bsItem.addEventListener('mouseleave', () => {
            bsItem.style.transform = 'translateY(0)';
            bsItem.style.boxShadow = 'none';
            highlightBS(index, false);
        });
        
        bsItem.addEventListener('click', (e) => {
            if (!e.target.classList.contains('bs-action-btn')) {
                selectBS(index);
            }
        });
        
        bsList.appendChild(bsItem);
    });
    
    // Select first BS by default
    if (baseStations.length > 0) {
        selectBS(0);
    }
}

function highlightBS(index, highlight) {
    if (bsMarkers[index]) {
        bsMarkers[index].material.opacity = highlight ? 1 : 0.9;
        bsMarkers[index].scale.setScalar(highlight ? 1.2 : 1);
    }
    if (bsLabels[index]) {
        bsLabels[index].material.opacity = highlight ? 1 : 0.9;
        bsLabels[index].scale.set(highlight ? 30 : 25, highlight ? 15 : 12.5, 1);
    }
}

function selectBS(index) {
    currentBSIndex = index;
    const bs = baseStations[index];
    
    // Center camera on selected BS
    if (bs.position) {
        const cameraDistance = Math.max(bs.radius * 2, 100);
        camera.position.set(
            bs.position.x + cameraDistance,
            bs.position.y + cameraDistance,
            bs.position.z + cameraDistance
        );
        controls.target.set(bs.position.x, bs.position.y, bs.position.z);
        controls.update();
    }
    
    // Update UI selection
    document.querySelectorAll('.bs-list-item').forEach((item, i) => {
        if (i === index) {
            item.style.background = '#ebf8ff';
            item.style.border = `2px solid ${bs.color}`;
        } else {
            item.style.background = 'white';
            item.style.border = '1px solid #e2e8f0';
        }
    });
}

function updateBSVisual(index) {
    const bs = baseStations[index];
    
    // Remove old marker if it exists
    if (bsMarkers[index]) {
        scene.remove(bsMarkers[index]);
    }

    // CREATE THE PYRAMID
    // Parameters: Radius (0.5 = Small), Height (15 = Big), Segments (4 = Pyramid)
    const geometry = new THREE.ConeGeometry(2.5, 50, 4);
    const material = new THREE.MeshPhongMaterial({ 
        color: bs.color, 
        flatShading: true,
        shininess: 100,
        emissive: bs.color,
        emissiveIntensity: 0.3
    });

    const tower = new THREE.Mesh(geometry, material);

    // Position: Lift by half-height (7.5) so base sits on the ground
    tower.position.set(bs.position.x, bs.position.y + 7.5, bs.position.z);

    // Add a glowing antenna tip
    const antennaGeo = new THREE.SphereGeometry(0.2, 16, 16);
    const antennaMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const antenna = new THREE.Mesh(antennaGeo, antennaMat);
    antenna.position.set(0, 7.5, 0); 
    tower.add(antenna);

    scene.add(tower);
    bsMarkers[index] = tower;
}

function editBaseStation(index) {
    showBSConfigPanel(index);
}

function removeBaseStation(index) {
    if (confirm(`Are you sure you want to remove ${baseStations[index].name}?`)) {
        // Remove from scene
        if (bsMarkers[index]) {
            scene.remove(bsMarkers[index]);
        }
        if (bsLabels[index]) {
            scene.remove(bsLabels[index]);
        }
        
        // Remove from arrays
        baseStations.splice(index, 1);
        bsMarkers.splice(index, 1);
        bsLabels.splice(index, 1);
        
        // Update indices
        baseStations.forEach((bs, i) => bs.index = i);
        
        updateBSList();
        updateGridRange();
        
        if (baseStations.length > 0) {
            selectBS(Math.min(index, baseStations.length - 1));
        }
    }
}

function removeAllBaseStations() {
    if (baseStations.length === 0) return;
    
    if (confirm(`Are you sure you want to remove all ${baseStations.length} base stations?`)) {
        // Remove all from scene
        bsMarkers.forEach(marker => {
            if (marker) scene.remove(marker);
        });
        bsLabels.forEach(label => {
            if (label) scene.remove(label);
        });
        
        // Clear arrays
        baseStations = [];
        bsMarkers = [];
        bsLabels = [];
        currentBSIndex = 0;
        
        updateBSList();
        updateGridRange();
    }
}

function updateGridRange() {
    if (baseStations.length === 0) {
        document.getElementById('grid-range-info').textContent = 'X: -200 to 200 m, Y: 0 to 50 m, Z: -200 to 200 m';
        document.getElementById('grid-points-info').textContent = 'Total points to analyze: Add base stations to calculate';
        return;
    }
    
    const autoGrid = document.getElementById('auto-grid').checked;
    const padding = parseFloat(document.getElementById('grid-padding').value);
    const resolution = parseFloat(document.getElementById('multi-coverage-resolution').value);
    
    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    
    if (autoGrid) {
        // Calculate grid based on BS positions and radii
        baseStations.forEach(bs => {
            if (bs.position) {
                minX = Math.min(minX, bs.position.x - bs.radius - padding);
                maxX = Math.max(maxX, bs.position.x + bs.radius + padding);
                minY = Math.min(minY, bs.position.y - padding);
                maxY = Math.max(maxY, bs.position.y + bs.radius * 0.3 + padding);
                minZ = Math.min(minZ, bs.position.z - bs.radius - padding);
                maxZ = Math.max(maxZ, bs.position.z + bs.radius + padding);
            }
        });
        
        // Ensure minimum dimensions
        const defaultRange = 200;
        if (minX === Infinity) minX = -defaultRange;
        if (maxX === -Infinity) maxX = defaultRange;
        if (minY === Infinity) minY = 0;
        if (maxY === -Infinity) maxY = 50;
        if (minZ === Infinity) minZ = -defaultRange;
        if (maxZ === -Infinity) maxZ = defaultRange;
        
        // Ensure Y has some height
        if (maxY - minY < 10) maxY = minY + 50;
    } else {
        // Use fixed grid
        minX = -200; maxX = 200;
        minY = 0; maxY = 50;
        minZ = -200; maxZ = 200;
    }
    
    // Update grid range display
    document.getElementById('grid-range-info').textContent = 
        `X: ${minX.toFixed(0)} to ${maxX.toFixed(0)} m, Y: ${minY.toFixed(0)} to ${maxY.toFixed(0)} m, Z: ${minZ.toFixed(0)} to ${maxZ.toFixed(0)} m`;
    
    // Calculate total points
    const xSteps = Math.ceil((maxX - minX) / resolution);
    const ySteps = Math.ceil((maxY - minY) / resolution);
    const zSteps = Math.ceil((maxZ - minZ) / resolution);
    const totalPoints = xSteps * ySteps * zSteps;
    
    document.getElementById('grid-points-info').textContent = 
        `Total points to analyze: ${totalPoints.toLocaleString()}`;
    
    return { minX, maxX, minY, maxY, minZ, maxZ, resolution, totalPoints };
}

async function analyzeMultiCoverage() {
    if (baseStations.length === 0) {
        alert('Please add at least one base station first!');
        return;
    }
    
    const startTime = performance.now();
    
    // Get grid parameters
    const gridParams = updateGridRange();
    if (!gridParams) return;
    
    // Clear previous visualization
    clearMultiCoverageVisualization();
    
    // Show progress overlay
    showProgressOverlay('Multi-BS Coverage Analysis', 'Calculating coverage for multiple base stations...');
    
    try {
        // Prepare data for worker
        const bsData = baseStations.map(bs => ({
            name: bs.name,
            position: bs.position,
            txPower: bs.txPower,
            frequency: bs.frequency,
            txHeight: bs.txHeight,
            radius: bs.radius,
            environment: bs.environment,
            antennaAzimuth: bs.antennaAzimuth,
            antennaBeamwidth: bs.antennaBeamwidth,
            antennaGain: bs.antennaGain,
            rayTracingEnabled: bs.rayTracingEnabled,
            index: bs.index
        }));
        
        // Execute multi-coverage analysis
        const result = await workerManager.executeMultiCoverageTask(
            bsData,
            gridParams,
            // Progress callback
            (progress) => {
                updateProgress(progress.progress || 0, 
                    `Processed ${(progress.processed||0).toLocaleString()} of ${(progress.total||0).toLocaleString()} points...`);
            }
        );
        
        const endTime = performance.now();
        const computeTime = ((endTime - startTime) / 1000).toFixed(2);
        
        // Unpack typed-array result from optimised worker
        const _mPos = result.positions, _mSig = result.signals, _mIdx = result.bsIndices, _mCount = result.pointCount;
        const coveragePoints = [];
        for (let _i = 0; _i < _mCount; _i++) {
            const _b = _i * 3;
            coveragePoints.push({
                position: new THREE.Vector3(_mPos[_b], _mPos[_b+1], _mPos[_b+2]),
                signalStrength: _mSig[_i],
                bsIndex: _mIdx[_i],
                color: getSignalColor(_mSig[_i])
            });
        }
        
        // Create visualization
        createMultiCoverageVisualization(coveragePoints);
        
        // Store analysis results
        multiCoverageAnalysis = {
            coveragePoints: coveragePoints,
            coverageStats: result.coverageStats,
            totalCoveragePoints: result.totalCoveragePoints,
            totalCoveragePercentage: result.totalCoveragePercentage,
            pointsAnalyzed: result.pointsAnalyzed,
            computeTime: computeTime,
            baseStations: result.baseStations,
            gridParams: gridParams
        };
        
        // Update UI with results
        updateMultiCoverageResults(result, computeTime);
        
    } catch (error) {
        console.error('Multi-coverage analysis failed:', error);
        if (error.message !== 'Analysis cancelled') {
            alert('Multi-coverage analysis failed: ' + error.message);
        }
    } finally {
        // Hide progress overlay
        hideProgressOverlay();
    }
}

function updateMultiCoverageResults(result, computeTime) {
    document.getElementById('total-coverage-percentage').textContent = result.totalCoveragePercentage;
    document.getElementById('total-coverage-points').textContent = result.totalCoveragePoints.toLocaleString();
    document.getElementById('multi-points-analyzed').textContent = result.pointsAnalyzed.toLocaleString();
    document.getElementById('multi-compute-time').textContent = computeTime + 's';
    
    // Calculate coverage density
    const gridVolume = (result.gridParams.maxX - result.gridParams.minX) * 
                       (result.gridParams.maxY - result.gridParams.minY) * 
                       (result.gridParams.maxZ - result.gridParams.minZ);
    const coverageDensity = gridVolume > 0 ? (result.totalCoveragePoints / gridVolume).toFixed(4) : 0;
    document.getElementById('coverage-density').textContent = coverageDensity + '/m³';
    
    // Update BS performance bars
    updateBSPerformanceBars(result.coverageStats);
    
    // Update BS stats list
    const bsStatsList = document.getElementById('bs-coverage-stats');
    bsStatsList.innerHTML = '';
    
    result.coverageStats.forEach(stat => {
        const li = document.createElement('li');
        li.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px;
            margin-bottom: 5px;
            background: white;
            border-radius: 6px;
            border-left: 4px solid ${baseStations[stat.index].color};
        `;
        li.innerHTML = `
            <div>
                <strong style="color: ${baseStations[stat.index].color}">${stat.name}</strong>
                <div style="font-size: 12px; color: #718096;">${stat.coveragePoints.toLocaleString()} points</div>
            </div>
            <div style="font-weight: bold; color: #3182ce;">${stat.coveragePercentage}%</div>
        `;
        bsStatsList.appendChild(li);
    });
    
    const status = workerManager.getStatus();
    document.getElementById('multi-performance-info').textContent = 
        `Worker mode: ${status.isWorkerSupported ? 'Multi-threaded' : 'Single-threaded'} | ` +
        `Points: ${result.totalCoveragePoints.toLocaleString()} | ` +
        `Grid: ${result.gridParams.resolution}m resolution`;
    
    document.getElementById('multi-coverage-result').style.display = 'block';
}

function updateBSPerformanceBars(coverageStats) {
    const container = document.getElementById('bs-performance-bars');
    container.innerHTML = '';
    
    // Find max coverage for scaling
    const maxCoverage = Math.max(...coverageStats.map(stat => stat.coveragePoints));
    
    coverageStats.forEach(stat => {
        const bs = baseStations[stat.index];
        if (!bs) return;
        
        const percentage = (stat.coveragePoints / maxCoverage) * 100;
        
        const barContainer = document.createElement('div');
        barContainer.style.cssText = `
            margin-bottom: 8px;
        `;
        
        barContainer.innerHTML = `
            <div style="display: flex; align-items: center; margin-bottom: 4px;">
                <div style="width: 12px; height: 12px; border-radius: 50%; background: ${bs.color}; margin-right: 8px;"></div>
                <div style="flex: 1; font-size: 13px; font-weight: bold; color: ${bs.color};">${stat.name}</div>
                <div style="font-size: 12px; color: #718096;">${stat.coveragePoints.toLocaleString()} points (${stat.coveragePercentage}%)</div>
            </div>
            <div style="height: 10px; background: #e2e8f0; border-radius: 5px; overflow: hidden;">
                <div style="height: 100%; width: ${percentage}%; background: ${bs.color}; border-radius: 5px; transition: width 0.5s;"></div>
            </div>
        `;
        
        container.appendChild(barContainer);
    });
}

function createMultiCoverageVisualization(coveragePoints) {
    if (coveragePoints.length === 0) return;
    
    // Clear existing coverage visualization
    clearMultiCoverageVisualization();
    
    // Group points by signal strength ranges instead of base station
    const signalRanges = [
        { min: -70, max: 0, color: new THREE.Color(0x00ff00), size: 2 }, // Green: Excellent
        { min: -85, max: -70, color: new THREE.Color(0xffff00), size: 2.5 }, // Yellow: Good to Fair
        { min: -100, max: -85, color: new THREE.Color(0xff8000), size: 3 }, // Orange: Poor
        { min: -120, max: -100, color: new THREE.Color(0xff0000), size: 3.5 } // Red: No signal/dead zone
    ];
    
    // Create point clouds for each signal strength range
    const rangeGroups = {};
    
    signalRanges.forEach((range, index) => {
        rangeGroups[index] = {
            positions: [],
            colors: []
        };
    });
    
    // Sort points into signal strength ranges
    coveragePoints.forEach(point => {
        for (let i = 0; i < signalRanges.length; i++) {
            if (point.signalStrength >= signalRanges[i].min && point.signalStrength < signalRanges[i].max) {
                rangeGroups[i].positions.push(point.position.x, point.position.y, point.position.z);
                rangeGroups[i].colors.push(signalRanges[i].color.r, signalRanges[i].color.g, signalRanges[i].color.b);
                break;
            }
        }
    });
    
    // Create a point cloud for each signal strength range
    Object.keys(rangeGroups).forEach(rangeIndex => {
        const group = rangeGroups[rangeIndex];
        if (group.positions.length === 0) return;
        
        const geometry = new THREE.BufferGeometry();
        
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(group.positions, 3));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(group.colors, 3));
        
        const material = new THREE.PointsMaterial({
            size: signalRanges[rangeIndex].size,
            vertexColors: true,
            transparent: true,
            opacity: 0.6
        });
        
        const pointCloud = new THREE.Points(geometry, material);
        pointCloud.name = `multi-coverage-point-cloud-range-${rangeIndex}`;
        scene.add(pointCloud);
        coverageMarkers.push(pointCloud);
    });
    
    // Create coverage spheres for better visualization (using signal strength colors)
    signalRanges.forEach((range, rangeIndex) => {
        const pointsInRange = coveragePoints.filter(p => 
            p.signalStrength >= range.min && p.signalStrength < range.max
        );
        
        // Sample some points for spheres (every 100th point)
        const samplePoints = pointsInRange.filter((_, index) => index % 100 === 0);
        
        samplePoints.forEach(point => {
            const geometry = new THREE.SphereGeometry(range.size * 1.5, 8, 8);
            const material = new THREE.MeshBasicMaterial({
                color: range.color,
                transparent: true,
                opacity: 0.2
            });
            
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.copy(point.position);
            sphere.name = `multi-coverage-sphere-range-${rangeIndex}`;
            scene.add(sphere);
            coverageMarkers.push(sphere);
        });
    });
}

// ── Interactive mode heatmap ────────────────────────────────────────────────
// Renders a signal-strength point cloud whose colour palette is anchored to
// the caller-supplied minRSSI floor instead of the fixed -120 dBm bin.
function createInteractiveHeatmap(coveragePoints, minRSSI) {
    if (!coveragePoints || coveragePoints.length === 0) return;

    clearMultiCoverageVisualization();

    // Dynamic colour scale: maps [minRSSI … -60 dBm] → red … green
    const floor  = (typeof minRSSI === 'number') ? minRSSI : -120;
    const ceil   = -60;   // excellent signal

    function signalToColor(sig) {
        // Normalise 0‒1 across the full range
        const t = Math.max(0, Math.min(1, (sig - floor) / (ceil - floor)));
        // Hue: 0° = red, 120° = green  →  t * 120
        return new THREE.Color().setHSL(t * 0.33, 1.0, 0.45);
    }

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(coveragePoints.length * 3);
    const colors    = new Float32Array(coveragePoints.length * 3);

    coveragePoints.forEach((pt, i) => {
        positions[i * 3]     = pt.position.x;
        positions[i * 3 + 1] = pt.position.y;
        positions[i * 3 + 2] = pt.position.z;
        const c = signalToColor(pt.signalStrength);
        colors[i * 3]     = c.r;
        colors[i * 3 + 1] = c.g;
        colors[i * 3 + 2] = c.b;
    });

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color',    new THREE.BufferAttribute(colors,    3));

    const cloud = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 3.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.75,
        sizeAttenuation: true
    }));
    cloud.name = 'multi-coverage-point-cloud-interactive';
    scene.add(cloud);
    coverageMarkers.push(cloud);
}

function clearMultiCoverageVisualization() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.name && obj.name.includes('multi-coverage')) {
            disposeObject(obj);
            scene.remove(obj);
        }
    }
    coverageMarkers = [];
}

function showMultiCoverageMap() {
    if (!multiCoverageAnalysis) {
        alert('Please run multi-coverage analysis first!');
        return;
    }
    
    const map = document.createElement('div');
    map.id = 'multi-coverage-map';
    map.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 90%;
        height: 85%;
        background: rgba(255, 255, 255, 0.98);
        border: 2px solid #333;
        border-radius: 15px;
        padding: 25px;
        z-index: 1000;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        overflow: auto;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        backdrop-filter: blur(10px);
    `;
    
    // Create coverage statistics HTML
    let bsStatsHTML = '';
    multiCoverageAnalysis.coverageStats.forEach(stat => {
        const bs = multiCoverageAnalysis.baseStations[stat.index];
        bsStatsHTML += `
            <div style="margin-bottom: 15px; padding: 15px; background: rgba(${parseInt(bs.color.slice(1,3), 16)}, ${parseInt(bs.color.slice(3,5), 16)}, ${parseInt(bs.color.slice(5,7), 16)}, 0.1); border-radius: 8px; border-left: 4px solid ${bs.color};">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div style="font-weight: bold; color: ${bs.color};">${stat.name}</div>
                    <div style="font-weight: bold;">${stat.coveragePercentage}% coverage</div>
                </div>
                <div style="margin-top: 10px; font-size: 14px;">
                    <div>Position: (${bs.position.x.toFixed(1)}, ${bs.position.y.toFixed(1)}, ${bs.position.z.toFixed(1)})</div>
                    <div>Power: ${bs.txPower} dBm | Frequency: ${bs.frequency} MHz | Radius: ${bs.radius}m</div>
                    <div>Coverage Points: ${stat.coveragePoints.toLocaleString()}</div>
                </div>
            </div>
        `;
    });
    
    map.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 2px solid #667eea; padding-bottom: 15px;">
            <h3 style="margin: 0; color: #2d3748; font-size: 1.5em;">Multi-BS Coverage Analysis Report</h3>
            <button onclick="this.parentElement.parentElement.remove()" 
                    style="padding: 10px 20px; background: linear-gradient(135deg, #e53e3e 0%, #c53030 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">
                Close Report
            </button>
        </div>
        
        <div style="display: grid; grid-template-columns: 2fr 1fr; gap: 25px;">
            <div>
                <div style="background: linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #48bb78; margin-bottom: 20px;">
                    <h4 style="margin-top: 0; color: #22543d; border-bottom: 1px solid #9ae6b4; padding-bottom: 10px;">Overall Coverage Summary</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                        <div style="text-align: center;">
                            <div style="font-size: 18px; font-weight: bold; color: #38a169;">Total Coverage</div>
                            <div style="font-size: 32px; font-weight: bold; color: #38a169;">${multiCoverageAnalysis.totalCoveragePercentage}%</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 18px; font-weight: bold; color: #3182ce;">Coverage Points</div>
                            <div style="font-size: 32px; font-weight: bold; color: #3182ce;">${multiCoverageAnalysis.totalCoveragePoints.toLocaleString()}</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 18px; font-weight: bold; color: #805ad5;">Points Analyzed</div>
                            <div style="font-size: 32px; font-weight: bold; color: #805ad5;">${multiCoverageAnalysis.pointsAnalyzed.toLocaleString()}</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 18px; font-weight: bold; color: #dd6b20;">Compute Time</div>
                            <div style="font-size: 32px; font-weight: bold; color: #dd6b20;">${multiCoverageAnalysis.computeTime}s</div>
                        </div>
                    </div>
                </div>
                
                <div style="background: linear-gradient(135deg, #ebf8ff 0%, #bee3f8 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #3182ce; margin-bottom: 20px;">
                    <h4 style="margin-top: 0; color: #2b6cb0; border-bottom: 1px solid #90cdf4; padding-bottom: 10px;">Analysis Grid Parameters</h4>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                        <div><strong>Resolution:</strong> ${multiCoverageAnalysis.gridParams.resolution} m</div>
                        <div><strong>X Range:</strong> ${multiCoverageAnalysis.gridParams.minX} to ${multiCoverageAnalysis.gridParams.maxX} m</div>
                        <div><strong>Y Range:</strong> ${multiCoverageAnalysis.gridParams.minY} to ${multiCoverageAnalysis.gridParams.maxY} m</div>
                        <div><strong>Z Range:</strong> ${multiCoverageAnalysis.gridParams.minZ} to ${multiCoverageAnalysis.gridParams.maxZ} m</div>
                        <div><strong>Total Grid Points:</strong> ${multiCoverageAnalysis.pointsAnalyzed.toLocaleString()}</div>
                        <div><strong>Base Stations:</strong> ${multiCoverageAnalysis.baseStations.length}</div>
                    </div>
                </div>
            </div>
            
            <div>
                <div style="background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #e53e3e; margin-bottom: 20px;">
                    <h4 style="margin-top: 0; color: #742a2a; border-bottom: 1px solid #fc8181; padding-bottom: 10px;">Base Station Coverage</h4>
                    <div style="max-height: 400px; overflow-y: auto;">
                        ${bsStatsHTML}
                    </div>
                </div>
            </div>
        </div>
        
        <div style="background: linear-gradient(135deg, #faf5ff 0%, #e9d8fd 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #805ad5; margin-top: 20px;">
            <h4 style="margin-top: 0; color: #44337a; border-bottom: 1px solid #d6bcfa; padding-bottom: 10px;">Coverage Assignment Rules</h4>
            <ul style="margin: 0; color: #44337a; line-height: 1.6;">
                <li><strong>Best Signal Selection:</strong> Each point is assigned to the base station with the strongest received power</li>
                <li><strong>Signal Calculation:</strong> Received Power = Transmit Power - Path Loss + Antenna Gain</li>
                <li><strong>Path Loss Models:</strong> 3GPP UMa/UMi models with environment-specific parameters</li>
                <li><strong>Antenna Effects:</strong> Directional antenna patterns and gains are considered</li>
                <li><strong>Minimum Signal:</strong> Points must have at least -120 dBm to be considered covered</li>
                <li><strong>Range Limitation:</strong> Points beyond base station radius are not considered</li>
            </ul>
        </div>
    `;
    
    document.body.appendChild(map);
}

function resetMultiCoverage() {
    // Clear BS markers
    bsMarkers.forEach(marker => {
        if (marker) scene.remove(marker);
    });
    bsLabels.forEach(label => {
        if (label) scene.remove(label);
    });
    
    baseStations = [];
    bsMarkers = [];
    bsLabels = [];
    currentBSIndex = 0;
    editingBSIndex = null;
    
    clearMultiCoverageVisualization();
    
    // Hide config panel
    hideBSConfigPanel();
    
    updateBSList();
    document.getElementById('multi-coverage-result').style.display = 'none';
    
    // Reset grid settings
    document.getElementById('multi-coverage-resolution').value = 5;
    document.getElementById('multi-coverage-resolution-value').textContent = '5 m';
    document.getElementById('grid-padding').value = 50;
    document.getElementById('grid-padding-value').textContent = '50 m';
    document.getElementById('auto-grid').checked = true;
    
    updateGridRange();
    exitSelectionMode();
}

// Additional utility functions for multi-coverage
function exportBSConfig() {
    if (baseStations.length === 0) {
        alert('No base stations to export!');
        return;
    }
    
    const config = {
        baseStations: baseStations.map(bs => ({
            name: bs.name,
            color: bs.color,
            position: bs.position,
            txPower: bs.txPower,
            frequency: bs.frequency,
            txHeight: bs.txHeight,
            radius: bs.radius,
            environment: bs.environment,
            antennaAzimuth: bs.antennaAzimuth,
            antennaBeamwidth: bs.antennaBeamwidth,
            antennaGain: bs.antennaGain,
            rayTracingEnabled: bs.rayTracingEnabled
        })),
        exportDate: new Date().toISOString(),
        version: '1.0'
    };
    
    const dataStr = JSON.stringify(config, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    
    const exportFileDefaultName = 'bs-configuration.json';
    
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
}

function importBSConfig() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    input.onchange = function(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        const reader = new FileReader();
        reader.onload = function(e) {
            try {
                const config = JSON.parse(e.target.result);
                
                if (!config.baseStations || !Array.isArray(config.baseStations)) {
                    throw new Error('Invalid configuration file format');
                }
                
                // Remove existing base stations
                removeAllBaseStations();
                
                // Add imported base stations
                config.baseStations.forEach(bs => {
                    baseStations.push({
                        ...bs,
                        index: baseStations.length
                    });
                    
                    const index = baseStations.length - 1;
                    const marker = createBSMarker(bs, index);
                    bsMarkers[index] = marker.marker;
                    bsLabels[index] = marker.label;
                });
                
                updateBSList();
                updateGridRange();
                
                alert(`Successfully imported ${config.baseStations.length} base stations!`);
                
            } catch (error) {
                alert('Error importing configuration: ' + error.message);
            }
        };
        
        reader.readAsText(file);
    };
    
    input.click();
}

function showBSComparison() {
    if (baseStations.length < 2) {
        alert('Need at least 2 base stations for comparison!');
        return;
    }
    
    if (!multiCoverageAnalysis) {
        alert('Please run coverage analysis first!');
        return;
    }
    
    const comparisonWindow = window.open('', 'BS Comparison', 'width=1000,height=700');
    
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Base Station Comparison</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; }
                .chart-container { margin: 20px 0; }
                .stats-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
                .stats-table th, .stats-table td { border: 1px solid #ddd; padding: 8px; text-align: center; }
                .stats-table th { background-color: #f2f2f2; }
                .color-swatch { width: 20px; height: 20px; display: inline-block; margin-right: 5px; }
            </style>
            <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
        </head>
        <body>
            <h2>Base Station Performance Comparison</h2>
            
            <div class="chart-container">
                <canvas id="coverageChart" width="400" height="200"></canvas>
            </div>
            
            <div class="chart-container">
                <canvas id="performanceChart" width="400" height="200"></canvas>
            </div>
            
            <table class="stats-table">
                <thead>
                    <tr>
                        <th>Base Station</th>
                        <th>Color</th>
                        <th>Coverage Points</th>
                        <th>Coverage %</th>
                        <th>Power (dBm)</th>
                        <th>Radius (m)</th>
                        <th>Height (m)</th>
                        <th>Signal Quality</th>
                    </tr>
                </thead>
                <tbody id="stats-body">
                </tbody>
            </table>
            
            <script>
                const stats = ${JSON.stringify(multiCoverageAnalysis.coverageStats)};
                const baseStations = ${JSON.stringify(multiCoverageAnalysis.baseStations)};
                
                // Coverage Chart
                const coverageCtx = document.getElementById('coverageChart').getContext('2d');
                new Chart(coverageCtx, {
                    type: 'bar',
                    data: {
                        labels: stats.map(s => s.name),
                        datasets: [{
                            label: 'Coverage Points',
                            data: stats.map(s => s.coveragePoints),
                            backgroundColor: stats.map(s => baseStations[s.index].color),
                            borderColor: stats.map(s => baseStations[s.index].color),
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            title: {
                                display: true,
                                text: 'Coverage Points by Base Station'
                            }
                        }
                    }
                });
                
                // Performance Chart
                const performanceCtx = document.getElementById('performanceChart').getContext('2d');
                new Chart(performanceCtx, {
                    type: 'radar',
                    data: {
                        labels: ['Coverage', 'Power', 'Radius', 'Height', 'Signal Quality'],
                        datasets: stats.map((stat, i) => ({
                            label: stat.name,
                            data: [
                                stat.coveragePercentage,
                                baseStations[stat.index].txPower / 50 * 100,
                                baseStations[stat.index].radius / 500 * 100,
                                baseStations[stat.index].txHeight,
                                100 - (stat.coveragePercentage > 0 ? stat.coveragePercentage : 0)
                            ],
                            backgroundColor: baseStations[stat.index].color.replace(')', ', 0.2)').replace('rgb', 'rgba'),
                            borderColor: baseStations[stat.index].color,
                            borderWidth: 2
                        }))
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            title: {
                                display: true,
                                text: 'Base Station Performance Radar Chart'
                            }
                        }
                    }
                });
                
                // Fill table
                const tbody = document.getElementById('stats-body');
                stats.forEach(stat => {
                    const bs = baseStations[stat.index];
                    const row = tbody.insertRow();
                    
                    const signalQuality = stat.coveragePercentage > 20 ? 'Excellent' : 
                                         stat.coveragePercentage > 10 ? 'Good' : 
                                         stat.coveragePercentage > 5 ? 'Fair' : 'Poor';
                    
                    row.innerHTML = \`
                        <td>\${stat.name}</td>
                        <td><div class="color-swatch" style="background-color: \${bs.color}"></div>\${bs.color}</td>
                        <td>\${stat.coveragePoints.toLocaleString()}</td>
                        <td>\${stat.coveragePercentage}%</td>
                        <td>\${bs.txPower} dBm</td>
                        <td>\${bs.radius} m</td>
                        <td>\${bs.txHeight} m</td>
                        <td>\${signalQuality}</td>
                    \`;
                });
            </script>
        </body>
        </html>
    `;
    
    comparisonWindow.document.write(html);
    comparisonWindow.document.close();
}

// Delay Analysis Functions
async function analyzeDelaySpread() {
    if (!point1) {
        alert('Please select transmitter location first!');
        return;
    }
    
    const startTime = performance.now();
    
    const frequency = parseFloat(document.getElementById('delay-frequency').value);
    const radius = parseFloat(document.getElementById('delay-radius').value);
    const resolution = parseFloat(document.getElementById('delay-resolution').value);
    const txHeight = parseFloat(document.getElementById('delay-tx-height').value);
    const environment = document.getElementById('delay-environment').value;
    const rTau = parseFloat(document.getElementById('delay-scaling').value);
    const numClusters = parseInt(document.getElementById('cluster-count').value);
    const rayTracingEnabled = document.getElementById('delay-ray-tracing').checked;
    
    // Clear previous visualization
    clearDelayVisualization();
    
    // Show progress overlay
    showProgressOverlay('3D Delay Analysis', 'Calculating delay spread using 3GPP UMA formulas...');
    
    try {
        const txPosition = {
            x: point1.x,
            y: point1.y,
            z: point1.z
        };
        
        const analysisData = {
            txPosition,
            radius,
            resolution,
            frequency,
            environment,
            txHeight,
            rTau,
            numClusters,
            rayTracingEnabled
        };
        
        // Store the current task
        currentAnalysisTask = {
            type: 'delay-analysis',
            data: analysisData
        };
        
        // Execute analysis in worker
        const result = await workerManager.executeTask(
            'delay-analysis',
            analysisData,
            // Progress callback
            (progress) => {
                updateProgress(progress.progress || 0, 
                    `Processed ${(progress.processed||0).toLocaleString()} of ${(progress.total||0).toLocaleString()} points...`);
            }
        );
        
        const endTime = performance.now();
        const computeTime = ((endTime - startTime) / 1000).toFixed(2);
        
        // Unpack typed-array result from optimised worker
        const _dPos = result.positions, _dVals = result.delayValues, _dCount = result.pointCount;
        delayPoints = [];
        for (let _i = 0; _i < _dCount; _i++) {
            const _b = _i * 3;
            delayPoints.push({
                position: new THREE.Vector3(_dPos[_b], _dPos[_b+1], _dPos[_b+2]),
                delaySpread: _dVals[_i],
                color: getDelayColor(_dVals[_i])
            });
        }
        
        // Create visualization
        create3DDelayVisualization();
        
        // Update UI with results
        document.getElementById('avg-delay-spread').textContent = result.avgDelaySpread.toFixed(2) + ' ns';
        document.getElementById('delay-points-analyzed').textContent = result.pointsAnalyzed.toLocaleString();
        document.getElementById('delay-compute-time').textContent = computeTime + ' seconds';
        document.getElementById('max-delay-spread').textContent = `Maximum Delay Spread: ${result.maxDelaySpread.toFixed(2)} ns`;
        document.getElementById('min-delay-spread').textContent = `Minimum Delay Spread: ${result.minDelaySpread.toFixed(2)} ns`;
        document.getElementById('delay-profile-info').textContent = `Environment: ${environment.toUpperCase()} | Clusters: ${numClusters}`;
        
        const status = workerManager.getStatus();
        document.getElementById('delay-performance-info').textContent = 
            `Worker mode: ${status.isWorkerSupported ? 'Multi-threaded' : 'Single-threaded'} | ` +
            `Points: ${result.pointCount.toLocaleString()}`;
        
        document.getElementById('delay-result').style.display = 'block';
        
        delayAnalysis = {
            txPosition: point1.clone(),
            txHeight: txHeight,
            radius: radius,
            resolution: resolution,
            pointsAnalyzed: result.pointsAnalyzed,
            avgDelaySpread: result.avgDelaySpread,
            maxDelaySpread: result.maxDelaySpread,
            minDelaySpread: result.minDelaySpread,
            computeTime: computeTime,
            delayPoints: result.pointCount,
            environment: environment,
            rTau: rTau,
            numClusters: numClusters,
            rayTracing: rayTracingEnabled
        };
        
    } catch (error) {
        console.error('Delay analysis failed:', error);
        if (error.message !== 'Analysis cancelled') {
            alert('Delay analysis failed: ' + error.message);
        }
    } finally {
        // Hide progress overlay
        hideProgressOverlay();
        currentAnalysisTask = null;
        currentTaskId = null;
    }
}

function getDelayColor(delaySpread) {
    // Color scale from green (low delay) to red (high delay)
    if (delaySpread <= 100) return new THREE.Color(0x00ff00); // Green
    if (delaySpread <= 300) return new THREE.Color(0x80ff00); // Light Green
    if (delaySpread <= 600) return new THREE.Color(0xffff00); // Yellow
    if (delaySpread <= 1000) return new THREE.Color(0xff8000); // Orange
    return new THREE.Color(0xff0000); // Red
}

function create3DDelayVisualization() {
    if (delayPoints.length === 0) return;
    createDelayPointCloud();
    createDelayVolumeSpheres();
}

function createDelayPointCloud() {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];
    
    delayPoints.forEach(point => {
        positions.push(point.position.x, point.position.y, point.position.z);
        colors.push(point.color.r, point.color.g, point.color.b);
    });
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    
    const material = new THREE.PointsMaterial({
        size: 2.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.7
    });
    
    const pointCloud = new THREE.Points(geometry, material);
    pointCloud.name = 'delay-point-cloud';
    scene.add(pointCloud);
    coverageMarkers.push(pointCloud);
}

function createDelayVolumeSpheres() {
    const delayRanges = [
        { min: 0, max: 100, color: new THREE.Color(0x00ff00), size: 3 }, // Green
        { min: 100, max: 300, color: new THREE.Color(0x80ff00), size: 4 }, // Light Green
        { min: 300, max: 600, color: new THREE.Color(0xffff00), size: 5 }, // Yellow
        { min: 600, max: 1000, color: new THREE.Color(0xff8000), size: 6 }, // Orange
        { min: 1000, max: 5000, color: new THREE.Color(0xff0000), size: 7 } // Red
    ];
    
    delayRanges.forEach(range => {
        const pointsInRange = delayPoints.filter(p => p.delaySpread >= range.min && p.delaySpread < range.max);
        const samplePoints = pointsInRange.filter((_, index) => index % 15 === 0);
        
        samplePoints.forEach(point => {
            const geometry = new THREE.SphereGeometry(range.size, 8, 8);
            const material = new THREE.MeshBasicMaterial({
                color: range.color,
                transparent: true,
                opacity: 0.25
            });
            
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.copy(point.position);
            sphere.name = 'delay-volume-sphere';
            scene.add(sphere);
            coverageMarkers.push(sphere);
        });
    });
}

function clearDelayVisualization() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.name && obj.name.includes('delay')) {
            disposeObject(obj);
            scene.remove(obj);
        }
    }
    delayPoints = [];
}

function resetDelayAnalysis() {
    if (point1Marker) scene.remove(point1Marker);
    
    point1 = null;
    point1Marker = null;
    
    clearDelayVisualization();
    
    document.getElementById('delay-tx-coords').textContent = 'Not selected';
    
    // Reset to default values
    document.getElementById('delay-tx-height').value = 25;
    document.getElementById('delay-tx-height-value').textContent = '25 m';
    document.getElementById('delay-frequency').value = 2400;
    document.getElementById('delay-frequency-value').textContent = '2400 MHz';
    document.getElementById('delay-radius').value = 100;
    document.getElementById('delay-radius-value').textContent = '100 m';
    document.getElementById('delay-resolution').value = 5;
    document.getElementById('delay-resolution-value').textContent = '5 m';
    document.getElementById('delay-scaling').value = 2.5;
    document.getElementById('delay-scaling-value').textContent = '2.5';
    document.getElementById('cluster-count').value = 12;
    document.getElementById('cluster-count-value').textContent = '12 clusters';
    document.getElementById('delay-ray-tracing').checked = false;
    document.getElementById('delay-environment').value = 'uma-nlos';
    
    document.getElementById('delay-result').style.display = 'none';
    
    if (delayMap) {
        delayMap.style.display = 'none';
    }
    
    exitSelectionMode();
}

// Throughput Analysis Functions
async function analyzeThroughput() {
    if (!point1) {
        alert('Please select transmitter location first!');
        return;
    }
    
    const startTime = performance.now();
    
    const frequency = parseFloat(document.getElementById('throughput-frequency').value);
    const radius = parseFloat(document.getElementById('throughput-radius').value);
    const resolution = parseFloat(document.getElementById('throughput-resolution').value);
    const txHeight = parseFloat(document.getElementById('throughput-tx-height').value);
    const environment = document.getElementById('throughput-environment').value;
    const bandwidth = parseFloat(document.getElementById('throughput-bandwidth').value);
    const cellLoad = parseFloat(document.getElementById('cell-load').value);
    const useConservativeSinr = document.getElementById('conservative-sinr').checked;
    
    // Get noise floor and interference values
    const noiseFloor = parseFloat(document.getElementById('noise-floor').value);
    const interference = parseFloat(document.getElementById('interference').value);
    
    // Clear previous visualization
    clearThroughputVisualization();
    
    // Show progress overlay
    showProgressOverlay('3D Throughput Analysis', 'Calculating LTE throughput using 3GPP methodology...');
    
    try {
        const txPosition = {
            x: point1.x,
            y: point1.y,
            z: point1.z
        };
        
        const analysisData = {
            txPosition,
            radius,
            resolution,
            frequency,
            environment,
            txHeight,
            bandwidth,
            cellLoad,
            useConservativeSinr,
            noiseFloor,        
            interference      
        };
        
        // Store the current task
        currentAnalysisTask = {
            type: 'throughput-analysis',
            data: analysisData
        };
        
        // Execute analysis in worker
        const result = await workerManager.executeTask(
            'throughput-analysis',
            analysisData,
            // Progress callback
            (progress) => {
                updateProgress(progress.progress || 0, 
                    `Processed ${(progress.processed||0).toLocaleString()} of ${(progress.total||0).toLocaleString()} points...`);
            }
        );
        
        const endTime = performance.now();
        const computeTime = ((endTime - startTime) / 1000).toFixed(2);
        
        // Unpack typed-array result from optimised worker
        const _tPos = result.positions, _tVals = result.throughputs, _tCount = result.pointCount;
        throughputPoints = [];
        for (let _i = 0; _i < _tCount; _i++) {
            const _b = _i * 3;
            throughputPoints.push({
                position: new THREE.Vector3(_tPos[_b], _tPos[_b+1], _tPos[_b+2]),
                throughput: _tVals[_i],
                color: getThroughputColor(_tVals[_i])
            });
        }
        
        // Create visualization
        create3DThroughputVisualization();
        
        // Update UI with results
        document.getElementById('avg-throughput').textContent = result.avgThroughput.toFixed(2) + ' Mbps';
        document.getElementById('throughput-points-analyzed').textContent = result.pointsAnalyzed.toLocaleString();
        document.getElementById('throughput-compute-time').textContent = computeTime + ' seconds';
        document.getElementById('max-throughput').textContent = `Maximum Throughput: ${result.maxThroughput.toFixed(2)} Mbps`;
        document.getElementById('min-throughput').textContent = `Minimum Throughput: ${result.minThroughput.toFixed(2)} Mbps`;
        
        const prbs = getPRBsFromBandwidth(bandwidth);
        document.getElementById('throughput-bandwidth-info').textContent = 
            `Bandwidth: ${bandwidth} MHz | PRBs: ${prbs} | Cell Load: ${(cellLoad * 100).toFixed(0)}%`;
        
        const status = workerManager.getStatus();
        document.getElementById('throughput-performance-info').textContent = 
            `Worker mode: ${status.isWorkerSupported ? 'Multi-threaded' : 'Single-threaded'} | ` +
            `Conservative SINR: ${useConservativeSinr ? 'On' : 'Off'} | ` +
            `Points: ${result.pointCount.toLocaleString()}`;
        
        document.getElementById('throughput-result').style.display = 'block';
        
        throughputAnalysis = {
            txPosition: point1.clone(),
            txHeight: txHeight,
            radius: radius,
            resolution: resolution,
            pointsAnalyzed: result.pointsAnalyzed,
            avgThroughput: result.avgThroughput,
            maxThroughput: result.maxThroughput,
            minThroughput: result.minThroughput,
            computeTime: computeTime,
            throughputPoints: result.pointCount,
            environment: environment,
            bandwidth: bandwidth,
            cellLoad: cellLoad,
            conservativeSinr: useConservativeSinr,
            noiseFloor: noiseFloor,               
            interference: interference            
        };
        
    } catch (error) {
        console.error('Throughput analysis failed:', error);
        if (error.message !== 'Analysis cancelled') {
            alert('Throughput analysis failed: ' + error.message);
        }
    } finally {
        // Hide progress overlay
        hideProgressOverlay();
        currentAnalysisTask = null;
        currentTaskId = null;
    }
}

function getThroughputColor(throughput) {
    // Color scale from red (low throughput) to green (high throughput)
    if (throughput >= 50) return new THREE.Color(0x00ff00); // Green
    if (throughput >= 25) return new THREE.Color(0x80ff00); // Light Green
    if (throughput >= 10) return new THREE.Color(0xffff00); // Yellow
    if (throughput >= 5) return new THREE.Color(0xff8000); // Orange
    return new THREE.Color(0xff0000); // Red
}

function getPRBsFromBandwidth(bandwidth) {
    const prbMapping = {
        1.4: 6,
        3: 15,
        5: 25,
        10: 50,
        15: 75,
        20: 100
    };
    return prbMapping[bandwidth] || 50;
}

function create3DThroughputVisualization() {
    if (throughputPoints.length === 0) return;
    createThroughputPointCloud();
    createThroughputVolumeSpheres();
}

function createThroughputPointCloud() {
    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];
    
    throughputPoints.forEach(point => {
        positions.push(point.position.x, point.position.y, point.position.z);
        colors.push(point.color.r, point.color.g, point.color.b);
    });
    
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    
    const material = new THREE.PointsMaterial({
        size: 3,
        vertexColors: true,
        transparent: true,
        opacity: 0.7
    });
    
    const pointCloud = new THREE.Points(geometry, material);
    pointCloud.name = 'throughput-point-cloud';
    scene.add(pointCloud);
    coverageMarkers.push(pointCloud);
}

function createThroughputVolumeSpheres() {
    const throughputRanges = [
        { min: 50, max: 1000, color: new THREE.Color(0x00ff00), size: 4 }, // Green
        { min: 25, max: 50, color: new THREE.Color(0x80ff00), size: 5 }, // Light Green
        { min: 10, max: 25, color: new THREE.Color(0xffff00), size: 6 }, // Yellow
        { min: 5, max: 10, color: new THREE.Color(0xff8000), size: 7 }, // Orange
        { min: 0, max: 5, color: new THREE.Color(0xff0000), size: 8 } // Red
    ];
    
    throughputRanges.forEach(range => {
        const pointsInRange = throughputPoints.filter(p => p.throughput >= range.min && p.throughput < range.max);
        const samplePoints = pointsInRange.filter((_, index) => index % 15 === 0);
        
        samplePoints.forEach(point => {
            const geometry = new THREE.SphereGeometry(range.size, 8, 8);
            const material = new THREE.MeshBasicMaterial({
                color: range.color,
                transparent: true,
                opacity: 0.3
            });
            
            const sphere = new THREE.Mesh(geometry, material);
            sphere.position.copy(point.position);
            sphere.name = 'throughput-volume-sphere';
            scene.add(sphere);
            coverageMarkers.push(sphere);
        });
    });
}

function clearThroughputVisualization() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.name && obj.name.includes('throughput')) {
            disposeObject(obj);
            scene.remove(obj);
        }
    }
    throughputPoints = [];
}

function resetThroughputAnalysis() {
    if (point1Marker) scene.remove(point1Marker);
    
    point1 = null;
    point1Marker = null;
    
    clearThroughputVisualization();
    
    document.getElementById('throughput-tx-coords').textContent = 'Not selected';
    
    // Reset to default values
    document.getElementById('throughput-tx-height').value = 25;
    document.getElementById('throughput-tx-height-value').textContent = '25 m';
    document.getElementById('throughput-frequency').value = 2400;
    document.getElementById('throughput-frequency-value').textContent = '2400 MHz';
    document.getElementById('throughput-radius').value = 100;
    document.getElementById('throughput-radius-value').textContent = '100 m';
    document.getElementById('throughput-resolution').value = 5;
    document.getElementById('throughput-resolution-value').textContent = '5 m';
    document.getElementById('throughput-bandwidth').value = 10;
    document.getElementById('cell-load').value = 0.7;
    document.getElementById('cell-load-value').textContent = '0.7 (70%)';
    document.getElementById('noise-floor').value = -95;
    document.getElementById('noise-floor-value').textContent = '-95 dBm';
    document.getElementById('interference').value = -90;
    document.getElementById('interference-value').textContent = '-90 dBm';
    document.getElementById('conservative-sinr').checked = true;
    document.getElementById('throughput-environment').value = 'uma-nlos';
    
    document.getElementById('throughput-result').style.display = 'none';
    
    if (throughputMap) {
        throughputMap.style.display = 'none';
    }
    
    exitSelectionMode();
}

// Utility Functions
function createPointMarker(position, color, name) {
    const geometry = new THREE.SphereGeometry(2, 16, 16);
    const material = new THREE.MeshBasicMaterial({ color: color });
    const marker = new THREE.Mesh(geometry, material);
    marker.position.copy(position);
    marker.name = name;
    scene.add(marker);
    return marker;
}

function updatePointDisplay(elementId, point) {
    document.getElementById(elementId).textContent = 
        `X: ${point.x.toFixed(2)} m, Y: ${point.y.toFixed(2)} m, Z: ${point.z.toFixed(2)} m`;
}

function showSelectionMode(show) {
    const indicator = document.querySelector('.selecting-mode');
    if (!indicator) {
        const newIndicator = document.createElement('div');
        newIndicator.className = 'selecting-mode';
        newIndicator.textContent = 'Click on the 3D model to select a point';
        document.body.appendChild(newIndicator);
    }
    
    const existingIndicator = document.querySelector('.selecting-mode');
    existingIndicator.style.display = show ? 'block' : 'none';
}

function exitSelectionMode() {
    isSelecting = false;
    isSelectingBSPosition = false;
    showSelectionMode(false);
}

function resetSelection() {
    if (point1Marker) scene.remove(point1Marker);
    if (point2Marker) scene.remove(point2Marker);
    
    point1 = null;
    point2 = null;
    point1Marker = null;
    point2Marker = null;
    
    document.getElementById('point1-coords').textContent = 'Not selected';
    document.getElementById('point2-coords').textContent = 'Not selected';
    document.getElementById('select-btn').textContent = 'Select Points';
    document.getElementById('select-btn').style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
    document.getElementById('result').style.display = 'none';
    
    exitSelectionMode();
}

// Antenna Pattern Visualization
function visualizeAntennaPattern(txPosition, azimuth, beamwidth) {
    // Remove existing antenna pattern visualization
    const existingPattern = scene.getObjectByName('antenna-pattern');
    if (existingPattern) {
        scene.remove(existingPattern);
    }
    
    if (beamwidth === 360) {
        // Omnidirectional - show a simple circle
        const circleGeometry = new THREE.RingGeometry(5, 10, 32);
        const circleMaterial = new THREE.MeshBasicMaterial({ 
            color: 0xffff00, 
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.3
        });
        const circle = new THREE.Mesh(circleGeometry, circleMaterial);
        circle.rotation.x = Math.PI / 2;
        circle.position.copy(txPosition);
        circle.position.y += 1;
        circle.name = 'antenna-pattern';
        scene.add(circle);
    } else {
        // Directional antenna - show sector
        const sectorGroup = new THREE.Group();
        sectorGroup.name = 'antenna-pattern';
        
        // Create sector geometry
        const sectorAngle = (beamwidth * Math.PI) / 180;
        const sectorRadius = 20;
        
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        
        for (let i = -sectorAngle/2; i <= sectorAngle/2; i += sectorAngle/10) {
            const x = Math.sin(i) * sectorRadius;
            const z = Math.cos(i) * sectorRadius;
            if (i === -sectorAngle/2) {
                shape.lineTo(x, z);
            } else {
                shape.lineTo(x, z);
            }
        }
        shape.lineTo(0, 0);
        
        const geometry = new THREE.ShapeGeometry(shape);
        const material = new THREE.MeshBasicMaterial({
            color: 0xffff00,
            side: THREE.DoubleSide,
            transparent: true,
            opacity: 0.2
        });
        
        const sector = new THREE.Mesh(geometry, material);
        sector.rotation.y = -azimuth * Math.PI / 180;
        sector.position.copy(txPosition);
        sector.position.y += 0.5;
        
        sectorGroup.add(sector);
        scene.add(sectorGroup);
    }
}

function calculateAntennaPattern(txPos, rxPos, azimuth, beamwidth, gain) {
    const dx = rxPos.x - txPos.x;
    const dz = rxPos.z - txPos.z;
    
    // Calculate angle from transmitter to receiver
    let angle = Math.atan2(dz, dx) * (180 / Math.PI);
    angle = (angle + 360) % 360; // Normalize to 0-360
    
    // Calculate angular difference from antenna direction
    let angleDiff = Math.abs(angle - azimuth);
    angleDiff = Math.min(angleDiff, 360 - angleDiff); // Shortest path
    
    // Check if receiver is within beamwidth
    const halfBeamwidth = beamwidth / 2;
    
    if (beamwidth === 360 || angleDiff <= halfBeamwidth) {
        // Within beam - apply gain
        return gain;
    } else {
        // Outside beam - apply front-to-back ratio (typical 25dB reduction)
        return gain - 25;
    }
}

// Progress Overlay Functions
function showProgressOverlay(title, message) {
    const overlay = document.getElementById('progress-overlay');
    const titleElement = document.getElementById('progress-title');
    const messageElement = document.getElementById('progress-message');
    
    titleElement.textContent = title;
    messageElement.textContent = message;
    overlay.classList.remove('hidden');
    
    // Store current task ID for cancellation
    currentTaskId = Date.now() + Math.random();
    
    // Reset progress bar
    updateProgress(0, 'Starting analysis...');
}

function hideProgressOverlay() {
    const overlay = document.getElementById('progress-overlay');
    overlay.classList.add('hidden');
    currentTaskId = null;
}

function updateProgress(percent, details = '') {
    const progressBar = document.getElementById('progress-bar');
    const detailsElement = document.getElementById('progress-details');
    
    progressBar.style.width = percent + '%';
    if (details) {
        detailsElement.textContent = details;
    }
}

function cancelAnalysis() {
    // Sends 'cancel' message — workers stay alive for reuse
    workerManager.cancelAllTasks();
    hideProgressOverlay();
    currentAnalysisTask = null;
    currentTaskId = null;
}

// Map Display Functions
function show3DCoverageMap() {
    if (!coverageAnalysis) {
        alert('Please run coverage analysis first!');
        return;
    }
    
    if (!coverageMap) {
        coverageMap = document.createElement('div');
        coverageMap.id = 'coverage-map';
        coverageMap.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            height: 85%;
            background: rgba(255, 255, 255, 0.98);
            border: 2px solid #333;
            border-radius: 15px;
            padding: 25px;
            z-index: 1000;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: auto;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            backdrop-filter: blur(10px);
        `;
        document.body.appendChild(coverageMap);
    }
    
    coverageMap.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 2px solid #667eea; padding-bottom: 15px;">
            <h3 style="margin: 0; color: #2d3748; font-size: 1.5em;">3D Coverage Analysis Report</h3>
            <button onclick="this.parentElement.parentElement.style.display='none'" 
                    style="padding: 10px 20px; background: linear-gradient(135deg, #e53e3e 0%, #c53030 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">
                Close Report
            </button>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 25px; margin-bottom: 25px;">
            <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #667eea;">
                <h4 style="margin-top: 0; color: #2d3748; border-bottom: 1px solid #cbd5e0; padding-bottom: 10px;">Transmitter Configuration</h4>
                <div style="line-height: 1.8;">
                    <div><strong>Position:</strong> X: ${coverageAnalysis.txPosition.x.toFixed(2)} m, Y: ${coverageAnalysis.txPosition.y.toFixed(2)} m, Z: ${coverageAnalysis.txPosition.z.toFixed(2)} m</div>
                    <div><strong>Height:</strong> ${coverageAnalysis.txHeight} m</div>
                    <div><strong>Analysis Radius:</strong> ${coverageAnalysis.radius} m</div>
                    <div><strong>Grid Resolution:</strong> ${coverageAnalysis.resolution} m</div>
                    <div><strong>Environment:</strong> ${coverageAnalysis.environment.toUpperCase()}</div>
                    <div><strong>Ray Tracing:</strong> ${coverageAnalysis.rayTracing ? 'Enabled' : 'Disabled'}</div>
                    ${coverageAnalysis.antennaParams ? `
                    <div><strong>Antenna Azimuth:</strong> ${coverageAnalysis.antennaParams.azimuth}°</div>
                    <div><strong>Antenna Beamwidth:</strong> ${coverageAnalysis.antennaParams.beamwidth}°</div>
                    <div><strong>Antenna Gain:</strong> ${coverageAnalysis.antennaParams.gain} dBi</div>
                    ` : ''}
                </div>
            </div>
            
            <div style="background: linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #48bb78;">
                <h4 style="margin-top: 0; color: #22543d; border-bottom: 1px solid #9ae6b4; padding-bottom: 10px;">Coverage Results</h4>
                <div style="font-size: 28px; font-weight: bold; color: #48bb78; margin: 15px 0; text-align: center;">
                    ${coverageAnalysis.coverageVolume.toFixed(2)} m³
                </div>
                <div style="line-height: 1.8;">
                    <div><strong>Points Analyzed:</strong> ${coverageAnalysis.pointsAnalyzed}</div>
                    <div><strong>Coverage Points:</strong> ${coverageAnalysis.coveragePoints}</div>
                    <div><strong>Computation Time:</strong> ${coverageAnalysis.computeTime} seconds</div>
                    <div><strong>Coverage Efficiency:</strong> ${((coverageAnalysis.coveragePoints / coverageAnalysis.pointsAnalyzed) * 100).toFixed(1)}%</div>
                </div>
            </div>
        </div>

        <!-- NEW: Path Loss Information for Coverage Analysis -->
        <div style="background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #e53e3e; margin-bottom: 20px;">
            <h4 style="margin-top: 0; color: #742a2a; border-bottom: 1px solid #fc8181; padding-bottom: 10px;">Path Loss Model Information</h4>
            <div style="line-height: 1.8;">
                <div><strong>3GPP Model:</strong> ${coverageAnalysis.environment.toUpperCase()}</div>
                <div><strong>Path Loss Exponents:</strong> 
                    ${coverageAnalysis.environment === 'uma-los' ? '2.2 (close), 4.0 (far)' : 
                      coverageAnalysis.environment === 'uma-nlos' ? '3.9' :
                      coverageAnalysis.environment === 'umi-los' ? '2.1 (close), 4.0 (far)' : '3.53'}
                </div>
                <div><strong>Frequency Dependence:</strong> 20×log₁₀(f) term included</div>
                <div><strong>Shadow Fading:</strong> ±4 dB variation applied</div>
                <div><strong>Breakpoint Distance:</strong> Environment-dependent calculation</div>
            </div>
        </div>

        <div style="background: linear-gradient(135deg, #faf5ff 0%, #e9d8fd 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #805ad5;">
            <h4 style="margin-top: 0; color: #44337a; border-bottom: 1px solid #d6bcfa; padding-bottom: 10px;">Signal Strength Legend</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #00ff00; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Excellent (≥ -70 dBm)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #80ff00; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Good (-80 to -70 dBm)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #ffff00; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Fair (-90 to -80 dBm)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #ff8000; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Poor (-100 to -90 dBm)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #ff0000; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Weak (< -100 dBm)</span>
                </div>
            </div>
        </div>
        
        <div style="background: linear-gradient(135deg, #ebf8ff 0%, #bee3f8 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #3182ce; margin-top: 20px;">
            <h4 style="margin-top: 0; color: #2b6cb0; border-bottom: 1px solid #90cdf4; padding-bottom: 10px;">3GPP Path Loss Models</h4>
            <ul style="margin: 0; color: #2b6cb0; line-height: 1.6;">
                <li><strong>UMa LOS:</strong> Urban Macrocell Line-of-Sight</li>
                <li><strong>UMa NLOS:</strong> Urban Macrocell Non-Line-of-Sight</li>
                <li><strong>UMi LOS:</strong> Urban Microcell Line-of-Sight</li>
                <li><strong>UMi NLOS:</strong> Urban Microcell Non-Line-of-Sight</li>
                ${coverageAnalysis.rayTracing ? '<li><strong>Ray Tracing:</strong> Enhanced multipath simulation enabled</li>' : ''}
            </ul>
        </div>
    `;
    
    coverageMap.style.display = 'block';
}

function show3DDelayMap() {
    if (!delayAnalysis) {
        alert('Please run delay analysis first!');
        return;
    }
    
    if (!delayMap) {
        delayMap = document.createElement('div');
        delayMap.id = 'delay-map';
        delayMap.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            height: 85%;
            background: rgba(255, 255, 255, 0.98);
            border: 2px solid #333;
            border-radius: 15px;
            padding: 25px;
            z-index: 1000;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: auto;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            backdrop-filter: blur(10px);
        `;
        document.body.appendChild(delayMap);
    }
    
    delayMap.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 2px solid #805ad5; padding-bottom: 15px;">
            <h3 style="margin: 0; color: #44337a; font-size: 1.5em;">3D Delay Spread Analysis Report</h3>
            <button onclick="this.parentElement.parentElement.style.display='none'" 
                    style="padding: 10px 20px; background: linear-gradient(135deg, #e53e3e 0%, #c53030 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">
                Close Report
            </button>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 25px; margin-bottom: 25px;">
            <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #805ad5;">
                <h4 style="margin-top: 0; color: #44337a; border-bottom: 1px solid #d6bcfa; padding-bottom: 10px;">Analysis Configuration</h4>
                <div style="line-height: 1.8;">
                    <div><strong>Position:</strong> X: ${delayAnalysis.txPosition.x.toFixed(2)} m, Y: ${delayAnalysis.txPosition.y.toFixed(2)} m, Z: ${delayAnalysis.txPosition.z.toFixed(2)} m</div>
                    <div><strong>Height:</strong> ${delayAnalysis.txHeight} m</div>
                    <div><strong>Analysis Radius:</strong> ${delayAnalysis.radius} m</div>
                    <div><strong>Grid Resolution:</strong> ${delayAnalysis.resolution} m</div>
                    <div><strong>Environment:</strong> ${delayAnalysis.environment.toUpperCase()}</div>
                    <div><strong>Delay Scaling (rτ):</strong> ${delayAnalysis.rTau}</div>
                    <div><strong>Number of Clusters:</strong> ${delayAnalysis.numClusters}</div>
                    <div><strong>Ray Tracing:</strong> ${delayAnalysis.rayTracing ? 'Enabled' : 'Disabled'}</div>
                </div>
            </div>
            
            <div style="background: linear-gradient(135deg, #faf5ff 0%, #e9d8fd 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #805ad5;">
                <h4 style="margin-top: 0; color: #44337a; border-bottom: 1px solid #d6bcfa; padding-bottom: 10px;">Delay Spread Results</h4>
                <div style="font-size: 28px; font-weight: bold; color: #805ad5; margin: 15px 0; text-align: center;">
                    ${delayAnalysis.avgDelaySpread.toFixed(2)} ns
                </div>
                <div style="line-height: 1.8;">
                    <div><strong>Points Analyzed:</strong> ${delayAnalysis.pointsAnalyzed}</div>
                    <div><strong>Delay Points:</strong> ${delayAnalysis.delayPoints}</div>
                    <div><strong>Computation Time:</strong> ${delayAnalysis.computeTime} seconds</div>
                    <div><strong>Maximum Delay:</strong> ${delayAnalysis.maxDelaySpread.toFixed(2)} ns</div>
                    <div><strong>Minimum Delay:</strong> ${delayAnalysis.minDelaySpread.toFixed(2)} ns</div>
                    <div><strong>Delay Variation:</strong> ${(delayAnalysis.maxDelaySpread - delayAnalysis.minDelaySpread).toFixed(2)} ns</div>
                </div>
            </div>
        </div>

        <!-- NEW: Path Loss Information for Delay Analysis -->
        <div style="background: linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #38a169; margin-bottom: 20px;">
            <h4 style="margin-top: 0; color: #22543d; border-bottom: 1px solid #9ae6b4; padding-bottom: 10px;">Path Loss Model Used</h4>
            <div style="line-height: 1.8;">
                <div><strong>3GPP Model:</strong> ${delayAnalysis.environment.toUpperCase()}</div>
                <div><strong>Path Loss Exponents:</strong> 
                    ${delayAnalysis.environment === 'uma-los' ? '2.2 (close), 4.0 (far)' : 
                      delayAnalysis.environment === 'uma-nlos' ? '3.9' :
                      delayAnalysis.environment === 'umi-los' ? '2.1 (close), 4.0 (far)' : '3.53'}
                </div>
                <div><strong>Impact on Delay:</strong> Path loss affects signal propagation time and multipath components</div>
                <div><strong>Environment Factor:</strong> ${delayAnalysis.environment.includes('nlos') ? 'Higher delay due to NLOS multipath' : 'Lower delay in LOS conditions'}</div>
            </div>
        </div>

        <div style="background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #e53e3e;">
            <h4 style="margin-top: 0; color: #742a2a; border-bottom: 1px solid #fc8181; padding-bottom: 10px;">Delay Spread Legend</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #00ff00; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Excellent (≤ 100 ns)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #80ff00; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Good (100-300 ns)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #ffff00; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Fair (300-600 ns)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #ff8000; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Poor (600-1000 ns)</span>
                </div>
                <div style="display: flex; align-items: center; padding: 8px; background: white; border-radius: 8px;">
                    <div style="width: 20px; height: 20px; background: #ff0000; margin-right: 12px; border-radius: 4px; border: 2px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.1);"></div>
                    <span style="font-weight: 500;">Critical (> 1000 ns)</span>
                </div>
            </div>
        </div>
        
        <div style="background: linear-gradient(135deg, #ebf8ff 0%, #bee3f8 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #3182ce; margin-top: 20px;">
            <h4 style="margin-top: 0; color: #2b6cb0; border-bottom: 1px solid #90cdf4; padding-bottom: 10px;">3GPP UMA Delay Model</h4>
            <ul style="margin: 0; color: #2b6cb0; line-height: 1.6;">
                <li><strong>Method:</strong> Cluster-based exponential delay distribution</li>
                <li><strong>Formula:</strong> τₙ′ = -rτ × DS × ln(Xₙ)</li>
                <li><strong>RMS Calculation:</strong> √(Σ(τₙ - μ)² / N)</li>
                <li><strong>Environment Factors:</strong> Distance-dependent scaling applied</li>
                ${delayAnalysis.rayTracing ? '<li><strong>Ray Tracing:</strong> Enhanced multipath effects simulation</li>' : ''}
            </ul>
        </div>
    `;
    
    delayMap.style.display = 'block';
}

function show3DThroughputMap() {
    if (!throughputAnalysis) {
        alert('Please run throughput analysis first!');
        return;
    }
    
    if (!throughputMap) {
        throughputMap = document.createElement('div');
        throughputMap.id = 'throughput-map';
        throughputMap.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            width: 90%;
            height: 85%;
            background: rgba(255, 255, 255, 0.98);
            border: 2px solid #333;
            border-radius: 15px;
            padding: 25px;
            z-index: 1000;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            overflow: auto;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            backdrop-filter: blur(10px);
        `;
        document.body.appendChild(throughputMap);
    }
    
    const prbs = getPRBsFromBandwidth(throughputAnalysis.bandwidth);
    const totalNoiseInterference = 10 * Math.log10(Math.pow(10, throughputAnalysis.noiseFloor/10) + Math.pow(10, throughputAnalysis.interference/10));
    
    throughputMap.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 2px solid #dd6b20; padding-bottom: 15px;">
            <h3 style="margin: 0; color: #744210; font-size: 1.5em;">3D Throughput Analysis Report (3GPP LTE)</h3>
            <button onclick="this.parentElement.parentElement.style.display='none'" 
                    style="padding: 10px 20px; background: linear-gradient(135deg, #e53e3e 0%, #c53030 100%); color: white; border: none; border-radius: 8px; cursor: pointer; font-weight: 600;">
                Close Report
            </button>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 25px; margin-bottom: 25px;">
            <div style="background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #dd6b20;">
                <h4 style="margin-top: 0; color: #744210; border-bottom: 1px solid #fbd38d; padding-bottom: 10px;">Transmitter Configuration</h4>
                <div style="line-height: 1.8;">
                    <div><strong>Position:</strong> X: ${throughputAnalysis.txPosition.x.toFixed(2)} m, Y: ${throughputAnalysis.txPosition.y.toFixed(2)} m, Z: ${throughputAnalysis.txPosition.z.toFixed(2)} m</div>
                    <div><strong>Height:</strong> ${throughputAnalysis.txHeight} m</div>
                    <div><strong>Analysis Radius:</strong> ${throughputAnalysis.radius} m</div>
                    <div><strong>Grid Resolution:</strong> ${throughputAnalysis.resolution} m</div>
                    <div><strong>Environment:</strong> ${throughputAnalysis.environment.toUpperCase()}</div>
                    <div><strong>Bandwidth:</strong> ${throughputAnalysis.bandwidth} MHz</div>
                    <div><strong>PRBs:</strong> ${prbs}</div>
                    <div><strong>Cell Load:</strong> ${(throughputAnalysis.cellLoad * 100).toFixed(0)}%</div>
                    <div><strong>Noise Floor:</strong> ${throughputAnalysis.noiseFloor} dBm</div>
                    <div><strong>Interference:</strong> ${throughputAnalysis.interference} dBm</div>
                    <div><strong>Total N+I:</strong> ${totalNoiseInterference.toFixed(1)} dBm</div>
                    <div><strong>SINR Planning:</strong> ${throughputAnalysis.conservativeSinr ? 'Conservative (5th percentile)' : 'Average'}</div>
                </div>
            </div>
            
            <div style="background: linear-gradient(135deg, #fffaf0 0%, #feebc8 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #dd6b20;">
                <h4 style="margin-top: 0; color: #744210; border-bottom: 1px solid #fbd38d; padding-bottom: 10px;">Throughput Results</h4>
                <div style="font-size: 28px; font-weight: bold; color: #dd6b20; margin: 15px 0; text-align: center;">
                    ${throughputAnalysis.avgThroughput.toFixed(2)} Mbps
                </div>
                <div style="line-height: 1.8;">
                    <div><strong>Points Analyzed:</strong> ${throughputAnalysis.pointsAnalyzed}</div>
                    <div><strong>Throughput Points:</strong> ${throughputAnalysis.throughputPoints}</div>
                    <div><strong>Computation Time:</strong> ${throughputAnalysis.computeTime} seconds</div>
                    <div><strong>Max Throughput:</strong> ${throughputAnalysis.maxThroughput.toFixed(2)} Mbps</div>
                    <div><strong>Min Throughput:</strong> ${throughputAnalysis.minThroughput.toFixed(2)} Mbps</div>
                    <div><strong>Throughput Range:</strong> ${(throughputAnalysis.maxThroughput - throughputAnalysis.minThroughput).toFixed(2)} Mbps</div>
                    <div><strong>Performance Ratio:</strong> ${(throughputAnalysis.avgThroughput / throughputAnalysis.maxThroughput * 100).toFixed(1)}% of max</div>
                </div>
            </div>
        </div>

        <!-- Signal Quality Distribution -->
        <div style="background: linear-gradient(135deg, #f0fff4 0%, #c6f6d5 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #38a169; margin-bottom: 20px;">
            <h4 style="margin-top: 0; color: #22543d; border-bottom: 1px solid #9ae6b4; padding-bottom: 10px;">Signal Quality Distribution</h4>
            <div style="display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 15px;">
                <div style="text-align: center; padding: 10px; background: white; border-radius: 8px; border: 1px solid #9ae6b4;">
                    <div style="font-size: 12px; color: #718096;">Excellent</div>
                    <div style="font-size: 18px; font-weight: bold; color: #38a169;">≥ 50 Mbps</div>
                    <div style="font-size: 11px; color: #718096; margin-top: 5px;">High-speed data</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 8px; border: 1px solid #9ae6b4;">
                    <div style="font-size: 12px; color: #718096;">Good</div>
                    <div style="font-size: 18px; font-weight: bold; color: #80ff00;">25-50 Mbps</div>
                    <div style="font-size: 11px; color: #718096; margin-top: 5px;">HD video streaming</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 8px; border: 1px solid #9ae6b4;">
                    <div style="font-size: 12px; color: #718096;">Fair</div>
                    <div style="font-size: 18px; font-weight: bold; color: #ffff00;">10-25 Mbps</div>
                    <div style="font-size: 11px; color: #718096; margin-top: 5px;">SD video streaming</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 8px; border: 1px solid #9ae6b4;">
                    <div style="font-size: 12px; color: #718096;">Poor</div>
                    <div style="font-size: 18px; font-weight: bold; color: #ff8000;">5-10 Mbps</div>
                    <div style="font-size: 11px; color: #718096; margin-top: 5px;">Basic web browsing</div>
                </div>
                <div style="text-align: center; padding: 10px; background: white; border-radius: 8px; border: 1px solid #9ae6b4;">
                    <div style="font-size: 12px; color: #718096;">Weak</div>
                    <div style="font-size: 18px; font-weight: bold; color: #ff0000;">&lt; 5 Mbps</div>
                    <div style="font-size: 11px; color: #718096; margin-top: 5px;">Basic voice services</div>
                </div>
            </div>
        </div>

        <!-- LTE Methodology Information -->
        <div style="background: linear-gradient(135deg, #ebf8ff 0%, #bee3f8 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #3182ce; margin-bottom: 20px;">
            <h4 style="margin-top: 0; color: #2b6cb0; border-bottom: 1px solid #90cdf4; padding-bottom: 10px;">3GPP LTE Throughput Calculation</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div>
                    <div style="font-weight: bold; color: #2b6cb0; margin-bottom: 5px;">Step 1: SINR Calculation</div>
                    <div style="font-size: 13px; color: #4a5568;">SINR = Rx Power - (Noise + Interference)</div>
                </div>
                <div>
                    <div style="font-weight: bold; color: #2b6cb0; margin-bottom: 5px;">Step 2: CQI Mapping</div>
                    <div style="font-size: 13px; color: #4a5568;">3GPP Table 7.2.3-1 (CQI vs SINR)</div>
                </div>
                <div>
                    <div style="font-weight: bold; color: #2b6cb0; margin-bottom: 5px;">Step 3: PRB Allocation</div>
                    <div style="font-size: 13px; color: #4a5568;">Bandwidth → PRBs mapping (${prbs} PRBs)</div>
                </div>
                <div>
                    <div style="font-weight: bold; color: #2b6cb0; margin-bottom: 5px;">Step 4: TBS Calculation</div>
                    <div style="font-size: 13px; color: #4a5568;">3GPP Table 7.1.7.2.1-1 (TBS tables)</div>
                </div>
                <div>
                    <div style="font-weight: bold; color: #2b6cb0; margin-bottom: 5px;">Step 5: Throughput</div>
                    <div style="font-size: 13px; color: #4a5568;">Throughput = TBS × 1000 / 1,000,000 Mbps</div>
                </div>
                <div>
                    <div style="font-weight: bold; color: #2b6cb0; margin-bottom: 5px;">Step 6: Load Factor</div>
                    <div style="font-size: 13px; color: #4a5568;">Apply ${(throughputAnalysis.cellLoad * 100).toFixed(0)}% cell load</div>
                </div>
            </div>
        </div>

        <!-- Path Loss Information -->
        <div style="background: linear-gradient(135deg, #faf5ff 0%, #e9d8fd 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #805ad5;">
            <h4 style="margin-top: 0; color: #44337a; border-bottom: 1px solid #d6bcfa; padding-bottom: 10px;">Path Loss Analysis</h4>
            <div style="line-height: 1.8;">
                <div><strong>3GPP Model:</strong> ${throughputAnalysis.environment.toUpperCase()}</div>
                <div><strong>Path Loss Characteristics:</strong> 
                    ${throughputAnalysis.environment === 'uma-los' ? 'Line-of-Sight urban macrocell with distance-dependent exponents' : 
                      throughputAnalysis.environment === 'uma-nlos' ? 'Non-Line-of-Sight urban macrocell with building penetration losses' :
                      throughputAnalysis.environment === 'umi-los' ? 'Line-of-Sight urban microcell for dense urban areas' : 
                      'Non-Line-of-Sight urban microcell with heavy multipath'}
                </div>
                <div><strong>Frequency Impact:</strong> Higher frequencies (${document.getElementById('throughput-frequency').value} MHz) increase path loss</div>
                <div><strong>Height Advantage:</strong> Transmitter height (${throughputAnalysis.txHeight} m) improves coverage range</div>
                <div><strong>Environmental Factors:</strong> ${throughputAnalysis.environment.includes('nlos') ? 'Increased multipath and shadowing effects' : 'Reduced multipath in LOS conditions'}</div>
            </div>
        </div>
        
        <div style="background: linear-gradient(135deg, #fff5f5 0%, #fed7d7 100%); padding: 20px; border-radius: 12px; border-left: 4px solid #e53e3e; margin-top: 20px;">
            <h4 style="margin-top: 0; color: #742a2a; border-bottom: 1px solid #fc8181; padding-bottom: 10px;">Key Performance Indicators</h4>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px;">
                <div>
                    <div><strong>Coverage Efficiency:</strong> ${(throughputAnalysis.throughputPoints / throughputAnalysis.pointsAnalyzed * 100).toFixed(1)}%</div>
                    <div><strong>Spectral Efficiency:</strong> ${(throughputAnalysis.avgThroughput / throughputAnalysis.bandwidth).toFixed(3)} bps/Hz</div>
                    <div><strong>Network Capacity:</strong> ${(throughputAnalysis.avgThroughput * 1000).toFixed(0)} kbps per user</div>
                </div>
                <div>
                    <div><strong>Quality of Service:</strong> ${throughputAnalysis.avgThroughput >= 10 ? 'Good' : throughputAnalysis.avgThroughput >= 5 ? 'Acceptable' : 'Poor'}</div>
                    <div><strong>User Experience:</strong> ${throughputAnalysis.avgThroughput >= 25 ? 'Excellent' : throughputAnalysis.avgThroughput >= 10 ? 'Good' : 'Basic'}</div>
                    <div><strong>Service Level:</strong> ${throughputAnalysis.avgThroughput >= 50 ? 'Premium' : throughputAnalysis.avgThroughput >= 25 ? 'Enhanced' : 'Standard'}</div>
                </div>
            </div>
        </div>
    `;
    
    throughputMap.style.display = 'block';
}

function makeDraggable(el) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    const header = document.getElementById("panel-header");
    if (!header) return;
    header.onmousedown = (e) => {
        e.preventDefault();
        pos3 = e.clientX;
        pos4 = e.clientY;
        document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
        document.onmousemove = (e) => {
            e.preventDefault();
            pos1 = pos3 - e.clientX;
            pos2 = pos4 - e.clientY;
            pos3 = e.clientX;
            pos4 = e.clientY;
            const newTop  = Math.max(10, el.offsetTop  - pos2);
            const newLeft = Math.max(10, Math.min(window.innerWidth - el.clientWidth - 10, el.offsetLeft - pos1));
            el.style.top  = newTop  + 'px';
            el.style.left = newLeft + 'px';
            el.style.right = 'auto';
        };
    };
}

function makeResizable(el) {
    const resizer = el.querySelector('.resizer');
    resizer.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const startWidth = el.offsetWidth;
        const startHeight = el.offsetHeight;
        const startX = e.clientX;
        const startY = e.clientY;

        const doResize = (e) => {
            el.style.width = (startWidth + e.clientX - startX) + 'px';
            el.style.height = (startHeight + e.clientY - startY) + 'px';
        };
        const stopResize = () => {
            window.removeEventListener('mousemove', doResize);
            window.removeEventListener('mouseup', stopResize);
        };
        window.addEventListener('mousemove', doResize);
        window.addEventListener('mouseup', stopResize);
    });
}

// ── Render-on-demand: only render when something changes ──────
let _needsRender = true;
function markNeedsRender() { _needsRender = true; }

function animate() {
    requestAnimationFrame(animate);
    if (controls.update()) _needsRender = true;
    if (!_needsRender) return;
    renderer.render(scene, camera);
    _needsRender = false;
}

function onWindowResize() {
    const container = document.getElementById('model-container');
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
    markNeedsRender();
}

// ── Ctrl+Enter: smooth animated reset to default top-down view ─
function resetToDefaultView() {
    if (!_defaultCameraPos || !controls) return;

    const startPos    = camera.position.clone();
    const startTarget = controls.target.clone();
    const endPos      = new THREE.Vector3(_defaultCameraPos.x, _defaultCameraPos.y, _defaultCameraPos.z);
    const endTarget   = new THREE.Vector3(_defaultCameraTarget.x, _defaultCameraTarget.y, _defaultCameraTarget.z);

    const duration = 600; // ms
    const startTime = performance.now();

    // Temporarily disable damping so the animated lerp drives the camera
    const wasDamping = controls.enableDamping;
    controls.enableDamping = false;

    function easeInOut(t) {
        return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
    }

    function animateReset() {
        const elapsed = performance.now() - startTime;
        const raw     = Math.min(elapsed / duration, 1);
        const t       = easeInOut(raw);

        camera.position.lerpVectors(startPos, endPos, t);
        controls.target.lerpVectors(startTarget, endTarget, t);
        controls.update();
        markNeedsRender();

        if (raw < 1) {
            requestAnimationFrame(animateReset);
        } else {
            // Snap to exact values at end
            camera.position.copy(endPos);
            controls.target.copy(endTarget);
            controls.update();
            controls.enableDamping = wasDamping;
            markNeedsRender();
        }
    }

    requestAnimationFrame(animateReset);
}

window.addEventListener('keydown', function(e) {
    if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        resetToDefaultView();
    }
});

// Global functions for event handlers
window.editBaseStation = editBaseStation;
window.removeBaseStation = removeBaseStation;
window.selectBS = selectBS;

// ═══════════════════════════════════════════════════════════════
//  CROWD ANALYSIS
// ═══════════════════════════════════════════════════════════════

function handleCrowdClick(point) {
    if (isSelectingCrowdBS) {
        crowdBSPosition = { x: point.x, y: point.y, z: point.z };
        document.getElementById('crowd-bs-coords').textContent =
            `(${point.x.toFixed(1)}, ${point.y.toFixed(1)}, ${point.z.toFixed(1)})`;
        // Remove old marker
        if (crowdBSTowerGroup) { scene.remove(crowdBSTowerGroup); crowdBSTowerGroup = null; }
        // Build tower icon
        crowdBSTowerGroup = buildBSTowerIcon(point, 0x764ba2);
        scene.add(crowdBSTowerGroup);
        isSelectingCrowdBS = false;
        const btn = document.getElementById('select-crowd-bs-btn');
        btn.textContent = '📍 Place Base Station';
        btn.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        showSelectionMode(false);
        markNeedsRender();
    } else if (isSelectingCrowdCenter) {
        crowdCenterPosition = { x: point.x, y: point.y, z: point.z };
        document.getElementById('crowd-center-coords').textContent =
            `(${point.x.toFixed(1)}, ${point.y.toFixed(1)}, ${point.z.toFixed(1)})`;
        if (crowdCenterMarker) { scene.remove(crowdCenterMarker); crowdCenterMarker = null; }
        // Pulsing ring to mark crowd center
        const ringGeo = new THREE.TorusGeometry(3, 0.5, 8, 32);
        const ringMat = new THREE.MeshBasicMaterial({ color: 0xed8936, transparent: true, opacity: 0.85 });
        crowdCenterMarker = new THREE.Mesh(ringGeo, ringMat);
        crowdCenterMarker.position.set(point.x, point.y + 0.5, point.z);
        crowdCenterMarker.rotation.x = Math.PI / 2;
        crowdCenterMarker.name = 'crowd-center-marker';
        scene.add(crowdCenterMarker);
        isSelectingCrowdCenter = false;
        const btn = document.getElementById('select-crowd-center-btn');
        btn.textContent = '🎯 Set Crowd Center';
        btn.style.background = '';
        showSelectionMode(false);
        markNeedsRender();
    }
}

// Build a realistic BS tower icon from primitives
function buildBSTowerIcon(pos, colorHex) {
    const group = new THREE.Group();
    const col   = new THREE.Color(colorHex);

    // Pole
    const poleGeo = new THREE.CylinderGeometry(0.4, 0.6, 18, 8);
    const poleMat = new THREE.MeshPhongMaterial({ color: 0x888888, shininess: 60 });
    const pole    = new THREE.Mesh(poleGeo, poleMat);
    pole.position.y = 9;
    group.add(pole);

    // Crossbar
    const barGeo = new THREE.BoxGeometry(8, 0.5, 0.5);
    const barMat = new THREE.MeshPhongMaterial({ color: 0x666666 });
    const bar    = new THREE.Mesh(barGeo, barMat);
    bar.position.y = 17;
    group.add(bar);

    // Three antenna panels on crossbar
    [-3, 0, 3].forEach(xOff => {
        const antGeo = new THREE.BoxGeometry(1.2, 4, 0.3);
        const antMat = new THREE.MeshPhongMaterial({
            color: col, emissive: col, emissiveIntensity: 0.4
        });
        const ant = new THREE.Mesh(antGeo, antMat);
        ant.position.set(xOff, 17, 1);
        group.add(ant);
    });

    // Glowing tip sphere
    const tipGeo = new THREE.SphereGeometry(0.8, 12, 12);
    const tipMat = new THREE.MeshBasicMaterial({ color: colorHex });
    const tip    = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = 19;
    group.add(tip);

    // Canvas label
    const canvas  = document.createElement('canvas');
    canvas.width  = 200; canvas.height = 64;
    const ctx     = canvas.getContext('2d');
    ctx.fillStyle = 'rgba(20,20,40,0.85)';
    ctx.roundRect(0, 0, 200, 64, 8);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font      = 'bold 20px Arial';
    ctx.textAlign = 'center';
    ctx.fillText('📡 Crowd BS', 100, 30);
    ctx.font      = '14px Arial';
    ctx.fillStyle = '#aaaaff';
    ctx.fillText(`(${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})`, 100, 52);
    const tex  = new THREE.CanvasTexture(canvas);
    const sprM = new THREE.SpriteMaterial({ map: tex, transparent: true });
    const spr  = new THREE.Sprite(sprM);
    spr.scale.set(20, 6.4, 1);
    spr.position.y = 25;
    group.add(spr);

    group.position.set(pos.x, pos.y, pos.z);
    group.name = 'crowd-bs-tower';
    return group;
}

// Spawn instanced human figures across crowd grid
function spawnHumanFigures(crowdPts, maxFigures) {
    if (crowdFiguresGroup) { scene.remove(crowdFiguresGroup); crowdFiguresGroup = null; }
    if (!crowdPts || crowdPts.length === 0) return;

    crowdFiguresGroup = new THREE.Group();
    crowdFiguresGroup.name = 'crowd-figures';

    // Body: cylinder; Head: sphere — as InstancedMesh for performance
    const stride   = Math.max(1, Math.floor(crowdPts.length / maxFigures));
    const count    = Math.floor(crowdPts.length / stride);

    const bodyGeo  = new THREE.CylinderGeometry(0.2, 0.25, 1.2, 6);
    const headGeo  = new THREE.SphereGeometry(0.22, 6, 6);
    const bodyMat  = new THREE.MeshPhongMaterial({ color: 0x4a90d9, transparent: true, opacity: 0.8 });
    const headMat  = new THREE.MeshPhongMaterial({ color: 0xf5cba7, transparent: true, opacity: 0.8 });

    const bodyInst = new THREE.InstancedMesh(bodyGeo, bodyMat, count);
    const headInst = new THREE.InstancedMesh(headGeo, headMat, count);
    bodyInst.name = 'crowd-body'; headInst.name = 'crowd-head';

    const dummy = new THREE.Object3D();
    let   idx   = 0;

    for (let i = 0; i < crowdPts.length && idx < count; i += stride) {
        const pt = crowdPts[i];
        const px = pt.position.x;
        const pz = pt.position.z;
        const py = pt.position.y;

        // Body
        dummy.position.set(px, py + 0.6, pz);
        dummy.rotation.y = Math.random() * Math.PI * 2;
        dummy.updateMatrix();
        bodyInst.setMatrixAt(idx, dummy.matrix);

        // Head
        dummy.position.set(px, py + 1.5, pz);
        dummy.updateMatrix();
        headInst.setMatrixAt(idx, dummy.matrix);

        idx++;
    }
    bodyInst.instanceMatrix.needsUpdate = true;
    headInst.instanceMatrix.needsUpdate = true;

    crowdFiguresGroup.add(bodyInst);
    crowdFiguresGroup.add(headInst);
    scene.add(crowdFiguresGroup);
}

// Draw heatmap quads on the ground coloured by signal
function drawCrowdHeatmap(crowdPts, resolution, groundY) {
    if (crowdHeatmapGroup) { scene.remove(crowdHeatmapGroup); crowdHeatmapGroup = null; }
    if (!crowdPts || crowdPts.length === 0) return;

    crowdHeatmapGroup = new THREE.Group();
    crowdHeatmapGroup.name = 'crowd-heatmap';

    const bands = [
        { min: -Infinity, max: -120, color: 0x440088 },   // extremely weak – deep purple
        { min: -120,      max: -100, color: 0x8800ff },   // very weak – purple
        { min: -100,      max: -90,  color: 0xff2200 },   // weak – red
        { min: -90,       max: -80,  color: 0xff8800 },   // fair – orange
        { min: -80,       max: -70,  color: 0xffee00 },   // good – yellow
        { min: -70,       max: Infinity, color: 0x00dd44 } // strong – green
    ];

    const tileSize = Math.max(resolution * 0.95, 1.0);
    // Place heatmap just above the ground (groundY + tiny offset)
    const tileY = (groundY !== undefined ? groundY : 0) + 0.15;

    bands.forEach(band => {
        const pts = crowdPts.filter(p => p.signalStrength >= band.min && p.signalStrength < band.max);
        if (pts.length === 0) return;

        // Fresh geometry per band — do NOT call rotateX on geometry (mutates in place)
        const geo = new THREE.PlaneGeometry(tileSize, tileSize);
        const mat = new THREE.MeshBasicMaterial({
            color: band.color, transparent: true, opacity: 0.65,
            side: THREE.DoubleSide, depthWrite: false
        });
        const inst = new THREE.InstancedMesh(geo, mat, pts.length);
        inst.name  = 'crowd-heatmap-band';
        inst.renderOrder = 1;

        pts.forEach((pt, i) => {
            // Create a fresh Object3D per tile — avoids rotation accumulation bug
            const d = new THREE.Object3D();
            d.position.set(pt.position.x, tileY, pt.position.z);
            d.rotation.set(-Math.PI / 2, 0, 0);  // flat on ground
            d.updateMatrix();
            inst.setMatrixAt(i, d.matrix);
        });
        inst.instanceMatrix.needsUpdate = true;
        crowdHeatmapGroup.add(inst);
    });

    scene.add(crowdHeatmapGroup);
    markNeedsRender();
}

async function analyzeCrowd() {
    if (!crowdBSPosition) {
        alert('Please place the base station first (📍 Place Base Station)');
        return;
    }
    if (!crowdCenterPosition) {
        alert('Please set the crowd center first (🎯 Set Crowd Center)');
        return;
    }

    const frequency   = parseFloat(document.getElementById('crowd-frequency').value);
    const txPower     = parseFloat(document.getElementById('crowd-tx-power').value);
    const txHeight    = parseFloat(document.getElementById('crowd-tx-height').value);
    const peakDensity = parseFloat(document.getElementById('crowd-density').value);
    const crowdRadius = parseFloat(document.getElementById('crowd-radius').value);
    const resolution  = parseFloat(document.getElementById('crowd-resolution').value);
    const environment = document.getElementById('crowd-environment').value;
    const weatherEffect = false; // removed

    clearCrowdVisualization(/* keepMarkers */ true);

    showProgressOverlay('Crowd Signal Analysis', 'Computing signal across crowd...');
    const startTime = performance.now();

    try {
        const result = await workerManager.executeTask(
            'crowd-analysis',
            {
                txPosition:   crowdBSPosition,
                crowdCenter:  crowdCenterPosition,
                crowdRadius, peakDensity,
                sigma: crowdRadius * 0.5,
                weatherEffect, frequency, txPower, txHeight,
                environment, resolution
            },
            (progress) => {
                updateProgress(progress.progress || 0,
                    `Processed ${(progress.processed || 0).toLocaleString()} of ${(progress.total || 0).toLocaleString()} points...`);
            }
        );

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(2);

        // Unpack typed arrays (worker path) or crowdPoints array (fallback path)
        let crowdPts = [];
        if (result.positions && result.pointCount > 0) {
            const pos = result.positions, sig = result.signals, den = result.densities;
            for (let i = 0; i < result.pointCount; i++) {
                crowdPts.push({
                    position:       { x: pos[i*3], y: pos[i*3+1], z: pos[i*3+2] },
                    signalStrength: sig[i],
                    density:        den[i]
                });
            }
        } else if (result.crowdPoints) {
            crowdPts = result.crowdPoints;
        }

        // Compute stats
        let totalSig = 0, maxS = -Infinity, minS = Infinity, totalPeople = 0;
        crowdPts.forEach(p => {
            totalSig += p.signalStrength;
            if (p.signalStrength > maxS) maxS = p.signalStrength;
            if (p.signalStrength < minS) minS = p.signalStrength;
            totalPeople += (p.density || 0) * resolution * resolution;
        });
        const avgSig = crowdPts.length > 0 ? totalSig / crowdPts.length : 0;

        // 3D visualizations
        const groundY = crowdCenterPosition ? crowdCenterPosition.y : 0;
        drawCrowdHeatmap(crowdPts, resolution, groundY);
        spawnHumanFigures(crowdPts, 800);

        // Store & update UI
        crowdAnalysis = { crowdPts, avgSig, maxS, minS, totalPeople: Math.round(totalPeople), elapsed, modelUsed: result.modelUsed };
        updateCrowdResults(crowdAnalysis);

    } catch (err) {
        if (err.message !== 'Analysis cancelled') alert('Crowd analysis failed: ' + err.message);
    } finally {
        hideProgressOverlay();
    }
}

function updateCrowdResults(r) {
    document.getElementById('crowd-avg-signal').textContent   = r.avgSig.toFixed(1) + ' dBm';
    document.getElementById('crowd-max-signal').textContent   = (r.maxS === -Infinity ? 0 : r.maxS).toFixed(1) + ' dBm';
    document.getElementById('crowd-min-signal').textContent   = (r.minS === Infinity  ? 0 : r.minS).toFixed(1) + ' dBm';
    document.getElementById('crowd-total-people').textContent = r.totalPeople.toLocaleString();
    document.getElementById('crowd-points-analyzed').textContent = `Points: ${r.crowdPts.length.toLocaleString()}`;
    document.getElementById('crowd-compute-time').textContent = `Time: ${r.elapsed}s`;
    document.getElementById('crowd-model-used').textContent   = r.modelUsed === 'B'
        ? '🔬 3GPP Model B — Fresnel screen geometry (≥ 6 GHz)'
        : '📡 3GPP Model A — Statistical blocker (< 6 GHz)';
    document.getElementById('crowd-result').style.display = 'block';
    markNeedsRender();
}

function clearCrowdVisualization(keepMarkers) {
    if (crowdHeatmapGroup) { scene.remove(crowdHeatmapGroup); crowdHeatmapGroup = null; }
    if (crowdFiguresGroup) { scene.remove(crowdFiguresGroup); crowdFiguresGroup = null; }
    if (!keepMarkers) {
        if (crowdBSTowerGroup)  { scene.remove(crowdBSTowerGroup);  crowdBSTowerGroup  = null; }
        if (crowdCenterMarker)  { scene.remove(crowdCenterMarker);  crowdCenterMarker  = null; }
    }
    markNeedsRender();
}

function resetCrowdAnalysis() {
    isSelectingCrowdBS     = false;
    isSelectingCrowdCenter = false;
    crowdBSPosition        = null;
    crowdCenterPosition    = null;
    crowdAnalysis          = null;

    clearCrowdVisualization(false);

    document.getElementById('crowd-bs-coords').textContent     = 'Not selected';
    document.getElementById('crowd-center-coords').textContent = 'Not selected';
    document.getElementById('crowd-result').style.display      = 'none';

    const bsBtn = document.getElementById('select-crowd-bs-btn');
    bsBtn.textContent  = '📍 Place Base Station';
    bsBtn.style.background = '';
    const cBtn = document.getElementById('select-crowd-center-btn');
    cBtn.textContent  = '🎯 Set Crowd Center';
    cBtn.style.background = '';

    // Reset sliders to defaults
    document.getElementById('crowd-density').value    = 1.5;
    document.getElementById('crowd-density-value').textContent  = '1.5 p/m²';
    document.getElementById('crowd-radius').value     = 60;
    document.getElementById('crowd-frequency').value  = 2400;
    document.getElementById('crowd-frequency-value').textContent = '2400 MHz';
    document.getElementById('crowd-tx-power').value   = 30;
    document.getElementById('crowd-tx-power-value').textContent = '30 dBm';
    document.getElementById('crowd-tx-height').value  = 10;
    document.getElementById('crowd-tx-height-value').textContent = '10 m';
    document.getElementById('crowd-resolution').value = 3;
    document.getElementById('crowd-resolution-value') &&
        (document.getElementById('crowd-resolution-value').textContent = '3 m');
    document.getElementById('crowd-model-indicator').textContent = '📡 Model A active — statistical blocker (3GPP TR 38.901) < 6 GHz';
    document.getElementById('crowd-model-indicator').style.color = '#276749';

    showSelectionMode(false);
    markNeedsRender();
}

// Initialize when page loads
window.addEventListener('load', init);
// ═══════════════════════════════════════════════════════════════
// BS PLACEMENT OPTIMISER — appended per INTEGRATION_GUIDE.md §3c
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
//  BS OPTIMISER  —  paste this entire block at the END of script.js
//  Works with the existing workerManager, baseStations[], scene,
//  removeAllBaseStations(), updateBSList(), updateGridRange() etc.
// ═══════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────
let optimiserRunning = false;
let optimiserResult  = null;

// ── RSSI display helper (called by the range input's oninput) ──────
// ── Compute auto ceiling + start from map geometry ─────────────────
// Hexagonal packing: each BS footprint (hex cell) ≈ √3/2 × r²
// ceiling  = ceil(mapArea / hexCellArea), capped at 30
// startCount = ceil(ceiling / 4)  — ¼ of ceiling as a sensible lower bound
function computeAutoCounts(mapBounds, radius) {
    const areaX      = mapBounds.maxX - mapBounds.minX;
    const areaZ      = mapBounds.maxZ - mapBounds.minZ;
    const mapArea    = areaX * areaZ;
    const hexCell    = (Math.sqrt(3) / 2) * radius * radius;
    const raw        = Math.ceil(mapArea / hexCell);
    const ceiling    = Math.min(Math.max(raw, 2), 30);
    const startCount = Math.max(1, Math.ceil(ceiling / 4));
    return { ceiling, startCount };
}

// ── BS-mode checkbox toggle ─────────────────────────────────────────
// Auto ON  → compute ceiling from current radius + map, set slider
//            min=startCount, max=ceiling, value=startCount, show info row.
// Auto OFF → restore slider to full manual range [1, 30], keep current value.
function optToggleAutoBS(isAuto) {
    const infoRow = document.getElementById('opt-auto-info');
    const label   = document.getElementById('opt-max-bs-label');
    const slider  = document.getElementById('opt-max-bs');

    if (isAuto) {
        // Compute from current radius + live map bounds
        const radius    = parseFloat(document.getElementById('opt-radius').value);
        const mapBounds = getMapBounds();
        const { ceiling, startCount } = computeAutoCounts(mapBounds, radius);

        // Update info row
        document.getElementById('opt-info-ceiling').textContent = ceiling;
        document.getElementById('opt-info-start').textContent   = startCount;
        infoRow.style.display = '';

        // Reconfigure slider: min=startCount, max=ceiling, value=startCount
        slider.min   = startCount;
        slider.max   = ceiling;
        slider.value = startCount;
        label.textContent = `Sweep start BS count (auto ceiling = ${ceiling})`;
        optRefreshSliderTicks(startCount, ceiling);
        document.getElementById('opt-max-bs-val').textContent = startCount;

    } else {
        infoRow.style.display = 'none';
        // Restore to full manual range
        slider.min   = 1;
        slider.max   = 30;
        slider.value = Math.max(1, Math.min(parseInt(slider.value), 30));
        label.textContent = 'Max BSs the GA may use (upper bound)';
        const v = parseInt(slider.value);
        optRefreshSliderTicks(1, 30, v);
        document.getElementById('opt-max-bs-val').textContent = v;
    }
}

// Update the min / mid / max tick labels under the slider
function optRefreshSliderTicks(min, max) {
    document.getElementById('opt-bs-slider-min').textContent = min;
    document.getElementById('opt-bs-slider-max').textContent = max;
    const mid = Math.round((min + max) / 2);
    document.getElementById('opt-bs-slider-mid').textContent = mid !== min && mid !== max ? mid : '';
}

// Called by oninput on the slider — updates display and, in auto mode, refreshes info start
function optOnMaxBsSlider(val) {
    const v      = parseInt(val);
    const isAuto = document.getElementById('opt-auto-bs').checked;
    document.getElementById('opt-max-bs-val').textContent = v;
    if (isAuto) {
        document.getElementById('opt-info-start').textContent = v;
    }
}

function optUpdateRSSIDisplay(val) {
    const v = parseInt(val);
    document.getElementById('opt-rssi-value').textContent = v + ' dBm';

    // Descriptive quality label
    let label = '';
    if      (v >= -70)  label = '🟢 Excellent — video streaming / VoLTE';
    else if (v >= -85)  label = '🟡 Good — data & voice, reliable';
    else if (v >= -100) label = '🟠 Moderate — basic data, some drops';
    else if (v >= -110) label = '🔴 Weak — edge of coverage';
    else                label = '⚫ Very weak — near noise floor';

    document.getElementById('opt-rssi-label').textContent = label;
}

// ── Derive map bounds from the loaded 3D model ────────────────────
function getMapBounds() {
    if (typeof model !== 'undefined' && model) {
        const box  = new THREE.Box3().setFromObject(model);
        const pad  = 10;  // small padding so BSs aren't right on the edge
        return {
            minX: box.min.x - pad, maxX: box.max.x + pad,
            minZ: box.min.z - pad, maxZ: box.max.z + pad
        };
    }
    // Fallback if model not loaded
    return { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };
}

// ── Main optimiser run ────────────────────────────────────────────
async function runBSOptimiser() {
    if (optimiserRunning) return;

    const isAuto      = document.getElementById('opt-auto-bs').checked;
    const txPower     = parseFloat(document.getElementById('opt-tx-power').value);
    const frequency   = parseFloat(document.getElementById('opt-frequency').value);
    const txHeight    = parseFloat(document.getElementById('opt-tx-height').value);
    const radius      = parseFloat(document.getElementById('opt-radius').value);
    const environment = document.getElementById('opt-environment').value;
    const minSpacing  = parseFloat(document.getElementById('opt-min-spacing').value);
    const resolution  = parseFloat(document.getElementById('opt-resolution').value);
    const minRSSI     = parseFloat(document.getElementById('opt-min-rssi').value);
    const mapBounds   = getMapBounds();

    const bsTemplate = { txPower, frequency, txHeight, radius, environment };

    // UI — transition to running state
    optimiserRunning = true;
    document.getElementById('run-optimiser-btn').style.display    = 'none';
    document.getElementById('cancel-optimiser-btn').style.display = '';
    document.getElementById('opt-progress-box').style.display     = '';
    document.getElementById('opt-result-box').style.display       = 'none';
    document.getElementById('opt-gen-bar').style.width            = '0%';
    document.getElementById('opt-gen-cur').textContent            = '0';
    document.getElementById('opt-phase-cur').textContent          = '1';
    document.getElementById('opt-phase-banner').style.display     = 'none';
    document.getElementById('opt-prog-cov').textContent           = '—';
    document.getElementById('opt-prog-gap').textContent           = '—';
    document.getElementById('opt-prog-bs').textContent            = '—';
    document.getElementById('opt-prog-fit').textContent           = '—';
    // Clear live map
    const lm = document.getElementById('opt-live-map');
    if (lm) { const lc = lm.getContext('2d'); lc.fillStyle='#1e293b'; lc.fillRect(0,0,lm.width,lm.height); }

    try {
        let result;

        if (isAuto) {
            result = await runAutoSweep({
                bsTemplate, mapBounds, resolution, minRSSI, minSpacing
            });
        } else {
            const maxBS = parseInt(document.getElementById('opt-max-bs').value);
            document.getElementById('opt-gen-max').textContent      = '80';
            document.getElementById('opt-sweep-label').style.display = 'none';
            document.getElementById('opt-phase-banner').style.display = 'none';

            result = await workerManager.executeTask(
                'bs-optimiser',
                { maxBS, bsTemplate, mapBounds, evalResolution: resolution, minRSSI, minSpacing },
                (p) => optProgressCallback(p, mapBounds, bsTemplate)
            );
        }

        optimiserResult = result;
        renderOptimiserResults(result, isAuto);

    } catch (err) {
        if (err.message !== 'Analysis cancelled' && err.message !== 'Optimisation cancelled') {
            alert('Optimiser error: ' + err.message);
            console.error(err);
        }
    } finally {
        optimiserRunning = false;
        document.getElementById('run-optimiser-btn').style.display    = '';
        document.getElementById('cancel-optimiser-btn').style.display = 'none';
        document.getElementById('opt-progress-box').style.display     = 'none';
        document.getElementById('opt-sweep-label').style.display      = 'none';
        document.getElementById('opt-phase-banner').style.display     = 'none';
    }
}

// ── Auto sweep: run GA from startCount → ceiling ──────────────────
// startCount = slider value (defaults to ¼ ceiling, user-overrideable).
// Ceiling is always recomputed fresh from map + radius at run time.
// Elbow detection stops early when coverage gain < 2% AND prev ≥ 85%.
async function runAutoSweep({ bsTemplate, mapBounds, resolution, minRSSI, minSpacing }) {
    const { ceiling, startCount: defaultStart } = computeAutoCounts(mapBounds, bsTemplate.radius);

    // Honour the slider — user may have dragged it away from the default start
    const sliderVal  = parseInt(document.getElementById('opt-max-bs').value);
    const startCount = Math.min(Math.max(sliderVal, 1), ceiling);

    // Update info row values with run-time numbers
    document.getElementById('opt-info-ceiling').textContent = ceiling;
    document.getElementById('opt-info-start').textContent   = startCount;

    // Progress UI
    document.getElementById('opt-sweep-label').style.display  = '';
    document.getElementById('opt-sweep-max').textContent       = ceiling;
    document.getElementById('opt-sweep-start').textContent     = startCount;
    document.getElementById('opt-gen-max').textContent         = '80';

    const sweepResults = [];   // [{bsCount, coveragePct, result}]

    for (let n = startCount; n <= ceiling; n++) {
        if (!optimiserRunning) throw new Error('Optimisation cancelled');

        document.getElementById('opt-sweep-cur').textContent = n;
        document.getElementById('opt-gen-cur').textContent   = '0';
        document.getElementById('opt-gen-bar').style.width   = '0%';

        const res = await workerManager.executeTask(
            'bs-optimiser',
            { maxBS: n, bsTemplate, mapBounds, evalResolution: resolution, minRSSI, minSpacing },
            (p) => optProgressCallback(p, mapBounds, bsTemplate)
        );

        const cov = res.finalStats.coveragePct;
        sweepResults.push({ bsCount: n, coveragePct: cov, result: res });

        // Early exit: effectively full coverage
        if (cov >= 99.5) break;

        // Elbow detection: gain from previous step < 2% and already decent coverage
        if (sweepResults.length >= 2) {
            const prev = sweepResults[sweepResults.length - 2].coveragePct;
            if (cov - prev < 2.0 && prev >= 85) break;
        }
    }

    // Pick the "elbow" winner: coverage% − 1.5 × bsCount
    const best = sweepResults.reduce((acc, s) => {
        const score = s.coveragePct - 1.5 * s.bsCount;
        return score > acc.score ? { ...s, score } : acc;
    }, { score: -Infinity, ...sweepResults[0] });

    best.result._sweepData    = sweepResults.map(s => ({ bsCount: s.bsCount, coveragePct: s.coveragePct }));
    best.result._sweepCeiling = ceiling;
    best.result._sweepStart   = startCount;

    return best.result;
}

// ── Shared progress callback — called every generation by the worker ─
function optProgressCallback(p, mapBounds, bsTemplate) {
    // Phase-transition notification from worker
    if (p.phaseTransition) {
        document.getElementById('opt-phase-banner').style.display = '';
        document.getElementById('opt-inject-bs').textContent      = p.injectedBS;
        document.getElementById('opt-phase-num').textContent      = p.phase;
        document.getElementById('opt-phase-cur').textContent      = p.phase;
        document.getElementById('opt-gen-bar').style.width        = '0%';
        return;
    }

    document.getElementById('opt-phase-banner').style.display = 'none';
    document.getElementById('opt-gen-cur').textContent         = p.generation      ?? '—';
    document.getElementById('opt-gen-bar').style.width         = (p.progress || 0) + '%';
    document.getElementById('opt-phase-cur').textContent       = p.phase ?? 1;

    const cov = p.coveragePct ?? null;
    const gap = p.coverageGap ?? null;
    document.getElementById('opt-prog-cov').textContent = cov !== null ? cov + '%' : '—';
    document.getElementById('opt-prog-gap').textContent = gap !== null ? gap + '%' : '—';

    // Colour the gap cell: green when small, amber, red when large
    const gapEl = document.getElementById('opt-prog-gap');
    if (gap !== null) {
        gapEl.style.color = gap <= 5  ? '#16a34a'
                          : gap <= 20 ? '#d97706'
                          :             '#ef4444';
    }

    document.getElementById('opt-prog-bs').textContent  = p.activeBSCount ?? '—';
    document.getElementById('opt-prog-fit').textContent = p.bestFitness   ?? '—';

    // Draw the live 2D map if we have placement data
    if (p.livePlacement && p.livePlacement.length > 0) {
        drawLiveMap(p.livePlacement, mapBounds, bsTemplate);
    }
}

// ── Live 2D map — drawn every generation onto #opt-live-map ──────
function drawLiveMap(placement, bounds, bsTemplate) {
    const canvas = document.getElementById('opt-live-map');
    if (!canvas) return;

    const W = canvas.offsetWidth || 280;
    const H = 130;
    if (canvas.width !== W)  canvas.width  = W;
    if (canvas.height !== H) canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    // Dark background
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(0, 0, W, H);

    const pad    = 10;
    const rangeX = (bounds.maxX - bounds.minX) || 1;
    const rangeZ = (bounds.maxZ - bounds.minZ) || 1;
    const scale  = Math.min((W - pad * 2) / rangeX, (H - pad * 2) / rangeZ);

    const toSX = x => pad + (x - bounds.minX) * scale;
    const toSY = z => pad + (z - bounds.minZ) * scale;

    // Map boundary
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, rangeX * scale, rangeZ * scale);

    // Coverage hexagons + BS dots
    const radius = bsTemplate ? bsTemplate.radius * scale : 20;

    placement.forEach((pos, i) => {
        const col = BS_PALETTE[i % BS_PALETTE.length];
        const cx  = toSX(pos.x);
        const cy  = toSY(pos.z);

        // Hexagonal footprint
        ctx.beginPath();
        for (let s = 0; s < 6; s++) {
            const angle = (Math.PI / 3) * s - Math.PI / 6;
            const hx = cx + radius * Math.cos(angle);
            const hy = cy + radius * Math.sin(angle);
            s === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
        }
        ctx.closePath();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle   = col;
        ctx.fill();
        ctx.globalAlpha = 0.75;
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // BS dot
        ctx.beginPath();
        ctx.arc(cx, cy, 4, 0, Math.PI * 2);
        ctx.fillStyle   = col;
        ctx.fill();
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1;
        ctx.stroke();

        // BS number label
        ctx.fillStyle   = 'white';
        ctx.font        = 'bold 8px sans-serif';
        ctx.textAlign   = 'center';
        ctx.fillText(i + 1, cx, cy + 3);
        ctx.textAlign   = 'left';
    });

    // Generation watermark
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font      = '9px monospace';
    ctx.fillText(`Gen ${document.getElementById('opt-gen-cur').textContent}  ·  ${placement.length} BS`, pad + 2, H - 3);
}

function cancelBSOptimiser() {
    workerManager.cancelAllTasks();
    optimiserRunning = false;
    document.getElementById('run-optimiser-btn').style.display    = '';
    document.getElementById('cancel-optimiser-btn').style.display = 'none';
    document.getElementById('opt-progress-box').style.display     = 'none';
}

// ── Render results ────────────────────────────────────────────────
const BS_PALETTE = [
    '#ef4444','#3b82f6','#22c55e','#f59e0b',
    '#a855f7','#06b6d4','#f97316','#6366f1',
    '#ec4899','#14b8a6','#84cc16','#8b5cf6'
];

function renderOptimiserResults(result, isAuto) {
    const { finalStats, history, bestPlacement, activeBSCount, minRSSI } = result;

    document.getElementById('opt-result-box').style.display = '';
    document.getElementById('opt-res-cov').textContent  = finalStats.coveragePct.toFixed(1) + '%';
    document.getElementById('opt-res-bs').textContent   = activeBSCount;
    document.getElementById('opt-res-sig').textContent  = finalStats.avgSignal.toFixed(1) + ' dBm';

    // Show phase count in header if multi-phase run happened
    const hdr = document.querySelector('#opt-result-box > strong');
    if (hdr) {
        const phases = result.totalPhases ?? 1;
        hdr.textContent = phases > 1
            ? `✅ Optimisation Complete — ${phases} phases (BS injection triggered)`
            : '✅ Optimisation Complete';
    }

    // Auto-sweep summary banner
    const summaryEl = document.getElementById('opt-auto-summary');
    if (isAuto && result._sweepData) {
        const sd    = result._sweepData;
        const start = result._sweepStart ?? sd[0].bsCount;
        const rows  = sd.map(s =>
            `${s.bsCount} BS → ${s.coveragePct.toFixed(1)}%${s.bsCount === activeBSCount ? ' ✅' : ''}`
        ).join(' &nbsp;|&nbsp; ');
        summaryEl.innerHTML =
            `🔍 Swept BS counts <strong>${start}</strong> → <strong>${result._sweepCeiling}</strong> ` +
            `(ceiling = map area ÷ hex footprint):<br>` +
            `<span style="font-family:monospace; font-size:10px;">${rows}</span>`;
        summaryEl.style.display = '';
    } else {
        summaryEl.style.display = 'none';
    }

    // Per-BS breakdown list
    const listEl = document.getElementById('opt-bs-list');
    listEl.innerHTML = '';
    bestPlacement.forEach((pos, i) => {
        const count   = finalStats.bsCounts[i] || 0;
        const pct     = ((count / (finalStats.totalPoints || 1)) * 100).toFixed(1);
        const col     = BS_PALETTE[i % BS_PALETTE.length];
        listEl.innerHTML += `
            <div style="display:flex; align-items:center; gap:8px; padding:8px 10px;
                        background:white; border-radius:6px; margin-bottom:5px;
                        border-left:3px solid ${col}; font-size:12px;">
                <div style="width:9px; height:9px; border-radius:50%;
                            background:${col}; flex-shrink:0;"></div>
                <div style="flex:1; font-weight:600;">BS-${i + 1}</div>
                <div style="color:#555; font-size:11px;">
                    (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)})
                </div>
                <div style="color:#888; font-size:11px; margin-left:6px;">
                    ${count.toLocaleString()} pts&nbsp;·&nbsp;${pct}%
                </div>
            </div>`;
    });

    // Draw sweep coverage chart (auto mode) or convergence chart (manual mode)
    if (isAuto && result._sweepData) {
        drawSweepChart(result._sweepData, activeBSCount);
    } else {
        drawConvergenceChart(history);
    }
    drawHexLayout(bestPlacement, result.mapBounds, finalStats.uncoveredSample);
}

// ── Sweep chart: coverage % vs BS count (auto mode) ───────────────
function drawSweepChart(sweepData, selectedCount) {
    const canvas = document.getElementById('opt-chart');
    if (!canvas || !sweepData.length) return;
    const W = canvas.offsetWidth || 280, H = 90;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const pad = { t: 6, r: 6, b: 20, l: 32 };
    const iW  = W - pad.l - pad.r, iH = H - pad.t - pad.b;

    const maxN = sweepData[sweepData.length - 1].bsCount;
    const toX  = n => pad.l + ((n - 1) / Math.max(maxN - 1, 1)) * iW;
    const toY  = v => pad.t + iH - (v / 100) * iH;

    // Grid
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
    [25, 50, 75, 100].forEach(g => {
        const y = toY(g);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + iW, y); ctx.stroke();
        ctx.fillStyle = '#9ca3af'; ctx.font = '9px monospace';
        ctx.fillText(g + '%', 1, y + 3);
    });

    // Coverage line
    ctx.beginPath(); ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 2;
    sweepData.forEach((s, i) => {
        i === 0 ? ctx.moveTo(toX(s.bsCount), toY(s.coveragePct))
                : ctx.lineTo(toX(s.bsCount), toY(s.coveragePct));
    });
    ctx.stroke();

    // Dots for each tested count
    sweepData.forEach(s => {
        const isSelected = s.bsCount === selectedCount;
        ctx.beginPath();
        ctx.arc(toX(s.bsCount), toY(s.coveragePct), isSelected ? 5 : 3, 0, Math.PI * 2);
        ctx.fillStyle   = isSelected ? '#2563eb' : '#16a34a';
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1;
        ctx.fill(); ctx.stroke();

        // BS count label below x-axis
        ctx.fillStyle = isSelected ? '#2563eb' : '#9ca3af';
        ctx.font = isSelected ? 'bold 9px sans-serif' : '9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(s.bsCount, toX(s.bsCount), H - 3);
        ctx.textAlign = 'left';
    });

    // X-axis label
    ctx.fillStyle = '#9ca3af'; ctx.font = '9px sans-serif';
    ctx.fillText('BS count →', pad.l, H - 3);

    // Legend
    ctx.fillStyle = '#16a34a'; ctx.fillRect(W - 110, 6, 10, 3);
    ctx.fillStyle = '#374151'; ctx.font = '9px sans-serif'; ctx.fillText('Coverage %', W - 97, 11);
    ctx.beginPath(); ctx.arc(W - 105, 20, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#2563eb'; ctx.fill();
    ctx.fillStyle = '#374151'; ctx.fillText('Selected', W - 97, 24);
}

// ── Convergence chart ─────────────────────────────────────────────
function drawConvergenceChart(history) {
    const canvas = document.getElementById('opt-chart');
    if (!canvas || !history.length) return;
    const W = canvas.offsetWidth || 280, H = 90;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const pad = { t: 6, r: 6, b: 18, l: 32 };
    const iW = W - pad.l - pad.r, iH = H - pad.t - pad.b;

    const covs = history.map(h => h.covPct);
    const yMin = 0, yMax = 100, yR = 100;
    const toX  = i => pad.l + (i / Math.max(history.length - 1, 1)) * iW;
    const toY  = v => pad.t + iH - ((v - yMin) / yR) * iH;

    // Grid lines at 25%, 50%, 75%, 100%
    ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1;
    [25, 50, 75, 100].forEach(g => {
        const y = toY(g);
        ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + iW, y); ctx.stroke();
        ctx.fillStyle = '#9ca3af'; ctx.font = '9px monospace';
        ctx.fillText(g + '%', 1, y + 3);
    });

    // Coverage % line (green)
    ctx.beginPath(); ctx.strokeStyle = '#16a34a'; ctx.lineWidth = 2;
    history.forEach((h, i) => {
        i === 0 ? ctx.moveTo(toX(i), toY(h.covPct)) : ctx.lineTo(toX(i), toY(h.covPct));
    });
    ctx.stroke();

    // Active BS count (blue dashed, secondary axis mapped 0–maxBS → 0–100)
    const maxBSseen = Math.max(...history.map(h => h.activeBSCount), 1);
    ctx.beginPath(); ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    history.forEach((h, i) => {
        const v = (h.activeBSCount / maxBSseen) * 100;
        i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v));
    });
    ctx.stroke(); ctx.setLineDash([]);

    // Legend
    ctx.fillStyle = '#16a34a'; ctx.fillRect(W - 100, 6, 10, 3);
    ctx.fillStyle = '#374151'; ctx.font = '9px sans-serif'; ctx.fillText('Coverage %', W - 87, 11);
    ctx.strokeStyle = '#3b82f6'; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(W - 100, 20); ctx.lineTo(W - 90, 20); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#374151'; ctx.fillText('BS count', W - 87, 24);

    // X label
    ctx.fillStyle = '#9ca3af'; ctx.fillText('Generation →', pad.l, H - 3);
}

// ── Hexagonal layout top-view canvas ─────────────────────────────
function drawHexLayout(placement, bounds, uncovered) {
    const canvas = document.getElementById('opt-hex-canvas');
    if (!canvas) return;
    const W = canvas.offsetWidth || 280, H = 140;
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);

    const pad = 12;
    const rangeX = (bounds.maxX - bounds.minX) || 1;
    const rangeZ = (bounds.maxZ - bounds.minZ) || 1;
    const scale  = Math.min((W - pad*2) / rangeX, (H - pad*2) / rangeZ);

    const toSX = x => pad + (x - bounds.minX) * scale;
    const toSY = z => pad + (z - bounds.minZ) * scale;

    // Map boundary
    ctx.strokeStyle = '#475569'; ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, rangeX * scale, rangeZ * scale);

    // Uncovered points (dim red)
    if (uncovered && uncovered.length) {
        ctx.fillStyle = 'rgba(239,68,68,0.35)';
        uncovered.forEach(p => {
            ctx.beginPath();
            ctx.arc(toSX(p.x), toSY(p.z), 1.5, 0, Math.PI * 2);
            ctx.fill();
        });
    }

    // Coverage circles for each BS
    placement.forEach((pos, i) => {
        const col = BS_PALETTE[i % BS_PALETTE.length];
        const bsTemplate = optimiserResult?.bsTemplate;
        const radius = bsTemplate ? bsTemplate.radius * scale : 20;

        // Draw hexagon approximating coverage circle
        ctx.beginPath();
        for (let s = 0; s < 6; s++) {
            const angle = (Math.PI / 3) * s - Math.PI / 6;
            const hx = toSX(pos.x) + radius * Math.cos(angle);
            const hy = toSY(pos.z) + radius * Math.sin(angle);
            s === 0 ? ctx.moveTo(hx, hy) : ctx.lineTo(hx, hy);
        }
        ctx.closePath();
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1.2;
        ctx.globalAlpha = 0.35;
        ctx.fillStyle   = col;
        ctx.fill();
        ctx.globalAlpha = 0.9;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // BS dot
        ctx.beginPath();
        ctx.arc(toSX(pos.x), toSY(pos.z), 4, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1;
        ctx.stroke();

        // BS label
        ctx.fillStyle = 'white'; ctx.font = 'bold 9px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(i + 1, toSX(pos.x), toSY(pos.z) + 3.5);
        ctx.textAlign = 'left';
    });
}

// ── Apply to Multi-Coverage tool ──────────────────────────────────
function applyOptimisedBSPositions() {
    if (!optimiserResult) return;
    const { bestPlacement, bsTemplate, activeBSCount } = optimiserResult;

    // Clear existing BSs first
    if (typeof removeAllBaseStations === 'function') removeAllBaseStations();

    bestPlacement.forEach((pos, i) => {
        const bs = {
            name:             `OPT-${i + 1}`,
            color:            BS_PALETTE[i % BS_PALETTE.length],
            txPower:          bsTemplate.txPower,
            frequency:        bsTemplate.frequency,
            txHeight:         bsTemplate.txHeight,
            radius:           bsTemplate.radius,
            environment:      bsTemplate.environment,
            antennaAzimuth:   0,
            antennaBeamwidth: 360,
            antennaGain:      0,
            rayTracingEnabled:false,
            position:         { x: pos.x, y: bsTemplate.txHeight, z: pos.z },
            index:            i
        };

        baseStations.push(bs);
        bsMarkers[i] = null;
        bsLabels[i]  = null;
        updateBSVisual(i);
    });

    // Reindex and refresh list
    baseStations.forEach((bs, i) => bs.index = i);
    updateBSList();
    if (typeof updateGridRange === 'function') updateGridRange();

    // Switch to multi-coverage tab
    const sel = document.getElementById('tool-select');
    if (sel) { sel.value = 'multi-coverage'; sel.dispatchEvent(new Event('change')); }

    alert(`✅ ${activeBSCount} optimised BSs applied.\nClick "Analyse Coverage" to simulate.`);
}

// ── Export results ────────────────────────────────────────────────
function exportOptimiserResults() {
    if (!optimiserResult) return;
    const { bestPlacement, finalStats, history, bsTemplate, activeBSCount, minRSSI,
            _sweepData, _sweepCeiling } = optimiserResult;

    const out = {
        timestamp:       new Date().toISOString(),
        algorithm:       'Genetic Algorithm (Minimise BS Count)',
        mode:            _sweepData ? 'auto-sweep' : 'manual',
        initialSeed:     'Hexagonal grid packing',
        generations:     80, populationSize: 50,
        minRSSI_dBm:     minRSSI,
        bsTemplate,
        result: {
            bsCount:        activeBSCount,
            coveragePct:    finalStats.coveragePct.toFixed(2),
            avgSignal_dBm:  finalStats.avgSignal.toFixed(2),
            coveredPoints:  finalStats.coveredPoints,
            totalPoints:    finalStats.totalPoints
        },
        optimisedPositions: bestPlacement.map((p, i) => ({
            bs: i + 1,
            x:  +p.x.toFixed(2), z: +p.z.toFixed(2),
            servedPoints: finalStats.bsCounts[i]
        })),
        convergence: history.map(h => ({
            gen:      h.generation,
            covPct:   +h.covPct.toFixed(2),
            activeBS: h.activeBSCount,
            fitness:  +h.best.toFixed(4)
        }))
    };

    if (_sweepData) {
        out.autoSweep = {
            ceiling:      _sweepCeiling,
            startCount:   optimiserResult._sweepStart ?? _sweepData[0]?.bsCount,
            testedCounts: _sweepData.length,
            sweepResults: _sweepData.map(s => ({
                bsCount:     s.bsCount,
                coveragePct: +s.coveragePct.toFixed(2)
            }))
        };
    }

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `bs-opt-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(url);
}
// ═══════════════════════════════════════════════════════════════════
//  CONTOUR CHAIN BS PLACER  —  append this block to the END of script.js
//  Also:
//    1. Add  workerManager.createWorker('contour-chain', 'contour-chain-worker.js');
//       inside initWorkersWithBuildingData()
//    2. Add tool switching case in your tool-selector change handler:
//       else if (currentTool === 'contour-chain') {
//           document.getElementById('contour-chain-tool').style.display = '';
//       }
// ═══════════════════════════════════════════════════════════════════

// ── State ─────────────────────────────────────────────────────────
let ccRunning = false;
let ccResult  = null;

// ── RSSI label helper ──────────────────────────────────────────────
function ccUpdateRSSI(val) {
    const v = parseInt(val);
    document.getElementById('cc-rssi-val').textContent = v + ' dBm';
    let label = '';
    if      (v >= -70)  label = '🟢 Excellent — video streaming / VoLTE';
    else if (v >= -85)  label = '🟡 Good — data & voice, reliable';
    else if (v >= -100) label = '🟠 Moderate — basic data, some drops';
    else if (v >= -110) label = '🔴 Weak — edge of coverage';
    else                label = '⚫ Very weak — near noise floor';
    document.getElementById('cc-rssi-label').textContent = label;
}

// ── Main run ──────────────────────────────────────────────────────
async function runContourChain() {
    if (ccRunning) return;

    const txPower     = parseFloat(document.getElementById('cc-tx-power').value);
    const frequency   = parseFloat(document.getElementById('cc-frequency').value);
    const txHeight    = parseFloat(document.getElementById('cc-tx-height').value);
    const radius      = parseFloat(document.getElementById('cc-radius').value);
    const environment = document.getElementById('cc-environment').value;
    const minRSSI     = parseFloat(document.getElementById('cc-min-rssi').value);
    const resolution  = parseFloat(document.getElementById('cc-resolution').value);
    const target      = parseFloat(document.getElementById('cc-target').value);
    const mapBounds   = getMapBounds();   // reuse from GA optimiser section

    const bsTemplate  = { txPower, frequency, txHeight, radius, environment };

    // UI — running state
    ccRunning = true;
    document.getElementById('cc-run-btn').style.display    = 'none';
    document.getElementById('cc-cancel-btn').style.display = '';
    document.getElementById('cc-progress-box').style.display = '';
    document.getElementById('cc-result-box').style.display   = 'none';
    document.getElementById('cc-prog-cov').textContent = '—';
    document.getElementById('cc-prog-gap').textContent = '—';
    document.getElementById('cc-prog-bs').textContent  = '—';
    document.getElementById('cc-prog-bar').style.width  = '0%';
    document.getElementById('cc-prog-bar').style.background = '';
    document.getElementById('cc-prog-bar').classList.add('cc-running');
    document.getElementById('cc-step-label').textContent = '🔗 Starting contour chain...';
    // Show working indicator
    const ccWorking = document.getElementById('cc-working');
    if (ccWorking) ccWorking.style.display = 'flex';
    const ccWorkingSub = document.getElementById('cc-working-sub');
    if (ccWorkingSub) ccWorkingSub.textContent = 'Initialising coverage matrix…';

    // Clear live map
    const lm = document.getElementById('cc-live-map');
    if (lm) {
        const lc = lm.getContext('2d');
        lc.fillStyle = '#0f172a';
        lc.fillRect(0, 0, lm.width, lm.height);
    }

    try {
        ccResult = await workerManager.executeTask(
            'contour-chain',
            { bsTemplate, mapBounds, evalResolution: resolution, minRSSI, targetCoverage: target },
            (p) => ccProgressCallback(p, mapBounds, bsTemplate)
        );

        ccRenderResults(ccResult);

    } catch (err) {
        if (err.message !== 'Analysis cancelled') {
            alert('Contour chain error: ' + err.message);
            console.error(err);
        }
    } finally {
        ccRunning = false;
        // Hide spinner and stop animated bar
        const ccWorking2 = document.getElementById('cc-working');
        if (ccWorking2) ccWorking2.style.display = 'none';
        document.getElementById('cc-prog-bar').classList.remove('cc-running');
        document.getElementById('cc-run-btn').style.display    = '';
        document.getElementById('cc-cancel-btn').style.display = 'none';
        document.getElementById('cc-progress-box').style.display = 'none';
    }
}

function cancelContourChain() {
    workerManager.cancelAllTasks();
    ccRunning = false;
    // Hide spinner and stop animated bar
    const ccWorking3 = document.getElementById('cc-working');
    if (ccWorking3) ccWorking3.style.display = 'none';
    const ccBar = document.getElementById('cc-prog-bar');
    if (ccBar) { ccBar.classList.remove('cc-running'); ccBar.style.background = '#f97316'; }
    document.getElementById('cc-run-btn').style.display    = '';
    document.getElementById('cc-cancel-btn').style.display = 'none';
    document.getElementById('cc-progress-box').style.display = 'none';
}

// ── Progress callback ──────────────────────────────────────────────
function ccProgressCallback(p, mapBounds, bsTemplate) {
    const cov = parseFloat(p.coveragePct || 0);
    const gap = parseFloat(p.coverageGap || 100);
    const bs  = p.bsCount || 0;

    document.getElementById('cc-prog-cov').textContent = cov.toFixed(1) + '%';
    document.getElementById('cc-prog-gap').textContent = gap.toFixed(1) + '%';
    document.getElementById('cc-prog-bs').textContent  = bs;
    document.getElementById('cc-prog-bar').style.width = Math.min(100, cov) + '%';
    // Update spinner sub-text
    const ccWorkingSub = document.getElementById('cc-working-sub');
    if (ccWorkingSub) ccWorkingSub.textContent = `Placed ${bs} BS · scanning next gap…`;

    const covEl = document.getElementById('cc-prog-cov');
    covEl.style.color = cov >= 90 ? '#16a34a' : cov >= 70 ? '#d97706' : '#ef4444';

    const gapEl = document.getElementById('cc-prog-gap');
    gapEl.style.color = gap <= 5 ? '#16a34a' : gap <= 20 ? '#d97706' : '#ef4444';

    const stepLbl = document.getElementById('cc-step-label');
    stepLbl.textContent = `🔗 Parasite growing — BS #${bs} · Coverage: ${cov.toFixed(1)}% · Frontier: ${p.frontierPoints?.length || 0} edge points`;
    stepLbl.style.color = '#0369a1';

    // Draw live map with covered area and frontier
    if (p.placements) {
        ccDrawLiveMap(p.placements, p.coveredPoints || [], p.frontierPoints || [], mapBounds, bsTemplate, cov, gap);
    }
}

// ── Live 2D map drawing ────────────────────────────────────────────
const CC_PALETTE = [
    '#3b82f6','#8b5cf6','#06b6d4','#6366f1',
    '#a855f7','#0ea5e9','#7c3aed','#2563eb',
    '#0891b2','#4f46e5','#7e22ce','#1d4ed8'
];

function ccDrawLiveMap(placements, coveredPoints, frontierPoints, bounds, bsTemplate, covPct, gapPct) {
    const canvas = document.getElementById('cc-live-map');
    if (!canvas) return;

    const W = canvas.offsetWidth || 300;
    const H = 200;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    const PAD = 12;
    const rangeX = (bounds.maxX - bounds.minX) || 1;
    const rangeZ = (bounds.maxZ - bounds.minZ) || 1;
    const scaleX = (W - PAD * 2) / rangeX;
    const scaleZ = (H - PAD * 2 - 18) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);

    const toSX = x => PAD + (x - bounds.minX) * scale;
    const toSY = z => PAD + (z - bounds.minZ) * scale;

    // Map boundary
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, rangeX * scale, rangeZ * scale);

    // Draw covered area (green) - the parasite body
    if (coveredPoints && coveredPoints.length > 0) {
        const dotSize = Math.max(2, scale * 3);
        for (const pt of coveredPoints) {
            ctx.fillStyle = 'rgba(34,197,94,0.6)';
            const sx = toSX(pt.x) - dotSize / 2;
            const sy = toSY(pt.z) - dotSize / 2;
            ctx.fillRect(sx, sy, dotSize, dotSize);
        }
    }

    // Draw frontier points (yellow) - the growing edge
    if (frontierPoints && frontierPoints.length > 0) {
        const dotSize = Math.max(3, scale * 4);
        for (const pt of frontierPoints) {
            ctx.fillStyle = 'rgba(234,179,8,0.8)';
            const sx = toSX(pt.x) - dotSize / 2;
            const sy = toSY(pt.z) - dotSize / 2;
            ctx.fillRect(sx, sy, dotSize, dotSize);
        }
    }

    const radius = bsTemplate ? bsTemplate.radius * scale : 20;

    // Draw placed BS positions
    placements.forEach((bs, i) => {
        const col = bs.isAnchor ? '#f97316' : (bs.isAggressive ? '#a855f7' : '#3b82f6');
        const cx = toSX(bs.x);
        const cy = toSY(bs.z);

        // Draw coverage circle (semi-transparent)
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.globalAlpha = 0.15;
        ctx.fillStyle = col;
        ctx.fill();
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = col;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // BS dot
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle = col;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // BS label
        ctx.fillStyle = 'white';
        ctx.font = 'bold 8px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(bs.isAnchor ? '★' : (i + 1), cx, cy + 3);
        ctx.textAlign = 'left';
    });

    // Coverage bar
    const barY = H - 16;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, barY, W, 16);
    const barW = (W - PAD * 2) * Math.min(1, covPct / 100);
    ctx.fillStyle = covPct >= 90 ? '#16a34a' : covPct >= 70 ? '#d97706' : '#ef4444';
    ctx.globalAlpha = 0.8;
    ctx.fillRect(PAD, barY + 2, barW, 12);
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'white';
    ctx.font = 'bold 9px monospace';
    ctx.fillText(`Coverage: ${covPct.toFixed(1)}%  ·  Gap: ${gapPct.toFixed(1)}%  ·  BS: ${placements.length}`, PAD + 4, barY + 11);
}

// ── Render final results ───────────────────────────────────────────
function ccRenderResults(result) {
    document.getElementById('cc-result-box').style.display = '';
    document.getElementById('cc-res-cov').textContent = result.coveragePct + '%';
    document.getElementById('cc-res-bs').textContent  = result.bsCount;

    // Per-BS list
    const list = document.getElementById('cc-bs-list');
    list.innerHTML = result.bsPositions.map((bs, i) => {
        const tag = bs.isHeal
            ? '<span style="font-size:10px; color:#b45309; background:#fef3c7; padding:1px 5px; border-radius:4px;">GAP HEAL</span>'
            : `<span style="font-size:10px; color:#0369a1; background:#e0f2fe; padding:1px 5px; border-radius:4px;">CHAIN #${i+1}</span>`;
        return `
            <div style="display:flex; justify-content:space-between; align-items:center;
                        padding:7px 10px; margin:3px 0; background:white; border-radius:6px;
                        border-left:3px solid ${bs.isHeal ? '#f59e0b' : CC_PALETTE[i % CC_PALETTE.length]};">
                <div>
                    <div style="font-weight:600; font-size:12px; color:#1e293b;">BS ${i + 1}</div>
                    <div style="font-size:10px; color:#64748b;">
                        x: ${bs.x.toFixed(1)}m &nbsp; z: ${bs.z.toFixed(1)}m
                    </div>
                </div>
                ${tag}
            </div>`;
    }).join('');

    // Draw final map (reuse live map drawing on the result canvas)
    const allPlacements = result.bsPositions.map((bs, i) => ({
        x: bs.x, z: bs.z,
        isActive: false,
        isHeal: bs.isHeal,
        contourPts: []
    }));

    // Draw on final canvas
    const finalCanvas = document.getElementById('cc-final-map');
    if (finalCanvas && result.bsPositions.length > 0) {
        ccDrawFinalMap(finalCanvas, allPlacements, result.mapBounds, result.bsTemplate,
                       parseFloat(result.coveragePct));
    }
}

// ── Final static map ──────────────────────────────────────────────
function ccDrawFinalMap(canvas, placements, bounds, bsTemplate, covPct) {
    const W = canvas.offsetWidth || 300;
    const H = 220;
    if (canvas.width  !== W) canvas.width  = W;
    if (canvas.height !== H) canvas.height = H;

    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, W, H);

    const PAD    = 12;
    const rangeX = (bounds.maxX - bounds.minX) || 1;
    const rangeZ = (bounds.maxZ - bounds.minZ) || 1;
    const scale  = Math.min((W - PAD * 2) / rangeX, (H - PAD * 2 - 18) / rangeZ);

    const toSX = x => PAD + (x - bounds.minX) * scale;
    const toSY = z => PAD + (z - bounds.minZ) * scale;

    ctx.strokeStyle = '#334155'; ctx.lineWidth = 1;
    ctx.strokeRect(PAD, PAD, rangeX * scale, rangeZ * scale);

    const radius = bsTemplate ? bsTemplate.radius * scale : 20;

    // Draw sweep direction arrow hint
    ctx.strokeStyle = 'rgba(148,163,184,0.3)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(W - PAD - 5, PAD + 10);
    ctx.lineTo(PAD + 5, PAD + 10);
    ctx.stroke();
    ctx.setLineDash([]);

    placements.forEach((bs, i) => {
        const col = bs.isHeal ? '#f59e0b' : CC_PALETTE[i % CC_PALETTE.length];
        const cx  = toSX(bs.x);
        const cy  = toSY(bs.z);

        // Coverage circle
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.globalAlpha = 0.18;
        ctx.fillStyle   = col;
        ctx.fill();
        ctx.globalAlpha = 0.6;
        ctx.strokeStyle = col;
        ctx.lineWidth   = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;

        // BS dot
        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle   = col;
        ctx.fill();
        ctx.strokeStyle = 'white'; ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = 'white';
        ctx.font      = 'bold 7px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(bs.isHeal ? '★' : (i + 1), cx, cy + 2.5);
        ctx.textAlign = 'left';
    });

    // Coverage bar
    const barY = H - 16;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, barY, W, 16);
    const barW = (W - PAD * 2) * Math.min(1, covPct / 100);
    ctx.fillStyle = covPct >= 90 ? '#16a34a' : covPct >= 70 ? '#d97706' : '#ef4444';
    ctx.globalAlpha = 0.8;
    ctx.fillRect(PAD, barY + 2, barW, 12);
    ctx.globalAlpha = 1;
    ctx.fillStyle   = 'white';
    ctx.font        = 'bold 9px monospace';
    ctx.fillText(`Final Coverage: ${covPct.toFixed(1)}%  ·  ${placements.length} BSs placed`, PAD + 4, barY + 11);
}

// ── Apply results to Multi-Coverage tool ──────────────────────────
function ccApplyToMultiCoverage() {
    if (!ccResult) return;
    const { bsPositions, bsTemplate } = ccResult;

    // Clear existing BSs directly — bypass the confirm dialog
    bsMarkers.forEach(m => { if (m) scene.remove(m); });
    bsLabels.forEach(l  => { if (l) scene.remove(l); });
    baseStations   = [];
    bsMarkers      = [];
    bsLabels       = [];
    currentBSIndex = 0;

    // Add each contour-chain BS
    bsPositions.forEach((bs, i) => {
        baseStations.push({
            position:         new THREE.Vector3(bs.x, bsTemplate.txHeight, bs.z),
            txPower:          bsTemplate.txPower,
            frequency:        bsTemplate.frequency,
            txHeight:         bsTemplate.txHeight,
            radius:           bsTemplate.radius,
            environment:      bsTemplate.environment,
            antennaGain:      0,
            antennaAzimuth:   0,
            antennaBeamwidth: 360,
            name: bs.isHeal ? `Heal-${i + 1}` : `CC-${i + 1}`
        });
        const marker = createPointMarker(
            new THREE.Vector3(bs.x, bsTemplate.txHeight, bs.z),
            bs.isHeal ? 0xf59e0b : 0x3b82f6,
            `cc-bs-${i}`
        );
        bsMarkers.push(marker);
        bsLabels.push(null);
    });

    updateBSList();
    updateGridRange();

    // Switch to Multi-Coverage tool automatically
    const toolSelect = document.getElementById('tool-select');
    if (toolSelect) {
        toolSelect.value = 'multi-coverage';
        toolSelect.dispatchEvent(new Event('change'));
    }
}

// ── Export JSON ───────────────────────────────────────────────────
function ccExport() {
    if (!ccResult) return;
    const blob = new Blob([JSON.stringify(ccResult, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'contour-chain-result.json'; a.click();
    URL.revokeObjectURL(url);
}

// ========================================================================
// SINR AND FAIRNESS ANALYSIS FUNCTIONS
// ========================================================================

function setupSINREventListeners() {
    // SINR TX selection
    document.getElementById('select-sinr-tx-btn').addEventListener('click', function() {
        isSelectingSinrTx = true;
        this.textContent = 'Selecting SINR TX...';
        this.style.background = 'linear-gradient(135deg, #ed8936 0%, #dd6b20 100%)';
        showSelectionMode(true);
    });

    // SINR controls
    document.getElementById('sinr-tx-power').addEventListener('input', function() {
        document.getElementById('sinr-tx-power-value').textContent = this.value + ' dBm';
    });
    document.getElementById('sinr-tx-height').addEventListener('input', function() {
        document.getElementById('sinr-tx-height-value').textContent = this.value + ' m';
    });
    document.getElementById('sinr-frequency').addEventListener('input', function() {
        document.getElementById('sinr-frequency-value').textContent = this.value + ' MHz';
    });
    document.getElementById('sinr-noise-floor').addEventListener('input', function() {
        document.getElementById('sinr-noise-floor-value').textContent = this.value + ' dBm';
    });
    document.getElementById('sinr-interference').addEventListener('input', function() {
        document.getElementById('sinr-interference-value').textContent = this.value + ' dBm';
    });
    document.getElementById('sinr-radius').addEventListener('input', function() {
        document.getElementById('sinr-radius-value').textContent = this.value + ' m';
    });
    document.getElementById('sinr-resolution').addEventListener('input', function() {
        document.getElementById('sinr-resolution-value').textContent = this.value + ' m';
    });

    // SINR analysis buttons
    document.getElementById('analyze-sinr-btn').addEventListener('click', analyzeSINR);
    document.getElementById('reset-sinr-btn').addEventListener('click', resetSINRAnalysis);

    // Fairness bandwidth control
    document.getElementById('fairness-bandwidth').addEventListener('input', function() {
        document.getElementById('fairness-bandwidth-value').textContent = this.value + ' MHz';
    });

    // Fairness analysis button
    document.getElementById('analyze-fairness-btn').addEventListener('click', analyzeFairness);
}

function handleSINRClick(intersects) {
    if (isSelectingSinrTx && intersects.length > 0) {
        const point = intersects[0].point.clone();

        // Remove old marker if exists
        if (sinrTxMarker) {
            scene.remove(sinrTxMarker);
        }

        // Store position
        sinrTxPosition = point;

        // Create visual marker
        const markerGeometry = new THREE.ConeGeometry(5, 15, 8);
        const markerMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
        sinrTxMarker = new THREE.Mesh(markerGeometry, markerMaterial);
        sinrTxMarker.position.copy(point);
        sinrTxMarker.name = 'sinr-tx-marker';
        scene.add(sinrTxMarker);

        // Update UI
        document.getElementById('sinr-tx-coords').textContent =
            `(${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;

        // Reset button state
        const selectBtn = document.getElementById('select-sinr-tx-btn');
        selectBtn.textContent = 'Select Transmitter';
        selectBtn.style.background = '';

        isSelectingSinrTx = false;
        exitSelectionMode();
        markNeedsRender();
    }
}

async function analyzeSINR() {
    if (!sinrTxPosition) {
        alert('Please select SINR transmitter location first!');
        return;
    }

    const startTime = performance.now();

    const txPower      = parseFloat(document.getElementById('sinr-tx-power').value);
    const radius       = parseFloat(document.getElementById('sinr-radius').value);
    const resolution   = parseFloat(document.getElementById('sinr-resolution').value);
    const frequency    = parseFloat(document.getElementById('sinr-frequency').value);
    const txHeight     = parseFloat(document.getElementById('sinr-tx-height').value);
    const noiseFloor   = parseFloat(document.getElementById('sinr-noise-floor').value);
    const interference = parseFloat(document.getElementById('sinr-interference').value);
    const cellTiers    = parseInt(document.getElementById('sinr-cell-tiers').value);
    const environment  = document.getElementById('sinr-environment').value;

    // Clear previous visualization
    clearSINRVisualization();

    // Show progress overlay
    showProgressOverlay('SINR Analysis', 'Calculating Signal-to-Interference-plus-Noise Ratio...');

    try {
        const analysisData = {
            txPosition: sinrTxPosition,
            radius, resolution, frequency, txPower,
            noiseFloor, interference, txHeight, environment, cellTiers
        };

        currentAnalysisTask = { type: 'sinr-analysis', data: analysisData };

        const result = await workerManager.executeTask(
            'sinr-analysis',
            analysisData,
            (progress) => {
                updateProgress(progress.progress || 0,
                    `Processed ${(progress.processed||0).toLocaleString()} of ${(progress.total||0).toLocaleString()} points...`);
            }
        );

        const endTime = performance.now();
        const computeTime = ((endTime - startTime) / 1000).toFixed(2);

        // Store results
        sinrPoints = result.sinrPoints;
        sinrAnalysis = {
            txPosition: { ...sinrTxPosition },
            avgSinr: result.avgSinr,
            maxSinr: result.maxSinr,
            minSinr: result.minSinr,
            pointsAnalyzed: result.pointsAnalyzed,
            computeTime,
            environment
        };

        // Create visualization
        createSINRVisualization();

        // Update UI
        document.getElementById('sinr-stats').innerHTML = `
            <p><strong>Points Analyzed:</strong> ${result.pointsAnalyzed.toLocaleString()}</p>
            <p><strong>Compute Time:</strong> ${computeTime} seconds</p>
            <p><strong>Environment:</strong> ${environment.toUpperCase()}</p>
            <p><strong>Cell Tiers:</strong> ${cellTiers} (${cellTiers === 1 ? 6 : cellTiers === 3 ? 18 : 42} interfering cells)</p>
        `;

        document.getElementById('avg-sinr').innerHTML = `
            Average SINR: <strong style="color: ${getSINRColor(result.avgSinr)};">${result.avgSinr.toFixed(2)} dB</strong><br>
            Max SINR: <strong style="color: ${getSINRColor(result.maxSinr)};">${result.maxSinr.toFixed(2)} dB</strong><br>
            Min SINR: <strong style="color: ${getSINRColor(result.minSinr)};">${result.minSinr.toFixed(2)} dB</strong>
        `;

        document.getElementById('sinr-result').style.display = 'block';

        // Enable fairness analysis button
        document.getElementById('analyze-fairness-btn').disabled = false;

    } catch (error) {
        console.error('SINR analysis failed:', error);
        if (error.message !== 'Analysis cancelled') {
            alert('SINR analysis failed: ' + error.message);
        }
    } finally {
        hideProgressOverlay();
        currentAnalysisTask = null;
        currentTaskId = null;
    }
}

function getSINRColor(sinr) {
    if (sinr >= 20) return '#00ff00';
    if (sinr >= 10) return '#80ff00';
    if (sinr >= 0)  return '#ffff00';
    if (sinr >= -10) return '#ff8000';
    return '#ff0000';
}

function createSINRVisualization() {
    if (sinrPoints.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];

    sinrPoints.forEach(point => {
        positions.push(point.position.x, point.position.y, point.position.z);
        const color = new THREE.Color(getSINRColor(point.sinr));
        colors.push(color.r, color.g, color.b);
    });

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 3,
        vertexColors: true,
        transparent: true,
        opacity: 0.7
    });

    const pointCloud = new THREE.Points(geometry, material);
    pointCloud.name = 'sinr-point-cloud';
    scene.add(pointCloud);
}

function clearSINRVisualization() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.name && obj.name.includes('sinr')) {
            disposeObject(obj);
            scene.remove(obj);
        }
    }
    sinrPoints = [];
}

function resetSINRAnalysis() {
    if (sinrTxMarker) scene.remove(sinrTxMarker);

    sinrTxPosition = null;
    sinrTxMarker   = null;
    sinrPoints     = [];
    sinrAnalysis   = null;

    clearSINRVisualization();

    document.getElementById('sinr-tx-coords').textContent = 'Not selected';
    document.getElementById('sinr-result').style.display = 'none';

    // Reset to default values
    document.getElementById('sinr-tx-power').value             = 20;
    document.getElementById('sinr-tx-power-value').textContent = '20 dBm';
    document.getElementById('sinr-tx-height').value            = 25;
    document.getElementById('sinr-tx-height-value').textContent= '25 m';
    document.getElementById('sinr-frequency').value            = 2400;
    document.getElementById('sinr-frequency-value').textContent= '2400 MHz';
    document.getElementById('sinr-noise-floor').value          = -95;
    document.getElementById('sinr-noise-floor-value').textContent = '-95 dBm';
    document.getElementById('sinr-interference').value         = -90;
    document.getElementById('sinr-interference-value').textContent = '-90 dBm';
    document.getElementById('sinr-radius').value               = 100;
    document.getElementById('sinr-radius-value').textContent   = '100 m';
    document.getElementById('sinr-resolution').value           = 5;
    document.getElementById('sinr-resolution-value').textContent = '5 m';
    document.getElementById('sinr-cell-tiers').value           = 3;
    document.getElementById('sinr-environment').value          = 'uma-los';

    // Disable fairness analysis button
    document.getElementById('analyze-fairness-btn').disabled = true;

    exitSelectionMode();
}

// ========================================================================
// FAIRNESS ANALYSIS FUNCTIONS
// ========================================================================

async function analyzeFairness() {
    if (!sinrPoints || sinrPoints.length === 0) {
        alert('Please run SINR analysis first to generate required data!');
        return;
    }

    const startTime = performance.now();
    const totalBandwidth = parseFloat(document.getElementById('fairness-bandwidth').value);

    showProgressOverlay('Fairness Analysis', 'Calculating network fairness metrics...');

    try {
        const analysisData = { sinrPoints, totalBandwidth };

        const result = await workerManager.executeTask(
            'fairness-analysis',
            analysisData,
            (progress) => {
                updateProgress(progress.progress || 0,
                    `Processed ${(progress.processed||0).toLocaleString()} of ${(progress.total||0).toLocaleString()} points...`);
            }
        );

        const endTime = performance.now();
        const computeTime = ((endTime - startTime) / 1000).toFixed(2);

        fairnessAnalysis = { ...result, computeTime };

        createFairnessVisualization(result);

        // Update UI results
        document.getElementById('fairness-index').textContent = result.fairnessValue.toFixed(4);
        document.getElementById('fairness-index').style.color =
            result.fairnessValue >= 0.8 ? '#16a34a' : result.fairnessValue >= 0.6 ? '#f59e0b' : '#ef4444';

        document.getElementById('fairness-avg-throughput').textContent = result.avgThroughput.toFixed(2);
        document.getElementById('fairness-min-throughput').textContent = result.minThroughput.toFixed(2);
        document.getElementById('fairness-p5-throughput').textContent  = result.p5Throughput.toFixed(2);
        document.getElementById('fairness-congested').textContent      = `${result.congestedPercent.toFixed(1)}%`;
        document.getElementById('fairness-critical').textContent       = result.criticalCount;
        document.getElementById('fairness-efficiency').textContent     = result.efficiencyScore;
        document.getElementById('fairness-efficiency').style.color =
            result.efficiencyScore >= 70 ? '#16a34a' : result.efficiencyScore >= 40 ? '#f59e0b' : '#ef4444';

        document.getElementById('fairness-insight').textContent = result.insightText;

        // Load distribution
        document.getElementById('fairness-underloaded').textContent = result.stats.underloaded;
        document.getElementById('fairness-balanced').textContent    = result.stats.balanced;
        document.getElementById('fairness-overloaded').textContent  = result.stats.overloaded;

        // User satisfaction
        document.getElementById('fairness-good').textContent     = result.satisfaction.good;
        document.getElementById('fairness-moderate').textContent  = result.satisfaction.moderate;
        document.getElementById('fairness-poor').textContent     = result.satisfaction.poor;

        document.getElementById('fairness-result').style.display = 'block';

    } catch (error) {
        console.error('Fairness analysis failed:', error);
        if (error.message !== 'Analysis cancelled') {
            alert('Fairness analysis failed: ' + error.message);
        }
    } finally {
        hideProgressOverlay();
        currentAnalysisTask = null;
        currentTaskId = null;
    }
}

function createFairnessVisualization(result) {
    clearFairnessVisualization();

    if (!result.throughputMap || result.throughputMap.length === 0) return;

    const geometry = new THREE.BufferGeometry();
    const positions = [];
    const colors = [];

    result.throughputMap.forEach(point => {
        positions.push(point.position.x, point.position.y, point.position.z);

        let color;
        if (point.congested) {
            color = new THREE.Color(0xff0000);
        } else if (point.throughput >= 8) {
            color = new THREE.Color(0x00ff00);
        } else if (point.throughput >= 4) {
            color = new THREE.Color(0xffff00);
        } else {
            color = new THREE.Color(0xff8000);
        }

        colors.push(color.r, color.g, color.b);
    });

    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color',    new THREE.Float32BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 4,
        vertexColors: true,
        transparent: true,
        opacity: 0.8
    });

    const pointCloud = new THREE.Points(geometry, material);
    pointCloud.name = 'fairness-point-cloud';
    scene.add(pointCloud);
}

function clearFairnessVisualization() {
    for (let i = scene.children.length - 1; i >= 0; i--) {
        const obj = scene.children[i];
        if (obj.name && obj.name.includes('fairness')) {
            disposeObject(obj);
            scene.remove(obj);
        }
    }
}




// Interactive Mode – initialisation (actual code moved to interactive-mode.js)
function initInteractiveMode() {
    // Called when tool is selected
    if (typeof window.setupInteractiveMode === 'function') {
        window.setupInteractiveMode(scene, camera, controls, renderer);
    } else {
        console.error('Interactive mode script not loaded');
    }
}