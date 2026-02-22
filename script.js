// QBIT Firmware Flasher
// Flashing handled by esp-web-tools <esp-web-install-button> via manifest.json

// UI elements
const ui = {
    themeBtn: document.getElementById('themeBtn'),
    versionEl: document.getElementById('version'),
    timestampEl: document.getElementById('timestamp'),
    firmwareSizeEl: document.getElementById('firmware-size'),
    firmwareMd5El: document.getElementById('firmware-md5'),
    refreshBtn: document.getElementById('refresh-btn'),
};

let releaseData = null;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    const isDark = !localStorage.getItem('qbit-light-mode');
    if (!isDark) document.body.classList.add('light-mode');
    ui.themeBtn.addEventListener('click', toggleTheme);

    loadLatestVersion();
    ui.refreshBtn.addEventListener('click', loadLatestVersion);
});

function toggleTheme() {
    document.body.classList.toggle('light-mode');
    localStorage.setItem('qbit-light-mode', document.body.classList.contains('light-mode') ? 'true' : '');
}

// Firmware info
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

        releaseData = latestJson;
        ui.versionEl.textContent = latestJson.version || 'Unknown';
        ui.timestampEl.textContent = formatDate(latestJson.timestamp) || 'Unknown';
        if (latestJson.files && latestJson.files['firmware.bin']) {
            const fw = latestJson.files['firmware.bin'];
            ui.firmwareSizeEl.textContent = formatBytes(fw.size);
            ui.firmwareMd5El.textContent = fw.md5.substring(0, 16) + '...';
        }
    } catch (error) {
        console.error('Load version failed:', error);
        ui.versionEl.textContent = '[ERR] Load failed';
    } finally {
        ui.refreshBtn.disabled = false;
    }
}

// Helpers
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
