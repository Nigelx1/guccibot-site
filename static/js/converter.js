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

  /* GucciBot's own .brrr (GBR6). Ported directly from this project's own
   * src/core/gbr6_format.cpp, so this one is actually accurate rather than
   * inferred -- it's the only binary format here we own the source of truth
   * for.
   *
   * Container: "GBR6" magic, u8 version, u8 flags, f32 tps, i64 timestamp,
   * u64 rngSeed, u32 p1size, u32 p2size, str name, p1 stream, p2 stream,
   * then optional level name / death list per flags. All little-endian.
   * Strings are u16 length + bytes.
   *
   * Per-player stream opcodes, read two bytes at a time:
   *   b0 == 0x00            autoclicker run: b1 = hold<<4|release, then u16
   *                         cycle count. Expands to cycles x (press, release).
   *   b1 == 0xFF            delta continuation, adds 255 and carries.
   *   b0 top bit clear      tap: hold = b0 & 0x7F, gap = b1. One press+release.
   *   otherwise             single input: p2 = bit4, button = bits1-3,
   *                         pressed = bit0, delta = b1. b0 == 0x80 is a pure
   *                         delta marker and emits nothing.
   */
  var GBR6_MAGIC = [0x47, 0x42, 0x52, 0x36]; // "GBR6"
  var GBR6_TWO_PLAYER = 1, GBR6_HAS_LEVELNAME = 16, GBR6_HAS_DEATHS = 32;

  function gbr6DecodeStream(bytes, isP2) {
    var out = [], frame = 0, i = 0, pending = 0;
    while (i + 1 < bytes.length) {
      var b0 = bytes[i], b1 = bytes[i + 1];
      i += 2;

      if (b0 === 0x00) {
        if (i + 1 >= bytes.length) break;
        var cycles = bytes[i] | (bytes[i + 1] << 8);
        i += 2;
        var hold = (b1 >> 4) & 0x0F, rel = b1 & 0x0F;
        if (!hold || !rel || !cycles) continue;
        frame += pending; pending = 0;
        for (var c = 0; c < cycles; c++) {
          out.push({ frame: frame, button: 1, down: true, player2: isP2 });
          frame += hold;
          out.push({ frame: frame, button: 1, down: false, player2: isP2 });
          frame += rel;
        }
        continue;
      }

      if (b1 === 0xFF) {
        pending += 255;
        if (b0 === 0x80) continue;
        if (!(b0 & 0x80)) {
          var h = b0 & 0x7F;
          frame += pending; pending = 0;
          out.push({ frame: frame, button: 1, down: true, player2: isP2 });
          frame += h;
          out.push({ frame: frame, button: 1, down: false, player2: isP2 });
        }
        continue;
      }

      if (!(b0 & 0x80)) {
        var hd = b0 & 0x7F;
        frame += pending + b1; pending = 0;
        out.push({ frame: frame, button: 1, down: true, player2: isP2 });
        frame += hd;
        out.push({ frame: frame, button: 1, down: false, player2: isP2 });
        continue;
      }

      var p2 = ((b0 >> 4) & 0x01) === 1;
      var btn = (b0 >> 1) & 0x07;
      var pressed = (b0 & 0x01) === 1;
      frame += pending + b1; pending = 0;
      if (b0 === 0x80) continue;
      out.push({ frame: frame, button: btn === 0 ? 1 : btn, down: pressed, player2: p2 || isP2 });
    }
    return out;
  }

  /* Writes the plain per-input encoding only -- no autoclicker run packing.
   * That's purely a size optimisation in the original encoder; omitting it
   * produces a larger but completely valid stream that GucciBot decodes
   * identically. Correctness over bytes saved. */
  function gbr6EncodeStream(inputs) {
    var out = [], prev = 0;
    inputs.slice().sort(function (a, b) { return a.frame - b.frame; }).forEach(function (inp) {
      var delta = Math.max(0, inp.frame - prev);
      var b0 = 0x80 | ((inp.player2 ? 1 : 0) << 4) | ((inp.button & 0x07) << 1) | (inp.down ? 1 : 0);
      while (delta > 254) { out.push(b0, 0xFF); delta -= 255; }
      out.push(b0, delta);
      prev = inp.frame;
    });
    return out;
  }

  /* LEB128 varints -- used by ToastyReplay Lite. */
  function readVarints(bytes, start) {
    var out = [], i = start || 0;
    while (i < bytes.length) {
      var v = 0, shift = 0;
      while (i < bytes.length) {
        var c = bytes[i++];
        v += (c & 0x7f) * Math.pow(2, shift);
        if (!(c & 0x80)) break;
        shift += 7;
      }
      out.push(v);
    }
    return out;
  }
  function pushVarint(arr, v) {
    v = Math.max(0, Math.round(v));
    do {
      var b = v % 128;
      v = Math.floor(v / 128);
      arr.push(v > 0 ? (b | 0x80) : b);
    } while (v > 0);
  }

  var FORMATS = {
    /* ToastyReplay Lite (.ttrl). Worked out from a real Acheron macro.
     *
     * "TTRL", u8 version, u8, then a run of LEB128 varints. The first few are
     * header fields -- varint[2] is the fps (240) and varint[4] is GD's
     * version as an integer (22081, i.e. 2.2081), which is what confirmed the
     * field alignment was right rather than coincidence.
     *
     * After nine header varints the rest of the stream is plain frame
     * DELTAS, with press and release alternating implicitly (first value is a
     * press). Checked against the sample: 460 values summing to 38534 frames,
     * which at 240fps is 160.6 seconds -- Acheron is about 2:40. A competing
     * reading (delta<<1|state) gave half that and didn't match, so the plain
     * delta reading is the one supported by the file.
     *
     * Reading is on solid ground. WRITING is not verified: several header
     * fields are still unidentified and are written back as observed
     * constants, so ToastyReplay Lite may well reject our output.
     */
    ttrl: {
      name: 'ToastyReplay Lite (.ttrl)',
      ext: '.ttrl',
      group: 'Current',
      confidence: 'exp',
      note: 'Reading worked out from a real macro and cross-checked against the level length. ' +
            'Writing reuses header fields that are still unidentified, so it may not load.',
      detect: function (name, text, buf) {
        return !!(buf && buf.length > 8 && buf[0] === 0x54 && buf[1] === 0x54 &&
                  buf[2] === 0x52 && buf[3] === 0x4C);
      },
      read: function (buf) {
        var vs = readVarints(buf, 4);
        if (vs.length < 10) throw new Error('TTRL: header too short');
        var tps = vs[2] > 0 ? vs[2] : 240;
        var inputs = [], frame = 0, down = true;
        for (var i = 9; i < vs.length; i++) {
          frame += vs[i];
          inputs.push({ frame: frame, button: 1, down: down, player2: false });
          down = !down;
        }
        return { tps: tps, inputs: inputs };
      },
      write: function (rep) {
        var out = [0x54, 0x54, 0x52, 0x4C, 0x01, 0x00];
        // Header varints, positions matching what the sample uses. Only fps
        // and the GD version are actually understood; the rest are copied
        // through as seen so the shape stays plausible.
        pushVarint(out, Math.round(rep.tps));  // fps
        pushVarint(out, 1);
        pushVarint(out, 22081);                // GD 2.2081
        pushVarint(out, 0);
        pushVarint(out, 5);
        pushVarint(out, 0);
        pushVarint(out, 0);
        var sorted = rep.inputs.slice().sort(function (a, b) { return a.frame - b.frame; });
        var prev = 0;
        sorted.forEach(function (i) {
          pushVarint(out, Math.max(0, i.frame - prev));
          prev = i.frame;
        });
        return new Uint8Array(out);
      }
    },

    brrr: {
      name: 'GucciBot (.brrr / GBR6)',
      ext: '.brrr',
      group: 'GucciBot',
      confidence: 'ok',
      note: 'Ported from GucciBot\'s own source. Reading verified against a real 847-input ' +
            '.brrr; writing round-trips identically but has not been loaded back into the ' +
            'game yet.',
      detect: function (name, text, buf) {
        return !!(buf && buf.length > 4 && buf[0] === 0x47 && buf[1] === 0x42 &&
                  buf[2] === 0x52 && buf[3] === 0x36);
      },
      read: function (buf) {
        var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        var pos = 4;
        var version = dv.getUint8(pos); pos += 1;
        var flags = dv.getUint8(pos); pos += 1;
        var tps = dv.getFloat32(pos, true); pos += 4;
        pos += 8;  // timestamp
        pos += 8;  // rngSeed
        var p1size = dv.getUint32(pos, true); pos += 4;
        var p2size = dv.getUint32(pos, true); pos += 4;
        var nameLen = dv.getUint16(pos, true); pos += 2;
        pos += nameLen;
        if (pos + p1size + p2size > buf.length) throw new Error('truncated GBR6 file');
        var p1 = buf.subarray(pos, pos + p1size); pos += p1size;
        var p2 = buf.subarray(pos, pos + p2size);
        var inputs = gbr6DecodeStream(p1, false).concat(gbr6DecodeStream(p2, true));
        inputs.sort(function (a, b) { return a.frame - b.frame; });
        void version; void flags;
        return { tps: tps > 0 ? tps : 240, inputs: inputs };
      },
      write: function (rep) {
        var p1 = gbr6EncodeStream(rep.inputs.filter(function (i) { return !i.player2; }));
        var p2 = gbr6EncodeStream(rep.inputs.filter(function (i) { return i.player2; }));
        var nameBytes = new TextEncoder().encode('');
        var total = 4 + 1 + 1 + 4 + 8 + 8 + 4 + 4 + 2 + nameBytes.length + p1.length + p2.length;
        var buf = new Uint8Array(total);
        var dv = new DataView(buf.buffer);
        var pos = 0;
        GBR6_MAGIC.forEach(function (b) { buf[pos++] = b; });
        dv.setUint8(pos, 1); pos += 1;                                    // version
        dv.setUint8(pos, p2.length ? GBR6_TWO_PLAYER : 0); pos += 1;      // flags
        dv.setFloat32(pos, rep.tps, true); pos += 4;
        dv.setBigInt64(pos, BigInt(Math.floor(Date.now() / 1000)), true); pos += 8;
        dv.setBigUint64(pos, BigInt(0), true); pos += 8;                  // rngSeed
        dv.setUint32(pos, p1.length, true); pos += 4;
        dv.setUint32(pos, p2.length, true); pos += 4;
        dv.setUint16(pos, nameBytes.length, true); pos += 2;
        buf.set(nameBytes, pos); pos += nameBytes.length;
        buf.set(p1, pos); pos += p1.length;
        buf.set(p2, pos);
        void GBR6_HAS_LEVELNAME; void GBR6_HAS_DEATHS;
        return buf;
      }
    },

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
  /* ------------------------------------------------- guessed formats
   *
   * Nigel's call: wire up the formats we have NO reference file for, and say
   * plainly on the page that that's what they are. These are constructed from
   * the shape 2.1-era replay formats generally take -- an fps value followed
   * by fixed-size records -- NOT from any spec or sample. They are expected
   * to be wrong.
   *
   * They carry their own 'guess' tier rather than sharing 'experimental',
   * because the two are not the same claim: experimental means "implemented,
   * not yet confirmed", guess means "nobody has checked this against
   * anything". A wrong reader shows visible nonsense; a wrong writer hands
   * you a file that looks fine and isn't. Hence the separate label.
   *
   * Any of these becomes real the moment a sample file turns up.
   */
  function guessFixedRecord(opts) {
    // fps (f32) + optional extra header floats, then records of
    // { f32 frame, u8 hold, u8 player2 }.
    var headerFloats = opts.headerFloats || 1;
    var rec = 6;
    return {
      name: opts.name,
      ext: opts.ext,
      group: opts.group,
      confidence: 'guess',
      note: 'No reference file -- structure is assumed, not known.',
      detect: function (name) {
        return !!name && name.toLowerCase().endsWith(opts.ext);
      },
      read: function (buf) {
        var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        var pos = 0;
        var tps = dv.getFloat32(pos, true); pos += 4;
        for (var h = 1; h < headerFloats; h++) pos += 4;
        var inputs = [];
        while (pos + rec <= buf.length) {
          var frame = dv.getFloat32(pos, true); pos += 4;
          var hold = dv.getUint8(pos); pos += 1;
          var p2 = dv.getUint8(pos); pos += 1;
          inputs.push({
            frame: Math.round(frame), button: 1, down: !!hold, player2: !!p2
          });
        }
        return { tps: tps > 0 && tps < 100000 ? tps : 240, inputs: inputs };
      },
      write: function (rep) {
        var buf = new Uint8Array(4 * headerFloats + rep.inputs.length * rec);
        var dv = new DataView(buf.buffer);
        var pos = 0;
        dv.setFloat32(pos, rep.tps, true); pos += 4;
        for (var h = 1; h < headerFloats; h++) { dv.setFloat32(pos, 1, true); pos += 4; }
        rep.inputs.forEach(function (i) {
          dv.setFloat32(pos, i.frame, true); pos += 4;
          dv.setUint8(pos, i.down ? 1 : 0); pos += 1;
          dv.setUint8(pos, i.player2 ? 1 : 0); pos += 1;
        });
        return buf;
      }
    };
  }

  [
    { key: 'replaybot', name: 'ReplayBot', ext: '.replay', group: 'Legacy (2.1)' },
    { key: 'zbot', name: 'zBot', ext: '.zbf', group: 'Legacy (2.1)', headerFloats: 2 },
    { key: 'kdbot', name: 'KD-Bot', ext: '.kd', group: 'Legacy (2.1)' },
    { key: 'fembot', name: 'Fembot', ext: '.freplay', group: 'Legacy (2.1)' },
    { key: 'rush', name: 'Rush', ext: '.rush', group: 'Legacy (2.1)' },
    { key: 'omegabot', name: 'OmegaBot 1 / 2 / 3', ext: '.replay', group: 'Legacy (2.1)' },
    { key: 'xbot', name: 'xBot', ext: '.xbot', group: 'Legacy (2.1)' },
    { key: 'mhrbin', name: 'Mega Hack Replay (binary)', ext: '.mhr', group: 'Legacy (2.1)' },
    { key: 'echobin', name: 'Echo (binary)', ext: '.echo', group: 'Legacy (2.1)' }
  ].forEach(function (g) {
    FORMATS[g.key] = guessFixedRecord(g);
  });

  /* Planned. Ones marked hasSample have a real reference file in hand, so
   * they can be implemented and verified properly rather than guessed at --
   * that's the difference between support that works and support that
   * silently corrupts a macro. The rest still need a sample each. */
  var PLANNED = [
    ['Silicate v3 (.slc)', 'Current', true],          // SLC3RPLY magic
    ['Astral (.ast)', 'Current', true],               // AST2; header solved, sample has 0 inputs
    ['TcBot (.tcm)', 'Current', true],
    ['GDR (binary .gdr)', 'Current', true],
    ['GDR2 (.gdr2)', 'Current', true],
    ['yBot (.ybot)', 'Legacy (2.1)', true],
    ['ToastyReplay', 'Current'],
    ['Silicate v1 / v2', 'Current'],
  ];

  /* ------------------------------------------------------------------- state */

  var original = null;   // as loaded, never mutated
  var current = null;    // working copy
  var loadedName = '';   // original filename, for the override gag
  var loadedKey = null;  // detected input format key

  var $ = function (id) { return document.getElementById(id); };

  function clone(rep) {
    return { tps: rep.tps, inputs: rep.inputs.map(function (i) { return Object.assign({}, i); }) };
  }

  function detect(name, buf, text) {
    for (var k in FORMATS) {
      try { if (FORMATS[k].detect(name, text, buf)) return k; } catch (e) {}
    }
    return null;
  }

  /* GucciBot's own formats -- .brrr plus every theme extension, which are the
   * same data under a different name. Used by the override gag below. */
  var GUCCI_EXTS = ['.brrr', '.icebrrr', '.toosii', '.ja', '.giddey', '.bam', '.sexyy',
    '.juice', '.butler', '.saweetie', '.maybach', '.romo', '.grizzley', '.redkingdom',
    '.lemonade', '.waka', '.youngsta', '.knockerz'];

  function isGucciFile(name) {
    name = (name || '').toLowerCase();
    return GUCCI_EXTS.some(function (e) { return name.endsWith(e); });
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

      loadedName = file.name;
      loadedKey = key;
      $('loaded').classList.remove('hidden');
      $('s-name').textContent = file.name;
      $('s-fmt').textContent = FORMATS[key].name;
      $('s-size').textContent = (buf.length / 1024).toFixed(1) + ' KB';
      $('outtps').value = current.tps;
      refresh();

      if (FORMATS[key].confidence === 'guess') {
        show('err', '<strong>Heads up:</strong> ' + FORMATS[key].name + ' was matched by ' +
          'file extension only, and its layout is a guess &mdash; no reference file ' +
          'exists for it. What you see below may be nonsense.');
      } else if (FORMATS[key].confidence === 'exp') {
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
        o.textContent = pair[1].name +
          (pair[1].confidence === 'exp' ? '  (experimental)' :
           pair[1].confidence === 'guess' ? '  (guess -- probably wrong)' : '');
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
    PLANNED.forEach(function (p) { rows.push([p[0], 'soon', p[1], p[2]]); });
    rows.forEach(function (r) {
      var d = document.createElement('div');
      d.className = 'fmt-item';
      d.innerHTML = r[0] + '<span class="tag ' + r[1] + '">' +
        (r[1] === 'ok' ? 'verified' : r[1] === 'exp' ? 'experimental'
          : r[1] === 'guess' ? 'guess &mdash; unverified' : 'planned') + '</span>' +
        (r[3] ? '<span class="tag soon" style="background:#1a2a1a;color:#7aa87a">sample in hand</span>' : '');
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

    // Save. Converting a GucciBot macro out to a rival format gets
    // interrupted -- see gucciOverride().
    $('b-save').addEventListener('click', function () {
      if (!current || !current.inputs.length) {
        show('err', 'Nothing to save &mdash; load a macro first.');
        return;
      }
      var outKey = $('outfmt').value;
      var cameFromGucci = isGucciFile(loadedName) ||
        (loadedKey && FORMATS[loadedKey] && FORMATS[loadedKey].group === 'GucciBot');
      if (cameFromGucci && FORMATS[outKey].group !== 'GucciBot' && !overrideGranted) {
        gucciOverride(doSave);
        return;
      }
      doSave();
    });

    function doSave() {
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
        'Saved as ' + f.name + '. ' + (
          f.confidence === 'ok' ? '' :
          f.confidence === 'guess' ?
            '<strong>This format is a guess.</strong> Nobody has a reference file for it, so ' +
            'the layout was assumed and this file is quite likely not valid at all. Do not ' +
            'delete your original.' :
            '<strong>This format is experimental &mdash; test it in-game before trusting it, ' +
            'and keep your original.</strong>'));
    }
  }

  /* The gag: taking a GucciBot macro out to another bot's format gets the
   * video, and only proceeds if you actually press the button. Granted once
   * per page load -- making someone sit through it on every save would stop
   * being funny immediately. */
  var overrideGranted = false;

  function gucciOverride(proceed) {
    if (document.getElementById('gucci-override')) return;

    var overlay = document.createElement('div');
    overlay.id = 'gucci-override';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:99999;background:#000;display:flex;' +
      'align-items:center;justify-content:center;';

    var video = document.createElement('video');
    video.src = (window.GucciDropped && window.GucciDropped.url) || '';
    video.loop = true;
    video.playsInline = true;
    video.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;';
    overlay.appendChild(video);

    var bar = document.createElement('div');
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;padding:2rem 1.5rem 2.5rem;text-align:center;' +
      'background:linear-gradient(to top, rgba(0,0,0,.92), rgba(0,0,0,0));z-index:1;';

    var line = document.createElement('div');
    line.textContent = 'That macro is already home.';
    line.style.cssText =
      "font-family:'Bebas Neue',sans-serif;font-size:1.6rem;letter-spacing:3px;" +
      'color:#D4AF37;margin-bottom:1.1rem;';
    bar.appendChild(line);

    var go = document.createElement('button');
    go.textContent = 'GUCCI OVERRIDE';
    go.style.cssText =
      "font-family:'Space Mono',monospace;font-size:0.8rem;letter-spacing:3px;" +
      'background:transparent;border:1px solid #D4AF37;color:#D4AF37;' +
      'padding:.85rem 2.2rem;cursor:pointer;margin:0 .4rem;';
    go.onmouseenter = function () { go.style.background = '#D4AF37'; go.style.color = '#0a0a0a'; };
    go.onmouseleave = function () { go.style.background = 'transparent'; go.style.color = '#D4AF37'; };
    bar.appendChild(go);

    var nah = document.createElement('button');
    nah.textContent = 'Never mind';
    nah.style.cssText =
      "font-family:'Space Mono',monospace;font-size:0.7rem;letter-spacing:2px;" +
      'background:transparent;border:1px solid #333;color:#888;' +
      'padding:.85rem 1.5rem;cursor:pointer;margin:0 .4rem;';
    bar.appendChild(nah);

    overlay.appendChild(bar);
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // Same reason as the sitewide gag: play() has to run inside the click
    // gesture for unmuted audio, especially on iOS.
    video.play().catch(function () { video.muted = true; video.play(); });

    function close() {
      video.pause();
      overlay.remove();
      document.body.style.overflow = '';
    }
    go.addEventListener('click', function () {
      overrideGranted = true;
      close();
      proceed();
    });
    nah.addEventListener('click', close);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
