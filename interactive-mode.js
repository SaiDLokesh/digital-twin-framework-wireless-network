// interactive-mode.js – Full interactive mode with contour chain modal

(function() {
    let scene, camera, controls, renderer;
    let interactiveModeActive = false;
    let statusDiv = null;
    let ccRunning = false;
    let currentTaskId = null;           // to cancel worker task
    let currentModal = null;

    let interactiveObjects = {
        baseStations: [],
        buildings: [],
        crowds: []
    };
    let nextId = 1;
    let coverageHistory = [];

    const BUILDING_MATERIALS = {
        concrete: { color: 0xaaaaaa, loss: 15.0 },
        brick:    { color: 0xaa8866, loss: 12.0 },
        glass:    { color: 0x88ccff, loss: 2.5 },
        wood:     { color: 0xc9a87c, loss: 6.0 },
        metal:    { color: 0x888888, loss: 40.0 }
    };
    window.BUILDING_MATERIALS = BUILDING_MATERIALS;

    function setStatus(msg) {
        if (statusDiv) statusDiv.innerHTML = `ℹ️ ${msg}`;
    }

    function getIntersectionPoint(event) {
        const rect = renderer.domElement.getBoundingClientRect();
        const mouse = new THREE.Vector2();
        mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);
        const intersects = raycaster.intersectObjects(scene.children, true);
        if (intersects.length) return intersects[0].point;
        return null;
    }

    function syncGlobalBS() {
        window.baseStations = [];
        interactiveObjects.baseStations.forEach(bs => {
            window.baseStations.push({
                name: bs.name,
                position: new THREE.Vector3(bs.position.x, bs.position.y, bs.position.z),
                txPower: bs.txPower,
                frequency: bs.frequency,
                txHeight: bs.txHeight,
                radius: bs.radius,
                environment: bs.environment,
                antennaAzimuth: bs.antennaAzimuth,
                antennaBeamwidth: bs.antennaBeamwidth,
                antennaGain: bs.antennaGain,
                rayTracingEnabled: false,
                index: window.baseStations.length
            });
        });
        if (typeof updateBSList === 'function') updateBSList();
        if (typeof updateGridRange === 'function') updateGridRange();
    }

    const FALLBACK_MATERIAL_LOSSES = {
        glass: 2.5, wood: 6.0, drywall: 4.0, brick: 12.0,
        concrete: 15.0, concrete_slab: 25.0, metal: 40.0,
        plaster: 8.0, composite: 15.0, unknown: 12.0
    };
    const FALLBACK_FREQ_FACTORS = {
        900: 0.9, 1800: 1.0, 2400: 1.2, 3500: 1.4, 5800: 1.8, 28000: 3.0
    };

    function rebuildBuildingData() {
        const toPlain = v => ({ x: v.x, y: v.y, z: v.z });
        const normaliseBB = (hb) => ({
            ...hb,
            boundingBox: {
                min: toPlain(hb.boundingBox.min),
                max: toPlain(hb.boundingBox.max)
            },
            innerBoundingBox: {
                min: toPlain(hb.innerBoundingBox.min),
                max: toPlain(hb.innerBoundingBox.max)
            }
        });

        // Scene buildings (from loaded 3D model) 
        const original = (window.buildingDetection && window.buildingDetection.hollowBuildings)
            ? window.buildingDetection.hollowBuildings.map(normaliseBB)
            : [];

        // User-placed buildings 
        const custom = interactiveObjects.buildings.map(b => normaliseBB(b.hollowBuilding));

        const all = [...original, ...custom];

        const data = {
            buildings: all,
            parameters: {
                wallThickness: 0.15,
                floorHeight: 3.0,
                materialLosses:   (window.buildingDetection && window.buildingDetection.materialLosses)
                                    || FALLBACK_MATERIAL_LOSSES,
                frequencyFactors: (window.buildingDetection && window.buildingDetection.frequencyFactors)
                                    || FALLBACK_FREQ_FACTORS
            }
        };

        if (window.workerManager) {
            window.workerManager.setBuildingData(data);
        }
        return data;
    }

    function refreshObjectList() {
        const container = document.getElementById('int-object-list');
        if (!container) return;
        let html = '';
        interactiveObjects.baseStations.forEach(bs => {
            html += `<div data-id="${bs.id}" data-type="bs" style="display:flex; justify-content:space-between; align-items:center; padding:4px 8px; border-bottom:1px solid #e2e8f0;">
                        <span>📡 ${bs.name} @ (${bs.position.x.toFixed(0)},${bs.position.z.toFixed(0)})</span>
                        <button class="int-edit-btn" data-id="${bs.id}" data-type="bs" style="padding:2px 6px; font-size:10px;">✏️ Edit</button>
                     </div>`;
        });
        interactiveObjects.buildings.forEach(b => {
            html += `<div data-id="${b.id}" data-type="building" style="display:flex; justify-content:space-between; align-items:center; padding:4px 8px; border-bottom:1px solid #e2e8f0;">
                        <span>🏢 ${b.materialType} (${b.hollowBuilding.outerSize.x.toFixed(0)}x${b.hollowBuilding.outerSize.z.toFixed(0)}m)</span>
                        <button class="int-edit-btn" data-id="${b.id}" data-type="building" style="padding:2px 6px; font-size:10px;">✏️ Edit</button>
                     </div>`;
        });
        interactiveObjects.crowds.forEach(c => {
            html += `<div data-id="${c.id}" data-type="crowd" style="display:flex; justify-content:space-between; align-items:center; padding:4px 8px; border-bottom:1px solid #e2e8f0;">
                        <span>👥 Crowd r=${c.radius}m, ${c.density}p/m²</span>
                        <button class="int-edit-btn" data-id="${c.id}" data-type="crowd" style="padding:2px 6px; font-size:10px;">✏️ Edit</button>
                     </div>`;
        });
        if (!html) html = '(no objects)';
        container.innerHTML = html;
        document.querySelectorAll('.int-edit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const id = parseInt(btn.dataset.id);
                const type = btn.dataset.type;
                let obj = null;
                if (type === 'bs') obj = interactiveObjects.baseStations.find(o => o.id === id);
                else if (type === 'building') obj = interactiveObjects.buildings.find(o => o.id === id);
                else if (type === 'crowd') obj = interactiveObjects.crowds.find(o => o.id === id);
                if (obj) showEditPanel(obj, type);
            });
        });
    }

    function showEditPanel(obj, type) {
        const panel   = document.getElementById('int-edit-panel');
        const content = document.getElementById('int-edit-content');
        const delBtn  = document.getElementById('int-edit-delete');
        const closeBtn= document.getElementById('int-edit-close');
        if (!panel || !content) return;

        // Hide add-panels so they don't overlap
        ['int-add-bs-panel','int-add-building-panel','int-add-crowd-panel'].forEach(id => {
            const el = document.getElementById(id); if (el) el.style.display = 'none';
        });

        let html = '';
        if (type === 'bs') {
            html = `
            <div class="control-group"><label>Name:</label>
              <input type="text" id="ep-bs-name" value="${obj.name}" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;"></div>
            <div class="control-group"><label>Tx Power (dBm):</label>
              <input type="range" id="ep-bs-txpower" min="20" max="50" step="1" value="${obj.txPower}">
              <span id="ep-bs-txpower-val">${obj.txPower}</span> dBm</div>
            <div class="control-group"><label>Frequency (MHz):</label>
              <input type="range" id="ep-bs-freq" min="700" max="3500" step="100" value="${obj.frequency}">
              <span id="ep-bs-freq-val">${obj.frequency}</span> MHz</div>
            <div class="control-group"><label>Height (m):</label>
              <input type="range" id="ep-bs-height" min="5" max="50" step="1" value="${obj.txHeight}">
              <span id="ep-bs-height-val">${obj.txHeight}</span> m</div>
            <div class="control-group"><label>Radius (m):</label>
              <input type="range" id="ep-bs-radius" min="50" max="500" step="10" value="${obj.radius}">
              <span id="ep-bs-radius-val">${obj.radius}</span> m</div>
            <div class="control-group"><label>Environment:</label>
              <select id="ep-bs-env" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;">
                <option value="uma-los" ${obj.environment==='uma-los'?'selected':''}>UMa LOS</option>
                <option value="uma-nlos" ${obj.environment==='uma-nlos'?'selected':''}>UMa NLOS</option>
                <option value="umi-los" ${obj.environment==='umi-los'?'selected':''}>UMi LOS</option>
                <option value="umi-nlos" ${obj.environment==='umi-nlos'?'selected':''}>UMi NLOS</option>
              </select></div>
            <div class="control-group"><label>Azimuth (°):</label>
              <input type="range" id="ep-bs-azimuth" min="0" max="360" step="1" value="${obj.antennaAzimuth}">
              <span id="ep-bs-azimuth-val">${obj.antennaAzimuth}</span>°</div>
            <div class="control-group"><label>Beamwidth (°):</label>
              <select id="ep-bs-beamwidth" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;">
                <option value="360" ${obj.antennaBeamwidth==360?'selected':''}>Omni (360°)</option>
                <option value="120" ${obj.antennaBeamwidth==120?'selected':''}>120°</option>
                <option value="90"  ${obj.antennaBeamwidth==90?'selected':''}>90°</option>
              </select></div>
            <div class="control-group"><label>Gain (dBi):</label>
              <input type="range" id="ep-bs-gain" min="0" max="30" step="1" value="${obj.antennaGain}">
              <span id="ep-bs-gain-val">${obj.antennaGain}</span> dBi</div>
            <button id="ep-bs-save" class="btn btn-primary" style="width:100%;margin-top:6px;">💾 Save Changes</button>`;
        } else if (type === 'building') {
            html = `
            <div class="control-group"><label>Material:</label>
              <select id="ep-bld-material" style="width:100%;padding:6px;border-radius:6px;border:1px solid #ddd;">
                <option value="concrete" ${obj.materialType==='concrete'?'selected':''}>Concrete (15 dB/m)</option>
                <option value="brick"    ${obj.materialType==='brick'?'selected':''}>Brick (12 dB/m)</option>
                <option value="glass"    ${obj.materialType==='glass'?'selected':''}>Glass (2.5 dB/m)</option>
                <option value="wood"     ${obj.materialType==='wood'?'selected':''}>Wood (6 dB/m)</option>
                <option value="metal"    ${obj.materialType==='metal'?'selected':''}>Metal (40 dB/m)</option>
              </select></div>
            <p style="font-size:11px;color:#64748b;margin:4px 0;">
              Size: ${obj.hollowBuilding.outerSize.x.toFixed(0)}×${obj.hollowBuilding.outerSize.z.toFixed(0)}×${obj.hollowBuilding.outerSize.y.toFixed(0)} m
            </p>
            <button id="ep-bld-save" class="btn btn-primary" style="width:100%;margin-top:6px;">💾 Save Changes</button>`;
        } else if (type === 'crowd') {
            html = `
            <div class="control-group"><label>Radius (m):</label>
              <input type="range" id="ep-crowd-radius" min="10" max="100" step="5" value="${obj.radius}">
              <span id="ep-crowd-radius-val">${obj.radius}</span> m</div>
            <div class="control-group"><label>Peak Density (p/m²):</label>
              <input type="range" id="ep-crowd-density" min="0.2" max="5" step="0.1" value="${obj.density}">
              <span id="ep-crowd-density-val">${obj.density}</span> p/m²</div>
            <button id="ep-crowd-save" class="btn btn-primary" style="width:100%;margin-top:6px;">💾 Save Changes</button>`;
        }
        content.innerHTML = html;

        // Live slider labels
        const wire = (sliderId, valId) => {
            const s = document.getElementById(sliderId);
            const v = document.getElementById(valId);
            if (s && v) s.oninput = () => v.innerText = s.value;
        };
        if (type === 'bs') {
            wire('ep-bs-txpower','ep-bs-txpower-val'); wire('ep-bs-freq','ep-bs-freq-val');
            wire('ep-bs-height','ep-bs-height-val');   wire('ep-bs-radius','ep-bs-radius-val');
            wire('ep-bs-azimuth','ep-bs-azimuth-val'); wire('ep-bs-gain','ep-bs-gain-val');
            document.getElementById('ep-bs-save').onclick = () => {
                obj.name             = document.getElementById('ep-bs-name').value;
                obj.txPower          = parseFloat(document.getElementById('ep-bs-txpower').value);
                obj.frequency        = parseFloat(document.getElementById('ep-bs-freq').value);
                obj.txHeight         = parseFloat(document.getElementById('ep-bs-height').value);
                obj.radius           = parseFloat(document.getElementById('ep-bs-radius').value);
                obj.environment      = document.getElementById('ep-bs-env').value;
                obj.antennaAzimuth   = parseFloat(document.getElementById('ep-bs-azimuth').value);
                obj.antennaBeamwidth = parseFloat(document.getElementById('ep-bs-beamwidth').value);
                obj.antennaGain      = parseFloat(document.getElementById('ep-bs-gain').value);
                obj.position.y       = obj.txHeight;
                syncGlobalBS(); refreshObjectList();
                setStatus(`BS "${obj.name}" updated.`);
                panel.style.display = 'none';
            };
        } else if (type === 'building') {
            wire('ep-bld-material', null);
            document.getElementById('ep-bld-save').onclick = () => {
                const mat   = document.getElementById('ep-bld-material').value;
                const matDef = BUILDING_MATERIALS[mat] || BUILDING_MATERIALS.concrete;
                obj.materialType = mat;
                obj.hollowBuilding.materialType = mat;
                if (obj.mesh && obj.mesh.material) obj.mesh.material.color.setHex(matDef.color);
                rebuildBuildingData(); refreshObjectList();
                setStatus('Building material updated.');
                panel.style.display = 'none';
            };
        } else if (type === 'crowd') {
            wire('ep-crowd-radius','ep-crowd-radius-val');
            wire('ep-crowd-density','ep-crowd-density-val');
            document.getElementById('ep-crowd-save').onclick = () => {
                obj.radius  = parseFloat(document.getElementById('ep-crowd-radius').value);
                obj.density = parseFloat(document.getElementById('ep-crowd-density').value);
                // Resize ring visual
                if (obj.centerMarker) {
                    scene.remove(obj.centerMarker);
                    const ring = new THREE.Mesh(
                        new THREE.RingGeometry(obj.radius-0.5, obj.radius+0.5, 32),
                        new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide, transparent: true, opacity: 0.6 })
                    );
                    ring.rotation.x = -Math.PI/2;
                    ring.position.set(obj.centerPos.x, obj.centerPos.y+0.2, obj.centerPos.z);
                    scene.add(ring);
                    obj.centerMarker = ring;
                }
                refreshObjectList();
                setStatus('Crowd updated.');
                panel.style.display = 'none';
            };
        }

        // Delete button
        if (delBtn) delBtn.onclick = () => {
            deleteObject(obj, type);
            panel.style.display = 'none';
        };
        if (closeBtn) closeBtn.onclick = () => { panel.style.display = 'none'; };

        panel.style.display = 'block';
    }

    function deleteObject(obj, type) {
        if (type === 'bs') {
            scene.remove(obj.marker);
            if (obj.label) scene.remove(obj.label);
            interactiveObjects.baseStations = interactiveObjects.baseStations.filter(b => b.id !== obj.id);
            syncGlobalBS();
        } else if (type === 'building') {
            scene.remove(obj.mesh);
            interactiveObjects.buildings = interactiveObjects.buildings.filter(b => b.id !== obj.id);
            rebuildBuildingData();
        } else if (type === 'crowd') {
            scene.remove(obj.centerMarker);
            interactiveObjects.crowds = interactiveObjects.crowds.filter(c => c.id !== obj.id);
        }
        refreshObjectList();
        setStatus(`${type} deleted.`);
    }

    function createBSTowerIcon(pos, name, colorHex = 0x3b82f6) {
        const group = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.6, 18, 8), new THREE.MeshPhongMaterial({ color: 0x888888 }));
        pole.position.y = 9;
        group.add(pole);
        const bar = new THREE.Mesh(new THREE.BoxGeometry(8, 0.5, 0.5), new THREE.MeshPhongMaterial({ color: 0x666666 }));
        bar.position.y = 17;
        group.add(bar);
        [-3, 0, 3].forEach(xo => {
            const ant = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4, 0.3), new THREE.MeshPhongMaterial({ color: colorHex, emissive: colorHex, emissiveIntensity: 0.4 }));
            ant.position.set(xo, 17, 1);
            group.add(ant);
        });
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.8, 12, 12), new THREE.MeshBasicMaterial({ color: colorHex }));
        tip.position.y = 19;
        group.add(tip);
        const canvas = document.createElement('canvas');
        canvas.width = 200; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'rgba(20,20,40,0.85)';
        ctx.roundRect(0, 0, 200, 64, 8);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 20px Arial';
        ctx.textAlign = 'center';
        ctx.fillText(name, 100, 30);
        ctx.font = '14px Arial';
        ctx.fillStyle = '#aaaaff';
        ctx.fillText(`(${pos.x.toFixed(0)},${pos.z.toFixed(0)})`, 100, 52);
        const texture = new THREE.CanvasTexture(canvas);
        const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true }));
        sprite.scale.set(20, 6.4, 1);
        sprite.position.y = 25;
        group.add(sprite);
        group.position.set(pos.x, pos.y + (pos.y === 0 ? 0 : 0), pos.z);
        scene.add(group);
        return { marker: group, label: sprite };
    }

    // ------------------------------------------------------------------
    // Add BS, building, crowd (unchanged, keep your original logic)
    // ------------------------------------------------------------------
    function startAddBS() {
        const panel = document.getElementById('int-add-bs-panel');
        panel.style.display = 'block';
        document.getElementById('int-bs-name').value = `BS-${interactiveObjects.baseStations.length + 1}`;
        const upd = (id, valId) => { document.getElementById(id).oninput = () => document.getElementById(valId).innerText = document.getElementById(id).value; };
        upd('int-bs-txpower', 'int-bs-txpower-val');
        upd('int-bs-freq', 'int-bs-freq-val');
        upd('int-bs-height', 'int-bs-height-val');
        upd('int-bs-radius', 'int-bs-radius-val');
        upd('int-bs-azimuth', 'int-bs-azimuth-val');
        upd('int-bs-gain', 'int-bs-gain-val');

        document.getElementById('int-bs-confirm').onclick = () => {
            const name = document.getElementById('int-bs-name').value;
            const config = {
                name, txPower: parseFloat(document.getElementById('int-bs-txpower').value),
                frequency: parseFloat(document.getElementById('int-bs-freq').value),
                txHeight: parseFloat(document.getElementById('int-bs-height').value),
                radius: parseFloat(document.getElementById('int-bs-radius').value),
                environment: document.getElementById('int-bs-env').value,
                antennaAzimuth: parseFloat(document.getElementById('int-bs-azimuth').value),
                antennaBeamwidth: parseFloat(document.getElementById('int-bs-beamwidth').value),
                antennaGain: parseFloat(document.getElementById('int-bs-gain').value)
            };
            panel.style.display = 'none';
            setStatus('Click on the map to place the base station.');
            const onClick = (event) => {
                const pos = getIntersectionPoint(event);
                if (pos) {
                    renderer.domElement.removeEventListener('click', onClick);
                    const id = nextId++;
                    const { marker, label } = createBSTowerIcon(pos, config.name);
                    interactiveObjects.baseStations.push({
                        id, name: config.name, position: { x: pos.x, y: config.txHeight, z: pos.z },
                        marker, label, ...config
                    });
                    syncGlobalBS();
                    refreshObjectList();
                    setStatus(`Base station "${config.name}" placed.`);
                }
            };
            renderer.domElement.addEventListener('click', onClick);
        };
        document.getElementById('int-bs-cancel').onclick = () => { panel.style.display = 'none'; setStatus('BS placement cancelled.'); };
    }

    function startAddBuilding() {
        const panel = document.getElementById('int-add-building-panel');
        panel.style.display = 'block';
        document.getElementById('int-bld-confirm').onclick = () => {
            const w = parseFloat(document.getElementById('int-bld-width').value);
            const d = parseFloat(document.getElementById('int-bld-depth').value);
            const h = parseFloat(document.getElementById('int-bld-height').value);
            const mat = document.getElementById('int-bld-material').value;
            panel.style.display = 'none';
            setStatus('Click on the map to place the building.');
            const onClick = (event) => {
                const pos = getIntersectionPoint(event);
                if (pos) {
                    renderer.domElement.removeEventListener('click', onClick);
                    const id = nextId++;
                    const color = BUILDING_MATERIALS[mat] ? BUILDING_MATERIALS[mat].color : 0xaa8866;
                    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshPhongMaterial({ color: color, transparent: true, opacity: 0.8 }));
                    mesh.position.set(pos.x, pos.y + h / 2, pos.z);
                    scene.add(mesh);
                    const bb = new THREE.Box3().setFromObject(mesh);
                    const center = bb.getCenter(new THREE.Vector3());
                    const hollowBuilding = {
                        name: `Custom_${id}`, center: { x: center.x, y: center.y, z: center.z },
                        outerSize: { x: w, y: h, z: d }, innerSize: { x: w * 0.8, y: h * 0.8, z: d * 0.8 },
                        wallThickness: 0.3, floors: Math.floor(h / 3), floorHeight: 3,
                        materialType: mat,
                        boundingBox: { min: bb.min, max: bb.max }, innerBoundingBox: { min: bb.min, max: bb.max }
                    };
                    interactiveObjects.buildings.push({ id, mesh, hollowBuilding, materialType: mat });
                    rebuildBuildingData();
                    refreshObjectList();
                    setStatus(`Building (${w}x${d}x${h}m, ${mat}) placed.`);
                }
            };
            renderer.domElement.addEventListener('click', onClick);
        };
        document.getElementById('int-bld-cancel').onclick = () => { panel.style.display = 'none'; setStatus('Building placement cancelled.'); };
    }

    function startAddCrowd() {
        const panel = document.getElementById('int-add-crowd-panel');
        panel.style.display = 'block';
        const rSl = document.getElementById('int-crowd-radius');
        const dSl = document.getElementById('int-crowd-density');
        rSl.oninput = () => document.getElementById('int-crowd-radius-val').innerText = rSl.value;
        dSl.oninput = () => document.getElementById('int-crowd-density-val').innerText = dSl.value;
        document.getElementById('int-crowd-confirm').onclick = () => {
            const radius = parseFloat(rSl.value);
            const density = parseFloat(dSl.value);
            panel.style.display = 'none';
            setStatus('Click on the map to set crowd center.');
            const onClick = (event) => {
                const pos = getIntersectionPoint(event);
                if (pos) {
                    renderer.domElement.removeEventListener('click', onClick);
                    const id = nextId++;
                    const ringGeo = new THREE.RingGeometry(radius - 0.5, radius + 0.5, 32);
                    const ringMat = new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide, transparent: true, opacity: 0.6 });
                    const ring = new THREE.Mesh(ringGeo, ringMat);
                    ring.rotation.x = -Math.PI / 2;
                    ring.position.set(pos.x, pos.y + 0.2, pos.z);
                    scene.add(ring);
                    interactiveObjects.crowds.push({
                        id, centerMarker: ring, radius, density,
                        centerPos: { x: pos.x, y: pos.y, z: pos.z }
                    });
                    refreshObjectList();
                    setStatus(`Crowd (r=${radius}m, density=${density}) placed.`);
                }
            };
            renderer.domElement.addEventListener('click', onClick);
        };
        document.getElementById('int-crowd-cancel').onclick = () => { panel.style.display = 'none'; setStatus('Crowd placement cancelled.'); };
    }

    function initDragSupport() {
        const raycaster = new THREE.Raycaster();
        let dragObj = null, dragType = null, offset = new THREE.Vector3();
        renderer.domElement.addEventListener('mousedown', (e) => {
            if (!interactiveModeActive) return;
            const mouse = new THREE.Vector2();
            mouse.x = (e.clientX / renderer.domElement.clientWidth) * 2 - 1;
            mouse.y = -(e.clientY / renderer.domElement.clientHeight) * 2 + 1;
            raycaster.setFromCamera(mouse, camera);
            let intersects = raycaster.intersectObjects(interactiveObjects.baseStations.map(b => b.marker));
            if (intersects.length) { dragObj = interactiveObjects.baseStations.find(b => b.marker === intersects[0].object); dragType = 'bs'; }
            else {
                intersects = raycaster.intersectObjects(interactiveObjects.buildings.map(b => b.mesh));
                if (intersects.length) { dragObj = interactiveObjects.buildings.find(b => b.mesh === intersects[0].object); dragType = 'building'; }
                else {
                    intersects = raycaster.intersectObjects(interactiveObjects.crowds.map(c => c.centerMarker));
                    if (intersects.length) { dragObj = interactiveObjects.crowds.find(c => c.centerMarker === intersects[0].object); dragType = 'crowd'; }
                }
            }
            if (dragObj) {
                e.preventDefault();
                const point = intersects[0].point;
                const objPos = dragObj.position || dragObj.centerPos || dragObj.mesh.position;
                offset.copy(point).sub(objPos);
                const onMove = (me) => {
                    const mouse2 = new THREE.Vector2();
                    mouse2.x = (me.clientX / renderer.domElement.clientWidth) * 2 - 1;
                    mouse2.y = -(me.clientY / renderer.domElement.clientHeight) * 2 + 1;
                    raycaster.setFromCamera(mouse2, camera);
                    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
                    const target = new THREE.Vector3();
                    if (raycaster.ray.intersectPlane(plane, target)) {
                        target.sub(offset);
                        if (dragType === 'bs') {
                            dragObj.position.x = target.x; dragObj.position.z = target.z;
                            dragObj.marker.position.copy(dragObj.position);
                            if (dragObj.label) dragObj.label.position.copy(dragObj.position).add(new THREE.Vector3(0, 15, 0));
                            syncGlobalBS();
                        } else if (dragType === 'building') {
                            dragObj.mesh.position.x = target.x; dragObj.mesh.position.z = target.z;
                            dragObj.hollowBuilding.center.x = target.x; dragObj.hollowBuilding.center.z = target.z;
                            rebuildBuildingData();
                        } else if (dragType === 'crowd') {
                            dragObj.centerPos.x = target.x; dragObj.centerPos.z = target.z;
                            dragObj.centerMarker.position.copy(dragObj.centerPos);
                        }
                        refreshObjectList();
                    }
                };
                const onUp = () => {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                };
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            }
        });
    }

    // ------------------------------------------------------------------
    // RSSI ANALYSIS (with history)
    // ------------------------------------------------------------------
    async function analyzeRSSI() {
        if (interactiveObjects.baseStations.length === 0) {
            setStatus('No base stations placed.');
            return;
        }
        if (!window.workerManager) {
            setStatus('Worker manager not available.');
            return;
        }
        if (!window.workerManager.workers.has('multi-coverage-analysis')) {
            window.workerManager.createWorker('multi-coverage-analysis', 'multi-coverage-worker.js');
        }

        const minRSSI   = parseFloat(document.getElementById('int-min-rssi').value) || -120;
        const fullMap   = document.getElementById('int-full-map-analysis').checked;
        let gridParams;
        let useIgnoreRadius = false;

        if (fullMap) {
            const bounds = (typeof getMapBounds === 'function')
                ? getMapBounds()
                : { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };
            const pad = 30;
            const maxBSHeight = interactiveObjects.baseStations.reduce((m, bs) => Math.max(m, (bs.txHeight || 25) + 5), 40);
            gridParams = {
                minX: bounds.minX - pad, maxX: bounds.maxX + pad,
                minY: 1.5,
                maxY: Math.min(maxBSHeight, 120),
                minZ: bounds.minZ - pad, maxZ: bounds.maxZ + pad,
                resolution: 8
            };
            useIgnoreRadius = true;
        } else {
            const resolution = 8;
            let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
            let maxBSH = 40;
            interactiveObjects.baseStations.forEach(bs => {
                const r = bs.radius || 200;
                minX = Math.min(minX, bs.position.x - r);
                maxX = Math.max(maxX, bs.position.x + r);
                minZ = Math.min(minZ, bs.position.z - r);
                maxZ = Math.max(maxZ, bs.position.z + r);
                maxBSH = Math.max(maxBSH, (bs.txHeight || 25) + 5);
            });
            if (!isFinite(minX)) { minX = -200; maxX = 200; minZ = -200; maxZ = 200; }
            gridParams = { minX, maxX, minY: 1.5, maxY: Math.min(maxBSH, 120), minZ, maxZ, resolution };
        }

        if (gridParams.maxX - gridParams.minX < 1 || gridParams.maxZ - gridParams.minZ < 1) {
            console.warn('Invalid grid bounds, using expanded defaults');
            gridParams.minX = -200; gridParams.maxX = 200;
            gridParams.minZ = -200; gridParams.maxZ = 200;
        }

        const gridDiag = Math.hypot(gridParams.maxX - gridParams.minX, gridParams.maxZ - gridParams.minZ);
        const bsData = interactiveObjects.baseStations.map((bs, idx) => ({
            name: bs.name,
            position: { x: bs.position.x, y: bs.position.y, z: bs.position.z },
            txPower: bs.txPower,
            frequency: bs.frequency,
            txHeight: bs.txHeight,
            radius: useIgnoreRadius ? gridDiag : bs.radius,
            environment: bs.environment,
            antennaAzimuth: bs.antennaAzimuth,
            antennaBeamwidth: bs.antennaBeamwidth,
            antennaGain: bs.antennaGain,
            rayTracingEnabled: false,
            index: idx
        }));

        if (typeof showProgressOverlay === 'function') showProgressOverlay('Interactive RSSI Analysis', 'Computing coverage map...');
        try {
            // Build crowd data in the format the worker expects
            const crowdDataForWorker = interactiveObjects.crowds.map(c => ({
                center: { x: c.centerPos.x, z: c.centerPos.z },
                radius: c.radius,
                density: c.density
            }));

            const result = await window.workerManager.executeTask(
                'multi-coverage-analysis',
                { baseStations: bsData, gridParams, minSignal: minRSSI, ignoreRadius: useIgnoreRadius, crowdData: crowdDataForWorker },
                (p) => { if (typeof updateProgress === 'function') updateProgress(p.progress || 0, `Points: ${(p.processed||0).toLocaleString()} / ${(p.total||0).toLocaleString()}`); }
            );

            const points = [];
            const positions = result.positions;
            const signals = result.signals;
            for (let i = 0; i < result.pointCount; i++) {
                const x = positions[i*3], y = positions[i*3+1], z = positions[i*3+2];
                const rssi = signals[i];
                // Crowd loss is now applied inside the worker — no post-processing needed
                if (rssi >= minRSSI) points.push({ position: new THREE.Vector3(x, y, z), signalStrength: rssi });
            }

            if (typeof clearMultiCoverageVisualization === 'function') clearMultiCoverageVisualization();
            if (typeof createInteractiveHeatmap === 'function') createInteractiveHeatmap(points, minRSSI);
            else if (typeof createMultiCoverageVisualization === 'function') createMultiCoverageVisualization(points);

            const covPct = result.totalPoints > 0 ? (points.length / result.totalPoints * 100).toFixed(1) : '0.0';
            const avgSig = points.length > 0 ? (points.reduce((s,p) => s+p.signalStrength,0)/points.length).toFixed(1) : 'N/A';

            coverageHistory.unshift({ timestamp: new Date().toLocaleTimeString(), coveragePct: parseFloat(covPct), pointsCovered: points.length, totalPoints: result.totalPoints, avgRSSI: avgSig });
            if (coverageHistory.length > 10) coverageHistory.pop();
            updateCoverageHistoryUI();

            setStatus(`Coverage: ${covPct}% | ${points.length.toLocaleString()} pts ≥ ${minRSSI} dBm | Avg RSSI: ${avgSig} dBm`);
        } catch (err) {
            console.error(err);
            setStatus('Analysis error: ' + err.message);
        } finally {
            if (typeof hideProgressOverlay === 'function') hideProgressOverlay();
        }
    }

    function updateCoverageHistoryUI() {
        let container = document.getElementById('int-coverage-history');
        if (!container) {
            const panel = document.getElementById('interactive-tool');
            if (!panel) return;
            container = document.createElement('div');
            container.id = 'int-coverage-history';
            container.style.cssText = 'margin-top:15px; background:#f8fafc; border-radius:8px; padding:10px; font-size:12px;';
            container.innerHTML = '<strong>📊 Last 10 Coverage Results</strong><div id="int-history-list"></div>';
            const analyzeBtn = document.getElementById('int-analyze');
            if (analyzeBtn) analyzeBtn.insertAdjacentElement('afterend', container);
        }
        const listDiv = document.getElementById('int-history-list');
        if (!listDiv) return;
        if (coverageHistory.length === 0) {
            listDiv.innerHTML = '<div style="color:#888;">No analyses yet. Click "Analyse RSSI Coverage".</div>';
            return;
        }
        let html = '<div style="max-height:150px; overflow-y:auto;">';
        coverageHistory.forEach(entry => {
            const color = entry.coveragePct >= 90 ? '#16a34a' : entry.coveragePct >= 70 ? '#d97706' : '#ef4444';
            html += `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid #e2e8f0;">
                        <span style="font-size:11px;">${entry.timestamp}</span>
                        <span style="font-weight:bold; color:${color};">${entry.coveragePct.toFixed(1)}%</span>
                        <span style="font-size:10px; color:#666;">${entry.pointsCovered.toLocaleString()} pts</span>
                     </div>`;
        });
        html += '</div>';
        listDiv.innerHTML = html;
    }

    // ------------------------------------------------------------------
    // ── Contour-chain modal: all state at module level ─────────────────
    let _ccLastPlacements = [];
    let _ccBsTemplate     = { txPower: 43, frequency: 1800, txHeight: 20, radius: 150, environment: 'uma-nlos' };
    let _ccRunGeneration  = 0;
    let _ccMapBounds      = null;   // captured when run starts, used by progress callback

    // ── Helpers used by both open and start ────────────────────────────
    function _ccShowWorking(subText) {
        const el  = document.getElementById('modal-working');
        const sub = document.getElementById('modal-working-sub');
        const bar = document.getElementById('modal-bar');
        if (el)  el.style.display = 'flex';
        if (sub && subText) sub.innerText = subText;
        if (bar) bar.classList.add('running');
    }
    function _ccHideWorking(barColor) {
        const el  = document.getElementById('modal-working');
        const bar = document.getElementById('modal-bar');
        if (el)  el.style.display = 'none';
        if (bar) { bar.classList.remove('running'); if (barColor) bar.style.background = barColor; }
    }
    function _ccResetUI() {
        const lc = document.getElementById('modal-live-map');
        if (lc) {
            const ctx = lc.getContext('2d');
            const w = lc.width, h = lc.height;
            ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = 'rgba(255,255,255,0.18)';
            ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Building coverage matrix\u2026', w/2, h/2 - 10);
            ctx.font = '11px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.09)';
            ctx.fillText('Map appears when first BS is placed', w/2, h/2 + 12);
            ctx.textAlign = 'left';
        }
        const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
        set('modal-cov', '0'); set('modal-bs', '0'); set('modal-gap', '100');
        const bar = document.getElementById('modal-bar');
        if (bar) { bar.style.width = '0%'; bar.style.background = '#16a34a'; }
        const pd = document.getElementById('modal-progress');
        const rd = document.getElementById('modal-result');
        if (pd) pd.style.display = 'block';
        if (rd) rd.style.display = 'none';
        const st = document.getElementById('modal-step');
        if (st) st.innerHTML = '';
    }
    function _ccShowImportBtn(placements, tmpl) {
        const n = placements.length;
        const covEl = document.getElementById('modal-cov');
        const covText = covEl ? covEl.innerText : '?';
        const stepEl = document.getElementById('modal-step');
        if (!stepEl) return;
        stepEl.innerHTML =
            `\u23f9 Cancelled \u00b7 <strong>${n} BS</strong> placed so far (${covText}% coverage).` +
            `<br><button id="modal-import-partial" class="btn btn-calculate" ` +
            `style="margin-top:10px;padding:10px 18px;font-size:13px;width:100%;">` +
            `\u2b07 Import ${n} current BS locations into scene</button>`;
        const btn = document.getElementById('modal-import-partial');
        if (btn) btn.onclick = () => {
            _ccApplyToScene(placements, tmpl);
            setStatus(`\u2705 Imported ${n} BS locations.`);
            document.getElementById('contour-modal').style.display = 'none';
        };
    }
    function _ccApplyToScene(placements, tmpl) {
        interactiveObjects.baseStations.forEach(bs => {
            scene.remove(bs.marker); if (bs.label) scene.remove(bs.label);
        });
        interactiveObjects.baseStations = [];
        placements.forEach((pos, idx) => {
            const name  = `CC-${idx+1}${pos.isHeal ? '-heal' : ''}`;
            const color = pos.isHeal ? 0xf59e0b : 0x3b82f6;
            const { marker, label } = createBSTowerIcon({ x: pos.x, y: tmpl.txHeight, z: pos.z }, name, color);
            interactiveObjects.baseStations.push({
                id: nextId++, name,
                position:         { x: pos.x, y: tmpl.txHeight, z: pos.z },
                marker, label,
                txPower:          tmpl.txPower,
                frequency:        tmpl.frequency,
                txHeight:         tmpl.txHeight,
                radius:           tmpl.radius,
                environment:      tmpl.environment,
                antennaAzimuth:   0,
                antennaBeamwidth: 360,
                antennaGain:      0
            });
        });
        syncGlobalBS();
        refreshObjectList();
    }
    function _ccDrawCanvas(p) {
        const lc = document.getElementById('modal-live-map');
        if (!lc || !_ccMapBounds) return;
        const ctx = lc.getContext('2d');
        const w = lc.width, h = lc.height, pad = 20;
        const mb = _ccMapBounds;
        const rangeX = mb.maxX - mb.minX, rangeZ = mb.maxZ - mb.minZ;
        const scale  = Math.min((w-pad*2)/rangeX, (h-pad*2-20)/rangeZ);
        const toX = x => pad + (x - mb.minX) * scale;
        const toY = z => pad + (z - mb.minZ) * scale;
        ctx.fillStyle = '#0f172a'; ctx.fillRect(0, 0, w, h);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1;
        ctx.strokeRect(toX(mb.minX), toY(mb.minZ), rangeX*scale, rangeZ*scale);
        if (p.coveredPoints && p.coveredPoints.length) {
            ctx.fillStyle = 'rgba(34,197,94,0.5)';
            p.coveredPoints.forEach(pt => ctx.fillRect(toX(pt.x)-2, toY(pt.z)-2, 4, 4));
        }
        if (p.autoFilledPoints && p.autoFilledPoints.length) {
            ctx.fillStyle = 'rgba(96,165,250,0.4)';
            p.autoFilledPoints.forEach(pt => ctx.fillRect(toX(pt.x)-2, toY(pt.z)-2, 4, 4));
        }
        if (p.placements && p.placements.length) {
            p.placements.forEach((bs, i) => {
                ctx.beginPath();
                ctx.arc(toX(bs.x), toY(bs.z), 5, 0, 2*Math.PI);
                ctx.fillStyle = bs.isAnchor ? '#f97316' : '#3b82f6';
                ctx.fill();
                ctx.fillStyle = 'white';
                ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center';
                ctx.fillText(i+1, toX(bs.x), toY(bs.z)-7);
                ctx.textAlign = 'left';
            });
        } else {
            ctx.fillStyle = 'rgba(255,255,255,0.2)';
            ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
            ctx.fillText('Scanning for optimal positions\u2026', w/2, h/2-8);
            ctx.font = '10px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.1)';
            ctx.fillText(`Step ${p.step||0}`, w/2, h/2+10);
            ctx.textAlign = 'left';
        }
    }
    function _ccCancel() {
        if (!ccRunning) return;
        if (window.workerManager) window.workerManager.cancelAllTasks();
        currentTaskId = null;
        ccRunning     = false;
        _ccRunGeneration++;       
        _ccHideWorking('#f97316');
        setStatus('Optimisation cancelled.');
        const sb = document.getElementById('modal-start-opt');
        if (sb) sb.disabled = false;
        if (_ccLastPlacements.length > 0) {
            _ccShowImportBtn(_ccLastPlacements, _ccBsTemplate);
        } else {
            const st = document.getElementById('modal-step');
            if (st) st.innerHTML = '\u23f9 Cancelled \u2014 no BS placed yet. Adjust parameters and restart.';
        }
    }
  
    async function _ccStart() {
        if (ccRunning) return;
        _ccLastPlacements = [];
        _ccRunGeneration++;
        const myGen = _ccRunGeneration;

        _ccResetUI();
        const sb = document.getElementById('modal-start-opt');
        if (sb) sb.disabled = true;

        const minRSSI     = parseInt(document.getElementById('modal-min-rssi').value)    || -100;
        const target      = parseInt(document.getElementById('modal-target').value)       || 95;
        const txPower     = parseFloat(document.getElementById('modal-txpower').value)    || 43;
        const frequency   = parseFloat(document.getElementById('modal-freq').value)       || 1800;
        const txHeight    = parseFloat(document.getElementById('modal-height').value)     || 20;
        const radius      = parseFloat(document.getElementById('modal-radius').value)     || 150;
        const environment = document.getElementById('modal-env').value || 'uma-nlos';

        _ccBsTemplate = { txPower, frequency, txHeight, radius, environment };
        _ccMapBounds  = (typeof getMapBounds === 'function')
            ? getMapBounds()
            : { minX: -200, maxX: 200, minZ: -200, maxZ: 200 };

        rebuildBuildingData();

        const crowdData = interactiveObjects.crowds.map(c => ({
            center: c.centerPos, radius: c.radius, density: c.density
        }));

        const st = document.getElementById('modal-step');
        if (st) st.innerHTML = 'Starting contour chain\u2026';
        ccRunning = true;
        _ccShowWorking('Initialising coverage matrix\u2026');

        try {
            const result = await window.workerManager.executeTask(
                'contour-chain',
                { bsTemplate: _ccBsTemplate, mapBounds: _ccMapBounds,
                  evalResolution: 10, minRSSI, targetCoverage: target, crowdData },
                (p) => {
                    if (myGen !== _ccRunGeneration) return;  // stale progress
                    const cov     = parseFloat(p.coveragePct || 0);
                    const bsCount = parseInt(p.bsCount || 0);
                    if (p.placements && p.placements.length > 0) {
                        _ccLastPlacements = p.placements.slice();
                    }
                    const sub = document.getElementById('modal-working-sub');
                    if (sub) sub.innerText = `Placed ${bsCount} BS \u00b7 scanning next gap\u2026`;
                    const set = (id, v) => { const el = document.getElementById(id); if (el) el.innerText = v; };
                    set('modal-cov',  cov.toFixed(1));
                    set('modal-bs',   bsCount);
                    set('modal-gap',  (100-cov).toFixed(1));
                    const bar = document.getElementById('modal-bar');
                    if (bar) bar.style.width = Math.min(100, cov) + '%';
                    if (st)  st.innerHTML = `Placing BS #${bsCount} \u00b7 Coverage: ${cov.toFixed(1)}%`;
                    _ccDrawCanvas(p);
                }
            );

            if (myGen !== _ccRunGeneration) return;
            _ccHideWorking('#16a34a');
            const rd = document.getElementById('modal-result');
            if (rd) {
                rd.style.display = 'block';
                const fc = document.getElementById('final-cov');
                const fb = document.getElementById('final-bs');
                if (fc) fc.innerText = result.coveragePct;
                if (fb) fb.innerText = result.bsCount;
            }
            if (st) st.innerHTML = `\u2705 Done \u00b7 Coverage: ${result.coveragePct}% with ${result.bsCount} BSs.`;
            const applyBtn = document.getElementById('apply-bs-btn');
            if (applyBtn) applyBtn.onclick = () => {
                _ccApplyToScene(result.bsPositions, _ccBsTemplate);
                setStatus(`Applied ${result.bsCount} optimised BSs.`);
                document.getElementById('contour-modal').style.display = 'none';
            };

        } catch (err) {
            if (myGen !== _ccRunGeneration) return;
            if (err.message !== 'Analysis cancelled') {
                console.error(err);
                _ccHideWorking('#ef4444');
                if (st) st.innerHTML = `\u274c Error: ${err.message}`;
                setStatus(`Optimisation error: ${err.message}`);
            }
        } finally {
            if (myGen === _ccRunGeneration) {
                ccRunning     = false;
                currentTaskId = null;
                if (sb) sb.disabled = false;
            }
        }
    }

    function runContourChainModal() {
        const modal = document.getElementById('contour-modal');
        if (!modal) { alert('Modal not found.'); return; }

      
        if (!document.getElementById('modal-start-opt')) {
            const row = document.createElement('div');
            row.id = 'modal-btn-row';
            row.style.cssText = 'margin-top:15px;display:flex;gap:10px;';
            const sb = document.createElement('button');
            sb.id = 'modal-start-opt'; sb.className = 'btn btn-primary';
            sb.textContent = '\u25b6 Start Optimisation';
            const cb = document.createElement('button');
            cb.id = 'modal-cancel-opt'; cb.className = 'btn btn-secondary';
            cb.textContent = '\u23f9 Cancel';
            row.appendChild(sb); row.appendChild(cb);
            (modal.querySelector('.modal-body') || modal).appendChild(row);
        }

        
        const sb = document.getElementById('modal-start-opt');
        const cb = document.getElementById('modal-cancel-opt');
        if (sb) sb.onclick = _ccStart;
        if (cb) cb.onclick = _ccCancel;

        const closeBtn = document.getElementById('modal-close');
        if (closeBtn) closeBtn.onclick = () => {
            if (ccRunning) _ccCancel();
            modal.style.display = 'none';
        };

        if (modal.style.display === 'block' && ccRunning) return;

        if (_ccLastPlacements.length > 0) {
            const pd = document.getElementById('modal-progress');
            const rd = document.getElementById('modal-result');
            if (pd) pd.style.display = 'block';
            if (rd) rd.style.display = 'none';
            _ccHideWorking('#f97316');
            _ccShowImportBtn(_ccLastPlacements, _ccBsTemplate);
        } else {
            _ccResetUI();
            const st = document.getElementById('modal-step');
            if (st) st.innerHTML = 'Ready. Click \u201cStart Optimisation\u201d.';
        }
        if (sb) sb.disabled = false;
        modal.style.display = 'block';
    }


    // ------------------------------------------------------------------
    // Export / Import / Clear
    // ------------------------------------------------------------------
    function exportConfig() {
        const data = {
            baseStations: interactiveObjects.baseStations.map(bs => ({ name: bs.name, position: bs.position, txPower: bs.txPower, frequency: bs.frequency, txHeight: bs.txHeight, radius: bs.radius, environment: bs.environment, antennaAzimuth: bs.antennaAzimuth, antennaBeamwidth: bs.antennaBeamwidth, antennaGain: bs.antennaGain })),
            buildings: interactiveObjects.buildings.map(b => ({ width: b.hollowBuilding.outerSize.x, depth: b.hollowBuilding.outerSize.z, height: b.hollowBuilding.outerSize.y, materialType: b.materialType, position: { x: b.mesh.position.x - b.hollowBuilding.outerSize.x/2, y: b.mesh.position.y - b.hollowBuilding.outerSize.y/2, z: b.mesh.position.z - b.hollowBuilding.outerSize.z/2 } })),
            crowds: interactiveObjects.crowds.map(c => ({ radius: c.radius, density: c.density, centerPos: c.centerPos }))
        };
        const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'interactive-config.json'; a.click(); URL.revokeObjectURL(blob);
        setStatus('Configuration exported.');
    }

    function importConfig() {
        const input = document.createElement('input'); input.type='file'; input.accept='.json';
        input.onchange = (e) => {
            const file = e.target.files[0];
            if(!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    clearAll();
                    if(data.baseStations) data.baseStations.forEach(bs => {
                        const id = nextId++;
                        const { marker, label } = createBSTowerIcon(bs.position, bs.name);
                        interactiveObjects.baseStations.push({ id, marker, label, ...bs });
                    });
                    if(data.buildings) data.buildings.forEach(b => {
                        const id = nextId++;
                        const color = BUILDING_MATERIALS[b.materialType] ? BUILDING_MATERIALS[b.materialType].color : 0xaa8866;
                        const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.width, b.height, b.depth), new THREE.MeshPhongMaterial({ color: color, transparent: true, opacity: 0.8 }));
                        mesh.position.set(b.position.x + b.width/2, b.position.y + b.height/2, b.position.z + b.depth/2);
                        scene.add(mesh);
                        const bb = new THREE.Box3().setFromObject(mesh);
                        const center = bb.getCenter(new THREE.Vector3());
                        const hollow = {
                            name: `Custom_${id}`, center: { x: center.x, y: center.y, z: center.z },
                            outerSize: { x: b.width, y: b.height, z: b.depth },
                            innerSize: { x: b.width*0.8, y: b.height*0.8, z: b.depth*0.8 },
                            wallThickness: 0.3, floors: Math.floor(b.height/3), floorHeight: 3,
                            materialType: b.materialType,
                            boundingBox: { min: bb.min, max: bb.max },
                            innerBoundingBox: { min: bb.min, max: bb.max }
                        };
                        interactiveObjects.buildings.push({ id, mesh, hollowBuilding: hollow, materialType: b.materialType });
                    });
                    if(data.crowds) data.crowds.forEach(c => {
                        const id = nextId++;
                        const ring = new THREE.Mesh(new THREE.RingGeometry(c.radius-0.5, c.radius+0.5, 32), new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide, transparent: true, opacity: 0.6 }));
                        ring.rotation.x = -Math.PI/2; ring.position.set(c.centerPos.x, c.centerPos.y+0.2, c.centerPos.z);
                        scene.add(ring);
                        interactiveObjects.crowds.push({ id, centerMarker: ring, radius: c.radius, density: c.density, centerPos: c.centerPos });
                    });
                    syncGlobalBS();
                    rebuildBuildingData();
                    refreshObjectList();
                    setStatus(`Imported ${data.baseStations?.length||0} BS, ${data.buildings?.length||0} buildings, ${data.crowds?.length||0} crowds.`);
                } catch(err) { setStatus('Import failed: '+err.message); }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    function clearAll() {
        interactiveObjects.baseStations.forEach(bs => { scene.remove(bs.marker); if(bs.label) scene.remove(bs.label); });
        interactiveObjects.buildings.forEach(b => scene.remove(b.mesh));
        interactiveObjects.crowds.forEach(c => scene.remove(c.centerMarker));
        interactiveObjects = { baseStations: [], buildings: [], crowds: [] };
        if (typeof clearMultiCoverageVisualization === 'function') clearMultiCoverageVisualization();
        syncGlobalBS();
        rebuildBuildingData();
        refreshObjectList();
        coverageHistory = [];
        updateCoverageHistoryUI();
        setStatus('All objects cleared.');
    }

    // ------------------------------------------------------------------
    // Initialisation
    // ------------------------------------------------------------------
    window.setupInteractiveMode = function(sceneRef, cameraRef, controlsRef, rendererRef) {
        scene = sceneRef; camera = cameraRef; controls = controlsRef; renderer = rendererRef;
        interactiveModeActive = true;
        statusDiv = document.getElementById('int-status');
        if (!statusDiv) {
            const panel = document.getElementById('interactive-tool');
            if (panel) {
                statusDiv = document.createElement('div');
                statusDiv.id = 'int-status';
                statusDiv.style.cssText = 'background:#f1f5f9; padding:6px; border-radius:6px; font-size:11px; margin-top:8px; color:#475569;';
                panel.appendChild(statusDiv);
            }
        }
        setStatus('Interactive mode ready.');

        document.getElementById('int-add-bs').onclick = startAddBS;
        document.getElementById('int-add-building').onclick = startAddBuilding;
        document.getElementById('int-add-crowd').onclick = startAddCrowd;
        document.getElementById('int-import-config').onclick = importConfig;
        document.getElementById('int-export-config').onclick = exportConfig;
        document.getElementById('int-analyze').onclick = analyzeRSSI;
        document.getElementById('int-clear-all').onclick = clearAll;
        document.getElementById('int-optimise-bs').onclick = runContourChainModal;

        // Setup modal slider displays
        const setupModalSlider = (id, displayId) => {
            const slider = document.getElementById(id);
            const display = document.getElementById(displayId);
            if (slider && display) {
                const update = () => { display.innerText = slider.value; };
                slider.addEventListener('input', update);
                update();
            }
        };
        setupModalSlider('modal-min-rssi', 'modal-min-rssi-val');
        setupModalSlider('modal-target', 'modal-target-val');
        setupModalSlider('modal-txpower', 'modal-txpower-val');
        setupModalSlider('modal-freq', 'modal-freq-val');
        setupModalSlider('modal-height', 'modal-height-val');
        setupModalSlider('modal-radius', 'modal-radius-val');

        initDragSupport();
        refreshObjectList();
        updateCoverageHistoryUI();
    };
})();
