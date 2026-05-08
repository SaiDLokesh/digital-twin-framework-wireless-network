# digital-twin-framework-wireless-network
Digital Twin Framework for Wireless Network Planning and Performance Evaluation


# Digital Twin Framework for Wireless Network Planning

## Project
BTech Final Year Project — VNIT Nagpur, 2026
Department of Electronics and Communication Engineering

## Team
- Royyuru Sahithi (BT22ECE006)
- K Manik Prabhu (BT22ECE032)
- D Venkata Sai Lokesh Reddy (BT22ECE059)
- Vadla Sreeja (BT22ECE084)

## Guide
Dr. Abhay S Gandhi, Professor, Dept. of ECE, VNIT Nagpur

## Live Demo
https://saidlokesh.github.io/digital-twin-wireless-network

## How to Run

### Option 1 — Live Demo (Recommended)
Open the link above directly in Chrome or Edge. No setup needed.

### Option 2 — Run Locally (Downloaded)

#### Windows
Step 1: Unzip the downloaded folder

Step 2: Open Command Prompt and navigate to the project folder  
(you should see index.html when you run "dir")

    cd C:\Users\YourName\Downloads\project

Step 3: Start the local server

    python -m http.server 8000

Step 4: Open your browser and go to

    http://localhost:8000

#### Ubuntu / Linux
Step 1: Unzip the downloaded folder

Step 2: Open Terminal and navigate to the project folder  
(you should see index.html when you run "ls")

    cd ~/Downloads/project

Step 3: Start the local server

    python3 -m http.server 8000

Step 4: Open your browser and go to

    http://localhost:8000

---

## Precautions

1. If you notice any UI bugs, reload the page after exporting
   your current configurations if any were set.

2. Always save (Export) your configurations as a JSON file
   before running a heavy simulation — this prevents losing your
   setup if the page needs to be reloaded.

3. Use Interactive Mode for the best experience — it contains
   most of the path loss related KPI analysis tools and is the
   primary feature of this framework.

4. Ignore the BS Placement Optimiser tool — it is not required
   for normal use and will be removed in a future update.

5. UI updates will be pushed periodically as and when bugs are
   noticed and fixed.

---

## Features
- 3D campus model of VNIT Nagpur (BlenderGIS + OpenStreetMap)
- 3GPP TR 38.901 channel models (UMa/UMi LOS/NLOS)
- Building penetration loss (10 material types)
- Multi-BS SINR with Tier 1/3/6 interference model
- Crowd blockage — 3GPP Model A and Model B
- Delay spread analysis
- Throughput and Jain's Fairness Index
- Interactive Mode — place BS, buildings, crowd zones in real time
- Contour Chain — automatic optimal BS placement
- 9 parallel Web Workers — responsive UI throughout
- Export/Import configurations as JSON

---

## Browser Compatibility
- Recommended: Google Chrome or Microsoft Edge
- Firefox and Safari may work but are not fully tested

---

## Tech Stack
- Three.js — 3D visualization
- JavaScript Web Workers — parallel computation
- 3GPP TR 38.901 — channel modeling standard
- BlenderGIS + OpenStreetMap — 3D campus model
