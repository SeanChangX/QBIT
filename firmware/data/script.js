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
    var params = 'host=' + encodeURIComponent(mqttHost.value)
               + '&port=' + encodeURIComponent(mqttPort.value)
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
      // Update card title (remove file count)
      var titleEl = el.querySelector('.card-title');
      if (titleEl) titleEl.innerHTML = 'Files';
      return;
    }

    // Update card title with file count
    var titleEl = el.querySelector('.card-title');
    if (titleEl) titleEl.innerHTML = 'Files <span class="file-count">' + files.length + '</span>';

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
