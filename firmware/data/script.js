// Utility: human-readable file size
function fmt(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

// Device info -- fetch ID and name, allow renaming
(function () {
  var devId = document.getElementById('devId');
  var devName = document.getElementById('devName');
  var btnDevSave = document.getElementById('btnDevSave');

  fetch('/api/device').then(function (r) { return r.json(); }).then(function (d) {
    devId.textContent = d.id;
    devName.value = d.name;
  }).catch(function () {});

  btnDevSave.addEventListener('click', function () {
    btnDevSave.disabled = true;
    fetch('/api/device?name=' + encodeURIComponent(devName.value) + '&save=1', { method: 'POST' })
      .then(function () {
        btnDevSave.classList.add('saved');
        btnDevSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnDevSave.disabled = false;
        setTimeout(function () {
          btnDevSave.classList.remove('saved');
          btnDevSave.textContent = 'Save Name';
        }, 2000);
      });
  });

  var btnWifiReset = document.getElementById('btnWifiReset');
  var btnReboot = document.getElementById('btnReboot');
  var devMsg = document.getElementById('devMsg');

  btnWifiReset.addEventListener('click', function () {
    if (!confirm('Reset WiFi? The device will disconnect. You can then connect to its AP to choose a new network.')) return;
    btnWifiReset.disabled = true;
    devMsg.className = 'msg ok';
    devMsg.textContent = 'Resetting WiFi...';
    devMsg.style.display = 'block';
    fetch('/api/wifi-reset', { method: 'POST' })
      .then(function () {
        devMsg.textContent = 'WiFi reset. Device disconnected. Connect to QBIT AP to set a new network.';
      })
      .catch(function () {
        devMsg.className = 'msg';
        devMsg.textContent = 'Connection lost (device may have disconnected).';
        btnWifiReset.disabled = false;
      });
  });

  btnReboot.addEventListener('click', function () {
    if (!confirm('Reboot the device?')) return;
    btnReboot.disabled = true;
    devMsg.className = 'msg ok';
    devMsg.textContent = 'Rebooting...';
    devMsg.style.display = 'block';
    fetch('/api/reboot', { method: 'POST' })
      .then(function () {
        devMsg.textContent = 'Rebooting. Connection will be lost.';
      })
      .catch(function () {
        devMsg.className = 'msg';
        devMsg.textContent = 'Connection lost (device may be rebooting).';
        btnReboot.disabled = false;
      });
  });
})();

// MQTT settings -- fetch config and allow saving
(function () {
  var btnMqtt     = document.getElementById('btnMqtt');
  var mqttHost    = document.getElementById('mqttHost');
  var mqttPort    = document.getElementById('mqttPort');
  var mqttUser    = document.getElementById('mqttUser');
  var mqttPass    = document.getElementById('mqttPass');
  var mqttPrefix  = document.getElementById('mqttPrefix');
  var btnMqttSave = document.getElementById('btnMqttSave');
  var _mqttOn = false;

  function updateMqttBtn() {
    btnMqtt.textContent = _mqttOn ? 'ON' : 'OFF';
    btnMqtt.classList.toggle('muted', !_mqttOn);
  }

  fetch('/api/mqtt').then(function (r) { return r.json(); }).then(function (d) {
    _mqttOn = d.enabled;
    mqttHost.value   = d.host;
    mqttPort.value   = d.port;
    mqttUser.value   = d.user;
    mqttPass.value   = d.pass;
    mqttPrefix.value = d.prefix;
    updateMqttBtn();
  }).catch(function () {});

  btnMqtt.addEventListener('click', function () {
    _mqttOn = !_mqttOn;
    updateMqttBtn();
  });

  btnMqttSave.addEventListener('click', function () {
    btnMqttSave.disabled = true;
    var host = String(mqttHost.value).trim();
    var portNum = parseInt(mqttPort.value, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) portNum = 1883;
    var params = 'host=' + encodeURIComponent(host)
               + '&port=' + String(portNum)
               + '&user=' + encodeURIComponent(mqttUser.value)
               + '&pass=' + encodeURIComponent(mqttPass.value)
               + '&prefix=' + encodeURIComponent(mqttPrefix.value)
               + '&enabled=' + (_mqttOn ? '1' : '0')
               + '&save=1';
    fetch('/api/mqtt?' + params, { method: 'POST' })
      .then(function () {
        btnMqttSave.classList.add('saved');
        btnMqttSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnMqttSave.disabled = false;
        setTimeout(function () {
          btnMqttSave.classList.remove('saved');
          btnMqttSave.textContent = 'Save MQTT';
        }, 2000);
      });
  });
})();

// GPIO pin configuration -- fetch current pins and allow saving
(function () {
  var VALID_PINS = [0,1,2,3,4,5,6,7,8,9,10,20,21];
  var selTouch  = document.getElementById('pinTouch');
  var selBuzzer = document.getElementById('pinBuzzer');
  var selSDA    = document.getElementById('pinSDA');
  var selSCL    = document.getElementById('pinSCL');
  var btnPin    = document.getElementById('btnPinSave');
  var pinMsg    = document.getElementById('pinMsg');

  // Populate each <select> with the available GPIO options
  [selTouch, selBuzzer, selSDA, selSCL].forEach(function (sel) {
    VALID_PINS.forEach(function (p) {
      var opt = document.createElement('option');
      opt.value = p;
      opt.textContent = 'GPIO ' + p;
      sel.appendChild(opt);
    });
  });

  // Fetch current pin values from device
  fetch('/api/pins').then(function (r) { return r.json(); }).then(function (d) {
    selTouch.value  = d.touch;
    selBuzzer.value = d.buzzer;
    selSDA.value    = d.sda;
    selSCL.value    = d.scl;
  }).catch(function () {});

  btnPin.addEventListener('click', function () {
    // Client-side validation: all 4 must be distinct
    var vals = [selTouch.value, selBuzzer.value, selSDA.value, selSCL.value];
    var unique = new Set(vals);
    if (unique.size < 4) {
      pinMsg.className = 'msg error';
      pinMsg.textContent = 'All four pins must be different.';
      pinMsg.style.display = 'block';
      return;
    }

    pinMsg.className = 'msg';
    pinMsg.style.display = 'none';
    btnPin.disabled = true;

    var params = 'touch=' + selTouch.value
               + '&buzzer=' + selBuzzer.value
               + '&sda=' + selSDA.value
               + '&scl=' + selSCL.value;
    fetch('/api/pins?' + params, { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.ok) {
          pinMsg.className = 'msg ok';
          pinMsg.textContent = 'Saved. Rebooting device...';
          pinMsg.style.display = 'block';
          btnPin.textContent = 'Rebooting...';
        } else {
          pinMsg.className = 'msg error';
          pinMsg.textContent = d.error || 'Save failed.';
          pinMsg.style.display = 'block';
          btnPin.disabled = false;
        }
      })
      .catch(function () {
        pinMsg.className = 'msg error';
        pinMsg.textContent = 'Connection lost (device may be rebooting).';
        pinMsg.style.display = 'block';
        btnPin.disabled = false;
      });
  });
})();

// Settings controls -- fetch current values and send changes on input
(function () {
  var rSpeed  = document.getElementById('rSpeed');
  var rBright = document.getElementById('rBright');
  var btnMute = document.getElementById('btnMute');
  var vSpeed  = document.getElementById('vSpeed');
  var vBright = document.getElementById('vBright');
  var _muted  = false;

  function updateMuteBtn() {
    btnMute.textContent = _muted ? 'OFF' : 'ON';
    btnMute.classList.toggle('muted', _muted);
  }

  // Fetch current settings from device
  fetch('/api/settings').then(function (r) { return r.json(); }).then(function (s) {
    rSpeed.value  = s.speed;       vSpeed.textContent  = s.speed;
    rBright.value = s.brightness;  vBright.textContent = s.brightness;
    _muted = s.volume === 0;
    updateMuteBtn();
  }).catch(function () {});

  // Debounce helper -- sends POST after user stops dragging for 150ms
  var _t = null;
  function send(key, val) {
    clearTimeout(_t);
    _t = setTimeout(function () {
      fetch('/api/settings?' + key + '=' + val, { method: 'POST' });
    }, 150);
  }

  rSpeed.addEventListener('input', function () {
    vSpeed.textContent = rSpeed.value;
    send('speed', rSpeed.value);
  });
  rBright.addEventListener('input', function () {
    vBright.textContent = rBright.value;
    send('brightness', rBright.value);
  });
  btnMute.addEventListener('click', function () {
    _muted = !_muted;
    updateMuteBtn();
    send('volume', _muted ? 0 : 100);
  });

  // Save button -- persist current settings to NVS
  var btnSave = document.getElementById('btnSave');
  btnSave.addEventListener('click', function () {
    btnSave.disabled = true;
    fetch('/api/settings?save=1', { method: 'POST' })
      .then(function () {
        btnSave.classList.add('saved');
        btnSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnSave.disabled = false;
        setTimeout(function () {
          btnSave.classList.remove('saved');
          btnSave.textContent = 'Save';
        }, 2000);
      });
  });
})();

// Fetch and display storage info
async function ls() {
  try {
    var r = await (await fetch('/api/storage')).json();
    document.getElementById('sU').textContent = fmt(r.used);
    document.getElementById('sT').textContent = fmt(r.total);
    var p = r.total ? ((r.used / r.total) * 100).toFixed(1) : '0';
    document.getElementById('sP').textContent = p;
    document.getElementById('sF').style.width  = p + '%';
  } catch (e) { /* ignore */ }
}

// Fetch and display file list
async function lf() {
  try {
    var files = await (await fetch('/api/list')).json();
    var el  = document.getElementById('fl');
    // Remove old file-list and empty elements, but keep card-title and preview
    var oldList = el.querySelector('.file-list');
    if (oldList) oldList.remove();
    var oldEmpty = el.querySelector('.empty');
    if (oldEmpty) oldEmpty.remove();

    if (!files.length) {
      var emptyDiv = document.createElement('div');
      emptyDiv.className = 'empty';
      emptyDiv.textContent = 'No .qgif files yet.';
      el.appendChild(emptyDiv);
      var titleText = el.querySelector('.card-title-text');
      if (titleText) titleText.textContent = 'Files';
      return;
    }

    var titleText = el.querySelector('.card-title-text');
    if (titleText) titleText.innerHTML = 'Files <span class="file-count">' + files.length + '</span>';

    var listDiv = document.createElement('div');
    listDiv.className = 'file-list';
    listDiv.innerHTML = files.map(function (f) {
      return '<div class="file">'
        + '<span class="file-name' + (f.playing ? ' playing' : '') + '">' + f.name + '</span>'
        + '<span class="file-size">' + fmt(f.size) + '</span>'
        + '<button class="btn btn-play" onclick="pf(\'' + f.name + '\')">Play</button>'
        + '<button class="btn btn-del"  onclick="df(\'' + f.name + '\')">Del</button>'
        + '</div>';
    }).join('');
    el.appendChild(listDiv);

    // Track current playing
    _currentFile = '';
    files.forEach(function (f) { if (f.playing) _currentFile = f.name; });
  } catch (e) {
    var el = document.getElementById('fl');
    var oldList = el.querySelector('.file-list');
    if (oldList) oldList.remove();
    var oldEmpty = el.querySelector('.empty');
    if (oldEmpty) oldEmpty.remove();
    var errDiv = document.createElement('div');
    errDiv.className = 'empty';
    errDiv.textContent = 'Error loading files';
    el.appendChild(errDiv);
  }
}

// Play a file
async function pf(n) {
  await fetch('/api/play?name=' + encodeURIComponent(n), { method: 'POST' });
  lf();
}

// Delete a file
async function df(n) {
  if (!confirm('Delete ' + n + '?')) return;
  await fetch('/api/delete?name=' + encodeURIComponent(n), { method: 'POST' });
  lf();
  ls();
}

// Upload a single file
async function uf1(file) {
  var fd = new FormData();
  fd.append('file', file);
  var r = await fetch('/api/upload', { method: 'POST', body: fd });
  var d = await r.json();
  return { ok: r.ok, name: file.name, error: d.error || 'Upload failed' };
}

// Upload multiple files sequentially
async function uf(files) {
  var m = document.getElementById('msg');
  m.className = 'msg';
  m.style.display = 'none';

  var ok = 0, fail = 0, errs = [];

  for (var i = 0; i < files.length; i++) {
    m.className   = 'msg ok';
    m.textContent = 'Uploading ' + (i + 1) + '/' + files.length + ': ' + files[i].name + '...';
    m.style.display = 'block';

    try {
      var r = await uf1(files[i]);
      if (r.ok) ok++;
      else { fail++; errs.push(r.name + ': ' + r.error); }
    } catch (e) {
      fail++;
      errs.push(files[i].name + ': error');
    }
  }

  if (fail == 0) {
    m.className   = 'msg ok';
    m.textContent = 'Uploaded ' + ok + ' file' + (ok > 1 ? 's' : '') + '.';
  } else {
    m.className   = 'msg error';
    m.textContent = ok + ' ok, ' + fail + ' failed: ' + errs.join('; ');
  }
  m.style.display = 'block';
  lf();
  ls();
}

// File input handler
document.getElementById('fi').addEventListener('change', function (e) {
  if (e.target.files.length) uf(e.target.files);
  e.target.value = '';
});

// Drag-and-drop handlers
var dz = document.getElementById('dz');
dz.addEventListener('dragover', function (e) {
  e.preventDefault();
  dz.classList.add('drag');
});
dz.addEventListener('dragleave', function () {
  dz.classList.remove('drag');
});
dz.addEventListener('drop', function (e) {
  e.preventDefault();
  dz.classList.remove('drag');
  if (e.dataTransfer.files.length) uf(e.dataTransfer.files);
});

// Timezone setting -- fetch current timezone and allow saving
(function () {
  var tzSelect = document.getElementById('tzSelect');
  var btnTzSave = document.getElementById('btnTzSave');

  fetch('/api/timezone').then(function (r) { return r.json(); }).then(function (d) {
    if (d.timezone) {
      // If detected timezone isn't in the select options, add it dynamically
      var found = false;
      for (var i = 0; i < tzSelect.options.length; i++) {
        if (tzSelect.options[i].value === d.timezone) { found = true; break; }
      }
      if (!found) {
        var opt = document.createElement('option');
        opt.value = d.timezone;
        opt.textContent = d.timezone + ' (detected)';
        tzSelect.appendChild(opt);
      }
      tzSelect.value = d.timezone;
    }
  }).catch(function () {});

  btnTzSave.addEventListener('click', function () {
    btnTzSave.disabled = true;
    var params = 'tz=' + encodeURIComponent(tzSelect.value);
    fetch('/api/timezone?' + params, { method: 'POST' })
      .then(function () {
        btnTzSave.classList.add('saved');
        btnTzSave.textContent = 'Saved';
      })
      .catch(function () {})
      .finally(function () {
        btnTzSave.disabled = false;
        setTimeout(function () {
          btnTzSave.classList.remove('saved');
          btnTzSave.textContent = 'Save Timezone';
        }, 2000);
      });
  });
})();

// Theme toggle (dark / light), persisted in localStorage
(function () {
  var saved = localStorage.getItem('theme');
  if (saved === 'light') document.documentElement.classList.add('light-mode');

  var btn = document.getElementById('themeBtn');
  function updateIcon() {
    // crescent moon for dark, sun for light
    btn.innerHTML = document.documentElement.classList.contains('light-mode')
      ? '&#9728;'   // sun
      : '&#9790;';  // moon
  }
  updateIcon();

  btn.addEventListener('click', function () {
    document.documentElement.classList.toggle('light-mode');
    var isLight = document.documentElement.classList.contains('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateIcon();
  });
})();

// QGIF preview renderer
var _previewTimer = null;
var _previewFile = '';

function parseQgif(buf) {
  var view = new DataView(buf);
  var frameCount = view.getUint8(0);
  var width = view.getUint16(1, true);
  var height = view.getUint16(3, true);
  var delays = [];
  for (var i = 0; i < frameCount; i++) {
    delays.push(view.getUint16(5 + i * 2, true));
  }
  var frameSize = Math.ceil(width * height / 8);
  var dataStart = 5 + frameCount * 2;
  var frames = [];
  for (var i = 0; i < frameCount; i++) {
    frames.push(new Uint8Array(buf, dataStart + i * frameSize, frameSize));
  }
  return { frameCount: frameCount, width: width, height: height, delays: delays, frames: frames };
}

function renderFrame(ctx, frame, w, h, scale) {
  var imgData = ctx.createImageData(w * scale, h * scale);
  var data = imgData.data;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      var bitIndex = y * w + x;
      var byteIndex = Math.floor(bitIndex / 8);
      var bitPos = 7 - (bitIndex % 8);
      var bit = (frame[byteIndex] >> bitPos) & 1;
      // In qgif: 0 = pixel on (white on OLED), 1 = pixel off
      var color = bit ? 0 : 255;
      for (var sy = 0; sy < scale; sy++) {
        for (var sx = 0; sx < scale; sx++) {
          var px = ((y * scale + sy) * w * scale + (x * scale + sx)) * 4;
          data[px] = color;
          data[px + 1] = color;
          data[px + 2] = color;
          data[px + 3] = 255;
        }
      }
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

function startPreview(filename) {
  // Stop existing animation
  if (_previewTimer) { clearTimeout(_previewTimer); _previewTimer = null; }

  var wrap = document.getElementById('previewWrap');
  var canvas = document.getElementById('previewCanvas');
  var nameEl = document.getElementById('previewName');

  if (!filename) { wrap.style.display = 'none'; return; }

  _previewFile = filename;
  nameEl.textContent = filename;

  fetch('/' + encodeURIComponent(filename))
    .then(function (r) { return r.arrayBuffer(); })
    .then(function (buf) {
      if (_previewFile !== filename) return; // changed while fetching
      var qgif = parseQgif(buf);
      var scale = 2;
      canvas.width = qgif.width * scale;
      canvas.height = qgif.height * scale;
      var ctx = canvas.getContext('2d');
      wrap.style.display = 'block';

      var frameIdx = 0;
      function tick() {
        if (_previewFile !== filename) return;
        renderFrame(ctx, qgif.frames[frameIdx], qgif.width, qgif.height, scale);
        var delay = qgif.delays[frameIdx] || 100;
        frameIdx = (frameIdx + 1) % qgif.frameCount;
        _previewTimer = setTimeout(tick, delay);
      }
      tick();
    })
    .catch(function () {
      wrap.style.display = 'none';
    });
}

// Backup all .qgif files as a zip (client-side: fetch list, fetch each file via /api/file, zip with JSZip, download)
function backupAllQgif() {
  if (typeof JSZip === 'undefined') {
    alert('JSZip not loaded. Check your connection.');
    return;
  }
  var btn = document.getElementById('btnBackupAll');
  var progressWrap = document.getElementById('backupProgressWrap');
  var progressFill = document.getElementById('backupProgressFill');
  var progressPct = document.getElementById('backupProgressPct');

  function showProgress(pct) {
    progressWrap.style.display = 'flex';
    progressWrap.setAttribute('aria-hidden', 'false');
    var v = Math.round(pct || 0);
    progressFill.style.width = v + '%';
    progressPct.textContent = v + '%';
  }
  function hideProgress() {
    progressWrap.style.display = 'none';
    progressWrap.setAttribute('aria-hidden', 'true');
    progressFill.style.width = '0%';
    progressPct.textContent = '0%';
  }

  btn.disabled = true;
  showProgress(0);

  fetch('/api/list')
    .then(function (r) { return r.json(); })
    .then(function (files) {
      if (!files.length) {
        alert('No .qgif files to backup.');
        btn.disabled = false;
        hideProgress();
        return;
      }
      var zip = new JSZip();
      var done = 0;
      function next() {
        if (done >= files.length) {
          showProgress(100);
          return zip.generateAsync({ type: 'blob' }).then(function (blob) {
            var a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'qbit-qgif-backup.zip';
            a.click();
            URL.revokeObjectURL(a.href);
            btn.disabled = false;
            hideProgress();
          });
        }
        var f = files[done];
        return fetch('/api/file?name=' + encodeURIComponent(f.name))
          .then(function (r) {
            if (!r.ok) return Promise.reject(new Error('Failed to fetch ' + f.name));
            return r.arrayBuffer();
          })
          .then(function (buf) {
            zip.file(f.name, buf);
            done++;
            showProgress((done / files.length) * 100);
            return next();
          });
      }
      return next();
    })
    .catch(function (err) {
      alert('Backup failed: ' + (err && err.message ? err.message : 'unknown error'));
      btn.disabled = false;
      hideProgress();
    });
}
document.getElementById('btnBackupAll').addEventListener('click', backupAllQgif);

// Track currently playing file and sync highlighting
var _currentFile = '';

// Poll current playing file every 3 seconds
function pollCurrent() {
  fetch('/api/current').then(function (r) { return r.json(); }).then(function (d) {
    if (d.name !== _currentFile) {
      _currentFile = d.name;
      // Update file list highlighting
      document.querySelectorAll('.file-name').forEach(function (el) {
        if (el.textContent === _currentFile) {
          el.classList.add('playing');
        } else {
          el.classList.remove('playing');
        }
      });
      // Trigger preview update
      if (typeof startPreview === 'function') startPreview(_currentFile);
    }
  }).catch(function () {});
}
setInterval(pollCurrent, 3000);

// Card collapse toggle -- click card-title to expand/collapse (only collapsible cards)
(function () {
  document.querySelectorAll('.collapsible .card-title').forEach(function (title) {
    title.addEventListener('click', function () {
      title.parentElement.classList.toggle('collapsed');
    });
  });
})();

// Initial load
ls();
lf();
pollCurrent();

// ==========================================================================
//  Web Cam streaming -- captures camera, converts to 128x64 monochrome,
//  and streams packed 1024-byte frames to /ws_cam via binary WebSocket.
//  The OLED preview (256x128 canvas) mirrors exactly what the device shows.
// ==========================================================================
(function () {
  // Overlay-centric controls (YouTube-style play/pause on preview)
  var btnOverlay  = document.getElementById('btnCamOverlay');
  var btnModePrev = document.getElementById('btnCamModePrev');
  var btnModeNext = document.getElementById('btnCamModeNext');
  var preview     = document.getElementById('camPreviewCanvas');
  var camMsg      = document.getElementById('camMsg');
  var modeLabel   = document.getElementById('camModeLabel');

  var cutoffWrap  = document.getElementById('camParamCutoff');
  var cutoff      = document.getElementById('camCutoff');
  var cutoffVal   = document.getElementById('camCutoffVal');

  var bayerWrap   = document.getElementById('camParamBayer');
  var bayerSize   = document.getElementById('camBayerSize');
  var bayerStr    = document.getElementById('camBayerStrength');
  var bayerStrVal = document.getElementById('camBayerStrengthVal');

  var noiseWrap   = document.getElementById('camParamNoise');
  var noiseAmt    = document.getElementById('camNoise');
  var noiseVal    = document.getElementById('camNoiseVal');

  var W = 128, H = 64;
  var FRAME_INTERVAL_MS = 100;  // cap at ~10 FPS to suit ESP32 I2C throughput

  var _ws        = null;
  var _stream    = null;
  var _video     = null;
  var _offCvs    = null;
  var _offCtx    = null;
  var _preCtx    = preview.getContext('2d');
  var _previewImageData = _preCtx.createImageData(W * 2, H * 2);
  var _running   = false;
  var _paused    = false;
  var _starting  = false;
  var _timerId   = null;

  // Mode + parameters (live-tunable)
  var MODES = [
    { id: 'threshold', name: 'Threshold' },
    { id: 'floyd',     name: 'Floyd–Steinberg' },
    { id: 'atkinson',  name: 'Atkinson' },
    { id: 'bayer',     name: 'Bayer (ordered)' },
    { id: 'noise',     name: 'Noise' }
  ];
  // Default to Bayer (ordered) as first mode
  var _modeIdx = 3;
  var _cutoff = 128;          // used by all modes as the baseline cutoff
  var _bayerStrength = 96;    // 0..255
  var _bayerN = 8;            // 4 or 8
  var _noise = 24;            // 0..128

  // Scratch buffers (reused per frame to avoid allocations)
  var _luma = new Uint8Array(W * H);
  var _diff = new Float32Array(W * H);

  function showMsg(text, isErr) {
    camMsg.textContent    = text;
    camMsg.className      = 'msg ' + (isErr ? 'error' : 'ok');
    camMsg.style.display  = text ? 'block' : 'none';
  }

  function computeLuma(pixels) {
    // Uint8 luma is enough and faster; any diffusion mode copies into _diff as float
    for (var i = 0, p = 0; i < W * H; i++, p += 4) {
      var l = 0.299 * pixels[p] + 0.587 * pixels[p + 1] + 0.114 * pixels[p + 2];
      _luma[i] = (l + 0.5) | 0;
    }
  }

  // Common helper: write bit=1 for dark pixel, bit=0 for lit pixel (QGIF convention)
  function setPixel(out, idx, isDark) {
    if (isDark) out[idx >> 3] |= (1 << (7 - (idx & 7)));
  }

  // Simple luminance threshold (fastest)
  function packThresholdFromLuma() {
    var out = new Uint8Array(W * H >> 3);
    for (var i = 0; i < W * H; i++) {
      setPixel(out, i, _luma[i] < _cutoff);
    }
    return out;
  }

  // Floyd–Steinberg error diffusion dithering
  function packFloyd() {
    // init diffusion buffer from luma
    for (var i = 0; i < W * H; i++) _diff[i] = _luma[i];

    var out = new Uint8Array(W * H >> 3);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var idx = y * W + x;
        var v   = _diff[idx];
        var isDark = v < _cutoff;
        setPixel(out, idx, isDark);
        var pix = isDark ? 0 : 255;
        var qe  = v - pix;
        if (x + 1 < W) _diff[idx + 1] += qe * 7 / 16;
        if (y + 1 < H) {
          if (x > 0)     _diff[idx + W - 1] += qe * 3 / 16;
                          _diff[idx + W]     += qe * 5 / 16;
          if (x + 1 < W) _diff[idx + W + 1] += qe * 1 / 16;
        }
      }
    }
    return out;
  }

  // Atkinson dithering (lighter diffusion)
  function packAtkinson() {
    for (var i = 0; i < W * H; i++) _diff[i] = _luma[i];
    var out = new Uint8Array(W * H >> 3);
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var idx = y * W + x;
        var v = _diff[idx];
        var isDark = v < _cutoff;
        setPixel(out, idx, isDark);
        var pix = isDark ? 0 : 255;
        var err = (v - pix) / 8;

        // distribute to 6 neighbors
        if (x + 1 < W) _diff[idx + 1] += err;
        if (x + 2 < W) _diff[idx + 2] += err;
        if (y + 1 < H) {
          if (x > 0)     _diff[idx + W - 1] += err;
                          _diff[idx + W]     += err;
          if (x + 1 < W) _diff[idx + W + 1] += err;
        }
        if (y + 2 < H) _diff[idx + 2 * W] += err;
      }
    }
    return out;
  }

  // Ordered dithering using Bayer matrix (4x4 or 8x8)
  var BAYER_4 = [
     0,  8,  2, 10,
    12,  4, 14,  6,
     3, 11,  1,  9,
    15,  7, 13,  5
  ];
  var BAYER_8 = [
     0, 48, 12, 60,  3, 51, 15, 63,
    32, 16, 44, 28, 35, 19, 47, 31,
     8, 56,  4, 52, 11, 59,  7, 55,
    40, 24, 36, 20, 43, 27, 39, 23,
     2, 50, 14, 62,  1, 49, 13, 61,
    34, 18, 46, 30, 33, 17, 45, 29,
    10, 58,  6, 54,  9, 57,  5, 53,
    42, 26, 38, 22, 41, 25, 37, 21
  ];
  function packBayer() {
    var out = new Uint8Array(W * H >> 3);
    var mat = (_bayerN === 4) ? BAYER_4 : BAYER_8;
    var n = _bayerN;
    var denom = n * n;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var idx = y * W + x;
        var m = mat[(y % n) * n + (x % n)]; // 0..denom-1
        // Map matrix to [-strength/2, +strength/2]
        var bias = ((m / (denom - 1)) - 0.5) * _bayerStrength;
        setPixel(out, idx, (_luma[idx] + bias) < _cutoff);
      }
    }
    return out;
  }

  // Noise dithering (randomized threshold)
  function packNoise() {
    var out = new Uint8Array(W * H >> 3);
    var a = _noise;
    for (var i = 0; i < W * H; i++) {
      var jitter = (Math.random() - 0.5) * a * 2; // [-a, +a]
      setPixel(out, i, (_luma[i] + jitter) < _cutoff);
    }
    return out;
  }

  // Render the packed frame back onto the preview canvas (2× scale)
  function renderPreview(frame) {
    var imgData = _previewImageData;
    var d = imgData.data;
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var idx = y * W + x;
        var bit = (frame[idx >> 3] >> (7 - (idx & 7))) & 1;
        var col = bit ? 0 : 255;   // bit 1 = dark, bit 0 = lit
        for (var sy = 0; sy < 2; sy++) {
          for (var sx = 0; sx < 2; sx++) {
            var p = ((y * 2 + sy) * W * 2 + (x * 2 + sx)) * 4;
            d[p] = d[p + 1] = d[p + 2] = col; d[p + 3] = 255;
          }
        }
      }
    }
    _preCtx.putImageData(imgData, 0, 0);
  }

  function sendFrame() {
    _timerId = null;
    if (!_running || _paused || !_ws || _ws.readyState !== WebSocket.OPEN) return;
    // Draw the video frame mirrored (natural selfie orientation) into the 128x64 canvas
    _offCtx.drawImage(_video, 0, 0, W, H);
    var pixels = _offCtx.getImageData(0, 0, W, H).data;
    computeLuma(pixels);

    var mode = MODES[_modeIdx].id;
    var frame;
    if (mode === 'threshold') frame = packThresholdFromLuma();
    else if (mode === 'floyd') frame = packFloyd();
    else if (mode === 'atkinson') frame = packAtkinson();
    else if (mode === 'bayer') frame = packBayer();
    else if (mode === 'noise') frame = packNoise();
    else frame = packThresholdFromLuma();
    renderPreview(frame);
    _ws.send(frame.buffer);
    _timerId = setTimeout(sendFrame, FRAME_INTERVAL_MS);
  }

  function setControlsEnabled(on) {
    btnModePrev.disabled = !on;
    btnModeNext.disabled = !on;

    cutoff.disabled = !on;
    bayerSize.disabled = !on;
    bayerStr.disabled = !on;
    noiseAmt.disabled = !on;

    cutoffWrap.style.display = on ? 'flex' : 'none';
    // other param blocks visibility is controlled by updateModeUI()
  }

  function updateModeUI() {
    var m = MODES[_modeIdx];
    modeLabel.textContent = m.name;

    // default: hide all param rows; show cutoff always while running
    bayerWrap.style.display = 'none';
    noiseWrap.style.display = 'none';
    cutoffWrap.style.display = _running ? 'flex' : 'none';

    if (_running) {
      if (m.id === 'bayer') bayerWrap.style.display = 'flex';
      if (m.id === 'noise') noiseWrap.style.display = 'flex';
    }
  }

  // optionalMessage: if provided, show as error after stopping (e.g. "busy" or close reason)
  function stop(optionalMessage) {
    _starting = false;
    _running  = false;
    _paused   = false;
    if (_timerId)  { clearTimeout(_timerId); _timerId = null; }
    if (_ws)       { _ws.close(); _ws = null; }
    if (_stream)   { _stream.getTracks().forEach(function (t) { t.stop(); }); _stream = null; }
    _video = null;

    // Hide/disable mode + params when not streaming
    setControlsEnabled(false);
    updateModeUI();
    showMsg(optionalMessage ? optionalMessage : '', !!optionalMessage);

    // Show play overlay when stopped
    btnOverlay.classList.remove('hidden');
    btnOverlay.classList.remove('is-pause');
  }

  function pauseStream() {
    if (!_running || _paused) return;
    _paused = true;
    if (_timerId) { clearTimeout(_timerId); _timerId = null; }
    btnOverlay.classList.remove('hidden');
    btnOverlay.classList.remove('is-pause');
    btnOverlay.classList.add('pulse');
    setTimeout(function () { btnOverlay.classList.remove('pulse'); }, 300);
  }

  function resumeStream() {
    if (!_running || !_paused) return;
    _paused = false;
    btnOverlay.classList.add('hidden');
    btnOverlay.classList.add('pulse');
    setTimeout(function () { btnOverlay.classList.remove('pulse'); }, 300);
    sendFrame();
  }

  function setOverlayState() {
    if (_running && !_paused) btnOverlay.classList.add('is-pause');
    else btnOverlay.classList.remove('is-pause');
  }

  function openWs() {
    var proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    _ws = new WebSocket(proto + '//' + window.location.host + '/ws_cam');
    _ws.binaryType = 'arraybuffer';

    _ws.onopen = function () {
      _running = true;
      _paused = false;
      _starting = false;

      // Enable mode + params once streaming starts
      setControlsEnabled(true);
      updateModeUI();
      showMsg('Streaming \u2014 tap device to exit.', false);
      setOverlayState();
      btnOverlay.classList.add('hidden');
      sendFrame();
    };

    _ws.onmessage = function (evt) {
      // Server may send a JSON text message (e.g. busy) before closing.
      if (typeof evt.data !== 'string') return;
      try {
        var msg = JSON.parse(evt.data);
        if (msg && msg.error === 'busy') {
          stop('Web Cam is in use by another client.');
          return;
        }
      } catch (e) {
        // Ignore non-JSON text
      }
    };

    _ws.onclose = function (evt) {
      // If we already stopped (e.g. from onmessage busy), keep the current message visible.
      if (!_running) {
        _starting = false;
        return;
      }
      _starting = false;
      var reason = (evt && evt.reason) ? evt.reason : '';
      if (reason) stop(reason);
      else stop();
    };
    _ws.onerror = function () {
      _starting = false;
      showMsg('WebSocket error.', true);
      stop();
    };
  }

  function start() {
    if (_starting || _running) return;
    _starting = true;

    // getUserMedia requires a secure context (HTTPS or localhost).
    // http://qbit.local is blocked by all modern browsers.
    if (!window.isSecureContext) {
      var isChrome = /Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent);
      var host = 'http://' + window.location.host;
      var msg;
      if (isChrome) {
        msg = 'Camera blocked: browser requires HTTPS for camera access.\n\n'
            + 'To fix in Chrome:\n'
            + '1. Open chrome://flags/#unsafely-treat-insecure-origin-as-secure\n'
            + '2. Add ' + host + '\n'
            + '3. Click Relaunch.';
      } else {
        msg = 'Camera blocked: browser requires HTTPS for camera access.\n\n'
            + 'Open this page in Chrome and enable the "Insecure origins treated as secure" flag for ' + host + '.';
      }
      showMsg(msg, true);
      _starting = false;
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showMsg('Camera API not available in this browser.', true);
      _starting = false;
      return;
    }
    btnOverlay.classList.add('pulse');
    setTimeout(function () { btnOverlay.classList.remove('pulse'); }, 300);
    showMsg('Requesting camera access...');

    navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 128 }, height: { ideal: 64 }, facingMode: 'user' }
    }).then(function (stream) {
      _stream = stream;
      _video  = document.createElement('video');
      _video.srcObject  = stream;
      _video.muted      = true;
      _video.playsInline = true;

      // Off-screen 128x64 canvas; mirror horizontally for natural selfie view
      _offCvs = document.createElement('canvas');
      _offCvs.width  = W;
      _offCvs.height = H;
      _offCtx = _offCvs.getContext('2d', { willReadFrequently: true });
      _offCtx.translate(W, 0);
      _offCtx.scale(-1, 1);

      _video.addEventListener('canplay', function onCanPlay() {
        _video.removeEventListener('canplay', onCanPlay);
        _video.play().catch(function () {});
        openWs();
      });
    }).catch(function (err) {
      showMsg('Camera denied: ' + (err.message || err), true);
      btnOverlay.classList.remove('hidden');
      _starting = false;
    });
  }

  function onOverlayClick() {
    if (!_running) {
      start();
      return;
    }
    if (_paused) resumeStream();
    else pauseStream();
    setOverlayState();
  }

  btnOverlay.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    onOverlayClick();
  });

  preview.addEventListener('click', function () {
    if (!_running) return;
    if (_paused) {
      onOverlayClick();
      return;
    }
    setOverlayState();
    btnOverlay.classList.remove('hidden');
    btnOverlay.classList.add('pulse');
    setTimeout(function () { btnOverlay.classList.remove('pulse'); }, 300);
    setTimeout(function () {
      if (_running && !_paused) btnOverlay.classList.add('hidden');
    }, 1200);
  });

  function cycleMode(dir) {
    if (!_running || _paused) return;
    _modeIdx = (_modeIdx + dir) % MODES.length;
    if (_modeIdx < 0) _modeIdx += MODES.length;
    updateModeUI();
  }
  btnModePrev.addEventListener('click', function () { cycleMode(-1); });
  btnModeNext.addEventListener('click', function () { cycleMode(1); });

  // Cutoff: live-adjust baseline cutoff while streaming
  cutoff.addEventListener('input', function () {
    var v = parseInt(cutoff.value, 10);
    if (isNaN(v)) v = 128;
    _cutoff = v;
    cutoffVal.textContent = String(v);
  });

  // Bayer params
  bayerSize.addEventListener('change', function () {
    var v = parseInt(bayerSize.value, 10);
    if (v !== 4 && v !== 8) v = 8;
    _bayerN = v;
  });
  bayerStr.addEventListener('input', function () {
    var v = parseInt(bayerStr.value, 10);
    if (isNaN(v)) v = 96;
    _bayerStrength = v;
    bayerStrVal.textContent = String(v);
  });

  // Noise param
  noiseAmt.addEventListener('input', function () {
    var v = parseInt(noiseAmt.value, 10);
    if (isNaN(v)) v = 24;
    _noise = v;
    noiseVal.textContent = String(v);
  });

  // Initial UI state (not streaming)
  setControlsEnabled(false);
  updateModeUI();
  btnOverlay.classList.remove('hidden');
  setOverlayState();
})();
