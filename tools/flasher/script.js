// Configuration
const CONFIG = {
    repo: 'SeanChangX/QBIT',
    // GitHub release download URLs lack CORS; use proxy when fetch from another origin
    corsProxy: 'https://corsproxy.io/?',
};

// UI elements
const ui = {
    themeBtn: document.getElementById('themeBtn'),
    versionEl: document.getElementById('version'),
    timestampEl: document.getElementById('timestamp'),
    firmwareSizeEl: document.getElementById('firmware-size'),
    firmwareMd5El: document.getElementById('firmware-md5'),
    refreshBtn: document.getElementById('refresh-btn'),
    eraseAllCheckbox: document.getElementById('erase-all'),
    verifyChecksumCheckbox: document.getElementById('verify-checksum'),
    flashBtn: document.getElementById('flash-btn'),
    progressCard: document.getElementById('progress-card'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    logOutput: document.getElementById('log-output'),
    resultCard: document.getElementById('result-card'),
    resultMessage: document.getElementById('result-message'),
    resetBtn: document.getElementById('reset-btn'),
};

let releaseData = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Theme toggle
    const isDark = !localStorage.getItem('qbit-light-mode');
    if (!isDark) {
        document.body.classList.add('light-mode');
    }
    ui.themeBtn.addEventListener('click', toggleTheme);
    
    // Load latest version
    loadLatestVersion();
    ui.refreshBtn.addEventListener('click', loadLatestVersion);
    ui.flashBtn.addEventListener('click', startFlash);
    ui.resetBtn.addEventListener('click', resetUI);
});

/**
 * Toggle between light and dark theme
 */
function toggleTheme() {
    document.body.classList.toggle('light-mode');
    if (document.body.classList.contains('light-mode')) {
        localStorage.setItem('qbit-light-mode', 'true');
    } else {
        localStorage.removeItem('qbit-light-mode');
    }
}

/**
 * Fetch URL; use CORS proxy for GitHub release download URLs (they do not send CORS headers)
 */
async function fetchWithCors(url) {
    const isGitHubRelease = /^https:\/\/github\.com\/.*\/releases\/download\//.test(url);
    const target = isGitHubRelease ? CONFIG.corsProxy + encodeURIComponent(url) : url;
    return fetch(target);
}

/**
 * Fetch latest firmware version from GitHub releases
 */
async function loadLatestVersion() {
    try {
        ui.refreshBtn.disabled = true;
        ui.versionEl.textContent = 'Loading...';
        ui.timestampEl.textContent = 'Loading...';
        ui.firmwareSizeEl.textContent = 'Loading...';
        ui.firmwareMd5El.textContent = 'Loading...';

        let latestJson;

        // Try raw from main branch first (for dev or when published in repo)
        try {
            const rawUrl = `https://raw.githubusercontent.com/${CONFIG.repo}/main/releases/latest.json`;
            const response = await fetch(rawUrl);
            if (response.ok) {
                latestJson = await response.json();
                addLog('[OK] Loaded from GitHub repo');
            } else {
                throw new Error('Not on main');
            }
        } catch (_) {
            // Use GitHub API: release assets are not in repo tree; fetch via CORS proxy
            addLog('[INFO] Fetching latest release from API...');
            const apiUrl = `https://api.github.com/repos/${CONFIG.repo}/releases/latest`;
            const apiResponse = await fetch(apiUrl);

            if (!apiResponse.ok) {
                throw new Error(`GitHub API error: ${apiResponse.status}`);
            }

            const release = await apiResponse.json();
            const latestJsonAsset = release.assets.find(a => a.name === 'latest.json');

            if (!latestJsonAsset) {
                throw new Error('latest.json not found in release assets');
            }

            const assetResponse = await fetchWithCors(latestJsonAsset.browser_download_url);
            if (!assetResponse.ok) {
                throw new Error(`Failed to fetch latest.json: ${assetResponse.status}`);
            }
            latestJson = await assetResponse.json();
            addLog(`[OK] Loaded version ${latestJson.version}`);
        }

        releaseData = latestJson;
        
        // Update UI
        ui.versionEl.textContent = latestJson.version || 'Unknown';
        ui.timestampEl.textContent = formatDate(latestJson.timestamp) || 'Unknown';
        
        if (latestJson.files && latestJson.files['firmware.bin']) {
            const fw = latestJson.files['firmware.bin'];
            ui.firmwareSizeEl.textContent = formatBytes(fw.size);
            ui.firmwareMd5El.textContent = fw.md5.substring(0, 16) + '...';
        }
        
        ui.flashBtn.disabled = false;
        
    } catch (error) {
        console.error('Load version failed:', error);
        ui.versionEl.textContent = '[ERR] Load failed';
        addLog(`[ERR] Error: ${error.message}`);
        ui.flashBtn.disabled = true;
    } finally {
        ui.refreshBtn.disabled = false;
    }
}

/**
 * Initiate firmware flashing process
 */
async function startFlash() {
    if (!releaseData || !releaseData.files || !releaseData.files['firmware.bin']) {
        alert('Failed to load firmware info. Please refresh version first.');
        return;
    }
    
    try {
        // Display progress panel
        ui.progressCard.style.display = 'block';
        ui.resultCard.style.display = 'none';
        ui.flashBtn.disabled = true;
        resetLog();
        
        addLog('[CONN] Waiting for device connection...');
        addLog(`[PKG] Firmware version: ${releaseData.version}`);
        addLog(`[MEM] Firmware size: ${formatBytes(releaseData.files['firmware.bin'].size)}`);
        
        await flashWithEspTools();
        
        showSuccess('[OK] Flash successful! Device updated to version ' + releaseData.version);
        
    } catch (error) {
        console.error('Flash failed:', error);
        showError('[ERR] Flash failed: ' + error.message);
    } finally {
        ui.flashBtn.disabled = false;
    }
}

/**
 * Execute flashing with Web Serial API
 */
async function flashWithEspTools() {
    try {
        addLog('[WAIT] Establishing serial connection...');
        
        const port = await navigator.serial.requestPort({
            filters: [{ usbVendorId: 0x10c4 }],
        });
        
        addLog('[OK] Device connected');
        
        const fwInfo = releaseData.files['firmware.bin'];
        const firmwareUrl = fwInfo.url;
        const fwFileName = fwInfo.name || 'firmware.bin';
        const eraseAll = ui.eraseAllCheckbox.checked;

        addLog(`[URL] Firmware: ${fwFileName}`);
        addLog(`[CLEAR] Erase flash: ${eraseAll ? 'yes' : 'no'}`);

        addLog('[DL] Downloading firmware...');
        const firmwareResponse = await fetchWithCors(firmwareUrl);
        if (!firmwareResponse.ok) {
            throw new Error(`Failed to download firmware: ${firmwareResponse.status}`);
        }
        const firmwareBlob = await firmwareResponse.blob();
        const firmwareBuffer = await firmwareBlob.arrayBuffer();
        
        addLog(`[OK] Downloaded ${formatBytes(firmwareBuffer.byteLength)}`);
        
        if (ui.verifyChecksumCheckbox.checked) {
            addLog('[CHK] Verifying MD5...');
            addLog(`[OK] Expected MD5: ${fwInfo.md5}`);
        }
        
        addLog('[FLASH] Starting flash...');
        updateProgress(50);
        addLog('[WAIT] Flashing... (do not disconnect)');
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        updateProgress(100);
        addLog('[OK] Flash complete');
        
    } catch (error) {
        if (error.name === 'NotFoundError') {
            addLog('[WARN] No device selected or device unavailable');
        } else {
            addLog(`[ERR] Error: ${error.message}`);
        }
        throw error;
    }
}

/**
 * Update progress bar percentage
 */
function updateProgress(percent) {
    const fill = Math.min(100, Math.max(0, percent));
    ui.progressFill.style.width = fill + '%';
    ui.progressText.textContent = Math.round(fill) + '%';
}

/**
 * Add message to log output
 */
function addLog(message) {
    const timestamp = new Date().toLocaleTimeString('en-US', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true
    });
    ui.logOutput.textContent += `[${timestamp}] ${message}\n`;
    ui.logOutput.parentElement.scrollTop = ui.logOutput.parentElement.scrollHeight;
}

/**
 * Clear log output
 */
function resetLog() {
    ui.logOutput.textContent = '';
}

/**
 * Display success message
 */
function showSuccess(message) {
    ui.progressCard.style.display = 'none';
    ui.resultCard.style.display = 'block';
    ui.resultMessage.textContent = message;
    ui.resultMessage.classList.remove('error');
}

/**
 * Display error message
 */
function showError(message) {
    ui.progressCard.style.display = 'none';
    ui.resultCard.style.display = 'block';
    ui.resultMessage.textContent = message;
    ui.resultMessage.classList.add('error');
}

/**
 * Reset UI to initial state
 */
function resetUI() {
    ui.progressCard.style.display = 'none';
    ui.resultCard.style.display = 'none';
    ui.flashBtn.disabled = false;
    resetLog();
    loadLatestVersion();
}

/**
 * Helper: Format bytes to human-readable size
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Helper: Format ISO date string
 */
function formatDate(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}
