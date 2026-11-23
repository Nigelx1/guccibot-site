// Site switches. Nigel, 2026-11-23.
//
// droppedVideo: the "dropped" video gag: a click on anything that isn't a real
// button or link, the converter's "That macro is already home." screen, and the
// /dropped/ page. Off for now: people found the video uncomfortable. With it off,
// a stray click does nothing, the converter keeps its message and buttons without
// the video, and /dropped/ sends the visit to the home page. Set it to true to
// bring the video back.
window.GUCCI_SITE = window.GUCCI_SITE || {};
window.GUCCI_SITE.droppedVideo = false;
