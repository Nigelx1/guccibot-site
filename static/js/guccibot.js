// Marquee
const items = [
  'GBR6','Frame Perfect','Silicate Engine','20 Themes','4 Disciplines',
  'Brrr.','TPS 240','Backwards Stepping','SSB Fix','Lock Delta',
  'Type C Delta','Autoclicker','Noclip','Macro Diff','Brrr.',
  '.brrr','.toosii','.ja','.giddey','.bam','.sexyy','.juice','.butler',
  'Jupiter My Favourite Trainer','Click Deviation','Synced Music','BIG BRRRR','Brrr.',
  'Trainer Tab','Any Macro','Manual Frame Windows','140 BPM','Brrr.',
  'Compact Mode','JuiceBot','ButlerBot','Playoff Jimmy','Brrr.',
  'Click Indicators','Video Mode','RomoBot','GrizzleyBot','BrrrBot','Custom Themes','Brrr.',
  'Frame Windows','Calculate','Custom Tiers','Pathfinder','No Recording Needed','26 Formats','Brrr.',
];

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

// Scroll reveal
const obs = new IntersectionObserver((entries) => {
  entries.forEach(e => {
    if (e.isIntersecting) {
      e.target.classList.add('visible');
      obs.unobserve(e.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -50px 0px' });

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
