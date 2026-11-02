// The page's head marks it .js, so the CSS can hide what this script
// reveals or folds away (scroll reveals, the nav's panel, the download
// picker's tabs). If this file never runs, the head takes .js back on load
// and everything shows as plain content.
window.GucciBotReady = true;

// Marquee
const items = [
  'GBR6','Frame Perfect','Silicate Engine','24 Themes','4 Disciplines',
  'Brrr.','TPS 240','Backwards Stepping','SSB Fix','Lock Delta',
  'Type C Delta','Autoclicker','Noclip','Macro Diff','Brrr.',
  '.brrr','.toosii','.ja','.giddey','.bam','.sexyy','.juice','.butler',
  'Jupiter My Favourite Trainer','Click Deviation','Synced Music','BIG BRRRR','Brrr.',
  'Trainer Tab','Any Macro','Manual Frame Windows','140 BPM','Brrr.',
  'Compact Mode','JuiceBot','ButlerBot','Playoff Jimmy','Brrr.',
  'Click Indicators','Video Mode','RomoBot','GrizzleyBot','BrrrBot','Custom Themes','Brrr.',
  'RondoBot','Playoff Rondo','SolarBot','JupiterBot','Brrr.',
  'Frame Windows','Calculate','Custom Tiers','Pathfinder','No Recording Needed','27 Formats','Brrr.',
];

// Nav: under 1,180 px wide the links fold into a panel behind the Menu
// button (guccibot.css). Every control here is a real <a> or <button>, so
// none of it sets off the click gag at the bottom of this file; the scrim
// behind the open panel is a button too, so a tap outside the panel only
// closes the menu.
(function () {
  const nav = document.querySelector('nav');
  const toggle = nav && nav.querySelector('.nav-toggle');
  if (!toggle) return;
  const label = toggle.querySelector('.nav-toggle-label');
  const scrim = nav.querySelector('.nav-scrim');
  function setOpen(open, refocus) {
    nav.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (label) label.textContent = open ? 'Close' : 'Menu';
    if (!open && refocus) toggle.focus();
  }
  toggle.addEventListener('click', () => setOpen(!nav.classList.contains('nav-open')));
  if (scrim) scrim.addEventListener('click', () => setOpen(false));
  nav.querySelectorAll('.nav-links a').forEach(a => a.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && nav.classList.contains('nav-open')) setOpen(false, true);
  });
  const wide = window.matchMedia('(min-width: 1180px)');
  const onWide = () => { if (wide.matches) setOpen(false); };
  if (wide.addEventListener) wide.addEventListener('change', onWide);
  else if (wide.addListener) wide.addListener(onWide);
})();

// Download picker: a tab per platform, opened on the visitor's own one (a
// guess from the browser; every tab is one press away). Arrow keys, Home and
// End move between tabs, as tabs do. The tabs are real buttons, so they
// never start the click gag. Without JavaScript the CSS shows all four.
(function () {
  const picker = document.querySelector('[data-picker]');
  if (!picker) return;
  const tabs = [...picker.querySelectorAll('[role="tab"]')];
  function select(tab, focus) {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', (e) => {
      let j = -1;
      if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
      else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = tabs.length - 1;
      if (j < 0) return;
      e.preventDefault();
      select(tabs[j], true);
    });
  });
  const ua = navigator.userAgent || '';
  // iPadOS asks for the desktop site, so an iPad says it's a Mac with a touch screen.
  const touchMac = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1;
  const guess = /Android/i.test(ua) ? 'android'
    : (/iPhone|iPad|iPod/.test(ua) || touchMac) ? 'iphone'
    : /Macintosh|Mac OS X/.test(ua) ? 'mac'
    : 'windows';
  select(document.getElementById('dl-tab-' + guess) || tabs[0]);
})();

// Click to copy (the release's SHA-256 and the commands that check it).
document.querySelectorAll('[data-copy]').forEach(btn => {
  const hint = btn.querySelector('.dl-copy-hint');
  let timer = 0;
  function fallback(text) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    area.remove();
    return ok;
  }
  function show(ok) {
    btn.classList.toggle('is-copied', ok);
    if (hint) hint.textContent = ok ? 'Copied' : 'Not copied';
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.classList.remove('is-copied');
      if (hint) hint.textContent = 'Copy';
    }, 2000);
  }
  btn.addEventListener('click', () => {
    const text = btn.getAttribute('data-copy');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => show(true), () => show(fallback(text)));
    } else {
      show(fallback(text));
    }
  });
});

// Shared across every page now that this is a real multi-page site
// (site/, not one guccibot.html) -- guarded so pages without a
// marquee (e.g. the changelog) don't error on the missing element.
const track = document.getElementById('marquee');
if (track) {
  const html = items.map(t =>
    `<span class="marquee-item">${t}</span><span class="marquee-item marquee-sep">·</span>`
  ).join('');
  track.innerHTML = html + html;
}

// Scroll reveal. An element shows once 10% of it is on screen -- except
// one taller than the screen, which shows as soon as it scrolls in: 10% of
// something over ten screens tall can never be on screen at once, and the
// changelog list (one .reveal holding every entry) grew past that and
// stayed invisible (2026-09-29).
const obs = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    const screen = e.rootBounds ? e.rootBounds.height : window.innerHeight;
    const tall = e.boundingClientRect.height > screen;
    if (e.isIntersecting && (tall || e.intersectionRatio >= 0.1)) {
      e.target.classList.add('visible');
      obs.unobserve(e.target);
    }
  });
}, { threshold: [0, 0.1], rootMargin: '0px 0px -50px 0px' });

document.querySelectorAll('.reveal').forEach(el => obs.observe(el));

// Stagger reveal children
document.querySelectorAll('.feature-grid.reveal, .themes-grid.reveal, .credits-grid.reveal, .changelog-list.reveal').forEach(grid => {
  [...grid.children].forEach((child, i) => {
    child.style.transitionDelay = `${i * 0.08}s`;
  });
});

// Gag, Nigel's ask: clicking anywhere that ISN'T a real interactive
// control triggers a fullscreen video, no controls, nothing else.
// Deliberately scoped to real <a>/<button>/form controls only, so
// every actual link and button (nav, download, changelog, credits
// links) keeps working normally -- but things that only LOOK clickable
// (theme cards, feature cards, credit cards, disc rows -- styled with
// a pointer cursor but no real destination) count as "not a button or
// anything" and trigger it, which is the whole bit.
//
// Shows as an in-page overlay instead of navigating to /dropped/,
// 2026-09-02 (was a real navigation before -- Nigel: no audio on
// mobile, wanted something better than a "first tap" fallback).
// Real mechanism, not a workaround: browsers only allow unmuted
// autoplay when play() is called as part of an actual user gesture,
// and mobile browsers (iOS Safari especially) are far stricter than
// desktop about what still COUNTS as that gesture -- a full page
// navigation to a brand new document loses it entirely, which is
// exactly why the old version had no sound on phones. Doing this as
// an overlay on the CURRENT page means video.play() runs synchronously
// inside the same click handler as the actual click -- same gesture,
// same document, no navigation in between -- so it's treated as a
// real user-initiated play rather than background autoplay. This is
// what fixes it for real, not the tap workaround.
// /dropped/ itself still exists as a real standalone page (for direct
// links) and keeps its own fallback for that case, since a direct
// visit genuinely has no prior gesture to reuse.
const DROPPED_VIDEO_URL = 'https://github.com/Nigelx1/guccibot-site/releases/download/site-video/0901.1.mp4';

function showDropped() {
  if (document.getElementById('dropped-overlay')) return; // already showing
  const overlay = document.createElement('div');
  overlay.id = 'dropped-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;';
  const video = document.createElement('video');
  video.src = DROPPED_VIDEO_URL;
  video.loop = true;
  video.playsInline = true;
  video.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain;';
  overlay.appendChild(video);
  document.body.appendChild(overlay);
  document.body.style.overflow = 'hidden';
  video.play().catch(() => {
    video.muted = true;
    video.play();
  });
}

// Exposed so the converter page can reuse the same video for its own,
// more targeted gag (converting a .brrr away from GucciBot).
window.GucciDropped = { url: DROPPED_VIDEO_URL, show: showDropped };

if (!location.pathname.startsWith('/dropped')) {
  document.addEventListener('click', (e) => {
    // The converter is a tool, not marketing -- a fullscreen video
    // hijacking the page while someone is mid-conversion is just
    // annoying, and its working area is full of panels, tables and
    // labels that aren't <button>s. That page runs its own gag instead
    // (see converter.js). Page chrome outside the tool still triggers
    // this one normally.
    if (e.target.closest('.conv-wrap')) return;
    const real = e.target.closest('a, button, input, textarea, select, label, [role="button"], [onclick]');
    if (!real) {
      showDropped();
    }
  });
}
