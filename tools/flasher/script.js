// Configuration: latest.json and firmware are served from same origin (gh-pages deploy)
// Real flashing via esptool-js (ES module from CDN)
import { ESPLoader, Transport } from 'https://esm.sh/esptool-js@0.5.7';

const FLASH_BAUDRATE = 921600;

// Flash layout matching firmware/partitions.csv
const FLASH_MAP = {
    'bootloader.bin': 0x0,
    'partitions.bin': 0x8000,
    'firmware.bin':   0x10000,
    'littlefs.bin':   0x190000,
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
    connectBtn: document.getElementById('connect-btn'),
    deviceConnected: document.getElementById('device-connected'),
    flashBtn: document.getElementById('flash-btn'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    monitorClearBtn: document.getElementById('monitor-clear-btn'),
    monitorOutput: document.getElementById('monitor-output'),
    monitorSendInput: document.getElementById('monitor-send-input'),
    monitorSendBtn: document.getElementById('monitor-send-btn'),
    progressCard: document.getElementById('progress-card'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    logOutput: document.getElementById('log-output'),
    resultModal: document.getElementById('result-modal'),
    resultMessage: document.getElementById('result-message'),
    resultModalClose: document.getElementById('result-modal-close'),
    resultModalTitle: document.getElementById('result-modal-title'),
    resetBtn: document.getElementById('reset-btn'),
};

let releaseData = null;
let monitorPort = null;
let monitorReader = null;
let monitorReadAborted = false;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const isDark = !localStorage.getItem('qbit-light-mode');
    if (!isDark) document.body.classList.add('light-mode');
    ui.themeBtn.addEventListener('click', toggleTheme);

    loadLatestVersion();
    ui.refreshBtn.addEventListener('click', loadLatestVersion);
    ui.flashBtn.addEventListener('click', startFlash);

    ui.resetBtn.addEventListener('click', () => { closeResultModal(); resetUI(); });
    ui.resultModalClose.addEventListener('click', () => { closeResultModal(); resetUI(); });
    ui.resultModal.addEventListener('click', (e) => { if (e.target === ui.resultModal) { closeResultModal(); resetUI(); } });

    ui.connectBtn.addEventListener('click', connectDevice);
    ui.disconnectBtn.addEventListener('click', disconnectDevice);
    ui.monitorClearBtn.addEventListener('click', () => { ui.monitorOutput.textContent = ''; });
    ui.monitorSendBtn.addEventListener('click', serialMonitorSend);
    ui.monitorSendInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') serialMonitorSend(); });
});

function setDeviceConnectedUI(connected) {
    ui.connectBtn.style.display = connected ? 'none' : '';
    ui.deviceConnected.style.display = connected ? 'block' : 'none';
}

function toggleTheme() {
    document.body.classList.toggle('light-mode');
    localStorage.setItem('qbit-light-mode', document.body.classList.contains('light-mode') ? 'true' : '');
}

async function loadLatestVersion() {
    try {
        ui.refreshBtn.disabled = true;
        ui.versionEl.textContent = 'Loading...';
        ui.timestampEl.textContent = 'Loading...';
        ui.firmwareSizeEl.textContent = 'Loading...';
        ui.firmwareMd5El.textContent = 'Loading...';

        const response = await fetch('latest.json');
        if (!response.ok) throw new Error(`Failed to fetch latest.json: ${response.status}`);
        const latestJson = await response.json();
        addLog(`[OK] Loaded version ${latestJson.version}`);

        releaseData = latestJson;
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
        addLog(`[ERR] ${error.message}`);
        ui.flashBtn.disabled = true;
    } finally {
        ui.refreshBtn.disabled = false;
    }
}

async function startFlash() {
    if (!releaseData?.files?.['firmware.bin']) {
        alert('Failed to load firmware info. Please refresh version first.');
        return;
    }
    const existingPort = monitorPort;
    if (existingPort) {
        monitorReadAborted = true;
        if (monitorReader) try { await monitorReader.cancel(); } catch (_) {}
        monitorReader = null;
    }
    try {
        ui.progressCard.style.display = 'block';
        ui.flashBtn.disabled = true;
        resetLog();
        addLog(`[PKG] Firmware version: ${releaseData.version}`);
        addLog(`[MEM] Firmware size: ${formatBytes(releaseData.files['firmware.bin'].size)}`);

        await flashWithEspTools(existingPort || undefined);
        if (existingPort) {
            monitorPort = null;
            setDeviceConnectedUI(false);
        }
        showSuccess('[OK] Flash successful! Device updated to version ' + releaseData.version);
    } catch (error) {
        console.error('Flash failed:', error);
        showError('[ERR] Flash failed: ' + error.message);
        if (existingPort) {
            try { await existingPort.close(); } catch (_) {}
            monitorPort = null;
            setDeviceConnectedUI(false);
        }
    } finally {
        ui.flashBtn.disabled = false;
    }
}

/**
 * Real flashing using esptool-js (loaded from CDN).
 * Erase all checked  -> flash bootloader + partitions + firmware + littlefs
 * Erase all unchecked -> flash firmware.bin only (quick update)
 */
async function flashWithEspTools(existingPort) {
    const port = existingPort || await navigator.serial.requestPort();
    if (!existingPort) addLog('[OK] Port selected');

    const eraseAll = ui.eraseAllCheckbox.checked;

    // Determine which files to flash
    const filesToFlash = eraseAll
        ? ['bootloader.bin', 'partitions.bin', 'firmware.bin', 'littlefs.bin']
        : ['firmware.bin'];

    // Download all needed binaries
    const images = [];
    for (const name of filesToFlash) {
        const fileInfo = releaseData.files[name];
        if (!fileInfo) {
            if (name === 'firmware.bin') throw new Error('firmware.bin not found in release');
            addLog(`[SKIP] ${name} not in release, skipping`);
            continue;
        }
        addLog(`[DL] Downloading ${name}...`);
        const resp = await fetch(fileInfo.url);
        if (!resp.ok) throw new Error(`Failed to download ${name}: ${resp.status}`);
        const buf = new Uint8Array(await resp.arrayBuffer());
        addLog(`[OK] ${name}: ${formatBytes(buf.length)}`);
        images.push({ name, offset: FLASH_MAP[name], data: buf });
    }

    const totalSize = images.reduce((s, i) => s + i.data.length, 0);
    addLog(`[INFO] Total: ${formatBytes(totalSize)}, erase all: ${eraseAll ? 'yes' : 'no'}`);
    addLog('[FLASH] Connecting to chip (hold BOOT if prompted)...');

    if (!existingPort) await port.open({ baudRate: 115200 });

    try {
        const terminal = {
            clean: () => {},
            write: (data) => { addLog(data.replace(/\n$/, '')); },
            writeLine: (data) => { addLog(data); },
        };

        const transport = new Transport(port);
        const loader = new ESPLoader({
            transport,
            baudrate: FLASH_BAUDRATE,
            terminal,
        });

        const result = await loader.connect();
        if (result !== 'success') throw new Error(result || 'Connect failed');
        addLog('[OK] Chip connected');

        if (eraseAll) {
            addLog('[ERASE] Erasing entire flash...');
            await loader.eraseFlash();
            addLog('[OK] Erase done');
        }

        // Flash each image sequentially
        let totalWritten = 0;
        for (const img of images) {
            const size = img.data.length;
            const numBlocks = Math.ceil(size / loader.FLASH_WRITE_SIZE);
            addLog(`[FLASH] Writing ${img.name} (${formatBytes(size)}) at 0x${img.offset.toString(16)}...`);
            await loader.flashBegin(size, img.offset);

            for (let seq = 0; seq < numBlocks; seq++) {
                const start = seq * loader.FLASH_WRITE_SIZE;
                const chunk = img.data.slice(start, start + loader.FLASH_WRITE_SIZE);
                const block = new Uint8Array(loader.FLASH_WRITE_SIZE);
                block.fill(0xff);
                block.set(chunk);
                await loader.flashBlock(block, seq, loader.timeoutPerMb(size));
                totalWritten += chunk.length;
                updateProgress(Math.round((totalWritten / totalSize) * 100));
            }
            addLog(`[OK] ${img.name} done`);
        }

        await loader.flashFinish(true);
        updateProgress(100);
        addLog('[OK] Flash complete, rebooting.');
    } finally {
        try { await port.close(); } catch (_) {}
    }
}

function updateProgress(percent) {
    const fill = Math.min(100, Math.max(0, percent));
    ui.progressFill.style.width = fill + '%';
    ui.progressText.textContent = Math.round(fill) + '%';
}

function addLog(message) {
    const ts = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
    ui.logOutput.textContent += `[${ts}] ${message}\n`;
    ui.logOutput.scrollTop = ui.logOutput.scrollHeight;
}

function resetLog() {
    ui.logOutput.textContent = '';
}

function showResultModal(isError, message) {
    ui.progressCard.style.display = 'none';
    const icon = ui.resultModalTitle.querySelector('.result-icon');
    icon.classList.remove('success-icon', 'error-icon');
    icon.classList.add(isError ? 'error-icon' : 'success-icon');
    icon.textContent = isError ? 'error' : 'check_circle';
    ui.resultMessage.textContent = message;
    ui.resultMessage.classList.toggle('error', isError);
    ui.resultModal.setAttribute('aria-hidden', 'false');
}

function closeResultModal() {
    ui.resultModal.setAttribute('aria-hidden', 'true');
}

function showSuccess(message) {
    showResultModal(false, message);
}

function showError(message) {
    showResultModal(true, message);
}

function resetUI() {
    ui.progressCard.style.display = 'none';
    closeResultModal();
    ui.flashBtn.disabled = false;
    resetLog();
    loadLatestVersion();
}

// Device: Connect / Disconnect (single port for both flash and serial)
async function connectDevice() {
    try {
        const port = await navigator.serial.requestPort();
        await port.open({ baudRate: 115200 });
        monitorPort = port;
        monitorReadAborted = false;
        setDeviceConnectedUI(true);
        appendMonitor('Connected. You can Flash firmware or use the serial monitor.\n');
        readSerialLoop();
    } catch (e) {
        if (e.name !== 'NotFoundError') alert('Connect failed: ' + e.message);
    }
}

async function disconnectDevice() {
    monitorReadAborted = true;
    if (monitorReader) try { await monitorReader.cancel(); } catch (_) {}
    if (monitorPort) try { await monitorPort.close(); } catch (_) {}
    monitorPort = null;
    monitorReader = null;
    setDeviceConnectedUI(false);
    appendMonitor('Disconnected.\n');
}

async function readSerialLoop() {
    if (!monitorPort || monitorReadAborted) return;
    const decoder = new TextDecoder();
    try {
        monitorReader = monitorPort.readable.getReader();
        while (!monitorReadAborted) {
            const { value, done } = await monitorReader.read();
            if (done) break;
            if (value && value.length) appendMonitor(decoder.decode(value));
        }
    } catch (e) {
        if (!monitorReadAborted) appendMonitor('\nRead error: ' + e.message + '\n');
    } finally {
        try { if (monitorReader) await monitorReader.releaseLock(); } catch (_) {}
    }
}

function appendMonitor(text) {
    ui.monitorOutput.textContent += text;
    ui.monitorOutput.scrollTop = ui.monitorOutput.scrollHeight;
}

async function serialMonitorSend() {
    if (!monitorPort || !monitorPort.writable) return;
    const line = ui.monitorSendInput.value + '\n';
    ui.monitorSendInput.value = '';
    const writer = monitorPort.writable.getWriter();
    try {
        await writer.write(new TextEncoder().encode(line));
    } finally {
        writer.releaseLock();
    }
}

function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

function formatDate(isoString) {
    if (!isoString) return null;
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return null;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    const h = String(date.getHours()).padStart(2, '0');
    const min = String(date.getMinutes()).padStart(2, '0');
    const s = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${d} ${h}:${min}:${s}`;
}
