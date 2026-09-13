/* GucciBot macro converter.
 *
 * Everything here is written from scratch against format layouts. No other
 * converter's code is used -- file formats themselves aren't copyrightable,
 * implementations are, and we don't have permission to use anyone else's.
 *
 * Internal representation, which every format converts to and from:
 *   { tps: number, inputs: [ { frame, button, down, player2 } ] }
 *   button: 1 = jump, 2 = left, 3 = right   (GD's own numbering)
 *   down:   true = press, false = release
 *
 * Each format declares a confidence level, surfaced in the UI:
 *   'ok'   verified against real files
 *   'exp'  implemented but NOT yet confirmed against real-world macros
 *   'soon' not wired up
 * Be honest with these. A wrong label is worse than a missing format.
 */
(function () {
  'use strict';

  var BTN = { 1: 'Jump', 2: 'Left', 3: 'Right' };

  function num(v, dflt) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : dflt;
  }

  /* ---------------------------------------------------------------- formats */

  var FORMATS = {
    plaintext: {
      name: 'Plain Text',
      ext: '.txt',
      group: 'General',
      confidence: 'ok',
      note: 'Our own layout, documented on this page.',
      detect: function (name, text) {
        if (!text) return false;
        return /^\s*(#|\d+\s+\d+)/.test(text);
      },
      read: function (buf, text) {
        var inputs = [];
        var tps = 240;
        text.split(/\r?\n/).forEach(function (line) {
          line = line.trim();
          if (!line) return;
          if (line[0] === '#') {
            var m = /tps\s*[:=]\s*([0-9.]+)/i.exec(line);
            if (m) tps = num(m[1], 240);
            return;
          }
          var p = line.split(/\s+/);
          if (p.length < 2) return;
          inputs.push({
            frame: num(p[0], 0) | 0,
            button: p.length > 1 ? (num(p[1], 1) | 0) : 1,
            down: p.length > 2 ? p[2] !== '0' : true,
            player2: p.length > 3 ? p[3] !== '0' : false
          });
        });
        return { tps: tps, inputs: inputs };
      },
      write: function (rep) {
        var out = ['# GucciBot converter plain text', '# tps: ' + rep.tps,
                   '# frame button down player2'];
        rep.inputs.forEach(function (i) {
          out.push(i.frame + ' ' + i.button + ' ' + (i.down ? 1 : 0) + ' ' + (i.player2 ? 1 : 0));
        });
        return new TextEncoder().encode(out.join('\n'));
      }
    },

    gdrjson: {
      name: 'GDR (JSON)',
      ext: '.gdr.json',
      group: 'Current',
      confidence: 'exp',
      note: 'Structure follows GDReplayFormat. Not yet checked against real files.',
      detect: function (name, text) {
        if (!text) return false;
        try {
          var j = JSON.parse(text);
          return !!(j && j.inputs && (j.framerate !== undefined || j.fps !== undefined));
        } catch (e) { return false; }
      },
      read: function (buf, text) {
        var j = JSON.parse(text);
        var inputs = (j.inputs || []).map(function (i) {
          return {
            frame: num(i.frame, 0) | 0,
            button: num(i.btn !== undefined ? i.btn : i.button, 1) | 0,
            down: i.down !== undefined ? !!i.down : !!i.hold,
            player2: !!(i.p2 !== undefined ? i.p2 : i.player2)
          };
        });
        return { tps: num(j.framerate !== undefined ? j.framerate : j.fps, 240), inputs: inputs };
      },
      write: function (rep) {
        var j = {
          gameVersion: 2.2, description: 'Converted by GucciBot',
          version: 1, duration: 0, botInfo: { name: 'GucciBot', version: '1.7' },
          levelInfo: { id: 0, name: '', }, framerate: rep.tps, seed: 0, coins: 0,
          ldm: false, inputs: rep.inputs.map(function (i) {
            return { frame: i.frame, btn: i.button, p2: i.player2, down: i.down };
          })
        };
        return new TextEncoder().encode(JSON.stringify(j, null, 2));
      }
    },

    tasbot: {
      name: 'TASBot',
      ext: '.json',
      group: 'Legacy (2.1)',
      confidence: 'exp',
      note: 'Implemented from the documented layout; unverified.',
      detect: function (name, text) {
        if (!text) return false;
        try { var j = JSON.parse(text); return !!(j && j.macro && j.fps !== undefined); }
        catch (e) { return false; }
      },
      read: function (buf, text) {
        var j = JSON.parse(text);
        var inputs = [];
        (j.macro || []).forEach(function (e) {
          var f = num(e.frame, 0) | 0;
          [['player_1', false], ['player_2', true]].forEach(function (pair) {
            var p = e[pair[0]];
            if (!p || p.click === undefined) return;
            var c = num(p.click, 0) | 0;
            if (c === 0) return;
            inputs.push({ frame: f, button: 1, down: c === 1, player2: pair[1] });
          });
        });
        return { tps: num(j.fps, 240), inputs: inputs };
      },
      write: function (rep) {
        var byFrame = {};
        rep.inputs.forEach(function (i) {
          if (i.button !== 1) return;
          if (!byFrame[i.frame]) byFrame[i.frame] = { frame: i.frame };
          byFrame[i.frame][i.player2 ? 'player_2' : 'player_1'] = {
            click: i.down ? 1 : 2, x_position: 0
          };
        });
        var macro = Object.keys(byFrame).map(Number).sort(function (a, b) { return a - b; })
          .map(function (f) { return byFrame[f]; });
        return new TextEncoder().encode(JSON.stringify({ fps: rep.tps, macro: macro }, null, 2));
      }
    },

    mhrjson: {
      name: 'Mega Hack Replay (JSON)',
      ext: '.mhr.json',
      group: 'Legacy (2.1)',
      confidence: 'exp',
      note: 'Implemented from the documented layout; unverified.',
      detect: function (name, text) {
        if (!text) return false;
        try { var j = JSON.parse(text); return !!(j && j.events && j.meta); }
        catch (e) { return false; }
      },
      read: function (buf, text) {
        var j = JSON.parse(text);
        var inputs = (j.events || []).filter(function (e) { return e.down !== undefined; })
          .map(function (e) {
            return {
              frame: num(e.frame, 0) | 0, button: 1,
              down: !!e.down, player2: !!e.p2
            };
          });
        return { tps: num(j.meta && j.meta.fps, 240), inputs: inputs };
      },
      write: function (rep) {
        var j = {
          meta: { fps: rep.tps, bot: 'GucciBot' },
          events: rep.inputs.filter(function (i) { return i.button === 1; }).map(function (i) {
            return { frame: i.frame, down: i.down, p2: i.player2 };
          })
        };
        return new TextEncoder().encode(JSON.stringify(j, null, 2));
      }
    },

    echojson: {
      name: 'Echo (New JSON)',
      ext: '.echo',
      group: 'Legacy (2.1)',
      confidence: 'exp',
      note: 'Implemented from the documented layout; unverified.',
      detect: function (name, text) {
        if (!text) return false;
        try {
          var j = JSON.parse(text);
          return !!(j && (j.macro || j.inputs) && (j.fps !== undefined || j.FPS !== undefined));
        } catch (e) { return false; }
      },
      read: function (buf, text) {
        var j = JSON.parse(text);
        var arr = j.macro || j.inputs || [];
        var inputs = arr.map(function (e) {
          return {
            frame: num(e.frame !== undefined ? e.frame : e.Frame, 0) | 0,
            button: 1,
            down: !!(e.hold !== undefined ? e.hold : e.Hold),
            player2: !!(e.player_2 !== undefined ? e.player_2 : e.Player2)
          };
        });
        return { tps: num(j.fps !== undefined ? j.fps : j.FPS, 240), inputs: inputs };
      },
      write: function (rep) {
        var j = {
          fps: rep.tps,
          macro: rep.inputs.filter(function (i) { return i.button === 1; }).map(function (i) {
            return { frame: i.frame, hold: i.down, player_2: i.player2 };
          })
        };
        return new TextEncoder().encode(JSON.stringify(j, null, 2));
      }
    },

    xdbot: {
      name: 'xdBot',
      ext: '.json',
      group: 'Current',
      confidence: 'exp',
      note: 'Implemented from the documented layout; unverified.',
      detect: function (name, text) {
        if (!text) return false;
        try {
          var j = JSON.parse(text);
          return !!(j && j.inputs && Array.isArray(j.inputs) && j.inputs.length &&
                    Array.isArray(j.inputs[0]));
        } catch (e) { return false; }
      },
      read: function (buf, text) {
        var j = JSON.parse(text);
        var inputs = (j.inputs || []).map(function (a) {
          return {
            frame: num(a[0], 0) | 0, button: num(a[1], 1) | 0,
            down: !!a[2], player2: !!a[3]
          };
        });
        return { tps: num(j.fps || j.framerate, 240), inputs: inputs };
      },
      write: function (rep) {
        var j = {
          fps: rep.tps,
          inputs: rep.inputs.map(function (i) {
            return [i.frame, i.button, i.down, i.player2];
          })
        };
        return new TextEncoder().encode(JSON.stringify(j, null, 2));
      }
    }
  };

  /* Declared but not implemented -- listed so the page is honest about what
   * it does and doesn't do, rather than quietly omitting them. */
  var PLANNED = [
    ['GucciBot .brrr (GBR6)', 'GucciBot'],
    ['Silicate v1 / v2 / v3', 'Current'],
    ['GDR (binary)', 'Current'],
    ['TcBot', 'Current'],
    ['OmegaBot 1 / 2 / 3', 'Legacy (2.1)'],
    ['ReplayBot', 'Legacy (2.1)'],
    ['Mega Hack Replay (binary)', 'Legacy (2.1)'],
    ['Echo (old / binary)', 'Legacy (2.1)'],
    ['yBot 1 / yBot 2', 'Legacy (2.1)'],
    ['zBot', 'Legacy (2.1)'],
    ['xBot', 'Legacy (2.1)'],
    ['KD-Bot', 'Legacy (2.1)'],
    ['Fembot', 'Legacy (2.1)'],
    ['Rush', 'Legacy (2.1)']
  ];

  /* ------------------------------------------------------------------- state */

  var original = null;   // as loaded, never mutated
  var current = null;    // working copy

  var $ = function (id) { return document.getElementById(id); };

  function clone(rep) {
    return { tps: rep.tps, inputs: rep.inputs.map(function (i) { return Object.assign({}, i); }) };
  }

  function detect(name, buf, text) {
    for (var k in FORMATS) {
      try { if (FORMATS[k].detect(name, text)) return k; } catch (e) {}
    }
    return null;
  }

  function show(kind, html) {
    var m = $('msg');
    m.className = 'msg ' + kind;
    m.innerHTML = html;
  }

  function refresh() {
    if (!current) return;
    $('s-count').textContent = current.inputs.length.toLocaleString();
    $('s-tps').textContent = current.tps;
    var body = $('tbody');
    body.innerHTML = '';
    var LIMIT = 500;
    current.inputs.slice(0, LIMIT).forEach(function (i, n) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + (n + 1) + '</td><td>' + i.frame + '</td>' +
        '<td class="' + (i.down ? '' : 'rel') + '">' + (i.down ? 'Press' : 'Release') + '</td>' +
        '<td>' + (BTN[i.button] || i.button) + '</td>' +
        '<td class="' + (i.player2 ? 'p2' : '') + '">' + (i.player2 ? 'P2' : 'P1') + '</td>';
      body.appendChild(tr);
    });
    $('tbl-note').textContent = current.inputs.length > LIMIT
      ? '(showing first ' + LIMIT + ' of ' + current.inputs.length.toLocaleString() + ')' : '';
  }

  /* -------------------------------------------------------------------- load */

  function load(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var buf = new Uint8Array(reader.result);
      var text = null;
      try { text = new TextDecoder('utf-8', { fatal: false }).decode(buf); } catch (e) {}

      var key = detect(file.name, buf, text);
      if (!key) {
        $('loaded').classList.remove('hidden');
        $('s-name').textContent = file.name;
        $('s-fmt').textContent = 'Unknown';
        show('err', '<strong>Couldn\'t recognise that format.</strong> It may be one of the ' +
          'binary formats still listed as planned below &mdash; those genuinely aren\'t ' +
          'implemented yet, so this isn\'t a bug in your file.');
        current = original = { tps: 240, inputs: [] };
        refresh();
        return;
      }

      try {
        original = FORMATS[key].read(buf, text);
      } catch (e) {
        show('err', '<strong>Failed to read that file.</strong> ' + (e && e.message ? e.message : e));
        return;
      }
      current = clone(original);

      $('loaded').classList.remove('hidden');
      $('s-name').textContent = file.name;
      $('s-fmt').textContent = FORMATS[key].name;
      $('s-size').textContent = (buf.length / 1024).toFixed(1) + ' KB';
      $('outtps').value = current.tps;
      refresh();

      if (FORMATS[key].confidence === 'exp') {
        show('err', '<strong>Heads up:</strong> ' + FORMATS[key].name + ' is marked ' +
          'experimental &mdash; it\'s implemented but hasn\'t been confirmed against real ' +
          'macros yet. Check the result in-game before relying on it.');
      } else {
        show('good', 'Loaded ' + current.inputs.length.toLocaleString() + ' inputs as ' +
          FORMATS[key].name + '.');
      }
    };
    reader.readAsArrayBuffer(file);
  }

  /* -------------------------------------------------------------------- init */

  function init() {
    // Output format dropdown, grouped.
    var sel = $('outfmt');
    var groups = {};
    Object.keys(FORMATS).forEach(function (k) {
      var f = FORMATS[k];
      (groups[f.group] = groups[f.group] || []).push([k, f]);
    });
    Object.keys(groups).forEach(function (g) {
      var og = document.createElement('optgroup');
      og.label = g;
      groups[g].forEach(function (pair) {
        var o = document.createElement('option');
        o.value = pair[0];
        o.textContent = pair[1].name + (pair[1].confidence === 'exp' ? '  (experimental)' : '');
        og.appendChild(o);
      });
      sel.appendChild(og);
    });

    // Format support list.
    var list = $('fmtlist');
    var rows = [];
    Object.keys(FORMATS).forEach(function (k) {
      rows.push([FORMATS[k].name, FORMATS[k].confidence, FORMATS[k].group]);
    });
    PLANNED.forEach(function (p) { rows.push([p[0], 'soon', p[1]]); });
    rows.forEach(function (r) {
      var d = document.createElement('div');
      d.className = 'fmt-item';
      d.innerHTML = r[0] + '<span class="tag ' + r[1] + '">' +
        (r[1] === 'ok' ? 'verified' : r[1] === 'exp' ? 'experimental' : 'planned') + '</span>';
      list.appendChild(d);
    });

    // Drop zone.
    var drop = $('drop');
    drop.addEventListener('click', function () { $('file').click(); });
    $('file').addEventListener('change', function (e) {
      if (e.target.files && e.target.files[0]) load(e.target.files[0]);
    });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault(); drop.classList.remove('over');
      });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer.files && e.dataTransfer.files[0]) load(e.dataTransfer.files[0]);
    });

    // Edit tools.
    $('b-offset').addEventListener('click', function () {
      var d = parseInt($('offset').value, 10) || 0;
      current.inputs.forEach(function (i) { i.frame = Math.max(0, i.frame + d); });
      refresh(); show('good', 'Shifted every input by ' + d + ' frame(s).');
    });
    $('b-sort').addEventListener('click', function () {
      current.inputs.sort(function (a, b) { return a.frame - b.frame; });
      refresh(); show('good', 'Sorted by frame.');
    });
    $('b-clean').addEventListener('click', function () {
      var before = current.inputs.length;
      var seen = {}, held = {}, out = [];
      current.inputs.slice().sort(function (a, b) { return a.frame - b.frame; })
        .forEach(function (i) {
          var key = i.frame + ':' + i.button + ':' + (i.player2 ? 1 : 0) + ':' + (i.down ? 1 : 0);
          if (seen[key]) return;
          seen[key] = true;
          var hk = i.button + ':' + (i.player2 ? 1 : 0);
          if (!i.down && !held[hk]) return;   // release with no press
          held[hk] = i.down;
          out.push(i);
        });
      current.inputs = out;
      refresh();
      show('good', 'Cleaned: ' + (before - out.length) + ' input(s) removed.');
    });
    $('b-rm1').addEventListener('click', function () {
      current.inputs = current.inputs.filter(function (i) { return i.player2; });
      refresh(); show('good', 'Removed all player 1 inputs.');
    });
    $('b-rm2').addEventListener('click', function () {
      current.inputs = current.inputs.filter(function (i) { return !i.player2; });
      refresh(); show('good', 'Removed all player 2 inputs.');
    });
    $('b-reset').addEventListener('click', function () {
      current = clone(original); $('outtps').value = current.tps;
      refresh(); show('good', 'Reverted to the file as loaded.');
    });

    // Plain text editor.
    $('b-text').addEventListener('click', function () {
      $('textpanel').classList.toggle('hidden');
    });
    $('b-textdump').addEventListener('click', function () {
      $('textarea').value = new TextDecoder().decode(FORMATS.plaintext.write(current));
    });
    $('b-textload').addEventListener('click', function () {
      try {
        current = FORMATS.plaintext.read(null, $('textarea').value);
        refresh(); show('good', 'Loaded ' + current.inputs.length + ' inputs from text.');
      } catch (e) {
        show('err', 'Couldn\'t parse that text: ' + (e && e.message ? e.message : e));
      }
    });

    // Save.
    $('b-save').addEventListener('click', function () {
      if (!current || !current.inputs.length) {
        show('err', 'Nothing to save &mdash; load a macro first.');
        return;
      }
      var key = $('outfmt').value;
      var f = FORMATS[key];
      var out = clone(current);
      out.tps = parseFloat($('outtps').value) || current.tps;
      var bytes;
      try {
        bytes = f.write(out);
      } catch (e) {
        show('err', 'Failed to write that format: ' + (e && e.message ? e.message : e));
        return;
      }
      var base = ($('s-name').textContent || 'macro').replace(/\.[^.]+$/, '');
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = base + f.ext;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      show(f.confidence === 'ok' ? 'good' : 'err',
        'Saved as ' + f.name + '. ' + (f.confidence === 'ok' ? '' :
        '<strong>This format is experimental &mdash; test it in-game before trusting it, ' +
        'and keep your original.</strong>'));
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
