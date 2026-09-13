/* GucciBot macro converter.
 *
 * Most of the 2.1-era formats are ported from peony's nat-converter
 * (https://github.com/peonii/nat-converter), used with her permission on the
 * condition that the source is linked on the page -- it is, in the credits
 * panel. See the porting note further down. The rest, GucciBot's own .brrr
 * included, are written here from the format layouts: formats themselves
 * aren't copyrightable, implementations are, so nothing else is borrowed.
 *
 * Internal representation, which every format converts to and from:
 *   { tps: number, inputs: [ { frame, button, down, player2 } ] }
 *   button: 1 = jump, 2 = left, 3 = right   (GD's own numbering)
 *   down:   true = press, false = release
 *
 * Each format declares a confidence level, surfaced in the UI:
 *   'ok'   checked against real files of that format
 *   'src'  implemented from the bot's own format code or library
 *   're'   reverse-engineered from a sample, no source to check against
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
      confidence: 're',
      p1only: true,
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
        return /^[ 	]*(#|\d+[ 	]+\d+)/.test(text);
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
      confidence: 'src',
      note: 'GDR v1 in JSON. Field names taken from nat-converter; "2p", not "p2".',
      detect: function (name, text) {
        if (!text) return false;
        try {
          var j = JSON.parse(text);
          return !!(j && Array.isArray(j.inputs) && (j.framerate !== undefined ||
                    j.botInfo !== undefined || j.gameVersion !== undefined));
        } catch (e) { return false; }
      },
      read: function (buf, text) { return gdr1ToRep(JSON.parse(text)); },
      write: function (rep) {
        return new TextEncoder().encode(JSON.stringify(repToGdr1(rep), null, 2));
      }
    },

    tasbot: {
      name: 'TASBot',
      ext: '.json',
      group: 'Legacy (2.1)',
      confidence: 'src',
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
      confidence: 'src',
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

    /* Echo shipped two different JSON shapes. The older one spells its keys
     * out in Title Case With Spaces and offsets every frame by a "Starting
     * Frame"; the newer one is plain snake_case and omits player_2 entirely
     * when it's false. Both layouts are per nat-converter. */
    echojson: {
      name: 'Echo (JSON)',
      ext: '.echo',
      group: 'Legacy (2.1)',
      confidence: 'src',
      note: 'Layout from nat-converter. Reads both the old and new shapes, writes the new one.',
      detect: function (name, text) {
        if (!text) return false;
        try {
          var j = JSON.parse(text);
          return !!(j && (Array.isArray(j.inputs) && j.fps !== undefined));
        } catch (e) { return false; }
      },
      read: function (buf, text) {
        var j = JSON.parse(text);
        if (Array.isArray(j['Echo Replay'])) {
          var start = num(j['Starting Frame'], 0) | 0;
          return {
            tps: Math.round(num(j.FPS, 240)),
            inputs: j['Echo Replay'].map(function (e) {
              return {
                frame: (num(e.Frame, 0) | 0) + start, button: 1,
                down: !!e.Hold, player2: !!e['Player 2']
              };
            })
          };
        }
        return {
          tps: Math.round(num(j.fps, 240)),
          inputs: (j.inputs || []).map(function (e) {
            return {
              frame: num(e.frame, 0) | 0, button: 1,
              down: !!e.holding, player2: !!e.player_2
            };
          })
        };
      },
      write: function (rep) {
        var j = {
          fps: rep.tps,
          inputs: rep.inputs.filter(function (i) { return i.button === 1; })
            .map(function (i) {
              var o = { holding: i.down, frame: i.frame };
              if (i.player2) o.player_2 = true;   // omitted when false
              return o;
            })
        };
        return new TextEncoder().encode(JSON.stringify(j, null, 2));
      }
    },

    echojsonold: {
      name: 'Echo (old JSON)',
      ext: '.echo',
      group: 'Legacy (2.1)',
      confidence: 'src',
      note: 'Layout from nat-converter.',
      detect: function (name, text) {
        if (!text) return false;
        try { return !!JSON.parse(text)['Echo Replay']; } catch (e) { return false; }
      },
      read: function (buf, text) {
        return FORMATS.echojson.read(buf, text);
      },
      write: function (rep) {
        var j = {
          FPS: rep.tps,
          'Starting Frame': 0,
          'Echo Replay': rep.inputs.filter(function (i) { return i.button === 1; })
            .map(function (i) {
              return {
                Hold: i.down, 'Player 2': i.player2,
                Frame: i.frame, 'X Position': 0
              };
            })
        };
        return new TextEncoder().encode(JSON.stringify(j, null, 2));
      }
    }
  };

  /* ---------------------------------------------- ported from nat-converter
   *
   * The formats below are ported from peony's nat-converter
   * (https://github.com/peonii/nat-converter), used WITH HER PERMISSION on
   * the condition that the source stays linked on the site -- it is, in the
   * "Credits & sources" panel on the converter page. Don't remove that link.
   *
   * These replace hand-written guesses that were, predictably, wrong. zBot's
   * header is a delta + speedhack pair, not an fps float. ReplayBot has an
   * "RPLY" magic and 5-byte records. Fembot pads every record out to 65
   * bytes. xdBot is line-based text, not JSON. None of that was guessable
   * from the outside, which is the whole reason the guess tier existed.
   *
   * nat-converter's model is one row per frame carrying BOTH players (p1/p2
   * each Click/Release/Skip); ours is one row per input. They convert
   * cleanly, so the page's own model is left alone.
   */
  function dvOf(buf) { return new DataView(buf.buffer, buf.byteOffset, buf.byteLength); }

  function jumps(rep) {
    // Every format here carries a jump input plus a player flag, nothing else.
    return rep.inputs.filter(function (i) { return i.button === 1; })
      .sort(function (a, b) { return a.frame - b.frame; });
  }

  function mkInput(frame, hold, p2) {
    return { frame: frame >>> 0, button: 1, down: !!hold, player2: !!p2 };
  }

  function hasMagic(buf, bytes) {
    if (!buf || buf.length < bytes.length) return false;
    for (var i = 0; i < bytes.length; i++) if (buf[i] !== bytes[i]) return false;
    return true;
  }

  var PORTED = {
    zbot: {
      name: 'zBot', ext: '.zbf', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n) { return !!n && /\.zbf$/i.test(n); },
      read: function (buf) {
        var dv = dvOf(buf);
        // Not an fps field: a frame delta and a speedhack multiplier.
        var delta = dv.getFloat32(0, true), speed = dv.getFloat32(4, true);
        var fps = Math.round(1 / (delta * speed));
        var out = [], pos = 8;
        while (pos + 6 <= buf.length) {
          var frame = dv.getInt32(pos, true); pos += 4;
          var hold = buf[pos++] === 0x31;   // ASCII '1' / '0', not 1 / 0
          var p2 = buf[pos++] === 0x31;
          out.push(mkInput(frame, hold, p2));
        }
        return { tps: fps > 0 && isFinite(fps) ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(8 + list.length * 6), dv = dvOf(buf), pos = 0;
        dv.setFloat32(pos, 1 / rep.tps, true); pos += 4;
        dv.setFloat32(pos, 1, true); pos += 4;
        list.forEach(function (i) {
          dv.setInt32(pos, i.frame, true); pos += 4;
          buf[pos++] = i.down ? 0x31 : 0x30;
          // nat-converter writes this flag inverted relative to how its own
          // reader reads it, which flips every player on a round-trip.
          // Matching the reader instead, so ours round-trips losslessly.
          buf[pos++] = i.player2 ? 0x31 : 0x30;
        });
        return buf;
      }
    },

    replaybot: {
      name: 'ReplayBot', ext: '.replay', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n, t, buf) { return hasMagic(buf, [0x52, 0x50, 0x4C, 0x59]); },
      read: function (buf) {
        var dv = dvOf(buf);
        if (buf[4] !== 2) throw new Error('ReplayBot: only version 2 is supported.');
        if (buf[5] !== 1) throw new Error('ReplayBot: this macro is X-position based, not frame based.');
        var fps = dv.getFloat32(6, true);
        var out = [], pos = 10;
        while (pos + 5 <= buf.length) {
          var frame = dv.getUint32(pos, true); pos += 4;
          var st = buf[pos++];
          out.push(mkInput(frame, (st & 1) === 1, (st & 2) === 2));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(10 + list.length * 5), dv = dvOf(buf);
        buf[0] = 0x52; buf[1] = 0x50; buf[2] = 0x4C; buf[3] = 0x59;  // RPLY
        buf[4] = 2;    // version
        buf[5] = 1;    // frame based
        dv.setFloat32(6, rep.tps, true);
        var pos = 10;
        list.forEach(function (i) {
          dv.setUint32(pos, i.frame, true); pos += 4;
          buf[pos++] = (i.down ? 1 : 0) | (i.player2 ? 2 : 0);
        });
        return buf;
      }
    },

    kdbot: {
      name: 'KD-Bot', ext: '.kd', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n) { return !!n && /\.kd$/i.test(n); },
      read: function (buf) {
        var dv = dvOf(buf);
        var fps = dv.getFloat32(0, true);
        var out = [], pos = 4;
        while (pos + 6 <= buf.length) {
          var frame = dv.getUint32(pos, true); pos += 4;
          var hold = buf[pos++] === 1;
          var p2 = buf[pos++] === 1;
          out.push(mkInput(frame, hold, p2));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(4 + list.length * 6), dv = dvOf(buf);
        dv.setFloat32(0, rep.tps, true);
        var pos = 4;
        list.forEach(function (i) {
          dv.setUint32(pos, i.frame, true); pos += 4;
          buf[pos++] = i.down ? 1 : 0;
          buf[pos++] = i.player2 ? 1 : 0;
        });
        return buf;
      }
    },

    rush: {
      name: 'Rush', ext: '.rush', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n) { return !!n && /\.rush$/i.test(n); },
      read: function (buf) {
        var dv = dvOf(buf);
        var fps = dv.getInt16(0, true);   // 16-bit, not a float
        var out = [], pos = 2;
        while (pos + 5 <= buf.length) {
          var frame = dv.getUint32(pos, true); pos += 4;
          var st = buf[pos++];
          out.push(mkInput(frame, (st & 1) === 1, (st & 2) === 2));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(2 + list.length * 5), dv = dvOf(buf);
        dv.setInt16(0, Math.round(rep.tps), true);
        var pos = 2;
        list.forEach(function (i) {
          dv.setUint32(pos, i.frame, true); pos += 4;
          buf[pos++] = (i.down ? 1 : 0) | (i.player2 ? 2 : 0);
        });
        return buf;
      }
    },

    fembot: {
      name: 'Fembot', ext: '.freplay', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n, t, buf) { return hasMagic(buf, [0x46, 0x42, 0x52, 0x50]); },
      read: function (buf) {
        var dv = dvOf(buf);
        var fps = dv.getFloat32(4, true);
        // 65 bytes per record: a state byte, a frame, then 60 bytes of padding.
        var out = [], pos = 8;
        while (pos + 65 <= buf.length) {
          var st = buf[pos++];
          var frame = dv.getUint32(pos, true); pos += 4;
          pos += 60;
          out.push(mkInput(frame, (st & 1) === 1, (st & 2) === 2));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(8 + list.length * 65), dv = dvOf(buf);
        buf[0] = 0x46; buf[1] = 0x42; buf[2] = 0x52; buf[3] = 0x50;  // FBRP
        dv.setFloat32(4, rep.tps, true);
        var pos = 8;
        list.forEach(function (i) {
          buf[pos++] = (i.down ? 1 : 0) | (i.player2 ? 2 : 0);
          dv.setUint32(pos, i.frame, true); pos += 4;
          pos += 60;   // padding, already zeroed
        });
        return buf;
      }
    },

    xbot: {
      name: 'xBot', ext: '.xbot', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n, t) { return !!t && /^fps:\s*[0-9.]+/i.test(t); },
      read: function (buf, text) {
        var lines = text.split(/\r?\n/);
        var fps = parseFloat((lines[0] || '').split(/\s+/)[1]);
        var out = [];
        // Line 0 is "fps: N", line 1 is a bare "frames" marker.
        for (var i = 2; i < lines.length; i++) {
          var parts = lines[i].trim().split(/\s+/);
          if (parts.length < 2) continue;
          var st = parseInt(parts[0], 10);
          if (!isFinite(st)) continue;
          out.push(mkInput(parseInt(parts[1], 10) || 0, st % 2 === 1, st > 1));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var lines = ['fps: ' + rep.tps, 'frames'];
        jumps(rep).forEach(function (i) {
          lines.push(((i.down ? 1 : 0) | (i.player2 ? 2 : 0)) + ' ' + i.frame);
        });
        return new TextEncoder().encode(lines.join('\n') + '\n');
      }
    },

    xdbot: {
      name: 'xdBot', ext: '.xd', group: 'Current', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n, t) {
        return !!t && /^[0-9.]+\s*[\r\n]+\d+\|[01]\|/.test(t);
      },
      read: function (buf, text) {
        var lines = text.split(/\r?\n/);
        var fps = parseFloat(lines[0]);
        var out = [];
        for (var i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          var d = lines[i].split('|');
          if (d.length < 4) continue;
          if (d[2] !== '1') continue;   // nat-converter skips non-jump rows
          out.push(mkInput(parseInt(d[0], 10) || 0, d[1] === '1', d[3] !== '1'));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var lines = ['' + rep.tps];
        jumps(rep).forEach(function (i) {
          // Same note as zBot: written to match this reader, not
          // nat-converter's writer, which inverts the flag.
          lines.push(i.frame + '|' + (i.down ? 1 : 0) + '|1|' + (i.player2 ? 0 : 1));
        });
        return new TextEncoder().encode(lines.join('\n') + '\n');
      }
    },

    mhrbin: {
      name: 'Mega Hack Replay (binary)', ext: '.mhr', group: 'Legacy (2.1)',
      confidence: 'src', note: 'Ported from nat-converter.',
      detect: function (n, t, buf) {
        return hasMagic(buf, [0x48, 0x41, 0x43, 0x4B, 0x50, 0x52, 0x4F, 0x07]);  // HACKPRO
      },
      read: function (buf) {
        var dv = dvOf(buf);
        var metaSize = dv.getInt32(8, true);
        var fps = dv.getInt32(12, true);   // integer fps, not a float
        // metaSize counts the fps field we just read, hence the -4, then
        // 8 bytes of reserved space MHR always writes.
        var pos = 16 + (metaSize - 4) + 8;
        var eventSize = dv.getUint32(pos, true); pos += 4;
        var count = dv.getUint32(pos, true); pos += 4;
        var out = [];
        for (var i = 0; i < count && pos + eventSize <= buf.length; i++) {
          pos += 2;
          var hold = buf[pos++] === 1;
          var p2 = buf[pos++] === 1;
          var frame = dv.getInt32(pos, true); pos += 4;
          pos += eventSize - 8;
          out.push(mkInput(frame, hold, p2));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var EV = 32;
        var buf = new Uint8Array(32 + list.length * EV + 16), dv = dvOf(buf);
        [0x48, 0x41, 0x43, 0x4B, 0x50, 0x52, 0x4F, 0x07]
          .forEach(function (b, i) { buf[i] = b; });
        dv.setInt32(8, 4, true);                    // meta size
        dv.setInt32(12, Math.round(rep.tps), true); // fps
        // 16..24 reserved, left zero
        dv.setUint32(24, EV, true);                 // event size
        dv.setUint32(28, list.length, true);        // event count, at 0x1c
        var pos = 32;
        list.forEach(function (i) {
          dv.setUint16(pos, 1, true); pos += 2;
          buf[pos++] = i.down ? 1 : 0;
          buf[pos++] = i.player2 ? 1 : 0;
          dv.setInt32(pos, i.frame, true); pos += 4;
          pos += 24;   // pad out to the 32-byte minimum event
        });
        [0xFA, 0x67, 0x55, 0x5A, 0x8D, 0x95, 0x94, 0x07,
         0xC9, 0x8C, 0xBA, 0x7F, 0x75, 0x9C, 0xEF, 0x3C]
          .forEach(function (b, n) { buf[pos + n] = b; });
        return buf;
      }
    },

    echobin: {
      name: 'Echo (binary)', ext: '.echo', group: 'Legacy (2.1)',
      confidence: 'src', note: 'Ported from nat-converter.',
      detect: function (n, t, buf) { return hasMagic(buf, [0x4D, 0x45, 0x54, 0x41]); },
      read: function (buf) {
        var dv = dvOf(buf);
        // A "DBG\0" at offset 4 means the fat 34-byte action, otherwise 6.
        var full = buf[4] === 0x44 && buf[5] === 0x42 && buf[6] === 0x47 && buf[7] === 0x00;
        var size = full ? 34 : 6;
        var fps = dv.getFloat32(24, true);
        var out = [], pos = 48;
        // nat-converter derives the action count from the whole file length
        // rather than what's left after the header, which overshoots by 48
        // bytes' worth. Bounding the loop by the buffer instead.
        while (pos + size <= buf.length) {
          var frame = dv.getUint32(pos, true); pos += 4;
          var down = buf[pos++] === 1;
          var p2 = buf[pos++] === 1;
          if (full) pos += 28;
          out.push(mkInput(frame, down, p2));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(48 + list.length * 6), dv = dvOf(buf);
        buf[0] = 0x4D; buf[1] = 0x45; buf[2] = 0x54; buf[3] = 0x41;  // META
        dv.setFloat32(24, rep.tps, true);
        var pos = 48;
        list.forEach(function (i) {
          dv.setUint32(pos, i.frame, true); pos += 4;
          buf[pos++] = i.down ? 1 : 0;
          buf[pos++] = i.player2 ? 1 : 0;
        });
        return buf;
      }
    },

    obot2: {
      name: 'OmegaBot 2', ext: '.replay', group: 'Legacy (2.1)',
      confidence: 'src',
      note: 'Ported from nat-converter. OmegaBot 3 uses a different encoding and is not supported yet.',
      detect: function (n, t, buf) {
        if (!buf || buf.length < 24) return false;
        if (hasMagic(buf, [0x52, 0x50, 0x4C, 0x59])) return false;   // that's ReplayBot
        var dv = dvOf(buf);
        var fps = dv.getFloat32(0, true);
        // replay_type == 1 is the frame-based variant; 0 is X-position.
        return fps > 0 && fps < 100000 && dv.getUint32(8, true) === 1;
      },
      read: function (buf) {
        // Rust bincode 1.x defaults: little-endian, fixed-width integers,
        // u64 lengths, enum variants tagged as u32.
        var dv = dvOf(buf);
        var fps = dv.getFloat32(0, true);
        if (dv.getUint32(8, true) !== 1)
          throw new Error('OmegaBot 2: this macro is X-position based, not frame based.');
        var count = dv.getUint32(20, true);   // u64 length, low half
        var out = [], pos = 28;
        for (var i = 0; i < count && pos + 12 <= buf.length; i++) {
          var locKind = dv.getUint32(pos, true); pos += 4;
          var frame = dv.getUint32(pos, true); pos += 4;
          var kind = dv.getUint32(pos, true); pos += 4;
          if (kind === 1) { pos += 4; continue; }   // FpsChange(f32), no input
          if (locKind !== 1 || kind < 2) continue;  // X-position or None
          // 2 = P1 down, 3 = P1 up, 4 = P2 down, 5 = P2 up
          out.push(mkInput(frame, kind === 2 || kind === 4, kind >= 4));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(28 + list.length * 12), dv = dvOf(buf);
        dv.setFloat32(0, rep.tps, true);    // initial_fps
        dv.setFloat32(4, rep.tps, true);    // current_fps
        dv.setUint32(8, 1, true);           // replay_type = Frame
        // 12..20: current_click (u64) = 0
        dv.setUint32(20, list.length, true);
        var pos = 28;
        list.forEach(function (i) {
          dv.setUint32(pos, 1, true); pos += 4;              // Location::Frame
          dv.setUint32(pos, i.frame, true); pos += 4;
          var kind = i.player2 ? (i.down ? 4 : 5) : (i.down ? 2 : 3);
          dv.setUint32(pos, kind, true); pos += 4;
        });
        return buf;
      }
    }
  };

  Object.keys(PORTED).forEach(function (k) { FORMATS[k] = PORTED[k]; });

  // tcm-rs's 16-byte file magic.
  var TCM_MAGIC = [0x9f, 0x88, 0x89, 0x84, 0x9f, 0x3b, 0x1d, 0xd8,
                   0xcc, 0xa1, 0x86, 0x8a, 0x88, 0x99, 0x84, 0x00];

  /* ------------------------------------------------- the modern formats
   *
   * These are the ones that needed a real spec rather than a sample, and now
   * have one:
   *
   *   GDR2   -- maxnut's GDReplayFormat, the library GucciBot itself links
   *             (CMakeLists.txt, libGDR). Layout read straight out of
   *             gdr.hpp / binarystream.hpp, so this one isn't guesswork.
   *   GDR    -- the older v1 of the same, which is MessagePack rather than a
   *             hand-rolled stream. Small msgpack codec below; it only needs
   *             maps, arrays, strings, numbers and bools.
   *   TCM    -- TcBot's format, from tcm-rs (MIT, tcbot.pro), which Chagh
   *             pointed us at. Both v1 and v2.
   *   URL, Silicate v1 -- ported from nat-converter like the batch above.
   *
   * Silicate v2/v3 stay planned: nat-converter reaches for the slc_oxide
   * crate for those, and a container format is not something to invent.
   */

  /* -- LEB128 varints, big-endian floats: GDR2's binarystream conventions.
   * Integers are variable-length, everything else is raw bytes reversed
   * (i.e. big-endian), and strings are a varint length then the bytes. */
  function BinReader(buf) {
    this.b = buf; this.p = 0;
    this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  BinReader.prototype.varint = function () {
    var v = 0, shift = 1, byte;
    do {
      if (this.p >= this.b.length) throw new Error('Unexpected end of file.');
      byte = this.b[this.p++];
      v += (byte & 0x7F) * shift;     // not <<: JS bitwise ops are 32-bit
      shift *= 128;
    } while (byte & 0x80);
    return v;
  };
  BinReader.prototype.str = function () {
    var n = this.varint();
    if (this.p + n > this.b.length) throw new Error('Bad string length.');
    var s = new TextDecoder().decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  };
  BinReader.prototype.f32 = function () { var v = this.dv.getFloat32(this.p, false); this.p += 4; return v; };
  BinReader.prototype.f64 = function () { var v = this.dv.getFloat64(this.p, false); this.p += 8; return v; };
  BinReader.prototype.left = function () { return this.b.length - this.p; };

  function BinWriter() { this.out = []; }
  BinWriter.prototype.raw = function (arr) { for (var i = 0; i < arr.length; i++) this.out.push(arr[i]); };
  BinWriter.prototype.varint = function (v) {
    v = Math.max(0, Math.round(v));
    if (v === 0) { this.out.push(0); return; }
    while (v > 0) {
      var byte = v % 128;
      v = Math.floor(v / 128);
      this.out.push(v > 0 ? (byte | 0x80) : byte);
    }
  };
  BinWriter.prototype.str = function (s) {
    var bytes = new TextEncoder().encode(s || '');
    this.varint(bytes.length);
    this.raw(bytes);
  };
  BinWriter.prototype.f32 = function (v) {
    var d = new DataView(new ArrayBuffer(4)); d.setFloat32(0, v, false);
    this.raw(new Uint8Array(d.buffer));
  };
  BinWriter.prototype.f64 = function (v) {
    var d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v, false);
    this.raw(new Uint8Array(d.buffer));
  };
  BinWriter.prototype.done = function () { return new Uint8Array(this.out); };

  /* -- MessagePack, just the subset GDR v1 uses. */
  function mpDecode(buf) {
    var dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), p = 0;
    function str(n) {
      var s = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; return s;
    }
    function val() {
      var b = buf[p++];
      if (b <= 0x7f) return b;                                  // positive fixint
      if (b >= 0xe0) return b - 256;                            // negative fixint
      if (b >= 0x80 && b <= 0x8f) return map(b & 0x0f);         // fixmap
      if (b >= 0x90 && b <= 0x9f) return arr(b & 0x0f);         // fixarray
      if (b >= 0xa0 && b <= 0xbf) return str(b & 0x1f);         // fixstr
      switch (b) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xca: { var f = dv.getFloat32(p, false); p += 4; return f; }
        case 0xcb: { var d = dv.getFloat64(p, false); p += 8; return d; }
        case 0xcc: return buf[p++];
        case 0xcd: { var u = dv.getUint16(p, false); p += 2; return u; }
        case 0xce: { var u4 = dv.getUint32(p, false); p += 4; return u4; }
        case 0xcf: { var hi = dv.getUint32(p, false), lo = dv.getUint32(p + 4, false); p += 8; return hi * 4294967296 + lo; }
        case 0xd0: return dv.getInt8(p++);
        case 0xd1: { var i2 = dv.getInt16(p, false); p += 2; return i2; }
        case 0xd2: { var i4 = dv.getInt32(p, false); p += 4; return i4; }
        case 0xd3: { var ih = dv.getInt32(p, false), il = dv.getUint32(p + 4, false); p += 8; return ih * 4294967296 + il; }
        case 0xd9: { var n1 = buf[p++]; return str(n1); }
        case 0xda: { var n2 = dv.getUint16(p, false); p += 2; return str(n2); }
        case 0xdb: { var n3 = dv.getUint32(p, false); p += 4; return str(n3); }
        case 0xdc: { var a2 = dv.getUint16(p, false); p += 2; return arr(a2); }
        case 0xdd: { var a4 = dv.getUint32(p, false); p += 4; return arr(a4); }
        case 0xde: { var m2 = dv.getUint16(p, false); p += 2; return map(m2); }
        case 0xdf: { var m4 = dv.getUint32(p, false); p += 4; return map(m4); }
      }
      throw new Error('Unsupported MessagePack byte 0x' + b.toString(16));
    }
    function arr(n) { var o = []; for (var i = 0; i < n; i++) o.push(val()); return o; }
    function map(n) { var o = {}; for (var i = 0; i < n; i++) { var k = val(); o[k] = val(); } return o; }
    return val();
  }

  function mpEncode(v) {
    var out = [];
    function push(b) { out.push(b); }
    function u16(n) { push((n >> 8) & 0xff); push(n & 0xff); }
    function u32(n) { push((n >>> 24) & 0xff); push((n >>> 16) & 0xff); push((n >>> 8) & 0xff); push(n & 0xff); }
    function enc(x) {
      if (x === null || x === undefined) return push(0xc0);
      if (typeof x === 'boolean') return push(x ? 0xc3 : 0xc2);
      if (typeof x === 'number') {
        if (Number.isInteger(x) && x >= 0 && x <= 0x7f) return push(x);
        if (Number.isInteger(x) && x < 0 && x >= -32) return push(x + 256);
        if (Number.isInteger(x) && x >= 0 && x <= 0xffffffff) { push(0xce); return u32(x); }
        if (Number.isInteger(x) && x < 0 && x >= -2147483648) { push(0xd2); return u32(x >>> 0); }
        push(0xcb);
        var d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, x, false);
        for (var i = 0; i < 8; i++) push(d.getUint8(i));
        return;
      }
      if (typeof x === 'string') {
        var bytes = new TextEncoder().encode(x);
        if (bytes.length < 32) push(0xa0 | bytes.length);
        else if (bytes.length < 256) { push(0xd9); push(bytes.length); }
        else { push(0xda); u16(bytes.length); }
        for (var j = 0; j < bytes.length; j++) push(bytes[j]);
        return;
      }
      if (Array.isArray(x)) {
        if (x.length < 16) push(0x90 | x.length);
        else if (x.length < 65536) { push(0xdc); u16(x.length); }
        else { push(0xdd); u32(x.length); }
        x.forEach(enc);
        return;
      }
      var keys = Object.keys(x);
      if (keys.length < 16) push(0x80 | keys.length);
      else if (keys.length < 65536) { push(0xde); u16(keys.length); }
      else { push(0xdf); u32(keys.length); }
      keys.forEach(function (k) { enc(k); enc(x[k]); });
    }
    enc(v);
    return new Uint8Array(out);
  }

  /* GDR v1's own field names -- note "2p", not "p2", and "bot"/"level"
   * rather than "botInfo"/"levelInfo". Shared by the msgpack and JSON
   * flavours, which are the same struct in two containers. */
  function gdr1ToRep(j) {
    var inputs = (j.inputs || []).map(function (i) {
      return {
        frame: num(i.frame, 0) | 0,
        button: num(i.btn !== undefined ? i.btn : i.button, 1) | 0,
        down: !!i.down,
        player2: !!(i['2p'] !== undefined ? i['2p'] : i.p2)
      };
    });
    var fps = j.framerate !== undefined ? j.framerate : j.fps;
    return { tps: Math.round(num(fps, 240)), inputs: inputs };
  }

  function repToGdr1(rep) {
    var list = rep.inputs.slice().sort(function (a, b) { return a.frame - b.frame; });
    var last = list.length ? list[list.length - 1].frame : 0;
    return {
      gameVersion: 2.204,
      description: 'Converted by GucciBot',
      version: 1,
      duration: last / (rep.tps || 240),
      author: 'CONVERTED MACRO',
      seed: 0, coins: 0, ldm: false,
      bot: { name: 'GucciBot', version: '1.7.1' },
      level: { id: 0, name: 'LEVEL NAME' },
      inputs: list.map(function (i) {
        return { frame: i.frame, btn: i.button, '2p': i.player2, down: i.down };
      }),
      framerate: rep.tps
    };
  }

  var MODERN = {
    gdr2: {
      name: 'GDR2 (binary)', ext: '.gdr2', group: 'Current', confidence: 'src',
      note: 'Layout read from maxnut\'s GDReplayFormat, the library GucciBot links.',
      detect: function (n, t, buf) {
        return !!(buf && buf.length > 8 && buf[0] === 0x47 && buf[1] === 0x44 && buf[2] === 0x52);
      },
      read: function (buf) {
        var r = new BinReader(buf);
        r.p = 3;                       // "GDR"
        r.varint();                    // format version
        var inputTag = r.str();        // input extension tag, "" when absent
        r.str(); r.str();              // author, description
        r.f32();                       // duration
        r.varint();                    // gameVersion
        var fps = r.f64();             // framerate is a double here
        r.varint(); r.varint();        // seed, coins
        r.varint(); var plat = r.varint() !== 0;   // ldm, platformer
        r.str(); r.varint();           // bot name, bot version
        r.varint(); r.str();           // level id, level name
        var extSize = r.varint();      // replay extension blob
        r.p += extSize;
        var deaths = r.varint();
        for (var d = 0; d < deaths; d++) r.varint();
        r.varint();                    // total inputs (not trusted; we read to EOF)
        var p1Left = r.varint();
        var out = [], prev = 0;
        while (r.left() > 0) {
          var packed = r.varint();
          var frame, button, down;
          if (plat) {
            // [ ...delta | button(2) | down(1) ]
            frame = Math.floor(packed / 8) + prev;
            button = (Math.floor(packed / 2)) & 3;
            down = (packed & 1) === 1;
          } else {
            frame = Math.floor(packed / 2) + prev;
            button = 1;
            down = (packed & 1) === 1;
          }
          out.push({ frame: frame, button: button || 1, down: down, player2: p1Left === 0 });
          if (inputTag) { var xs = r.varint(); r.p += xs; }  // per-input extension
          prev = frame;
          // P2 inputs follow P1 as a separate delta run, so the base resets.
          if (p1Left > 0 && --p1Left === 0) prev = 0;
        }
        out.sort(function (a, b) { return a.frame - b.frame; });
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = rep.inputs.slice().sort(function (a, b) { return a.frame - b.frame; });
        var p1 = list.filter(function (i) { return !i.player2; });
        var p2 = list.filter(function (i) { return i.player2; });
        var w = new BinWriter();
        w.raw([0x47, 0x44, 0x52]);          // "GDR"
        w.varint(2);                        // format version
        w.str('');                          // no input extension
        w.str('CONVERTED MACRO');           // author
        w.str('Converted by GucciBot');     // description
        w.f32(list.length ? list[list.length - 1].frame / (rep.tps || 240) : 0);
        w.varint(22074);                    // gameVersion
        w.f64(rep.tps);
        w.varint(0); w.varint(0);           // seed, coins
        w.varint(0); w.varint(0);           // ldm, platformer (non-platformer)
        w.str('GucciBot'); w.varint(1);
        w.varint(0); w.str('');             // level id, level name
        w.varint(0);                        // no replay extension
        w.varint(0);                        // no deaths
        w.varint(list.length);
        w.varint(p1.length);
        [p1, p2].forEach(function (group) {
          var prev = 0;
          group.forEach(function (i) {
            w.varint((i.frame - prev) * 2 + (i.down ? 1 : 0));
            prev = i.frame;
          });
        });
        return w.done();
      }
    },

    gdrbin: {
      name: 'GDR (binary)', ext: '.gdr', group: 'Current', confidence: 'src',
      note: 'GDR v1 -- the same struct as the JSON flavour, in MessagePack.',
      detect: function (n, t, buf) {
        if (!buf || buf.length < 4) return false;
        if (buf[0] === 0x47 && buf[1] === 0x44 && buf[2] === 0x52) return false;  // that's GDR2
        var b = buf[0];
        if (!((b >= 0x80 && b <= 0x8f) || b === 0xde || b === 0xdf)) return false;
        try { var j = mpDecode(buf); return !!(j && Array.isArray(j.inputs)); }
        catch (e) { return false; }
      },
      read: function (buf) { return gdr1ToRep(mpDecode(buf)); },
      write: function (rep) { return mpEncode(repToGdr1(rep)); }
    },

    tcm: {
      name: 'TcBot (.tcm)', ext: '.tcm', group: 'Current', confidence: 'ok',
      note: 'Layout from tcm-rs (MIT, tcbot.pro). Reads v1 and v2, writes v2. Reading is checked against sample macros the library ships; writing is not yet confirmed in TcBot.',
      detect: function (n, t, buf) { return hasMagic(buf, TCM_MAGIC); },
      read: function (buf) {
        var dv = dvOf(buf);
        var version = buf[16];
        var flags = buf[18];
        var tpsOrDt = dv.getFloat32(20, true);
        // v2 can store either tps or its reciprocal; bit 1 says which.
        var tps = (version === 1 || (flags & 2)) ? tpsOrDt : 1 / tpsOrDt;
        var p = 80;                 // 16-byte magic + 0x40 meta
        var out = [];

        function varint() {
          var v = 0, shift = 1, byte;
          do {
            if (p >= buf.length) throw new Error('Unexpected end of file.');
            byte = buf[p++];
            v += (byte & 0x7F) * shift;
            shift *= 128;
          } while (byte & 0x80);
          return v;
        }

        if (version === 1) {
          var count = varint();
          for (var i = 0; i < count; i++) {
            var frame = varint();
            var b = buf[p++];
            var kind = b & 7;
            if (kind > 2) continue;     // 3/4/5 are restart markers, not inputs
            out.push({
              frame: frame, button: kind + 1,
              down: (b & 0x80) !== 0, player2: (b & 0x40) !== 0
            });
          }
        } else if (version === 2) {
          // A little state machine: an action byte carries the input plus a
          // descriptor for the frame delta that follows it.
          var frame2 = varint(), lastDelta = 0, blob = 0, magic = false;
          var next = 'action';
          for (;;) {
            if (next === 'action') {
              if (p >= buf.length) break;
              var byte = buf[p++];
              var dd = (byte >> 5) & 7;
              blob = (dd >> 1) & 3; magic = (dd & 1) !== 0;
              var input = byte & 3;
              if (input > 0) {
                var push = (byte & 4) !== 0, p2 = (byte & 8) !== 0;
                var swift = (byte & 16) !== 0;
                out.push({ frame: frame2, button: input, down: push, player2: p2 });
                // "swift" means press and release land on the same frame.
                if (swift) out.push({ frame: frame2, button: input, down: !push, player2: p2 });
                next = 'delta';
              } else {
                var custom = (byte >> 2) & 3, extra = (byte & 16) !== 0;
                if (custom === 3) { next = extra ? 'delta' : 'tps'; }
                else { next = extra ? 'seed' : 'delta'; frame2 = 0; }
              }
            } else if (next === 'delta') {
              var v = 0;
              if (blob === 1) { if (p >= buf.length) break; v = buf[p++]; }
              else if (blob === 2) { if (p + 2 > buf.length) break; v = dv.getUint16(p, true); p += 2; }
              else if (blob === 3) { if (p + 4 > buf.length) break; v = dv.getUint32(p, true); p += 4; }
              var result = (magic ? lastDelta : 0) + v;
              if (blob !== 0 && result !== 0) lastDelta = result;
              frame2 += result;
              next = 'action';
            } else if (next === 'tps') {
              if (p + 4 > buf.length) break;
              p += 4;               // a mid-replay tps change; we keep the header's
              next = 'delta';
            } else {                // seed
              if (p + 8 > buf.length) break;
              p += 8;
              next = 'delta';
            }
          }
        } else {
          throw new Error('TCM: unsupported version ' + version + '.');
        }
        return { tps: tps > 0 ? tps : 240, inputs: out };
      },
      write: function (rep) {
        var list = rep.inputs.slice().sort(function (a, b) { return a.frame - b.frame; });
        var out = [];
        TCM_MAGIC.forEach(function (b) { out.push(b); });
        var meta = new Uint8Array(0x40), mdv = dvOf(meta);
        meta[0] = 2;            // version
        meta[2] = 2;            // flags: the tps field really is tps, not dt
        mdv.setFloat32(4, rep.tps, true);
        meta.forEach(function (b) { out.push(b); });

        function varint(v) {
          v = Math.max(0, Math.round(v));
          if (v === 0) { out.push(0); return; }
          while (v > 0) { var b = v % 128; v = Math.floor(v / 128); out.push(v > 0 ? (b | 0x80) : b); }
        }

        varint(list.length ? list[0].frame : 0);
        list.forEach(function (inp, n) {
          var delta = n + 1 < list.length ? list[n + 1].frame - inp.frame : 0;
          var blob = delta === 0 ? 0 : delta <= 0xFF ? 1 : delta <= 0xFFFF ? 2 : 3;
          var button = inp.button >= 1 && inp.button <= 3 ? inp.button : 1;
          out.push(button | ((inp.down ? 1 : 0) << 2) | ((inp.player2 ? 1 : 0) << 3) |
                   ((blob << 1) << 5));
          if (blob === 1) out.push(delta & 0xFF);
          else if (blob === 2) { out.push(delta & 0xFF); out.push((delta >> 8) & 0xFF); }
          else if (blob === 3) {
            out.push(delta & 0xFF); out.push((delta >> 8) & 0xFF);
            out.push((delta >> 16) & 0xFF); out.push((delta >>> 24) & 0xFF);
          }
        });
        return new Uint8Array(out);
      }
    },

    silicate1: {
      name: 'Silicate v1 (.slc)', ext: '.slc', group: 'Current', confidence: 'src',
      note: 'Ported from nat-converter. v2 and v3 are different containers and aren\'t supported yet.',
      detect: function (n, t, buf) {
        if (!n || !/\.slc$/i.test(n) || !buf || buf.length < 12) return false;
        if (hasMagic(buf, [0x53, 0x4C, 0x43, 0x33])) return false;   // "SLC3" is v3
        var fps = dvOf(buf).getFloat64(0, true);
        return fps > 0 && fps < 100000;
      },
      read: function (buf) {
        var dv = dvOf(buf);
        var fps = dv.getFloat64(0, true);
        var count = dv.getUint32(8, true);
        var out = [], p = 12;
        for (var i = 0; i < count && p + 4 <= buf.length; i++) {
          var st = dv.getUint32(p, true); p += 4;
          if (((st & 6) >> 1) !== 1) continue;    // not a jump input
          out.push({
            frame: Math.floor(st / 16), button: 1,
            down: (st & 1) === 1, player2: (st & 8) !== 0
          });
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(12 + list.length * 4), dv = dvOf(buf);
        dv.setFloat64(0, rep.tps, true);
        dv.setUint32(8, list.length, true);
        var p = 12;
        list.forEach(function (i) {
          dv.setUint32(p, i.frame * 16 + (i.player2 ? 8 : 0) + 2 + (i.down ? 1 : 0), true);
          p += 4;
        });
        return buf;
      }
    },

    urlbot: {
      name: 'URL', ext: '.url', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter.',
      detect: function (n, t, buf) {
        if (!n || !/\.url$/i.test(n) || !buf || buf.length < 5) return false;
        var fps = dvOf(buf).getFloat32(0, true);
        return buf[4] <= 2 && fps > 0 && fps < 100000;
      },
      read: function (buf) {
        var dv = dvOf(buf);
        var fps = dv.getFloat32(0, true);
        var kind = buf[4];   // 0 = X-position, 1 = frames, 2 = both
        if (kind === 0) throw new Error('URL: this macro is X-position based, not frame based.');
        var size = kind === 2 ? 9 : 5, out = [], p = 5;
        while (p + size <= buf.length) {
          var st = buf[p]; p += 1;
          if (kind === 2) p += 4;      // skip the X position
          var frame = dv.getUint32(p, true); p += 4;
          out.push(mkInput(frame, (st & 1) === 1, (st >> 1) === 1));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(5 + list.length * 5), dv = dvOf(buf);
        dv.setFloat32(0, rep.tps, true);
        buf[4] = 1;                    // frame based
        var p = 5;
        list.forEach(function (i) {
          buf[p++] = (i.down ? 1 : 0) | (i.player2 ? 2 : 0);
          dv.setUint32(p, i.frame, true); p += 4;
        });
        return buf;
      }
    }
  };

  Object.keys(MODERN).forEach(function (k) { FORMATS[k] = MODERN[k]; });

  /* ----------------------------------------------------- TTR and yBot
   *
   * ToastyReplay's .ttr3, implemented from ToastexGD's own source
   * (github.com/ToastexGD/ToastyReplay, src/format/ttr3_format.cpp). Nigel
   * co-owns ToastyReplay, and only the byte layout is taken from it in any
   * case -- no code was copied.
   *
   * TTR3 is the odd one out here in a way that matters: it stores inputs by
   * ABSOLUTE TIME IN SECONDS, not by frame. Every other format on this page
   * is frame-indexed. Converting between them multiplies or divides by the
   * TPS, so a macro round-tripped through TTR3 at the wrong rate lands on the
   * wrong frames -- set the output TPS deliberately, don't leave it to luck.
   *
   * yBot comes from the ybot_fmt crate vendored in nat-converter. Two
   * different formats share the "ybot" magic: v1 is a flat record list, v2 is
   * a header + meta block + blobs + varint action stream.
   */
  function zlibInflate(bytes) {
    // Browsers ship this; it is the only async step in the whole page.
    var ds = new DecompressionStream('deflate');
    return new Response(new Blob([bytes]).stream().pipeThrough(ds))
      .arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }
  function zlibDeflate(bytes) {
    var cs = new CompressionStream('deflate');
    return new Response(new Blob([bytes]).stream().pipeThrough(cs))
      .arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
  }

  var TTR3_MAGIC = [0x54, 0x54, 0x52, 0x33];   // "TTR3"

  var TTR_YBOT = {
    ttr3: {
      name: 'ToastyReplay (.ttr3)', ext: '.ttr3', group: 'Current', confidence: 'src',
      timeBased: true,
      note: 'Layout from ToastyReplay\'s own source. Stores time in seconds, not frames.',
      detect: function (n, t, buf) { return hasMagic(buf, TTR3_MAGIC); },
      read: function (buf) {
        var dv = dvOf(buf);
        var version = dv.getUint16(4, true);
        if (version === 0 || version > 1) throw new Error('TTR3: unsupported wire version ' + version + '.');
        var flags = dv.getUint32(8, true);
        var headerLen = dv.getUint32(12, true);
        if (headerLen < 16 || headerLen > buf.length) throw new Error('TTR3: bad header length.');

        // Metadata block, between the fixed header and headerLen.
        var mp = 16;
        mp += 8;                                    // sourceFormatId
        mp += 8;                                    // gameVersion
        mp += 4;                                    // levelId
        mp += 2 + dv.getUint16(mp, true);           // levelName
        mp += 2 + dv.getUint16(mp, true);           // author
        var fps = dv.getFloat64(mp, true); mp += 8; // framerateHint
        if (!(fps > 0)) throw new Error('TTR3: invalid framerate.');

        // Section table, then the payload it indexes into.
        var tp = headerLen;
        var sections = dv.getUint16(tp, true); tp += 2;
        var entries = [];
        for (var i = 0; i < sections; i++) {
          var kind = buf[tp]; tp += 4;              // kind + 3 reserved bytes
          var offLo = dv.getUint32(tp, true), offHi = dv.getUint32(tp + 4, true); tp += 8;
          var szLo = dv.getUint32(tp, true), szHi = dv.getUint32(tp + 4, true); tp += 8;
          entries.push({ kind: kind, off: offHi * 4294967296 + offLo, size: szHi * 4294967296 + szLo });
        }
        var inputs = entries.filter(function (e) { return e.kind === 1; })[0];
        if (!inputs) throw new Error('TTR3: no inputs section.');

        var raw = buf.subarray(tp);
        var payload = (flags & 1024) ? zlibInflate(raw) : Promise.resolve(raw);
        return payload.then(function (pl) {
          var pdv = dvOf(pl);
          var q = inputs.off;
          var count = pdv.getUint32(q, true) + pdv.getUint32(q + 4, true) * 4294967296;
          q += 8;
          var out = [];
          for (var n = 0; n < count && q + 12 <= pl.length; n++) {
            var seconds = pdv.getFloat64(q, true); q += 8;
            var button = pl[q++];
            var f = pl[q++];
            q += 2;                                 // padding
            out.push({
              frame: Math.round(seconds * fps),
              button: button || 1,
              down: (f & 2) !== 0,
              player2: (f & 1) !== 0
            });
          }
          return { tps: fps, inputs: out };
        });
      },
      write: function (rep) {
        var list = rep.inputs.slice().sort(function (a, b) { return a.frame - b.frame; });
        var tps = rep.tps || 240;

        // Inputs section: u64 count, then 12 bytes each.
        var sec = new Uint8Array(8 + list.length * 12), sdv = dvOf(sec);
        sdv.setUint32(0, list.length, true);
        var q = 8;
        list.forEach(function (i) {
          sdv.setFloat64(q, i.frame / tps, true); q += 8;
          sec[q++] = i.button >= 1 && i.button <= 3 ? i.button : 1;
          sec[q++] = (i.player2 ? 1 : 0) | (i.down ? 2 : 0);
          q += 2;
        });

        return zlibDeflate(sec).then(function (packed) {
          var name = new TextEncoder().encode('');
          var head = [];
          function u8(v) { head.push(v & 0xff); }
          function u16(v) { u8(v); u8(v >> 8); }
          function u32(v) { u16(v); u16(v >>> 16); }
          function u64(v) { u32(v); u32(Math.floor(v / 4294967296)); }
          function f64(v) {
            var d = new DataView(new ArrayBuffer(8)); d.setFloat64(0, v, true);
            for (var i = 0; i < 8; i++) u8(d.getUint8(i));
          }
          TTR3_MAGIC.forEach(u8);
          u16(1);                                   // wire version
          u16(0);                                   // reserved
          // FlagTwoPlayer (8) | FlagMacroConverted (512) | FlagCompressed (1024)
          var flags = 512 | 1024;
          if (list.some(function (i) { return i.player2; })) flags |= 8;
          u32(flags);
          var headerLenAt = head.length;
          u32(0);                                   // patched below
          u64(0x00000000FFFF0003);                  // sourceFormatId
          u64(0);                                   // gameVersion
          u32(0);                                   // levelId
          u16(name.length);                         // levelName
          u16(name.length);                         // author
          f64(tps);                                 // framerateHint
          u32(0); u32(0);                           // startPosX, startPosY
          u32(0); u32(0);                           // recordTimestamp (i64)
          u32(0);                                   // rngSeed
          u8(0);                                    // accuracy mode
          f64(list.length ? list[list.length - 1].frame / tps : 0);   // duration
          var headerLen = head.length;
          head[headerLenAt] = headerLen & 0xff;
          head[headerLenAt + 1] = (headerLen >> 8) & 0xff;
          head[headerLenAt + 2] = (headerLen >> 16) & 0xff;
          head[headerLenAt + 3] = (headerLen >>> 24) & 0xff;
          u16(1);                                   // one section
          u8(1); u8(0); u8(0); u8(0);               // kind = Inputs, reserved
          u64(0);                                   // offset
          u64(sec.length);                          // size
          var out = new Uint8Array(head.length + packed.length);
          out.set(head, 0);
          out.set(packed, head.length);
          return out;
        });
      }
    },

    ybot2: {
      name: 'yBot 2', ext: '.ybot', group: 'Current', confidence: 'src',
      note: 'Layout from the ybot_fmt crate vendored in nat-converter.',
      detect: function (n, t, buf) {
        // yBot 1 shares this magic; it puts an f32 fps where v2 puts a small
        // version number, so the two separate cleanly on that field.
        return hasMagic(buf, [0x79, 0x62, 0x6F, 0x74]) && buf.length >= 16 &&
               dvOf(buf).getUint32(4, true) <= 16;
      },
      read: function (buf) {
        var dv = dvOf(buf);
        var metaLen = dv.getUint32(8, true);
        var blobs = dv.getUint32(12, true);
        // FPS sits at meta offset 24, after DATE(i64), PRESSES(u64), FRAMES(u64).
        var fps = metaLen >= 28 ? dv.getFloat32(16 + 24, true) : 240;
        var p = 16 + metaLen;
        for (var b = 0; b < blobs; b++) { p += 4 + dv.getUint32(p, true); }
        var out = [], frame = 0;
        while (p < buf.length) {
          var v = 0, shift = 1, byte;
          do {
            if (p >= buf.length) { v = -1; break; }
            byte = buf[p++];
            v += (byte & 0x7F) * shift;
            shift *= 128;
          } while (byte & 0x80);
          if (v < 0) break;
          var f = v & 15;
          frame += Math.floor(v / 16);
          var button = f >> 2;
          if (button < 1 || button > 3) { p += 4; continue; }   // an FPS change
          // Bit 0 is player ONE here, not player two.
          out.push({ frame: frame, button: button, down: (f & 2) !== 0, player2: (f & 1) === 0 });
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = rep.inputs.slice().sort(function (a, b) { return a.frame - b.frame; });
        var out = [];
        [0x79, 0x62, 0x6F, 0x74].forEach(function (b) { out.push(b); });
        function u32(v) { out.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff); }
        u32(1);        // version
        u32(36);       // meta length: through TOTAL_PRESSES
        u32(0);        // no blobs
        var meta = new Uint8Array(36), mdv = dvOf(meta);
        mdv.setUint32(8, list.length, true);                                   // PRESSES
        mdv.setUint32(16, list.length ? list[list.length - 1].frame + 1 : 0, true);  // FRAMES
        mdv.setFloat32(24, rep.tps, true);                                     // FPS
        mdv.setUint32(28, list.length, true);                                  // TOTAL_PRESSES
        meta.forEach(function (b) { out.push(b); });
        var prev = 0;
        list.forEach(function (i) {
          var button = i.button >= 1 && i.button <= 3 ? i.button : 1;
          var flags = (i.player2 ? 0 : 1) | (i.down ? 2 : 0) | (button << 2);
          var v = (i.frame - prev) * 16 + flags;
          prev = i.frame;
          if (v === 0) { out.push(0); return; }
          while (v > 0) { var b = v % 128; v = Math.floor(v / 128); out.push(v > 0 ? (b | 0x80) : b); }
        });
        return new Uint8Array(out);
      }
    },

    ybot1: {
      name: 'yBot 1', ext: '.ybot', group: 'Legacy (2.1)', confidence: 'src',
      note: 'Ported from nat-converter. Shares yBot 2\'s magic but is a flat record list.',
      detect: function (n, t, buf) {
        return hasMagic(buf, [0x79, 0x62, 0x6F, 0x74]) && buf.length >= 12 &&
               dvOf(buf).getUint32(4, true) > 16;
      },
      read: function (buf) {
        var dv = dvOf(buf);
        var fps = dv.getFloat32(4, true);
        var count = dv.getInt32(8, true);
        var out = [], p = 12;
        for (var i = 0; i < count && p + 8 <= buf.length; i++) {
          var frame = dv.getUint32(p, true); p += 4;
          var st = dv.getUint32(p, true); p += 4;
          out.push(mkInput(frame, (st & 2) === 2, (st & 1) === 1));
        }
        return { tps: fps > 0 ? fps : 240, inputs: out };
      },
      write: function (rep) {
        var list = jumps(rep);
        var buf = new Uint8Array(12 + list.length * 8), dv = dvOf(buf);
        buf[0] = 0x79; buf[1] = 0x62; buf[2] = 0x6F; buf[3] = 0x74;
        dv.setFloat32(4, rep.tps, true);
        dv.setInt32(8, list.length, true);
        var p = 12;
        list.forEach(function (i) {
          dv.setUint32(p, i.frame, true); p += 4;
          dv.setUint32(p, (i.down ? 2 : 0) | (i.player2 ? 1 : 0), true); p += 4;
        });
        return buf;
      }
    }
  };

  Object.keys(TTR_YBOT).forEach(function (k) { FORMATS[k] = TTR_YBOT[k]; });


  /* Planned. Ones marked hasSample have a real reference file in hand, so
   * they can be implemented and verified properly rather than guessed at --
   * that's the difference between support that works and support that
   * silently corrupts a macro. The rest still need a sample each. */
  var PLANNED = [
    ['OmegaBot 3 (.replay)', 'Legacy (2.1)'],
    ['Silicate v2 / v3', 'Current', true],
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

      // Most readers are synchronous, but a compressed container (TTR3) has
      // to go through DecompressionStream, which is not. Promise.resolve
      // swallows the difference so neither kind needs special-casing.
      var pending;
      try {
        pending = Promise.resolve(FORMATS[key].read(buf, text));
      } catch (e) {
        pending = Promise.reject(e);
      }
      pending.then(function (rep) { finishLoad(rep); }, function (e) {
        show('err', '<strong>Failed to read that file.</strong> ' + (e && e.message ? e.message : e));
      });

    function finishLoad(rep) {
      original = rep;
      // Formats that store a frame delta rather than a rate come back as
      // 239.99998... from float32 rounding. The intent is obviously 240.
      if (Math.abs(original.tps - Math.round(original.tps)) < 0.002)
        original.tps = Math.round(original.tps);

      current = clone(original);

      loadedName = file.name;
      loadedKey = key;
      $('loaded').classList.remove('hidden');
      $('s-name').textContent = file.name;
      $('s-fmt').textContent = FORMATS[key].name;
      $('s-size').textContent = (buf.length / 1024).toFixed(1) + ' KB';
      $('outtps').value = current.tps;
      refresh();

      // Some formats (TCM especially) record a whole practice session, with a
      // restart marker resetting the frame counter on each attempt. Flattened
      // into one input list, that reads as frames jumping backwards.
      var backwards = current.inputs.some(function (i, n) {
        return n > 0 && i.frame < current.inputs[n - 1].frame;
      });

      if (backwards) {
        show('err', '<strong>This macro contains restarts.</strong> The frame numbers jump ' +
          'backwards, so it is a recording of several attempts rather than one run. Every ' +
          'attempt is loaded here, one after another &mdash; converting it as-is will not ' +
          'give you a playable single run.');
      } else if (FORMATS[key].confidence === 're') {
        show('warn', FORMATS[key].name + ' was worked out from a sample rather than from any ' +
          'published source, so it is the least certain format here. Check the result in-game.');
      } else {
        show('good', 'Loaded ' + current.inputs.length.toLocaleString() + ' inputs as ' +
          FORMATS[key].name + '.');
      }
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
        o.textContent = pair[1].name;
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
        (r[1] === 'ok' ? 'verified' : r[1] === 'src' ? 'from source'
          : r[1] === 're' ? 'reverse-engineered' : 'planned') + '</span>' +
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
      var writing;
      try {
        writing = Promise.resolve(f.write(out));
      } catch (e) {
        writing = Promise.reject(e);
      }
      writing.then(function (bytes) { deliver(bytes); }, function (e) {
        show('err', 'Failed to write that format: ' + (e && e.message ? e.message : e));
      });

    function deliver(bytes) {
      var base = ($('s-name').textContent || 'macro').replace(/\.[^.]+$/, '');
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = base + f.ext;
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
      var droppedP2 = f.p1only && out.inputs.some(function (i) { return i.player2; });
      show(droppedP2 ? 'err' : f.timeBased ? 'warn' : 'good',
        'Saved as ' + f.name + '.' + (droppedP2 ?
          ' <strong>Player 2 inputs were dropped.</strong> ' + f.name + ' has no ' +
          'player field at all, so only player 1 survives the conversion.' : '') +
        (f.timeBased ?
          ' <strong>' + f.name + ' stores time, not frames.</strong> Every input was written ' +
          'as its frame divided by ' + out.tps + ' TPS &mdash; if that is not the rate the macro ' +
          'was recorded at, the inputs will land in the wrong place.' : ''));
    }
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
